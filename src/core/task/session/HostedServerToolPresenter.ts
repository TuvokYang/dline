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
import { normalizeWebSearchItems } from "@shared/web-tools"
import type {
	ProviderServerToolPresentationPort,
	ProviderServerToolPresentationSession,
	ProviderServerToolRequestContext,
} from "../executors/provider/service/DefaultProductionProviderService"
import type { MessageStateHandler } from "../message-state"
import { HostedImageGenerationLifecycle } from "../tools/HostedImageGenerationLifecycle"
import { type HostedServerToolUpdate, ServerToolLifecycle } from "../tools/ServerToolLifecycle"
import type { PresentationIdSequence } from "./PresentationIdSequence"

function providerLabel(providerId: string): string {
	if (providerId === "openai") return "OpenAI"
	if (providerId === "deepseek") return "DeepSeek"
	return providerId
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
			status: update.status === "failed" ? "failed" : update.status === "completed" ? "completed" : "running",
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
	const label = providerLabel(providerId)
	return {
		tool: "webFetch",
		path: url,
		content: update.status === "failed" ? `Web fetch failed: ${error ?? url}` : `Fetching URL: ${url}`,
		operationIsLocatedInWorkspace: false,
		webFetch: {
			schemaVersion: 1,
			status: update.status === "failed" ? "failed" : update.status === "completed" ? "completed" : "running",
			source: {
				id: `${providerId}-hosted`,
				label: `${label} Web Fetch`,
				execution: "hosted",
				provider: providerId,
			},
			url,
			...(error === undefined ? {} : { error }),
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

/**
 * Owns chat presentation for all provider-hosted calls in one provider response.
 *
 * Rows are transient while a call runs and become durable only when its lifecycle
 * reaches a terminal update. A stable row identity also lets a late provider
 * result enrich an already-completed call without appending a duplicate card.
 */
class HostedServerToolPresentationSession implements ProviderServerToolPresentationSession {
	private readonly rowIds = new Map<string, number>()
	private readonly webTools: ServerToolLifecycle
	private readonly images: HostedImageGenerationLifecycle

	constructor(
		taskId: string,
		context: ProviderServerToolRequestContext,
		private readonly messages: MessageStateHandler,
		private readonly nextPresentationId: PresentationIdSequence,
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
			return
		}
		// beginDurableClineMessage permits a late terminal enrichment to replace
		// the durable row that the first terminal update already committed.
		await this.messages.beginDurableClineMessage(row).persistence
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
	) {}

	begin(context: ProviderServerToolRequestContext): ProviderServerToolPresentationSession {
		return new HostedServerToolPresentationSession(this.taskId, context, this.messages, this.nextPresentationId)
	}
}

export type { WebSearchRoutingPlan }
