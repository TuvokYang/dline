import { getPrompt } from "@core/prompts/i18n"
import { isInteractionCancellationError } from "@core/task/interaction/InteractionCancellationError"
import { ClineSayTool } from "@shared/ExtensionMessage"
import { ClineDefaultTool } from "@shared/tools"
import { DEFAULT_LOCAL_SEARCH_ENGINE, isLocalSearchEngineId, LOCAL_SEARCH_ENGINE_LABELS } from "@shared/web-search"
import { telemetryService } from "@/services/telemetry"
import { createLocalSearchRegistry, type LocalSearchRegistryOptions } from "@/services/web-search/createLocalSearchRegistry"
import type { LocalSearchRegistry, LocalSearchResultItem } from "@/services/web-search/LocalSearchProvider"
import { parsePartialArrayString } from "@/shared/array"
import { ToolUse } from "../../../assistant-message"
import { formatResponse } from "../../../prompts/responses"
import { ToolResponse } from "../.."
import type { IFullyManagedTool } from "../ToolExecutorCoordinator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"

type LocalSearchRegistryFactory = (options: LocalSearchRegistryOptions) => LocalSearchRegistry

function matchesDomain(url: string, domain: string): boolean {
	try {
		const hostname = new URL(url).hostname.toLowerCase()
		const normalizedDomain = domain.trim().toLowerCase().replace(/^\.+/, "")
		return Boolean(normalizedDomain) && (hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`))
	} catch {
		return false
	}
}

function filterByDomains(
	items: readonly LocalSearchResultItem[],
	allowedDomains: readonly string[],
	blockedDomains: readonly string[],
): readonly LocalSearchResultItem[] {
	if (allowedDomains.length > 0) {
		return items.filter((item) => allowedDomains.some((domain) => matchesDomain(item.url, domain)))
	}
	if (blockedDomains.length > 0) {
		return items.filter((item) => !blockedDomains.some((domain) => matchesDomain(item.url, domain)))
	}
	return items
}

function formatSearchResults(engineLabel: string, items: readonly LocalSearchResultItem[]): string {
	let resultText = `${engineLabel} search completed (${items.length} results found)`
	if (items.length === 0) {
		return resultText
	}
	resultText += ":\n\n"
	items.forEach((item, index) => {
		resultText += `${index + 1}. ${item.title}\n   ${item.url}`
		if (item.snippet) {
			resultText += `\n   ${item.snippet}`
		}
		resultText += "\n\n"
	})
	return resultText
}

export class WebSearchToolHandler implements IFullyManagedTool {
	readonly name = ClineDefaultTool.WEB_SEARCH

	constructor(private readonly createRegistry: LocalSearchRegistryFactory = createLocalSearchRegistry) {}

	getDescription(block: ToolUse): string {
		return `[${block.name} for '${block.params.query}']`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const query = block.params.query || ""
		const normalizedQuery = uiHelpers.removeClosingTag(block, "query", query)
		const sharedMessageProps: ClineSayTool = {
			tool: "webSearch",
			path: normalizedQuery,
			content: `Searching for: ${normalizedQuery}`,
			operationIsLocatedInWorkspace: false, // web_search is always external
			webSearch: {
				schemaVersion: 1,
				status: "running",
				query: normalizedQuery,
			},
		} satisfies ClineSayTool

		const partialMessage = JSON.stringify(sharedMessageProps)

		await uiHelpers.say("tool", partialMessage, undefined, undefined, true, block.ts)
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		let terminalMessage: ClineSayTool | undefined
		let failureWritten = false
		const writeFailure = async (message: string): Promise<void> => {
			if (failureWritten || !terminalMessage?.webSearch) return
			const failedMessage: ClineSayTool = {
				...terminalMessage,
				content: `Web search failed: ${message}`,
				webSearch: {
					...terminalMessage.webSearch,
					status: "failed",
					error: message,
				},
			}
			await config.callbacks.say("tool", JSON.stringify(failedMessage), undefined, undefined, false, block.ts)
			failureWritten = true
		}

		try {
			const query: string | undefined = block.params.query
			const allowedDomainsRaw: string | undefined = block.params.allowed_domains
			const blockedDomainsRaw: string | undefined = block.params.blocked_domains

			const provider = config.api.getProviderId?.()

			// A request scope freezes the route before the API call. Do not let a
			// later settings change alter the tool contract already shown to the model.
			const route = config.webSearchRoutingPlan?.route
			const localRouteEnabled =
				route === undefined
					? config.services.stateManager.getGlobalSettingsKey("clineWebToolsEnabled") === true
					: route === "local"
			if (!localRouteEnabled) {
				return formatResponse.toolError(getPrompt("toolHandlers", "webSearchDisabled"))
			}

			// Validate required parameters
			if (!query) {
				config.taskState.consecutiveMistakeCount++
				return await config.callbacks.sayAndCreateMissingParamError(this.name, "query", undefined, block.ts)
			}
			config.taskState.consecutiveMistakeCount = 0

			// Parse domain arrays
			const allowedDomains = parsePartialArrayString(allowedDomainsRaw || "[]")
			const blockedDomains = parsePartialArrayString(blockedDomainsRaw || "[]")

			// Validate mutual exclusivity
			if (allowedDomains.length > 0 && blockedDomains.length > 0) {
				config.taskState.consecutiveMistakeCount++
				return formatResponse.toolError(getPrompt("toolHandlers", "webSearchDomainConflict"))
			}

			const configuredEngine = config.services.stateManager.getGlobalSettingsKey("localWebSearchEngine")
			const engineId = configuredEngine ?? DEFAULT_LOCAL_SEARCH_ENGINE
			if (!isLocalSearchEngineId(engineId)) {
				throw new Error(`Unsupported local web search engine: ${engineId}`)
			}
			const source = {
				id: engineId,
				label: LOCAL_SEARCH_ENGINE_LABELS[engineId],
				execution: "dline" as const,
			}

			// Create message for approval with the exact engine frozen for this execution.
			const sharedMessageProps: ClineSayTool = {
				tool: "webSearch",
				path: query,
				content: `Searching for: ${query}`,
				operationIsLocatedInWorkspace: false,
				webSearch: {
					schemaVersion: 1,
					status: "running",
					source,
					query,
				},
			}
			terminalMessage = sharedMessageProps
			const completeMessage = JSON.stringify(sharedMessageProps)

			await config.callbacks.say("tool", completeMessage, undefined, undefined, false, block.ts)
			telemetryService.captureToolUsage(
				config.ulid ?? "",
				"web_search",
				config.api.getModel().id,
				provider ?? "",
				!block.dline_tid || !config.admissionOutcomes?.has(block.dline_tid),
				true,
				undefined,
				block.isNativeToolCall,
			)

			// Run PreToolUse hook after approval but before execution
			try {
				const { ToolHookUtils } = await import("../utils/ToolHookUtils")
				await ToolHookUtils.runPreToolUseIfEnabled(config, block, { beforeTaskCancellation: writeFailure })
			} catch (error) {
				const { PreToolUseHookCancellationError } = await import("@core/hooks/PreToolUseHookCancellationError")
				if (error instanceof PreToolUseHookCancellationError) {
					await writeFailure(error.message)
					return formatResponse.toolDenied()
				}
				throw error
			}

			const searxngSearchUrl = config.services.stateManager.getGlobalSettingsKey("searxngSearchUrl")?.trim()
			if (engineId === "searxng" && !searxngSearchUrl) {
				throw new Error("SearXNG is selected but no SearXNG URL is configured")
			}
			const searxngSearchToken = config.services.stateManager.getSecretKey("searxngSearchToken")?.trim()
			const registry = this.createRegistry({
				...(searxngSearchUrl ? { searxngSearchUrl } : {}),
				...(searxngSearchToken ? { searxngSearchToken } : {}),
			})
			const descriptor = registry.list().find((entry) => entry.id === engineId)
			if (!descriptor) {
				throw new Error(`Local web search engine "${engineId}" is not configured`)
			}
			const response = await registry.search(engineId, { query })
			const items = filterByDomains(response.items, allowedDomains, blockedDomains)
			const completedMessage: ClineSayTool = {
				...sharedMessageProps,
				content: `${descriptor.label} search completed`,
				webSearch: {
					schemaVersion: 1,
					status: "completed",
					source,
					query,
					items: [...items],
				},
			}
			await config.callbacks.say("tool", JSON.stringify(completedMessage), undefined, undefined, false, block.ts)
			return formatResponse.toolResult(formatSearchResults(descriptor.label, items))
		} catch (error) {
			if (isInteractionCancellationError(error)) throw error
			const message = error instanceof Error ? error.message : String(error)
			await writeFailure(message)
			return `Error performing web search: ${message}`
		}
	}
}
