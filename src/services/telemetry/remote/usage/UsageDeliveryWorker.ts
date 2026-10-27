import { randomUUID } from "node:crypto"
import type { UsageObservationSpool } from "@/core/storage/telemetry-remote/UsageObservationSpool"
import type { UsageOutboxRepository, UsageSenderGrant } from "@/core/storage/telemetry-remote/UsageOutboxRepository"
import type { DeviceTokenBroker } from "../auth/DeviceTokenBroker"
import { classifyUsageResponse, type DeliveryOutcome, type StopScope } from "../contracts/classification"
import { type ReplayBudget, usageReplayBudget } from "../contracts/pacing"
import type { UsageBodyGrant, UsageClientWire } from "../contracts/usageBody"
import type { DeliveryDisposition } from "../contracts/wire"
import { DlineOtelTransportError, type UsageTransport } from "../transport/DlineOtelHttpClient"
import {
    boundUsageAttemptBacklog,
    dueUsageAttemptReplay,
    foldUsageAttemptShards,
    settleUsageAttemptInflight,
    takeUsageAttemptBatch,
    type UsageAttemptInflight,
    type UsageAttemptObservationRejection,
    type UsageInflightResolution,
    usageBucketFitsGrant,
} from "./usageOutbox"

export type UsageCycleResult =
    /** Another window holds the sender lease, this window's turn just ended, or a newer Dline owns the outbox. */
    | { readonly kind: "standby" }
    /** The lease lapsed during the cycle; the next holder takes over the same inflight. */
    | { readonly kind: "fenced" }
    | { readonly kind: "idle" }
    | { readonly kind: "aborted" }
    /** No usable token yet; the inflight waits unchanged. */
    | {
          readonly kind: "waiting"
          readonly reason: "enrollment_backoff" | "refresh_in_progress" | "token_unavailable"
          readonly retryAt?: number
      }
    | { readonly kind: "delivered"; readonly requestId: string; readonly disposition: DeliveryDisposition }
    | { readonly kind: "retrying"; readonly requestId: string }
    /** A 429 or a pause: nothing is sent on this channel until `until`, then the same batch is replayed first. */
    | { readonly kind: "paused"; readonly requestId: string; readonly code: string; readonly until: number }
    | { readonly kind: "discarded"; readonly requestId: string; readonly code: string }
    | { readonly kind: "rejected"; readonly violations: readonly string[] }
    /** The service refused the device or profile; the caller records the stop and drops pending usage. */
    | { readonly kind: "stopped"; readonly scope: StopScope; readonly code: string }

export interface UsageDeliveryWorkerOptions {
    readonly outbox: UsageOutboxRepository
    readonly spool: UsageObservationSpool
    readonly tokens: Pick<DeviceTokenBroker, "acquire">
    readonly transport: UsageTransport
    /** The `client` section of every body, already reduced to values the service accepts. */
    readonly client: UsageClientWire
    /** Identity of this window in the sender lease. */
    readonly ownerId: string
    readonly clock?: () => number
    readonly newRequestId?: () => string
    /** Source of the 429 wait jitter. */
    readonly random?: () => number
    /** Static test seam; production reads the active atomic grant before every cycle. */
    readonly attemptGrant?: UsageBodyGrant
    readonly readAttemptGrant?: () => Promise<UsageBodyGrant | undefined>
}

type PreparedAttempts = (
    | { readonly kind: "send"; readonly inflight: UsageAttemptInflight }
    | { readonly kind: "idle" }
    | { readonly kind: "rejected"; readonly violations: readonly string[] }
) & { readonly keepRequestId: string | undefined }

type Attempt =
    | { readonly kind: "outcome"; readonly outcome: DeliveryOutcome }
    | { readonly kind: "result"; readonly result: UsageCycleResult }

/** Code reported when the service rejects a freshly exchanged token as well. */
export const USAGE_TOKEN_REJECTED = "token_rejected"

/**
 * One delivery cycle of the machine-wide usage outbox.
 *
 * Only the lease holder works: it seals every process shard, folds settled
 * ones into pending minutes, and either replays the inflight or creates the
 * next batch once the service's gate opened and no 429 wait runs. HTTP runs outside every lock; the
 * outcome is applied under the lease, so a sender that lost its lease while
 * waiting cannot acknowledge. Policy decisions stay with the caller: a refusal
 * is returned, not recorded.
 */
export class UsageDeliveryWorker {
    private readonly clock: () => number
    private readonly newRequestId: () => string
    private grant: UsageSenderGrant | undefined

    constructor(private readonly options: UsageDeliveryWorkerOptions) {
        this.clock = options.clock ?? Date.now
        this.newRequestId = options.newRequestId ?? randomUUID
    }

