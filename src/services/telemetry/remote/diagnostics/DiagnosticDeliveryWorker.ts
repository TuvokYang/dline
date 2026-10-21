import type { DiagnosticOutboxRepository, DiagnosticSettlement } from "@/core/storage/telemetry-remote/DiagnosticOutboxRepository"
import type { TokenAcquisition } from "../auth/DeviceTokenBroker"
import { classifyDeliveryResponse, type DeliveryOutcome } from "../contracts/classification"
import { type DiagnosticLogsTransport, DlineOtelTransportError } from "../transport/DlineOtelHttpClient"

/** Wait before trying again when no token is available yet or the send was aborted. */
export const DIAGNOSTICS_RETRY_MS = 60_000

export interface DiagnosticTokenSource {
    acquire(profile: "production", options?: { rejectedAccessToken?: string; signal?: AbortSignal }): Promise<TokenAcquisition>
}

export interface DiagnosticDeliveryWorkerOptions {
    readonly outbox: Pick<DiagnosticOutboxRepository, "claim" | "settle">
    readonly tokens: DiagnosticTokenSource
    readonly transport: DiagnosticLogsTransport
    /** This window's identity in the shared outbox claim. */
    readonly owner: string
    readonly clock?: () => number
    readonly log?: (message: string) => void
}

/**
 * Sends one claimed batch of the shared diagnostic outbox to `/logs`.
 *
 * A batch that may have reached the service is resent with the same request id
 * and bytes, so a copy is answered as a duplicate. A 429 or a pause holds the whole
 * channel and keeps the batch unchanged for the first send after it; a 413 splits the batch. A
 * rejected token is exchanged once and the batch resent; a refusal of the
 * stream records a stop in the outbox that every window respects.
 */
export class DiagnosticDeliveryWorker {
    private readonly clock: () => number

    constructor(private readonly options: DiagnosticDeliveryWorkerOptions) {
        this.clock = options.clock ?? Date.now
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
                const response = await this.options.transport.sendLogs(
                    { accessToken: acquisition.token.accessToken, requestId, body: new TextEncoder().encode(body) },
                    signal,
                )
                outcome = classifyDeliveryResponse(response)
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
                this.options.log?.(`[RemoteDiagnostics] The service asked to wait (${outcome.code}); diagnostics are held`)
                return { kind: "wait", retryAfterMs: outcome.retryAfterMs }
            case "too_large":
                return { kind: "split" }
            case "discard":
                this.options.log?.(`[RemoteDiagnostics] The service refused a batch for good: ${outcome.code}`)
                return { kind: "discard" }
            case "stop":
                this.options.log?.(`[RemoteDiagnostics] The service stopped diagnostics: ${outcome.code}`)
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
