import { randomUUID } from "node:crypto"
import { openReportBugIssue } from "@core/reporting/ReportBugIssue"
import { fetch } from "@shared/net"
import { parseReportBugDraft, type ReportBugDraft } from "@shared/report-bug"
import { DeviceCredentialRepository } from "@/core/storage/telemetry-remote/DeviceCredentialRepository"
import {
    type IssueCredentialRecord,
    IssueCredentialRepository,
    type SupportAuthorizationState,
} from "@/core/storage/telemetry-remote/IssueCredentialRepository"
import { IssueGrantRepository } from "@/core/storage/telemetry-remote/IssueGrantRepository"
import { resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import {
    type SupportOperationIntent,
    SupportOperationRepository,
} from "@/core/storage/telemetry-remote/SupportOperationRepository"
import { DeviceTokenBroker } from "@/services/telemetry/remote/auth/DeviceTokenBroker"
import { createRecoverableIssueExchangeRuntime } from "@/services/telemetry/remote/auth/exchangeRuntime"
import {
    purgeIssueDiagnosticsOverlay,
    refreshIssueDiagnosticsOverlay,
} from "@/services/telemetry/remote/remoteDiagnosticsRuntime"
import { DlineOtelHttpClient, loopbackEndpointOverride } from "@/services/telemetry/remote/transport/DlineOtelHttpClient"
import { openExternal } from "@/utils/env"

const DEFAULT_SUPPORT_ENDPOINT = "https://dev.dline.cc"
const REQUEST_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 16 * 1024
const REQUESTED_CAPTURE_MS = 8 * 60 * 60_000
const MAX_AUTOMATIC_POLLS = 3

export interface SupportTelemetryServiceOptions {
    readonly dataDir: string
    readonly clientVersion: string
    readonly platform: string
    readonly supportEndpoint?: string
    readonly otelEndpoint?: string
    readonly clock?: () => number
}

export interface SupportStatusProjection {
    readonly publicCode: string
    readonly state: SupportAuthorizationState
    readonly authorizationExpiresAt: number
    readonly captureExpiresAt?: number
    readonly issue?: { readonly owner: string; readonly repo: string; readonly number: number }
}

/** Client-only control-plane owner. Private credentials never leave this service/repository boundary. */
export class SupportTelemetryService {
    private readonly clock: () => number
    private readonly credentials: IssueCredentialRepository
    private readonly grants: IssueGrantRepository
    private readonly devices: DeviceCredentialRepository
    private readonly operations: SupportOperationRepository
    private readonly deviceTokens: DeviceTokenBroker
    private readonly exchange: ReturnType<typeof createRecoverableIssueExchangeRuntime>["coordinator"]
    private readonly control: SupportControlClient
    private polling: AbortController | undefined
    private operationTail: Promise<void> = Promise.resolve()

    constructor(private readonly options: SupportTelemetryServiceOptions) {
        this.clock = options.clock ?? Date.now
        const layout = resolveOtelStorageLayout(options.dataDir)
        this.credentials = new IssueCredentialRepository(layout)
        this.grants = new IssueGrantRepository(layout)
        this.devices = new DeviceCredentialRepository(layout)
        this.operations = new SupportOperationRepository(layout, { clock: this.clock })
        const otel = new DlineOtelHttpClient({ clientVersion: options.clientVersion, endpoint: options.otelEndpoint })
        this.deviceTokens = new DeviceTokenBroker({
            repository: this.devices,
            transport: otel,
            clientVersion: options.clientVersion,
            platform: options.platform,
        })
        this.exchange = createRecoverableIssueExchangeRuntime({
            dataDir: options.dataDir,
            clientVersion: options.clientVersion,
            platform: options.platform,
            endpoint: options.otelEndpoint,
        }).coordinator
        this.control = new SupportControlClient(options.supportEndpoint ?? DEFAULT_SUPPORT_ENDPOINT, options.clientVersion)
    }

    async createAuthorizationAndOpenIssue(draft: ReportBugDraft): Promise<SupportStatusProjection> {
        if (!draft.temporaryTelemetryConsent) {
            await openReportBugIssue(draft.content, draft.environment)
            throw new Error("SupportAuthorizationNotRequested")
        }
        return this.runOperation(async () => {
            const pending = await this.operations.read()
            if (pending?.kind === "create") return this.completeCreate(pending)
            if (pending) await this.resumePendingOperationInternal()

            const intent = await this.operations.prepare({
                kind: "create",
                requestId: randomUUID(),
                pathname: "/support/authorizations",
                body: {
                    report_draft_id: randomUUID(),
                    client_version: this.options.clientVersion,
                    platform: this.options.platform,
                    requested_capture_ms: REQUESTED_CAPTURE_MS,
                    requested_signals: ["logs", "metrics", "traces"],
                    consent: { temporary_telemetry: true, confirmed_at: this.clock() },
                },
                context: { draft },
            })
            return this.completeCreate(intent)
        })
    }

    async status(): Promise<SupportStatusProjection | undefined> {
        return this.runOperation(async () => {
            await this.resumePendingOperationInternal(true)
            const record = (await this.credentials.read()).record
            return record ? project(record) : undefined
        })
    }

    async checkNow(signal?: AbortSignal): Promise<SupportStatusProjection | undefined> {
        return this.runOperation(async () => {
            const pending = await this.operations.read()
            if (pending?.kind === "status") return this.completeStatus(pending, signal)
            if (pending) await this.resumePendingOperationInternal(false, signal)

            const current = (await this.credentials.read()).record
            if (!current) return undefined
            const intent = await this.operations.prepare({
                kind: "status",
                requestId: randomUUID(),
                pathname: "/support/authorizations/status",
                body: { authorization_id: current.authorizationId, resume_credential: current.resumeCredential },
            })
            return this.completeStatus(intent, signal)
        })
    }

    async openIssue(): Promise<void> {
        const issue = (await this.credentials.read()).record?.issue
        if (!issue) return
        await openExternal(`https://github.com/${issue.owner}/${issue.repo}/issues/${issue.number}`)
    }

    async deleteAndRevoke(): Promise<void> {
        return this.runOperation(async () => {
            this.polling?.abort("support_deleted")
            this.polling = undefined
            await purgeIssueDiagnosticsOverlay("deleted")
            await this.grants.clear("deleted")

            const pending = await this.operations.read()
            if (pending?.kind === "status") await this.operations.complete(pending.requestId)
            const tombstone = await this.credentials.writeRevokeTombstone()
            if (!tombstone) return
            await this.prepareAndCompleteRevoke(tombstone, true)
        })
    }

    /** Resume an exact pending control-plane operation without exposing its private request body. */
    async resumePendingRevoke(): Promise<void> {
        await this.runOperation(async () => this.resumePendingOperationInternal(true))
    }

    private async resumePendingOperationInternal(suppressNetworkErrors = false, signal?: AbortSignal): Promise<void> {
        await this.credentials.pruneNaturalExpiry(this.clock())
        const pending = await this.operations.read()
        try {
            if (pending?.kind === "create") {
                await this.completeCreate(pending, signal)
                return
            }
            if (pending?.kind === "status") {
                await this.completeStatus(pending, signal)
                return
            }
            if (pending?.kind === "revoke") {
                const tombstone = (await this.credentials.read()).revokeTombstone
                if (!tombstone) {
                    await this.operations.complete(pending.requestId)
                    return
                }
                await this.completeRevoke(pending, signal)
                return
            }

            const tombstone = (await this.credentials.read()).revokeTombstone
            if (tombstone) await this.prepareAndCompleteRevoke(tombstone, suppressNetworkErrors, signal)
        } catch (error) {
            if (!suppressNetworkErrors) throw error
        }
    }

    private async completeCreate(intent: SupportOperationIntent, signal?: AbortSignal): Promise<SupportStatusProjection> {
        const draft = parseReportBugDraft(isRecord(intent.context) ? intent.context.draft : undefined)
        if (!draft?.temporaryTelemetryConsent) throw new Error("Invalid pending support authorization draft")
        const response = await this.sendPreparedOperation(intent, signal)
        const record = parseAuthorization(response, intent.requestId)
        await this.credentials.publish(record)
        await openReportBugIssue(
            {
                ...draft.content,
                additionalContext: [
                    draft.content.additionalContext.trim(),
                    "Temporary telemetry consent: [x] I consent to temporary high-density telemetry",
                    `Public support code: ${record.publicCode}`,
                ]
                    .filter(Boolean)
                    .join("\n\n"),
            },
            draft.environment,
        )
        await this.operations.complete(intent.requestId)
        this.startBoundedPolling(record.pollAfterMs)
        return project(record)
    }

    private async completeStatus(
        intent: SupportOperationIntent,
        signal?: AbortSignal,
    ): Promise<SupportStatusProjection | undefined> {
        const current = (await this.credentials.read()).record
        if (!current) {
            await this.operations.complete(intent.requestId)
            return undefined
        }
        const response = await this.sendPreparedOperation(intent, signal)
        const updated = parseStatus(response, intent.requestId, current)
        await this.credentials.publish(updated)
        if (updated.state === "approved" && updated.exchangeTicket && updated.exchangeTicketExpiresAt! > this.clock()) {
            await this.exchangeApproved(updated, signal)
        } else if (["revoked", "expired", "deleted"].includes(updated.state)) {
            await purgeIssueDiagnosticsOverlay(updated.state === "expired" ? "expired" : "revoked")
        }
        await this.operations.complete(intent.requestId)
        return project(updated)
    }

    private async prepareAndCompleteRevoke(
        tombstone: { readonly authorizationId: string; readonly resumeCredential: string; readonly expectedRevision: number },
        suppressNetworkErrors: boolean,
        signal?: AbortSignal,
    ): Promise<void> {
        const intent = await this.operations.prepare({
            kind: "revoke",
            requestId: randomUUID(),
            pathname: "/support/authorizations/revoke",
            body: {
                authorization_id: tombstone.authorizationId,
                resume_credential: tombstone.resumeCredential,
                expected_revision: tombstone.expectedRevision,
            },
        })
        try {
            await this.completeRevoke(intent, signal)
        } catch (error) {
            if (!suppressNetworkErrors) throw error
        }
    }

    private async completeRevoke(intent: SupportOperationIntent, signal?: AbortSignal): Promise<void> {
        const response = await this.sendPreparedOperation(intent, signal)
        if (response.status !== 200 || !isRecord(response.json) || response.json.request_id !== intent.requestId) {
            throw new Error("Invalid support revoke response")
        }
        await this.credentials.clearAfterConfirmedRevoke()
        await this.operations.complete(intent.requestId)
    }

    private async sendPreparedOperation(intent: SupportOperationIntent, signal?: AbortSignal): Promise<SupportWireResponse> {
        if (intent.response) return intent.response
        const response = await this.control.post(intent.pathname, intent.requestId, intent.body, signal)
        const stored = await this.operations.storeResponse(intent.requestId, response)
        if (!stored.response) throw new Error("Support operation response was not persisted")
        return stored.response
    }

    private runOperation<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.operationTail.then(operation, operation)
        this.operationTail = result.then(
            () => undefined,
            () => undefined,
        )
        return result
    }

    private async exchangeApproved(record: IssueCredentialRecord, signal?: AbortSignal): Promise<void> {
        const token = await this.deviceTokens.acquire("production", { signal })
        if (token.status !== "ready" || !record.exchangeTicket || !record.issue) return
        await this.exchange.exchange(
            {
                deviceId: token.token.deviceId,
                deviceAccessToken: token.token.accessToken,
                issue: record.issue,
                pairingSecret: record.exchangeTicket,
                authorizationRevision: record.revision,
            },
            signal,
        )
        await refreshIssueDiagnosticsOverlay()
    }

    private startBoundedPolling(delayMs: number): void {
        this.polling?.abort("support_poll_replaced")
        const controller = new AbortController()
        this.polling = controller
        void (async () => {
            let delay = Math.max(1_000, delayMs)
            for (let attempt = 0; attempt < MAX_AUTOMATIC_POLLS && !controller.signal.aborted; attempt += 1) {
                await wait(delay, controller.signal)
                if (controller.signal.aborted) return
                const state = await this.checkNow(controller.signal)
                if (!state || ["approved", "revoked", "expired", "deleted"].includes(state.state)) return
                const current = (await this.credentials.read()).record
                delay = Math.max(1_000, current?.pollAfterMs ?? delay)
            }
        })().catch(() => undefined)
    }
}

