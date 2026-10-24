import { randomUUID } from "node:crypto"
import type { UsageObservationSpool } from "@/core/storage/telemetry-remote/UsageObservationSpool"
import type { UsageOutboxRepository, UsageSenderGrant } from "@/core/storage/telemetry-remote/UsageOutboxRepository"
import type { DeviceTokenBroker } from "../auth/DeviceTokenBroker"
import { classifyDeliveryResponse, type DeliveryOutcome, type StopScope } from "../contracts/classification"
import type { UsageAttemptBodyValidation, UsageClientWire } from "../contracts/usageBody"
import type { DeliveryDisposition } from "../contracts/wire"
import { DlineOtelTransportError, type UsageTransport } from "../transport/DlineOtelHttpClient"
import {
    alignUsagePolicyEpoch,
    boundUsageAttemptBacklog,
    dueUsageAttemptReplay,
    dueUsageReplay,
    foldUsageAttemptShards,
    foldUsageShards,
    settleUsageAttemptInflight,
    settleUsageInflight,
    takeUsageAttemptBatch,
    takeUsageBatch,
    type UsageAttemptInflight,
    type UsageAttemptObservationRejection,
    type UsageInflight,
    type UsageInflightResolution,
    type UsageObservationRejection,
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
    /** How long after a minute ends observations from other shards may still arrive. */
    readonly batchSettleMs: number
    readonly clock?: () => number
    readonly newRequestId?: () => string
    /** Source of the 429 wait jitter. */
    readonly random?: () => number
    /** Static test seam; production reads the active atomic grant before every cycle. */
    readonly attemptValidation?: UsageAttemptBodyValidation
    readonly readAttemptValidation?: () => Promise<UsageAttemptBodyValidation | undefined>
}

