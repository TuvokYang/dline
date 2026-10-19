import type { DiagnosticOutboxRepository, DiagnosticSettlement } from "@/core/storage/telemetry-remote/DiagnosticOutboxRepository"
import type { TokenAcquisition } from "../auth/DeviceTokenBroker"
import { classifyDiagnosticResponse, type WireResponse } from "../contracts/classification"
import type { DiagnosticLogsTransport } from "../transport/DlineOtelHttpClient"
import { type DiagnosticRecord, type DiagnosticResource, encodeDiagnosticLogs } from "./diagnosticRecord"

/** Wait after a result the service did not confirm, unless it named a delay. */
export const DIAGNOSTICS_RETRY_MS = 60_000

export interface DiagnosticTokenSource {
    acquire(profile: "production", options?: { rejectedAccessToken?: string; signal?: AbortSignal }): Promise<TokenAcquisition>
}

export interface DiagnosticDeliveryWorkerOptions {
    readonly outbox: Pick<DiagnosticOutboxRepository, "claim" | "settle">
    readonly tokens: DiagnosticTokenSource
    readonly transport: DiagnosticLogsTransport
    readonly resource: DiagnosticResource
    /** This window's identity in the shared outbox claim. */
    readonly owner: string
    readonly clock?: () => number
    readonly log?: (message: string) => void
}

/**
 * Sends one claimed batch of the shared diagnostic outbox to `/v1/logs`.
 *
 * A batch that may have reached the service is resent with the same request id
 * and bytes, so the service drops the copy. A rejected token is exchanged once
 * and the batch resent; a refusal of the stream records a stop in the outbox
 * that every window respects.
 */
export class DiagnosticDeliveryWorker {
    private readonly clock: () => number

    constructor(private readonly options: DiagnosticDeliveryWorkerOptions) {
        this.clock = options.clock ?? Date.now
    }

    async deliverOnce(signal?: AbortSignal): Promise<void> {
        const { outbox, owner } = this.options
        const encode = (records: readonly DiagnosticRecord[]) => encodeDiagnosticLogs(records, this.options.resource)
        const batch = await outbox.claim(owner, this.clock(), encode)
        if (!batch) return
        const settlement = await this.send(batch.requestId, batch.body, signal)
        await outbox.settle(owner, batch.requestId, settlement, this.clock())
    }

    private async send(requestId: string, body: string, signal: AbortSignal | undefined): Promise<DiagnosticSettlement> {
        let acquisition = await this.options.tokens.acquire("production", { signal })
        for (let attempt = 0; attempt < 2; attempt++) {
            if (acquisition.status !== "ready") return this.withoutToken(acquisition)
            let response: WireResponse
            try {
                response = await this.options.transport.sendLogs(
                    { accessToken: acquisition.token.accessToken, requestId, body: new TextEncoder().encode(body) },
                    signal,
                )
            } catch {
                return this.retryAfter(undefined)
            }
            const outcome = classifyDiagnosticResponse(response)
            switch (outcome.kind) {
                case "acknowledged":
                    return { kind: "delivered" }
                case "discard":
                    this.options.log?.(`[RemoteDiagnostics] The service refused a batch for good: ${outcome.code}`)
                    return { kind: "delivered" }
                case "replay":
                    return this.retryAfter(outcome.retryAfterMs)
                case "stop":
                    this.options.log?.(`[RemoteDiagnostics] The service stopped diagnostics: ${outcome.code}`)
                    return { kind: "stopped", code: outcome.code }
                case "refresh_token":
                    acquisition = await this.options.tokens.acquire("production", {
                        rejectedAccessToken: acquisition.token.accessToken,
                        signal,
                    })
                    break
            }
        }
        return { kind: "stopped", code: "token_rejected" }
    }

    private withoutToken(acquisition: Exclude<TokenAcquisition, { status: "ready" }>): DiagnosticSettlement {
        switch (acquisition.status) {
            case "deferred":
                return { kind: "retry", at: acquisition.retryAt }
            case "stopped":
                return { kind: "stopped", code: acquisition.code }
            default:
                return this.retryAfter(undefined)
        }
    }

    private retryAfter(delayMs: number | undefined): DiagnosticSettlement {
        return { kind: "retry", at: this.clock() + (delayMs ?? DIAGNOSTICS_RETRY_MS) }
    }
}
