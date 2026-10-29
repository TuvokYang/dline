import type {
    IssueDiagnosticOutboxRepository,
    IssueDiagnosticSettlement,
} from "@/core/storage/telemetry-remote/IssueDiagnosticOutboxRepository"
import type { WireResponse } from "../contracts/classification"
import type { AtomicIssueGrant } from "../contracts/issueGrant"
import type { IssueDiagnosticTransport } from "../transport/DlineOtelHttpClient"
import { DlineOtelTransportError } from "../transport/DlineOtelHttpClient"

export interface IssueDiagnosticDeliveryWorkerOptions {
    readonly outbox: Pick<IssueDiagnosticOutboxRepository, "claim" | "settle" | "clear">
    readonly activeGrant: () => AtomicIssueGrant | undefined
    readonly transport: IssueDiagnosticTransport
    readonly owner: string
    readonly clock?: () => number
    readonly seal: (reason: "revoked" | "expired") => Promise<void>
}

/** Sends only the physically separate issue partition and seals it on token/authorization refusal. */
export class IssueDiagnosticDeliveryWorker {
    private readonly clock: () => number

    constructor(private readonly options: IssueDiagnosticDeliveryWorkerOptions) {
        this.clock = options.clock ?? Date.now
    }

    async deliverOnce(signal?: AbortSignal): Promise<void> {
        const grant = this.options.activeGrant()
        if (!grant) {
            await this.options.outbox.clear()
            return
        }
        const batch = await this.options.outbox.claim(this.options.owner, grant, this.clock())
        if (!batch) return
        let settlement: IssueDiagnosticSettlement
        try {
            const response = await this.options.transport.sendIssueDiagnostics(
                {
                    stream: batch.stream,
                    accessToken: grant.accessToken,
                    requestId: batch.requestId,
                    body: new TextEncoder().encode(batch.body),
                },
                signal,
            )
            settlement = classify(response)
        } catch (error) {
            settlement =
                error instanceof DlineOtelTransportError && error.failure === "aborted"
                    ? { kind: "replay", retryAfterMs: 1_000 }
                    : { kind: "replay" }
        }
        await this.options.outbox.settle(this.options.owner, batch.requestId, settlement, this.clock())
        if (settlement.kind === "sealed") await this.options.seal("revoked")
    }
}

function classify(response: WireResponse): IssueDiagnosticSettlement {
    if (response.status >= 200 && response.status < 300) {
        if (isRecord(response.json) && response.json.ok === true) {
            const disposition = response.json.disposition
            if (disposition === undefined || disposition === "accepted" || disposition === "duplicate") {
                return { kind: "acknowledged" }
            }
        }
        return { kind: "discard" }
    }
    if (response.status === 401 || response.status === 403) return { kind: "sealed" }
    if (response.status === 413) return { kind: "split" }
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
        return { kind: "replay", ...(retryAfterMs(response) === undefined ? {} : { retryAfterMs: retryAfterMs(response) }) }
    }
    return { kind: "discard" }
}

function retryAfterMs(response: WireResponse): number | undefined {
    if (isRecord(response.json) && typeof response.json.retry_after_ms === "number" && response.json.retry_after_ms >= 0) {
        return Math.trunc(response.json.retry_after_ms)
    }
    if (!response.retryAfter) return undefined
    const seconds = Number(response.retryAfter)
    return Number.isFinite(seconds) && seconds >= 0 ? Math.trunc(seconds * 1_000) : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