    async runCycle(policyEpoch: number, signal?: AbortSignal): Promise<UsageCycleResult> {
        const { outbox } = this.options
        let attemptGrant = (await this.options.readAttemptGrant?.()) ?? this.options.attemptGrant
        let outboxActive = await this.outboxActive()

        // A dynamic grant reader means the service contract owns admission. The grant is bootstrapped
        // before the outbox exists, so no batch is ever built without the contract 5 grant it must satisfy.
        if (!attemptGrant && !outboxActive && this.options.readAttemptGrant) {
            let acquired
            try {
                acquired = await this.options.tokens.acquire("usage", { signal })
            } catch (error) {
                if (signal?.aborted) return { kind: "aborted" }
                throw error
            }
            if (acquired.status === "stopped") return { kind: "stopped", scope: acquired.scope, code: acquired.code }
            if (acquired.status === "deferred") {
                return { kind: "waiting", reason: acquired.reason, retryAt: acquired.retryAt }
            }
            if (acquired.status === "unavailable") return { kind: "waiting", reason: "token_unavailable" }
            attemptGrant = await this.options.readAttemptGrant()
        }

        if (attemptGrant) {
            await outbox.activateAttempts(policyEpoch)
            outboxActive = await this.outboxActive()
        }
        if (outboxActive) return this.runAttemptFoldCycle(policyEpoch, attemptGrant, signal)
        // Until a contract 5 grant is durably visible, attempt observations stay in their process shards
        // and the next cycle retries.
        return { kind: "idle" }
    }

    /** Whether this machine's contract 5 outbox exists; observations are folded only into it. */
    private async outboxActive(): Promise<boolean> {
        return (await this.options.outbox.readAttempts()) !== undefined
    }

    /** Fold schema 4 shards under the same fenced machine lease; manifest delivery is the next stage. */
    private async runAttemptFoldCycle(
        policyGeneration: number,
        attemptGrant: UsageBodyGrant | undefined,
        signal?: AbortSignal,
    ): Promise<UsageCycleResult> {
        const { outbox, spool } = this.options
        const grant = await outbox.claimAttempts(this.options.ownerId)
        this.grant = grant
        if (!grant) return { kind: "standby" }

        const now = this.clock()
        await spool.sealActiveAttempts(now)
        const { shards } = await spool.readSettledAttempts(this.clock())
        const rejected: UsageAttemptObservationRejection[] = []
        const folded = await outbox.transactAttempts(grant, async (state, committedAt) => {
            const next = foldUsageAttemptShards(state, shards, {
                currentPolicyGeneration: policyGeneration,
                newBucketId: randomUUID,
                sealedAt: committedAt,
                eventWindowMs: attemptGrant?.contract.eventWindowMs,
                ...(attemptGrant ? { fits: usageBucketFitsGrant(attemptGrant, this.options.client) } : {}),
                onRejected: (rejection) => rejected.push(rejection),
            })
            const bounded = boundUsageAttemptBacklog(next, committedAt)
            await spool.quarantineRejectedAttempts(rejected)
            for (const loss of bounded.losses) {
                await outbox.writeAttemptLoss({
                    kind: "delivery",
                    bucketIds: loss.bucketIds,
                    violations: loss.violations,
                    recordedAt: committedAt,
                })
            }
            return { state: bounded.state, result: bounded.state.inflight?.requestId }
        })
        if (folded.status === "fenced") return { kind: "fenced" }
        if (shards.length > 0) await spool.discardAttempts(shards.map((shard) => shard.name))
        if (!(await outbox.removeAttemptBodies(grant, folded.result))) return { kind: "fenced" }
        if (!attemptGrant) return { kind: "idle" }

        const prepared = await this.prepareAttempts(grant, attemptGrant)
        if (prepared.status === "fenced") return { kind: "fenced" }
        const next = prepared.result
        if (!(await outbox.removeAttemptBodies(grant, next.keepRequestId))) return { kind: "fenced" }
        if (next.kind === "idle") return { kind: "idle" }
        if (next.kind === "rejected") return { kind: "rejected", violations: next.violations }
        return this.deliverAttempt(grant, next.inflight, usageReplayBudget(attemptGrant.contract.maxRequestReplayAgeMs), signal)
    }

    private prepareAttempts(grant: UsageSenderGrant, attemptGrant: UsageBodyGrant) {
        const { outbox } = this.options
        return outbox.transactAttempts<PreparedAttempts>(grant, async (state, now) => {
            if (state.inflight) {
                const keepRequestId = state.inflight.requestId
                const due = dueUsageAttemptReplay(state, now)
                return { state, result: due ? { kind: "send", inflight: due, keepRequestId } : { kind: "idle", keepRequestId } }
            }
            const decision = takeUsageAttemptBatch(state, {
                now,
                requestId: this.newRequestId(),
                client: this.options.client,
                random: this.options.random,
                contract: attemptGrant.contract,
            })
            if (decision.kind === "none") return { state, result: { kind: "idle", keepRequestId: undefined } }
            if (decision.kind === "rejected") {
                await outbox.writeAttemptLoss({
                    kind: "validation",
                    bucketIds: decision.bucketIds,
                    violations: decision.violations,
                    recordedAt: now,
                })
                return {
                    state: decision.state,
                    result: { kind: "rejected", violations: decision.violations, keepRequestId: undefined },
                }
            }
            await outbox.writeBody(decision.inflight.requestId, decision.bytes)
            return {
                state: decision.state,
                result: { kind: "send", inflight: decision.inflight, keepRequestId: decision.inflight.requestId },
            }
        })
    }