let configured: SupportTelemetryService | undefined

export function configureSupportTelemetryService(options: SupportTelemetryServiceOptions): SupportTelemetryService {
    configured ??= new SupportTelemetryService(options)
    void configured.resumePendingRevoke().catch(() => undefined)
    return configured
}

export function getSupportTelemetryService(): SupportTelemetryService | undefined {
    return configured
}

class SupportControlClient {
    private readonly endpoint: URL
    private readonly userAgent: string

    constructor(endpoint: string, clientVersion: string) {
        this.endpoint = parseSupportEndpoint(endpoint)
        this.userAgent = `Dline/${clientVersion}`
    }

    async post(pathname: string, requestId: string, body: object, signal?: AbortSignal): Promise<SupportWireResponse> {
        const deadline = new AbortController()
        const timer = setTimeout(() => deadline.abort(), REQUEST_TIMEOUT_MS)
        const forwardAbort = () => deadline.abort(signal?.reason)
        signal?.addEventListener("abort", forwardAbort, { once: true })
        try {
            const response = await fetch(new URL(pathname, this.endpoint), {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "User-Agent": this.userAgent,
                    "x-dline-request-id": requestId,
                },
                body: JSON.stringify(body),
                redirect: "error",
                signal: deadline.signal,
            })
            return { status: response.status, json: parseJson(await readBounded(response)) }
        } finally {
            clearTimeout(timer)
            signal?.removeEventListener("abort", forwardAbort)
        }
    }
}

