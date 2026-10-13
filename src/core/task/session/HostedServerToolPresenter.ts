import { recordHostedToolDeferralResolved } from "@core/api/observability/hosted-tool-deferral"
import type { WebSearchRoutingPlan } from "@core/api/server-tools"
import type { ApiStreamServerToolChunk } from "@core/api/transform/stream"
import {
    describeCodeExecutionOperation,
    normalizeCodeExecutionErrorCode,
    normalizeCodeExecutionOutput,
    normalizeHostedCodeExecutionOperation,
} from "@shared/code-execution-tools"
import type { UiSayTool } from "@shared/ExtensionMessage"
import { ServerTool } from "@shared/proto/dline/models/metadata"
import { Logger } from "@shared/services/Logger"
import {
    type HostedCallPresentation,
    normalizeHostedWebFetchContent,
    normalizeWebSearchItems,
    type WebToolPresentationStatus,
} from "@shared/web-tools"
import type {
    DeferredHostedResumeRequest,
    ProviderServerToolPresentationPort,
    ProviderServerToolPresentationSession,
    ProviderServerToolRequestContext,
} from "../executors/provider/service/DefaultProductionProviderService"
import type { MessageStateHandler } from "../message-state"
import { type DeferredHostedRow, planDeferredHostedRows } from "../tools/deferred-hosted-rows"
import { HostedImageGenerationLifecycle } from "../tools/HostedImageGenerationLifecycle"
import { type HostedServerToolUpdate, ServerToolLifecycle } from "../tools/ServerToolLifecycle"
import type { PresentationIdSequence } from "./PresentationIdSequence"
import type { RealtimeMessagePublisher } from "./RealtimeMessagePublisher"

function providerLabel(providerId: string): string {
    if (providerId === "openai") return "OpenAI"
    if (providerId === "deepseek") return "DeepSeek"
    return providerId
}

/** Row status of a hosted web call; a started call is still running. */
function webToolStatus(update: HostedServerToolUpdate): WebToolPresentationStatus {
    return update.status === "started" ? "running" : update.status
}

/** A deferred row names its hosted call, so the request that resumes it finishes this row. */
function deferredHostedCall(update: HostedServerToolUpdate): { hostedCall?: HostedCallPresentation } {
    return update.status === "deferred" ? { hostedCall: { functionId: update.functionId, traceId: update.dlineTid } } : {}
}

/** Present one hosted Web Search call. */
function buildWebSearchMessage(update: HostedServerToolUpdate, providerId: string): UiSayTool {
    const items = normalizeWebSearchItems(update.result)
    const label = providerLabel(providerId)
    return {
        tool: "webSearch",
        path: update.query,
        content:
            update.status === "failed" ? `Web search failed: ${update.error ?? update.query}` : `Searching for: ${update.query}`,
        operationIsLocatedInWorkspace: false,
        webSearch: {
            schemaVersion: 1,
            status: webToolStatus(update),
            source: {
                id: `${providerId}-hosted`,
                label: `${label} Web Search`,
                execution: "hosted",
                provider: providerId,
            },
            query: update.query,
            operation: update.operation,
            ...(items.length > 0 ? { items } : {}),
            ...(update.error === undefined ? {} : { error: update.error }),
            ...deferredHostedCall(update),
        },
    }
}

function hostedFetchUrl(update: HostedServerToolUpdate): string {
    for (const candidate of [update.input, update.result]) {
        if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
            const url = (candidate as { url?: unknown }).url
            if (typeof url === "string" && url.trim().length > 0) return url.trim()
        }
    }
    return update.query
}

function hostedFetchError(update: HostedServerToolUpdate): string | undefined {
    if (update.status !== "failed") return update.error
    const detail = update.errorDetail
    if (detail && typeof detail === "object" && !Array.isArray(detail)) {
        const code = (detail as { error_code?: unknown }).error_code
        if (typeof code === "string" && code.length > 0) return `${update.error ?? "Web fetch failed"} (${code})`
    }
    return update.error
}

