import { randomUUID } from "node:crypto"
import { IssueCredentialRepository } from "@/core/storage/telemetry-remote/IssueCredentialRepository"
import { IssueDiagnosticOutboxRepository } from "@/core/storage/telemetry-remote/IssueDiagnosticOutboxRepository"
import { IssueGrantRepository } from "@/core/storage/telemetry-remote/IssueGrantRepository"
import type { OtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import type { JournalTelemetrySignal, TelemetrySpanHandle, TelemetrySpanStartOptions } from "../../providers/capabilities"
import type { AtomicIssueGrant } from "../contracts/issueGrant"
import type { IssueDiagnosticTransport } from "../transport/DlineOtelHttpClient"
import type { DiagnosticResource } from "./diagnosticRecord"
import { IssueDiagnosticDeliveryWorker } from "./IssueDiagnosticDeliveryWorker"
import { createIssueDiagnosticSpan, type IssueDiagnosticItem, toIssueDiagnosticItem } from "./issueDiagnosticRecord"

const MAX_BUFFERED_ITEMS = 1_000

export interface IssueDiagnosticsOverlayOptions {
    readonly layout: OtelStorageLayout
    readonly resource: DiagnosticResource
    readonly transport: IssueDiagnosticTransport
    readonly allowed: () => boolean
    readonly clock?: () => number
}

/**
 * Temporary issue-only overlay attached to the one remote diagnostics registration.
 *
 * Its memory buffer, durable outbox, request identities, bearer token and abort
 * controller are all separate from production diagnostics and Usage. A missing
 * or terminal authorization clears only this partition.
 */
export class IssueDiagnosticsOverlay {
    private readonly clock: () => number
    private readonly credentials: IssueCredentialRepository
    private readonly grants: IssueGrantRepository
    private readonly outbox: IssueDiagnosticOutboxRepository
    private readonly worker: IssueDiagnosticDeliveryWorker
    private activeGrant: AtomicIssueGrant | undefined
    private buffer: IssueDiagnosticItem[] = []
    private deliveryAbort = new AbortController()
    private delivering: Promise<void> | undefined
    private closed = false

    constructor(private readonly options: IssueDiagnosticsOverlayOptions) {
        this.clock = options.clock ?? Date.now
        this.credentials = new IssueCredentialRepository(options.layout, { clock: this.clock })
        this.grants = new IssueGrantRepository(options.layout, { clock: this.clock })
        this.outbox = new IssueDiagnosticOutboxRepository(options.layout, options.resource)
        this.worker = new IssueDiagnosticDeliveryWorker({
            outbox: this.outbox,
            activeGrant: () => this.activeGrant,
            transport: options.transport,
            owner: `${process.pid}-${randomUUID().slice(0, 8)}`,
            clock: this.clock,
            seal: (reason) => this.deactivate(reason),
        })
    }

    readonly append = (signal: JournalTelemetrySignal): void => {
        if (!this.activeGrant || !this.options.allowed()) return
        const item = toIssueDiagnosticItem(signal, this.clock())
        if (!item || !scopeAllows(this.activeGrant, item.stream)) return
        if (this.buffer.length >= MAX_BUFFERED_ITEMS) this.buffer.shift()
        this.buffer.push(item)
    }

    readonly startSpan = (options: TelemetrySpanStartOptions): TelemetrySpanHandle =>
        createIssueDiagnosticSpan(
            options,
            () => Boolean(this.activeGrant && scopeAllows(this.activeGrant, "traces") && this.options.allowed()),
            (item) => {
                if (this.buffer.length >= MAX_BUFFERED_ITEMS) this.buffer.shift()
                this.buffer.push(item)
            },
            this.clock,
        )

    async refresh(): Promise<boolean> {
        if (this.closed) return false
        const now = this.clock()
        if (!this.options.allowed()) {
            await this.deactivate("revoked")
            return false
        }
        const authorization = (await this.credentials.read()).record
        if (this.closed) return false
        if (
            !authorization ||
            authorization.state !== "approved" ||
            authorization.authorizationExpiresAt <= now ||
            (authorization.captureExpiresAt ?? authorization.authorizationExpiresAt) <= now
        ) {
            await this.deactivate(authorization?.state === "expired" ? "expired" : "revision_changed")
            return false
        }
        const grant = await this.grants.readActive(now, authorization.revision)
        if (this.closed) return false
        if (!grant || !hasOverlayScopes(grant)) {
            await this.deactivate(grant ? "revision_changed" : "expired")
            return false
        }
        if (!sameGeneration(this.activeGrant, grant)) {
            this.deliveryAbort.abort("issue_grant_changed")
            this.deliveryAbort = new AbortController()
            this.buffer = []
            await this.outbox.clear()
        }
        this.activeGrant = grant
        return true
    }

    async flush(): Promise<void> {
        if (!(await this.refresh()) || !this.activeGrant || this.buffer.length === 0) return
        const items = this.buffer
        this.buffer = []
        await this.outbox.append(this.activeGrant, items, this.clock())
    }

    async deliver(): Promise<void> {
        this.delivering ??= (async () => {
            await this.flush()
            if (this.activeGrant) await this.worker.deliverOnce(this.deliveryAbort.signal)
        })().finally(() => {
            this.delivering = undefined
        })
        return this.delivering
    }

    async deactivate(reason: "revoked" | "expired" | "revision_changed" | "deleted"): Promise<void> {
        this.deliveryAbort.abort(`issue_overlay_${reason}`)
        this.deliveryAbort = new AbortController()
        this.buffer = []
        this.activeGrant = undefined
        await this.outbox.clear()
        await this.grants.clear(reason)
    }

    async stop(): Promise<void> {
        await this.flush().catch(() => undefined)
        this.closed = true
        this.deliveryAbort.abort("issue_overlay_stopped")
        await this.delivering?.catch(() => undefined)
        this.buffer = []
        this.activeGrant = undefined
    }

    /** Tests and lifecycle owners inspect only whether an approved generation is active. */
    isActive(): boolean {
        return this.activeGrant !== undefined
    }
}

function hasOverlayScopes(grant: AtomicIssueGrant): boolean {
    return scopeAllows(grant, "logs") || scopeAllows(grant, "metrics") || scopeAllows(grant, "traces")
}

function scopeAllows(grant: AtomicIssueGrant, stream: "logs" | "metrics" | "traces"): boolean {
    const required = stream === "logs" ? "debug" : stream === "metrics" ? "high_density_metrics" : "high_density_traces"
    return grant.scopes.includes(required)
}

function sameGeneration(left: AtomicIssueGrant | undefined, right: AtomicIssueGrant): boolean {
    return Boolean(
        left &&
            left.authorizationId === right.authorizationId &&
            left.authorizationRevision === right.authorizationRevision &&
            left.accessToken === right.accessToken,
    )
}