interface SupportWireResponse {
    readonly status: number
    readonly json?: unknown
}

function parseAuthorization(response: SupportWireResponse, requestId: string): IssueCredentialRecord {
    if (response.status !== 201 || !isRecord(response.json) || response.json.request_id !== requestId) {
        throw new Error("Support authorization creation failed")
    }
    return parseRecord(response.json)
}

function parseStatus(response: SupportWireResponse, requestId: string, current: IssueCredentialRecord): IssueCredentialRecord {
    if (response.status !== 200 || !isRecord(response.json) || response.json.request_id !== requestId) {
        throw new Error("Support authorization status check failed")
    }
    return parseRecord({ ...currentToWire(current), ...response.json, resume_credential: current.resumeCredential })
}

function parseRecord(value: Record<string, unknown>): IssueCredentialRecord {
    const issue = isRecord(value.issue)
        ? { owner: String(value.issue.owner), repo: String(value.issue.repo), number: Number(value.issue.number) }
        : undefined
    const record: IssueCredentialRecord = {
        authorizationId: String(value.authorization_id ?? ""),
        publicCode: String(value.public_code ?? ""),
        resumeCredential: String(value.resume_credential ?? ""),
        state: String(value.state ?? "") as SupportAuthorizationState,
        revision: Number(value.revision),
        authorizationExpiresAt: Number(value.authorization_expires_at),
        pollAfterMs: Number(value.poll_after_ms ?? 0),
        ...(issue ? { issue } : {}),
        ...(value.capture_expires_at === undefined ? {} : { captureExpiresAt: Number(value.capture_expires_at) }),
        ...(value.exchange_ticket === undefined ? {} : { exchangeTicket: String(value.exchange_ticket) }),
        ...(value.exchange_ticket_expires_at === undefined
            ? {}
            : { exchangeTicketExpiresAt: Number(value.exchange_ticket_expires_at) }),
    }
    if (!record.authorizationId || !record.publicCode || !record.resumeCredential) {
        throw new Error("Support authorization response is malformed")
    }
    return record
}

