import { randomUUID } from "node:crypto"
import type { UsageObservationSpool } from "@/core/storage/telemetry-remote/UsageObservationSpool"
import type { UsageOutboxRepository, UsageSenderGrant } from "@/core/storage/telemetry-remote/UsageOutboxRepository"
import type { DeviceTokenBroker } from "../auth/DeviceTokenBroker"
import { classifyDeliveryResponse, type DeliveryOutcome, type StopScope } from "../contracts/classification"
import type { UsageClientWire } from "../contracts/usageBody"
import type { DeliveryDisposition } from "../contracts/wire"
import { DlineOtelTransportError, type UsageTransport } from "../transport/DlineOtelHttpClient"
import {
    alignUsagePolicyEpoch,
    dueUsageReplay,
    foldUsageShards,
    settleUsageInflight,
    takeUsageBatch,
    type UsageInflight,
    type UsageInflightResolution,
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
}

type Prepared = (
    | { readonly kind: "send"; readonly inflight: UsageInflight }
    | { readonly kind: "idle" }
    | { readonly kind: "rejected"; readonly violations: readonly string[] }
) & {
    /** The inflight the committed outbox still names; its body must survive orphan cleanup. */
    readonly keepRequestId: string | undefined
}

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
        const { outbox, spool } = this.options
        const grant = await outbox.claim(this.options.ownerId)
        this.grant = grant
        if (!grant) return { kind: "standby" }

        await spool.sealActive(this.clock())
        const { shards } = await spool.readSettled(this.clock())
        const folded = await outbox.transact(grant, (state, now) => ({
            state: foldUsageShards(alignUsagePolicyEpoch(state, policyEpoch), shards, now),
            result: undefined,
        }))
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

    /** Give the lease up at shutdown so another window can send at once. */
    async release(): Promise<void> {
        const grant = this.grant
        this.grant = undefined
        if (grant) await this.options.outbox.release(grant)
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
        const attempt = await this.attempt(inflight, body, signal)
        if (attempt.kind === "result") return attempt.result
        const { outcome } = attempt
        if (outcome.kind === "stop") return { kind: "stopped", scope: outcome.scope, code: outcome.code }
        if (outcome.kind === "refresh_token") return { kind: "stopped", scope: "profile", code: USAGE_TOKEN_REJECTED }
        return this.settle(grant, inflight, outcome)
    }

    /** Send with the current token; a 401 earns exactly one fresh token and one more send of the same bytes. */
    private async attempt(inflight: UsageInflight, body: Uint8Array, signal?: AbortSignal): Promise<Attempt> {
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
                    { accessToken, requestId: inflight.requestId, body },
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
