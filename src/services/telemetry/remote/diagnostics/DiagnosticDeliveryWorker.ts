import type { ClaimedDiagnostics, DiagnosticSettlement } from "@/core/storage/telemetry-remote/DiagnosticOutboxRepository"
import type { TokenAcquisition } from "../auth/DeviceTokenBroker"
import type { DeliveryOutcome, WireResponse } from "../contracts/classification"
import { classifyOtlpResponse } from "../contracts/otlpProduction"
import { type DiagnosticDelivery, DlineOtelTransportError } from "../transport/DlineOtelHttpClient"

/** Wait before trying again when no token is available yet or the send was aborted. */
export const DIAGNOSTICS_RETRY_MS = 60_000

export interface DiagnosticTokenSource {
    acquire(profile: "production", options?: { rejectedAccessToken?: string; signal?: AbortSignal }): Promise<TokenAcquisition>
}

/** A machine-wide outbox of one production OTLP signal: frozen batches claimed by one window at a time. */
export interface ProductionOtlpOutbox {
    claim(owner: string, now: number): Promise<ClaimedDiagnostics | undefined>
    settle(owner: string, requestId: string, settlement: DiagnosticSettlement, now: number): Promise<void>
}

export interface DiagnosticDeliveryWorkerOptions {
    readonly outbox: ProductionOtlpOutbox
    readonly tokens: DiagnosticTokenSource
    /** Sends the batch to the signal's route: `/v1/logs`, `/v1/metrics` or `/v1/traces`. */
    readonly send: (delivery: DiagnosticDelivery, signal?: AbortSignal) => Promise<WireResponse>
    /** This window's identity in the shared outbox claim. */
    readonly owner: string
    /** Names the channel in log lines; nothing else depends on it. */
    readonly label?: string
    readonly clock?: () => number
    readonly log?: (message: string) => void
}

/**
 * Sends one claimed batch of a shared production OTLP outbox (TADR §2.4): the
 * error and runtime Logs, or the Metrics or Traces of this device.
 *
 * A batch that may have reached the service is resent with the same request id
 * and bytes, so a copy is answered as a duplicate. A 429 or a pause holds the whole
 * channel and keeps the batch unchanged for the first send after it; a 413 splits the batch. A
 * rejected token is exchanged once and the batch resent; a refusal of the
 * stream records a stop in the outbox that every window respects.
 */
export class DiagnosticDeliveryWorker {
    private readonly clock: () => number
    private readonly label: string

    constructor(private readonly options: DiagnosticDeliveryWorkerOptions) {
        this.clock = options.clock ?? Date.now
        this.label = options.label ?? "diagnostics"
    }

    async deliverOnce(signal?: AbortSignal): Promise<void> {
        const { outbox, owner } = this.options
        const batch = await outbox.claim(owner, this.clock())
        if (!batch) return
        const settlement = await this.send(batch.requestId, batch.body, signal)
        await outbox.settle(owner, batch.requestId, settlement, this.clock())
    }

    private async send(requestId: string, body: string, signal: AbortSignal | undefined): Promise<DiagnosticSettlement> {
        let acquisition = await this.options.tokens.acquire("production", { signal })
        for (let attempt = 0; attempt < 2; attempt++) {
            if (acquisition.status !== "ready") return this.withoutToken(acquisition)
            let outcome: DeliveryOutcome
            try {
                const response = await this.options.send(
                    { accessToken: acquisition.token.accessToken, requestId, body: new TextEncoder().encode(body) },
                    signal,
                )
                outcome = classifyOtlpResponse(response, this.clock())
            } catch (error) {
                // Shutdown is not a failed attempt; a timeout or a broken connection may have reached the service.
                if (error instanceof DlineOtelTransportError && error.failure === "aborted") return this.retryLater()
                outcome = { kind: "replay" }
            }
            if (outcome.kind !== "refresh_token") return this.settlementOf(outcome)
            acquisition = await this.options.tokens.acquire("production", {
                rejectedAccessToken: acquisition.token.accessToken,
                signal,
            })
        }
        return { kind: "stopped", code: "token_rejected" }
    }

    private settlementOf(outcome: Exclude<DeliveryOutcome, { kind: "refresh_token" }>): DiagnosticSettlement {
        switch (outcome.kind) {
            case "acknowledged":
                return { kind: "acknowledged", nextEligibleAt: outcome.nextEligibleAt }
            case "replay":
                return { kind: "replay", retryAfterMs: outcome.retryAfterMs }
            case "wait":
                this.options.log?.(`[RemoteDiagnostics] The service asked to wait (${outcome.code}); ${this.label} are held`)
                return { kind: "wait", retryAfterMs: outcome.retryAfterMs }
            case "too_large":
                return { kind: "split" }
            case "discard":
                this.options.log?.(`[RemoteDiagnostics] The service refused a ${this.label} batch for good: ${outcome.code}`)
                return { kind: "discard" }
            case "stop":
                this.options.log?.(`[RemoteDiagnostics] The service stopped ${this.label}: ${outcome.code}`)
                return { kind: "stopped", code: outcome.code }
        }
    }

    private withoutToken(acquisition: Exclude<TokenAcquisition, { status: "ready" }>): DiagnosticSettlement {
        switch (acquisition.status) {
            case "deferred":
                return { kind: "retry", at: acquisition.retryAt }
            case "stopped":
                return { kind: "stopped", code: acquisition.code }
            default:
                return this.retryLater()
        }
    }

    private retryLater(): DiagnosticSettlement {
        return { kind: "retry", at: this.clock() + DIAGNOSTICS_RETRY_MS }
    }
}