/** Present one hosted Web Fetch call in the same row shape as a local fetch. */
function buildWebFetchMessage(update: HostedServerToolUpdate, providerId: string): UiSayTool {
    const url = hostedFetchUrl(update)
    const error = hostedFetchError(update)
    const content = normalizeHostedWebFetchContent(update.result)
    const label = providerLabel(providerId)
    return {
        tool: "webFetch",
        path: url,
        content: update.status === "failed" ? `Web fetch failed: ${error ?? url}` : `Fetching URL: ${url}`,
        operationIsLocatedInWorkspace: false,
        webFetch: {
            schemaVersion: 1,
            status: webToolStatus(update),
            source: {
                id: `${providerId}-hosted`,
                label: `${label} Web Fetch`,
                execution: "hosted",
                provider: providerId,
            },
            url,
            ...(content === undefined ? {} : { content }),
            ...(error === undefined ? {} : { error }),
            ...deferredHostedCall(update),
        },
    }
}

/** Present one provider-hosted sandbox run. */
function buildCodeExecutionMessage(update: HostedServerToolUpdate, providerId: string): UiSayTool {
    const operation = normalizeHostedCodeExecutionOperation(update.input)
    const output = normalizeCodeExecutionOutput(update.result)
    const errorCode = normalizeCodeExecutionErrorCode(update.errorDetail)
    const description = describeCodeExecutionOperation(operation)
    const label = providerLabel(providerId)
    return {
        tool: "codeExecution",
        path: description ?? update.query,
        content:
            update.status === "failed"
                ? `Code execution failed: ${errorCode ?? update.error ?? "unknown error"}`
                : (description ?? "Running code"),
        operationIsLocatedInWorkspace: false,
        codeExecution: {
            schemaVersion: 1,
            status: update.status === "failed" ? "failed" : update.status === "completed" ? "completed" : "running",
            source: {
                id: `${providerId}-hosted`,
                label: `${label} Code Execution`,
                execution: "hosted",
                provider: providerId,
            },
            operation,
            ...(output === undefined ? {} : { output }),
            ...(errorCode === undefined ? {} : { errorCode }),
            ...(update.error === undefined ? {} : { error: update.error }),
        },
    }
}

function buildHostedMessage(update: HostedServerToolUpdate, providerId: string): UiSayTool {
    if (update.tool === ServerTool.CODE_EXECUTION) return buildCodeExecutionMessage(update, providerId)
    if (update.tool === ServerTool.WEB_FETCH) return buildWebFetchMessage(update, providerId)
    return buildWebSearchMessage(update, providerId)
}

/** Failure shown on a deferred row once the conversation no longer lets the provider run its call. */
const DEFERRED_HOSTED_CALL_ABANDONED_REASON =
    "The provider never ran this deferred hosted call: the conversation moved on before a request could resume it."

/**
 * Owns chat presentation for all provider-hosted calls in one provider response.
 *
 * Rows are transient while a call runs and become durable only when its lifecycle
 * reaches a terminal or deferred update. A stable row identity also lets a late provider
 * result enrich an already-completed call without appending a duplicate card.
 */
class HostedServerToolPresentationSession implements ProviderServerToolPresentationSession {
    private readonly rowIds = new Map<string, number>()
    private readonly webTools: ServerToolLifecycle
    private readonly images: HostedImageGenerationLifecycle

    constructor(
        taskId: string,
        private readonly context: ProviderServerToolRequestContext,
        private readonly messages: MessageStateHandler,
        private readonly nextPresentationId: PresentationIdSequence,
        private readonly realtime?: RealtimeMessagePublisher,
    ) {
        this.webTools = new ServerToolLifecycle(context.webSearchRoutingPlan, true, async (update) => {
            await this.present(update.dlineTid, buildHostedMessage(update, context.providerId), update.partial)
        })
        this.images = new HostedImageGenerationLifecycle({
            taskId,
            context: context.imageGeneration,
            onUpdate: async (update) => {
                await this.present(update.dlineTid, update.message, update.partial)
            },
        })
    }

    async consume(chunk: ApiStreamServerToolChunk): Promise<boolean> {
        if (await this.images.consume(chunk)) return true
        return await this.webTools.consume(chunk)
    }

