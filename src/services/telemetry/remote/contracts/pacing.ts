/**
 * Delivery pacing shared by the usage channel and the production OTLP Logs,
 * Metrics and Traces channels (otel contract v2.1 §1.5–§1.8, TADR §2.4).
 *
 * Every function here is pure: the owning outbox persists the state, so a pause
 * or a server interval survives a restart and is shared by every window of the
 * machine. Each channel keeps its own state, so a wait on one never holds the other.
 */

export type DeliveryChannel = "usage" | "logs" | "metrics" | "traces"

/**
 * Cadence used until the service names one, including the first batch after a
 * restart. Metrics export one delta window every 60 s (TADR §7.2); Traces
 * follow the same cadence so a span reaches the service about as soon as its
 * window's metrics do.
 */
export const DEFAULT_INTERVAL_MS: Readonly<Record<DeliveryChannel, number>> = {
    usage: 10 * 60_000,
    logs: 5 * 60_000,
    metrics: 60_000,
    traces: 60_000,
}
/** No single wait lasts longer, so a misconfigured pause cannot stop a device for good. */
export const MAX_WAIT_MS = 7 * 24 * 60 * 60_000
/** Extra wait past the server gate, so a small disagreement between clocks does not cost a 429. */
export const GATE_MARGIN_MS = 2_000
/** A batch whose outcome stays unknown this often, or this long, is dropped instead of replayed forever. */
export const MAX_REPLAY_ATTEMPTS = 12
export const MAX_REPLAY_AGE_MS = 24 * 60 * 60_000

const WAIT_FALLBACK_BASE_MS = 60_000
const WAIT_FALLBACK_CAP_MS = 30 * 60_000
const WAIT_JITTER_RATIO = 0.1
const REPLAY_BACKOFF_BASE_MS = 30_000
const REPLAY_BACKOFF_CAP_MS = 30 * 60_000

export interface ChannelPacing {
    /** Local time before which no new batch may start; replays of the batch in flight are exempt. */
    readonly nextEligibleAt: number
    /** Local time before which nothing is sent at all, replays included: a 429 or a pause is running. */
    readonly waitUntil: number
    /** 429 answers in a row; the next acknowledgement resets it. */
    readonly consecutiveWaits: number
}

export const INITIAL_PACING: ChannelPacing = { nextEligibleAt: 0, waitUntil: 0, consecutiveWaits: 0 }

/** Whether a 429 wait or a pause is still running; nothing may be sent while it is. */
export function isWaiting(pacing: ChannelPacing, now: number): boolean {
    return now < pacing.waitUntil
}

/** Whether a new batch may be built and sent now. */
export function mayStartBatch(pacing: ChannelPacing, now: number): boolean {
    return !isWaiting(pacing, now) && now >= pacing.nextEligibleAt
}

/**
 * Hold the next new batch back a full default interval as soon as one exists.
 * The acknowledgement replaces it with the server's own gate; a batch that is
 * dropped without one keeps it, so a refusal never turns into a tight loop.
 */
export function reserveInterval(pacing: ChannelPacing, channel: DeliveryChannel, now: number): ChannelPacing {
    return { ...pacing, nextEligibleAt: Math.max(pacing.nextEligibleAt, now + DEFAULT_INTERVAL_MS[channel]) }
}

/**
 * Follow the gate an acknowledgement named (§1.6). The server's value wins over
 * the reservation in both directions; a missing value falls back to the default
 * interval, and a value beyond the wait cap is held to it.
 */
export function afterAcknowledged(
    pacing: ChannelPacing,
    channel: DeliveryChannel,
    nextEligibleAt: number | undefined,
    now: number,
): ChannelPacing {
    const gate =
        nextEligibleAt === undefined
            ? now + DEFAULT_INTERVAL_MS[channel]
            : Math.min(Math.max(nextEligibleAt + GATE_MARGIN_MS, now), now + MAX_WAIT_MS)
    return { nextEligibleAt: gate, waitUntil: pacing.waitUntil, consecutiveWaits: 0 }
}

/**
 * Start the wait a 429 or a pause asks for (§1.7); it does not count as a
 * replay attempt. The refused batch is replayed unchanged as soon as the wait
 * ends (§1.7 rules 7 and 9), so the interval reserved when it was built must not outlast the wait.
 */
export function afterRateLimited(
    pacing: ChannelPacing,
    retryAfterMs: number | undefined,
    now: number,
    random: () => number = Math.random,
): ChannelPacing {
    const consecutiveWaits = pacing.consecutiveWaits + 1
    const waitUntil = now + rateLimitWaitMs(retryAfterMs, consecutiveWaits, random)
    return { nextEligibleAt: Math.min(pacing.nextEligibleAt, waitUntil), waitUntil, consecutiveWaits }
}

/**
 * How long to wait after the n-th 429 in a row: the service's `retry_after_ms`
 * or `Retry-After` when it gave one (the caller already prefers the body), else
 * 60 s doubling up to 30 min. A 0–10 % jitter spreads devices that would all
 * resume at the same instant, such as UTC midnight; no wait exceeds 7 days.
 */
export function rateLimitWaitMs(retryAfterMs: number | undefined, consecutiveWaits: number, random: () => number): number {
    const base = retryAfterMs ?? Math.min(WAIT_FALLBACK_CAP_MS, WAIT_FALLBACK_BASE_MS * 2 ** (Math.max(1, consecutiveWaits) - 1))
    const jitter = Math.min(Math.max(random(), 0), 1) * WAIT_JITTER_RATIO
    return Math.min(MAX_WAIT_MS, Math.round(base * (1 + jitter)))
}

/** Delay before the n-th replay of the same bytes: the service's hint or 30 s doubling, at most 30 min. */
export function replayDelayMs(attempts: number, retryAfterMs: number | undefined): number {
    const backoff = Math.min(REPLAY_BACKOFF_CAP_MS, REPLAY_BACKOFF_BASE_MS * 2 ** (Math.max(1, attempts) - 1))
    return Math.min(REPLAY_BACKOFF_CAP_MS, Math.max(retryAfterMs ?? 0, backoff))
}

export interface ReplayBudget {
    readonly maxAttempts: number
    readonly maxAgeMs: number
}

/** The logs channel's budget: twelve attempts or a day since the batch was built. */
export const DEFAULT_REPLAY_BUDGET: ReplayBudget = { maxAttempts: MAX_REPLAY_ATTEMPTS, maxAgeMs: MAX_REPLAY_AGE_MS }

/**
 * The Usage budget: the grant's `max_request_replay_age_ms` alone bounds it
 * (usage-contract §14), because the service keeps the request journal that
 * long and an attempt cap would dead-letter a request it could still accept.
 */
export function usageReplayBudget(maxRequestReplayAgeMs: number): ReplayBudget {
    return { maxAttempts: Number.POSITIVE_INFINITY, maxAgeMs: maxRequestReplayAgeMs }
}

/** Whether a batch has used up its replays. */
export function replayBudgetExhausted(
    attempts: number,
    createdAt: number,
    now: number,
    budget: ReplayBudget = DEFAULT_REPLAY_BUDGET,
): boolean {
    return attempts >= budget.maxAttempts || now - createdAt >= budget.maxAgeMs
}