function currentToWire(record: IssueCredentialRecord): Record<string, unknown> {
    return {
        authorization_id: record.authorizationId,
        public_code: record.publicCode,
        state: record.state,
        revision: record.revision,
        authorization_expires_at: record.authorizationExpiresAt,
        poll_after_ms: record.pollAfterMs,
    }
}

function project(record: IssueCredentialRecord): SupportStatusProjection {
    return {
        publicCode: record.publicCode,
        state: record.state,
        authorizationExpiresAt: record.authorizationExpiresAt,
        ...(record.captureExpiresAt === undefined ? {} : { captureExpiresAt: record.captureExpiresAt }),
        ...(record.issue ? { issue: { ...record.issue } } : {}),
    }
}

async function readBounded(response: Response): Promise<string | undefined> {
    const reader = response.body?.getReader()
    if (!reader) return undefined
    const chunks: Uint8Array[] = []
    let total = 0
    try {
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            total += value.byteLength
            if (total > MAX_RESPONSE_BYTES) {
                await reader.cancel().catch(() => undefined)
                return undefined
            }
            chunks.push(value)
        }
    } finally {
        reader.releaseLock()
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
    }
    return new TextDecoder().decode(bytes)
}

function parseJson(text: string | undefined): unknown {
    if (!text) return undefined
    try {
        return JSON.parse(text) as unknown
    } catch {
        return undefined
    }
}

function parseSupportEndpoint(value: string): URL {
    const override = loopbackEndpointOverride(value)
    if (override) return new URL(override)
    const url = new URL(value)
    if (url.origin !== DEFAULT_SUPPORT_ENDPOINT) throw new Error("Support endpoint must use the canonical HTTPS origin")
    return url
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason)
        const timer = setTimeout(resolve, milliseconds)
        signal.addEventListener(
            "abort",
            () => {
                clearTimeout(timer)
                reject(signal.reason)
            },
            { once: true },
        )
    })
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