    async finalizeOpen(reason: string): Promise<void> {
        await this.images.finalizeOpen()
        await this.webTools.finalizeOpen(reason)
    }

    /**
     * Read the deferred rows from the durable chat, fail those this request cannot resume, and adopt the rest
     * under their original rows so the result the provider opens its reply with completes them in place.
     *
     * Returns provider call id → trace identity of the calls this request resumes.
     */
    async resumeDeferred(request: DeferredHostedResumeRequest): Promise<ReadonlyMap<string, string>> {
        const plan = planDeferredHostedRows(this.messages.clineMessages, request.history, request)
        for (const row of plan.abandoned) await this.abandonDeferred(row)
        for (const row of plan.carried) this.rowIds.set(row.dlineTid, row.ts)
        this.webTools.adopt(plan.carried)
        return new Map(plan.carried.map((row) => [row.functionId, row.dlineTid]))
    }

    /**
     * Fail a deferred row in place. It is written directly rather than through the lifecycle, because the
     * current request may no longer route the tool, and it keeps the provider that announced the call.
     *
     * A failed write only loses this presentation update: the durable row stays deferred and is abandoned
     * again by the next request. It must not fail the provider request that is resuming, which would
     * present a local storage error as an API failure the user has to retry by hand.
     */
    private async abandonDeferred(row: DeferredHostedRow): Promise<void> {
        this.rowIds.set(row.dlineTid, row.ts)
        try {
            const update: HostedServerToolUpdate = {
                dlineTid: row.dlineTid,
                functionId: row.functionId,
                tool: row.tool,
                status: "failed",
                partial: false,
                query: row.query,
                operation: row.operation,
                ...(row.input === undefined ? {} : { input: row.input }),
                error: DEFERRED_HOSTED_CALL_ABANDONED_REASON,
            }
            await this.present(row.dlineTid, buildHostedMessage(update, row.providerId ?? this.context.providerId), false)
        } catch (error) {
            Logger.error(`[HostedServerToolPresenter] Failed to persist the abandoned deferred row ${row.ts}:`, error)
            return
        } finally {
            this.rowIds.delete(row.dlineTid)
        }
        recordHostedToolDeferralResolved({
            apiFormat: "anthropic_messages",
            hostedTool: row.tool === ServerTool.WEB_FETCH ? "web_fetch" : "web_search",
            resolution: "not_resumed",
        })
    }

    private async present(dlineTid: string, message: UiSayTool, partial: boolean): Promise<void> {
        const ts = this.rowId(dlineTid)
        const row = {
            ts,
            type: "say" as const,
            say: "tool" as const,
            text: JSON.stringify(message),
            partial,
        }
        if (partial) {
            this.messages.upsertTransientClineMessage(row)
            this.realtime?.publish(row)
            return
        }
        // beginDurableClineMessage permits a late terminal enrichment to replace
        // the durable row that the first terminal update already committed. That
        // replacement keeps the message count, the only change the view refetches
        // on, so the terminal row is pushed to it like a partial one.
        const durable = this.messages.beginDurableClineMessage(row)
        this.realtime?.publish(durable.message)
        await durable.persistence
    }

    private rowId(dlineTid: string): number {
        const existing = this.rowIds.get(dlineTid)
        if (existing !== undefined) return existing
        const created = this.nextPresentationId()
        this.rowIds.set(dlineTid, created)
        return created
    }
}

/** Creates one isolated hosted-tool presenter for each provider response. */
export class HostedServerToolPresenter implements ProviderServerToolPresentationPort {
    constructor(
        private readonly taskId: string,
        private readonly messages: MessageStateHandler,
        private readonly nextPresentationId: PresentationIdSequence,
        private readonly realtime?: RealtimeMessagePublisher,
    ) {}

    begin(context: ProviderServerToolRequestContext): ProviderServerToolPresentationSession {
        return new HostedServerToolPresentationSession(
            this.taskId,
            context,
            this.messages,
            this.nextPresentationId,
            this.realtime,
        )
    }
}

export type { WebSearchRoutingPlan }