    private async deliverAttempt(
        grant: UsageSenderGrant,
        inflight: UsageAttemptInflight,
        replayBudget: ReplayBudget,
        signal?: AbortSignal,
    ): Promise<UsageCycleResult> {
        const body = await this.options.outbox.readBody(inflight)
        if (!body) return this.settleAttempt(grant, inflight, { kind: "body_lost" }, replayBudget)
        const attempted = await this.attempt(inflight, body, signal)
        if (attempted.kind === "result") return attempted.result
        const { outcome } = attempted
        if (outcome.kind === "stop") return { kind: "stopped", scope: outcome.scope, code: outcome.code }
        if (outcome.kind === "refresh_token") return { kind: "stopped", scope: "profile", code: USAGE_TOKEN_REJECTED }
        return this.settleAttempt(grant, inflight, outcome, replayBudget)
    }

    private async settleAttempt(
        grant: UsageSenderGrant,
        inflight: UsageAttemptInflight,
        resolution: UsageInflightResolution,
        replayBudget: ReplayBudget,
    ): Promise<UsageCycleResult> {
        const { outbox } = this.options
        const committed = await outbox.transactAttempts(grant, async (state, now) => {
            const next = settleUsageAttemptInflight(state, inflight.requestId, resolution, now, replayBudget, this.options.random)
            const violations = attemptLossViolations(resolution, state.inflight !== undefined && next.inflight === undefined)
            if (violations) {
                await outbox.writeAttemptLoss({
                    kind: "delivery",
                    bucketIds: inflight.bucketIds,
                    violations,
                    recordedAt: now,
                })
            }
            return { state: next, result: undefined }
        })
        if (committed.status === "fenced") return { kind: "fenced" }
        const settled = await outbox.readAttempts()
        if (settled?.inflight?.requestId !== inflight.requestId) {
            await outbox.removeAttemptBodies(grant, settled?.inflight?.requestId)
        }
        const { requestId } = inflight
        switch (resolution.kind) {
            case "acknowledged":
                return { kind: "delivered", requestId, disposition: resolution.disposition }
            case "replay":
                return settled?.inflight?.requestId === requestId
                    ? { kind: "retrying", requestId }
                    : { kind: "discarded", requestId, code: "replay_budget_exhausted" }
            case "wait":
                return { kind: "paused", requestId, code: resolution.code, until: settled?.pacing.waitUntil ?? 0 }
            case "too_large":
                return { kind: "discarded", requestId, code: "payload_too_large" }
            case "discard":
                return { kind: "discarded", requestId, code: resolution.code }
            case "body_lost":
                return { kind: "discarded", requestId, code: "body_lost" }
        }
    }

    /** Give the schema 4 lease up at shutdown so another window can send at once. */
    async release(): Promise<void> {
        const grant = this.grant
        this.grant = undefined
        if (grant) await this.options.outbox.releaseAttempts(grant)
    }

    /** Send with the current schema 4 token; a 401 earns exactly one fresh token and one replay of the same bytes. */
    private async attempt(
        inflight: Pick<UsageAttemptInflight, "requestId">,
        body: Uint8Array,
        signal?: AbortSignal,
    ): Promise<Attempt> {
        let rejectedAccessToken: string | undefined
        for (let send = 0; send < 2; send++) {
            const acquired = await this.options.tokens.acquire("usage", { rejectedAccessToken, signal })
            if (acquired.status === "stopped") {
                return { kind: "result", result: { kind: "stopped", scope: acquired.scope, code: acquired.code } }
            }
            if (acquired.status === "deferred") {
                return { kind: "result", result: { kind: "waiting", reason: acquired.reason, retryAt: acquired.retryAt } }
            }
            if (acquired.status === "unavailable") {
                return { kind: "result", result: { kind: "waiting", reason: "token_unavailable" } }
            }
            const accessToken = acquired.token.accessToken
            let outcome: DeliveryOutcome
            try {
                const response = await this.options.transport.sendUsage(
                    { accessToken, requestId: inflight.requestId, body },
                    signal,
                )
                outcome = classifyUsageResponse(response, this.clock())
            } catch (error) {
                if (!(error instanceof DlineOtelTransportError)) throw error
                if (error.failure === "aborted") return { kind: "result", result: { kind: "aborted" } }
                outcome = { kind: "replay" }
            }
            if (outcome.kind !== "refresh_token") return { kind: "outcome", outcome }
            rejectedAccessToken = accessToken
        }
        return { kind: "outcome", outcome: { kind: "refresh_token" } }
    }
}

function attemptLossViolations(resolution: UsageInflightResolution, released: boolean): readonly string[] | undefined {
    if (!released) return undefined
    switch (resolution.kind) {
        case "too_large":
            return ["payload_too_large"]
        case "discard":
            return [resolution.code]
        case "body_lost":
            return ["body_lost"]
        case "replay":
            return ["replay_budget_exhausted"]
        case "acknowledged":
        case "wait":
            return undefined
    }
}