type Prepared = (
    | { readonly kind: "send"; readonly inflight: UsageInflight }
    | { readonly kind: "idle" }
    | { readonly kind: "rejected"; readonly violations: readonly string[] }
) & {
    /** The inflight the committed outbox still names; its body must survive orphan cleanup. */
    readonly keepRequestId: string | undefined
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
    private grantMode: "legacy" | "attempts" | undefined
    private attemptsActive = false

    constructor(private readonly options: UsageDeliveryWorkerOptions) {
        this.clock = options.clock ?? Date.now
        this.newRequestId = options.newRequestId ?? randomUUID
    }

    /** Synchronous authority projection used to retire the schema 3 logical intake after clean-cut. */
    get attemptAuthorityActive(): boolean {
        return this.attemptsActive
    }

    /** Resolve persisted authority before coordinator intake opens after a restart. */
    async refreshAttemptAuthority(): Promise<boolean> {
        try {
            this.attemptsActive = (await this.options.outbox.readAttempts()) !== undefined
            return this.attemptsActive
        } catch (error) {
            // Unknown ownership must not reopen the retired schema 3 authority.
            this.attemptsActive = true
            throw error
        }
    }

    async runCycle(policyEpoch: number, signal?: AbortSignal): Promise<UsageCycleResult> {
        const { outbox, spool } = this.options
        const attemptValidation = (await this.options.readAttemptValidation?.()) ?? this.options.attemptValidation
        if (attemptValidation) await outbox.activateAttempts(policyEpoch)
        if (await this.refreshAttemptAuthority()) {
            await spool.purgeLegacy()
            return this.runAttemptFoldCycle(policyEpoch, attemptValidation, signal)
        }
        const grant = await outbox.claim(this.options.ownerId)
        this.grant = grant
        this.grantMode = grant ? "legacy" : undefined
        if (!grant) return { kind: "standby" }

        await spool.sealActive(this.clock())
        const { shards } = await spool.readSettled(this.clock())
        const rejected: UsageObservationRejection[] = []
        const folded = await outbox.transact(grant, async (state, now) => {
            const next = foldUsageShards(alignUsagePolicyEpoch(state, policyEpoch), shards, now, {
                client: this.options.client,
                currentPolicyEpoch: policyEpoch,
                onRejected: (rejection) => rejected.push(rejection),
            })
            await spool.quarantineRejected(rejected)
            return { state: next, result: undefined }
        })
        if (folded.status === "fenced") return { kind: "fenced" }
        if (shards.length > 0) await spool.discard(shards.map((shard) => shard.name))

        const prepared = await this.prepare(grant)
        if (prepared.status === "fenced") return { kind: "fenced" }
        const next = prepared.result
        await outbox.removeBodies(next.keepRequestId)
        if (next.kind === "idle") return { kind: "idle" }
        if (next.kind === "rejected") return { kind: "rejected", violations: next.violations }
        try {
            return await this.deliver(grant, next.inflight, signal)
        } catch (error) {
            // An abort during the token exchange surfaces as the exchange's own error; the inflight stays for later.
            if (signal?.aborted) return { kind: "aborted" }
            throw error
        }
    }

    /** Fold schema 4 shards under the same fenced machine lease; manifest delivery is the next stage. */
    private async runAttemptFoldCycle(
        policyGeneration: number,
        validation: UsageAttemptBodyValidation | undefined,
        signal?: AbortSignal,
    ): Promise<UsageCycleResult> {
        const { outbox, spool } = this.options
        const grant = await outbox.claimAttempts(this.options.ownerId)
        this.grant = grant
        this.grantMode = grant ? "attempts" : undefined
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
                eventWindowMs: validation?.contract.eventWindowMs,
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
        if (!validation) return { kind: "idle" }

        const prepared = await this.prepareAttempts(grant, validation)
        if (prepared.status === "fenced") return { kind: "fenced" }
        const next = prepared.result
        if (!(await outbox.removeAttemptBodies(grant, next.keepRequestId))) return { kind: "fenced" }
        if (next.kind === "idle") return { kind: "idle" }
        if (next.kind === "rejected") return { kind: "rejected", violations: next.violations }
        return this.deliverAttempt(grant, next.inflight, signal)
    }

    private prepareAttempts(grant: UsageSenderGrant, validation: UsageAttemptBodyValidation) {
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
                ...validation,
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
        signal?: AbortSignal,
    ): Promise<UsageCycleResult> {
        const body = await this.options.outbox.readBody(inflight)
        if (!body) return this.settleAttempt(grant, inflight, { kind: "body_lost" })
        const attempted = await this.attempt(inflight, body, 4, signal)
        if (attempted.kind === "result") return attempted.result
        const { outcome } = attempted
        if (outcome.kind === "stop") return { kind: "stopped", scope: outcome.scope, code: outcome.code }
        if (outcome.kind === "refresh_token") return { kind: "stopped", scope: "profile", code: USAGE_TOKEN_REJECTED }
        return this.settleAttempt(grant, inflight, outcome)
    }

    private async settleAttempt(
        grant: UsageSenderGrant,
        inflight: UsageAttemptInflight,
        resolution: UsageInflightResolution,
    ): Promise<UsageCycleResult> {
        const { outbox } = this.options
        const committed = await outbox.transactAttempts(grant, async (state, now) => {
            const next = settleUsageAttemptInflight(state, inflight.requestId, resolution, now, this.options.random)
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

    /** Give the lease up at shutdown so another window can send at once. */
    async release(): Promise<void> {
        const grant = this.grant
        const mode = this.grantMode
        this.grant = undefined
        this.grantMode = undefined
        if (!grant) return
        if (mode === "attempts") await this.options.outbox.releaseAttempts(grant)
        else await this.options.outbox.release(grant)
    }

    /** Pick the due replay, or publish a new batch: body first, then the manifest naming it. */
    private prepare(grant: UsageSenderGrant) {
        const { outbox } = this.options
        return outbox.transact<Prepared>(grant, async (state, now) => {
            if (state.inflight) {
                const keepRequestId = state.inflight.requestId
                const due = dueUsageReplay(state, now)
                return { state, result: due ? { kind: "send", inflight: due, keepRequestId } : { kind: "idle", keepRequestId } }
            }
            const decision = takeUsageBatch(state, {
                now,
                requestId: this.newRequestId(),
                client: this.options.client,
                settleMs: this.options.batchSettleMs,
            })
            if (decision.kind === "none") return { state, result: { kind: "idle", keepRequestId: undefined } }
            if (decision.kind === "rejected") {
                return {
                    state: decision.state,
                    result: { kind: "rejected", violations: decision.violations, keepRequestId: undefined },
                }
            }
            const { inflight } = decision
            await outbox.writeBody(inflight.requestId, decision.bytes)
            return { state: decision.state, result: { kind: "send", inflight, keepRequestId: inflight.requestId } }
        })
    }

    private async deliver(grant: UsageSenderGrant, inflight: UsageInflight, signal?: AbortSignal): Promise<UsageCycleResult> {
        const body = await this.options.outbox.readBody(inflight)
        if (!body) return this.settle(grant, inflight, { kind: "body_lost" })
        const attempt = await this.attempt(inflight, body, 3, signal)
        if (attempt.kind === "result") return attempt.result
        const { outcome } = attempt
        if (outcome.kind === "stop") return { kind: "stopped", scope: outcome.scope, code: outcome.code }
        if (outcome.kind === "refresh_token") return { kind: "stopped", scope: "profile", code: USAGE_TOKEN_REJECTED }
        return this.settle(grant, inflight, outcome)
    }

    /** Send with the current token; a 401 earns exactly one fresh token and one more send of the same bytes. */
    private async attempt(
        inflight: Pick<UsageInflight, "requestId">,
        body: Uint8Array,
        contractVersion: 3 | 4,
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
            if (acquired.status === "unavailable")
                return { kind: "result", result: { kind: "waiting", reason: "token_unavailable" } }
            const accessToken = acquired.token.accessToken
            let outcome: DeliveryOutcome
            try {
                const response = await this.options.transport.sendUsage(
                    { accessToken, requestId: inflight.requestId, body, contractVersion },
                    signal,
                )
                outcome = classifyDeliveryResponse(response)
            } catch (error) {
                if (!(error instanceof DlineOtelTransportError)) throw error
                if (error.failure === "aborted") return { kind: "result", result: { kind: "aborted" } }
                // Timeout or a broken connection: the server may hold the batch, so only the same bytes may follow.
                outcome = { kind: "replay" }
            }
            if (outcome.kind !== "refresh_token") return { kind: "outcome", outcome }
            rejectedAccessToken = accessToken
        }
        return { kind: "outcome", outcome: { kind: "refresh_token" } }
    }

    private async settle(
        grant: UsageSenderGrant,
        inflight: UsageInflight,
        resolution: UsageInflightResolution,
    ): Promise<UsageCycleResult> {
        const { outbox } = this.options
        const committed = await outbox.transact(grant, (state, now) => ({
            state: settleUsageInflight(state, inflight.requestId, resolution, now, this.options.random),
            result: undefined,
        }))
        if (committed.status === "fenced") return { kind: "fenced" }
        const settled = await outbox.read()
        if (settled?.inflight?.requestId !== inflight.requestId) await outbox.removeBodies(settled?.inflight?.requestId)
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
