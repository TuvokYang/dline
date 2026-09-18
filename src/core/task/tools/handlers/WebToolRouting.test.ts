import { resolveWebSearchRoutingPlan } from "@core/api/server-tools"
import { PreToolUseHookCancellationError } from "@core/hooks/PreToolUseHookCancellationError"
import { resolveApprovalKind } from "@core/task/kernel/turn/approval-kind"
import { ToolExecutor } from "@core/task/ToolExecutor"
import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"
import { WebToolsMode } from "@shared/proto/dline/provider/common"
import { ClineDefaultTool } from "@shared/tools"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AuthService } from "@/services/auth/AuthService"
import type { LocalWebFetchProvider } from "@/services/web-fetch/LocalWebFetchProvider"
import { type LocalSearchProvider, LocalSearchRegistry } from "@/services/web-search/LocalSearchProvider"
import type { ToolUse } from "../../../assistant-message"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { ToolHookUtils } from "../utils/ToolHookUtils"
import { NO_TOOL_RESULT } from "../utils/ToolResultUtils"
import { WebFetchToolHandler } from "./WebFetchToolHandler"
import { WebSearchToolHandler } from "./WebSearchToolHandler"

function routingPlan(route: "disabled" | "local" | "hosted") {
	return resolveWebSearchRoutingPlan({
		enabled: true,
		mode: route === "disabled" ? WebToolsMode.WEB_TOOLS_MODE_FORCE_OFF : WebToolsMode.WEB_TOOLS_MODE_AUTO,
		modelInfo: { capabilities: { tools: [ServerTool.WEB_SEARCH] } },
		selectedApiFormat: route === "hosted" ? ApiFormat.OPENAI_RESPONSES : ApiFormat.OPENAI_CHAT,
		localAvailable: true,
		remoteAdapterAvailable: route === "hosted",
	})
}

function createSayMock() {
	return vi.fn(
		async (_type: string, _text?: string, _images?: string[], _files?: string[], _partial?: boolean, _existingTs?: number) =>
			undefined,
	)
}

function config(webToolsEnabled: boolean, route: "disabled" | "local" | "hosted", includeRoute = true) {
	const operationAbortController = new AbortController()
	return {
		api: {
			getProviderId: () => "deepseek",
			getModel: () => ({ id: "test-model", info: { id: "test-model" } }),
		},
		...(includeRoute ? { webSearchRoutingPlan: routingPlan(route) } : {}),
		webToolsEnabled,
		services: {
			stateManager: {
				getGlobalSettingsKey: (key: string): unknown => (key === "clineWebToolsEnabled" ? webToolsEnabled : undefined),
				getSecretKey: vi.fn((_key: string): string | undefined => undefined),
			},
		},
		taskState: { consecutiveMistakeCount: 0, operationSignal: operationAbortController.signal },
		autoApprovalSettings: { ...DEFAULT_AUTO_APPROVAL_SETTINGS },
		callbacks: {
			sayAndCreateMissingParamError: vi.fn(async (_tool: string, parameter: string) => `missing:${parameter}`),
			say: createSayMock(),
			shouldAutoApproveTool: vi.fn(() => false),
		},
	}
}

function asTaskConfig(value: ReturnType<typeof config>): TaskConfig {
	return value as unknown as TaskConfig
}

function block(name: "web_search" | "web_fetch"): ToolUse {
	return {
		type: "tool_use",
		name,
		params: {},
		partial: false,
		ts: 1,
		function_id: "call-1",
		dline_tid: "dline-1",
	} as ToolUse
}

describe("Web Tool admission", () => {
	it("uses an independent Web permission instead of the Browser permission", () => {
		const browserOnly = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			enabled: true,
			actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, useBrowser: true, useWeb: false },
		}
		expect(resolveApprovalKind({ toolName: ClineDefaultTool.BROWSER, settings: browserOnly }).kind).toBe("automatic")
		expect(resolveApprovalKind({ toolName: ClineDefaultTool.WEB_SEARCH, settings: browserOnly }).kind).toBe("manual")
		expect(resolveApprovalKind({ toolName: ClineDefaultTool.WEB_FETCH, settings: browserOnly }).kind).toBe("manual")

		const webOnly = {
			...browserOnly,
			actions: { ...browserOnly.actions, useBrowser: false, useWeb: true },
		}
		expect(resolveApprovalKind({ toolName: ClineDefaultTool.BROWSER, settings: webOnly }).kind).toBe("manual")
		expect(resolveApprovalKind({ toolName: ClineDefaultTool.WEB_SEARCH, settings: webOnly }).kind).toBe("automatic")
		expect(resolveApprovalKind({ toolName: ClineDefaultTool.WEB_FETCH, settings: webOnly }).kind).toBe("automatic")
	})

	it("defaults a missing Web permission to manual instead of inheriting Browser approval", () => {
		const settings = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			enabled: true,
			actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, useBrowser: true, useWeb: undefined },
		}
		expect(resolveApprovalKind({ toolName: ClineDefaultTool.WEB_SEARCH, settings }).kind).toBe("manual")
		expect(resolveApprovalKind({ toolName: ClineDefaultTool.WEB_FETCH, settings }).kind).toBe("manual")
	})
})

describe("local Web Tool routing", () => {
	beforeEach(() => vi.clearAllMocks())

	it("admits local Web Search for a non-Cline provider when the request plan selects local", async () => {
		const taskConfig = config(true, "local")

		await expect(new WebSearchToolHandler().execute(asTaskConfig(taskConfig), block("web_search"))).resolves.toBe(
			"missing:query",
		)
		expect(taskConfig.callbacks.sayAndCreateMissingParamError).toHaveBeenCalledWith("web_search", "query", undefined, 1)
	})

	it("re-resolves the local route for a restored approval without a live request scope", () => {
		const executor = Object.assign(Object.create(ToolExecutor.prototype), {
			api: {
				getModel: () => ({
					id: "restored-chat-model",
					info: {
						id: "restored-chat-model",
						apiFormats: [ApiFormat.OPENAI_CHAT],
						capabilities: { contextWindow: 131_072 },
					},
				}),
				supportsServerTool: () => false,
			},
			stateManager: {
				getGlobalSettingsKey: (key: string) => (key === "clineWebToolsEnabled" ? true : undefined),
			},
		}) as ToolExecutor
		const resolveForExecution = (
			ToolExecutor.prototype as unknown as {
				getWebSearchRoutingPlanForExecution(): ReturnType<typeof routingPlan> | undefined
			}
		).getWebSearchRoutingPlanForExecution

		expect(resolveForExecution.call(executor)).toMatchObject({
			route: "local",
			localToolEnabled: true,
			serverTools: [],
		})
	})

	it("keeps provider-hosted search enabled for restored execution when local Use Web auto-approval is off", () => {
		const executor = Object.assign(Object.create(ToolExecutor.prototype), {
			api: {
				getModel: () => ({
					id: "restored-responses-model",
					info: {
						id: "restored-responses-model",
						apiFormats: [ApiFormat.OPENAI_RESPONSES],
						capabilities: { contextWindow: 131_072, tools: [ServerTool.WEB_SEARCH] },
					},
				}),
				supportsServerTool: () => true,
			},
			stateManager: {
				getGlobalSettingsKey: (key: string) =>
					key === "clineWebToolsEnabled"
						? true
						: key === "autoApprovalSettings"
							? { actions: { useWeb: false } }
							: undefined,
			},
		}) as ToolExecutor
		const resolveForExecution = (
			ToolExecutor.prototype as unknown as {
				getWebSearchRoutingPlanForExecution(): ReturnType<typeof routingPlan> | undefined
			}
		).getWebSearchRoutingPlanForExecution

		expect(resolveForExecution.call(executor)).toMatchObject({
			route: "hosted",
			localToolEnabled: false,
			serverTools: [ServerTool.WEB_SEARCH],
		})
	})

	it("rejects a local Web Search function before Cline Auth when hosted routing owns the request", async () => {
		const taskConfig = config(true, "hosted")
		const getAuthToken = vi.spyOn(AuthService.getInstance(), "getAuthToken")
		const searchBlock = { ...block("web_search"), params: { query: "DeepSeek hosted search" } } as ToolUse

		const result = await new WebSearchToolHandler().execute(asTaskConfig(taskConfig), searchBlock)

		expect(String(result)).toContain("disabled")
		expect(getAuthToken).not.toHaveBeenCalled()
		expect(taskConfig.callbacks.sayAndCreateMissingParamError).not.toHaveBeenCalled()
	})

	it("lets the global switch disable local Web Search even with a local plan", async () => {
		const taskConfig = config(false, "local", false)

		const result = await new WebSearchToolHandler().execute(asTaskConfig(taskConfig), block("web_search"))

		expect(String(result)).toContain("disabled")
		expect(taskConfig.callbacks.sayAndCreateMissingParamError).not.toHaveBeenCalled()
	})

	it("keeps a frozen local Web Search route after the live global switch changes", async () => {
		const taskConfig = config(false, "local")

		await expect(new WebSearchToolHandler().execute(asTaskConfig(taskConfig), block("web_search"))).resolves.toBe(
			"missing:query",
		)
		expect(taskConfig.callbacks.sayAndCreateMissingParamError).toHaveBeenCalledWith("web_search", "query", undefined, 1)
	})

	it("keeps Web Fetch enabled when provider Web Search is Force Off", async () => {
		const taskConfig = config(true, "disabled")

		await expect(new WebFetchToolHandler().execute(asTaskConfig(taskConfig), block("web_fetch"))).resolves.toBe("missing:url")
	})

	it("disables Web Fetch when the frozen global Web Tools feature is disabled", async () => {
		const taskConfig = config(false, "disabled")

		expect(String(await new WebFetchToolHandler().execute(asTaskConfig(taskConfig), block("web_fetch")))).toContain(
			"disabled",
		)
		expect(taskConfig.callbacks.sayAndCreateMissingParamError).not.toHaveBeenCalled()
	})

	it("waits for a non-empty URL before rendering partial Web Fetch presentation", async () => {
		const say = vi.fn<StronglyTypedUIHelpers["say"]>(async () => undefined)
		const uiHelpers: StronglyTypedUIHelpers = {
			say,
			ask: vi.fn(async () => ({ response: "yesButtonClicked" as const })),
			removeClosingTag: (_block: ToolUse, _parameter: string, value?: string) => value ?? "",
			getConfig: vi.fn(() => {
				throw new Error("getConfig should not be called while rendering a partial Web Fetch block")
			}),
		}
		const handler = new WebFetchToolHandler()
		const fetchBlock = block("web_fetch")

		await handler.handlePartialBlock(fetchBlock, uiHelpers)
		expect(say).not.toHaveBeenCalled()

		const url = "https://example.test/streamed-url"
		await handler.handlePartialBlock({ ...fetchBlock, params: { url } } as ToolUse, uiHelpers)

		expect(say).toHaveBeenCalledOnce()
		const serializedPayload = say.mock.calls[0]?.[1]
		if (!serializedPayload) throw new Error("Expected Web Fetch presentation payload")
		const payload = JSON.parse(serializedPayload)
		expect(payload).toMatchObject({
			tool: "webFetch",
			path: url,
			webFetch: { schemaVersion: 1, status: "running", url },
		})
	})

	it("executes an OpenAI local Web Search without consulting Cline Auth", async () => {
		const taskConfig = config(true, "local")
		taskConfig.api.getProviderId = () => "openai"
		taskConfig.services.stateManager.getGlobalSettingsKey = (key: string) =>
			key === "clineWebToolsEnabled"
				? true
				: key === "hooksEnabled"
					? false
					: key === "localWebSearchEngine"
						? "searxng"
						: key === "searxngSearchUrl"
							? "https://search.example.test"
							: undefined
		taskConfig.services.stateManager.getSecretKey = vi.fn((key: string) =>
			key === "searxngSearchToken" ? "private-token" : undefined,
		)
		taskConfig.autoApprovalSettings = { ...DEFAULT_AUTO_APPROVAL_SETTINGS, enableNotifications: false }
		taskConfig.callbacks.shouldAutoApproveTool = vi.fn(() => true)
		taskConfig.callbacks.say = createSayMock()
		const search = vi.fn(async () => ({
			engineId: "searxng" as const,
			query: "Dline local search",
			items: [{ title: "Dline", url: "https://example.test/dline", snippet: "Local result" }],
		}))
		const provider: LocalSearchProvider = {
			descriptor: { id: "searxng", label: "SearXNG", execution: "dline" },
			search,
		}
		const createRegistry = vi.fn(() => new LocalSearchRegistry([provider]))
		const getAuthToken = vi.spyOn(AuthService.getInstance(), "getAuthToken")
		const searchBlock = {
			...block("web_search"),
			params: { query: "Dline local search" },
		} as ToolUse

		const result = await new WebSearchToolHandler(createRegistry).execute(asTaskConfig(taskConfig), searchBlock)

		expect(String(result)).toContain("SearXNG search completed")
		expect(String(result)).toContain("https://example.test/dline")
		expect(String(result)).toContain("Local result")
		expect(createRegistry).toHaveBeenCalledWith({
			searxngSearchUrl: "https://search.example.test",
			searxngSearchToken: "private-token",
		})
		expect(search).toHaveBeenCalledWith({ query: "Dline local search" })
		expect(taskConfig.callbacks.say).toHaveBeenCalledTimes(2)
		const approvalPayload = JSON.parse(taskConfig.callbacks.say.mock.calls[0]?.[1] ?? "{}")
		const completedPayload = JSON.parse(taskConfig.callbacks.say.mock.calls[1]?.[1] ?? "{}")
		expect(approvalPayload.webSearch).toEqual({
			schemaVersion: 1,
			status: "running",
			source: { id: "searxng", label: "SearXNG", execution: "dline" },
			query: "Dline local search",
		})
		expect(completedPayload.webSearch).toEqual({
			schemaVersion: 1,
			status: "completed",
			source: { id: "searxng", label: "SearXNG", execution: "dline" },
			query: "Dline local search",
			items: [{ title: "Dline", url: "https://example.test/dline", snippet: "Local result" }],
		})
		expect(taskConfig.callbacks.say.mock.calls[1][5]).toBe(searchBlock.ts)
		expect(getAuthToken).not.toHaveBeenCalled()
	})

	it("updates the local Web Search card with its source and actionable error", async () => {
		const taskConfig = config(true, "local")
		taskConfig.services.stateManager.getGlobalSettingsKey = (key: string) =>
			key === "clineWebToolsEnabled"
				? true
				: key === "hooksEnabled"
					? false
					: key === "localWebSearchEngine"
						? "bing"
						: undefined
		taskConfig.services.stateManager.getSecretKey = vi.fn()
		taskConfig.autoApprovalSettings = { ...DEFAULT_AUTO_APPROVAL_SETTINGS, enableNotifications: false }
		taskConfig.callbacks.shouldAutoApproveTool = vi.fn(() => true)
		taskConfig.callbacks.say = createSayMock()
		const provider: LocalSearchProvider = {
			descriptor: { id: "bing", label: "Browser / Bing", execution: "dline" },
			search: vi.fn(async () => {
				throw new Error("Browser / Bing search failed: navigation timed out")
			}),
		}
		const searchBlock = { ...block("web_search"), params: { query: "Dline timeout" } } as ToolUse

		const result = await new WebSearchToolHandler(() => new LocalSearchRegistry([provider])).execute(
			asTaskConfig(taskConfig),
			searchBlock,
		)

		expect(String(result)).toContain("navigation timed out")
		const failedPayload = JSON.parse(taskConfig.callbacks.say.mock.calls[1]?.[1] ?? "{}")
		expect(failedPayload.content).toContain("navigation timed out")
		expect(failedPayload.webSearch).toEqual({
			schemaVersion: 1,
			status: "failed",
			source: { id: "bing", label: "Browser / Bing", execution: "dline" },
			query: "Dline timeout",
			error: "Browser / Bing search failed: navigation timed out",
		})
		expect(taskConfig.callbacks.say.mock.calls[1][5]).toBe(searchBlock.ts)
	})

	it("terminates the local Web Search card when PreToolUse cancels execution", async () => {
		const taskConfig = config(true, "local")
		taskConfig.services.stateManager.getGlobalSettingsKey = (key: string) =>
			key === "clineWebToolsEnabled" ? true : key === "localWebSearchEngine" ? "bing" : undefined
		taskConfig.services.stateManager.getSecretKey = vi.fn()
		taskConfig.autoApprovalSettings = { ...DEFAULT_AUTO_APPROVAL_SETTINGS, enableNotifications: false }
		taskConfig.callbacks.shouldAutoApproveTool = vi.fn(() => true)
		taskConfig.callbacks.say = createSayMock()
		const search = vi.fn()
		const provider: LocalSearchProvider = {
			descriptor: { id: "bing", label: "Browser / Bing", execution: "dline" },
			search,
		}
		const runHook = vi
			.spyOn(ToolHookUtils, "runPreToolUseIfEnabled")
			.mockImplementationOnce(async (_config, _block, options) => {
				const message = "Web search blocked by workspace policy"
				await options?.beforeTaskCancellation?.(message)
				throw new PreToolUseHookCancellationError(message)
			})
		const searchBlock = { ...block("web_search"), params: { query: "blocked search" } } as ToolUse

		try {
			await new WebSearchToolHandler(() => new LocalSearchRegistry([provider])).execute(
				asTaskConfig(taskConfig),
				searchBlock,
			)
		} finally {
			runHook.mockRestore()
		}

		expect(search).not.toHaveBeenCalled()
		expect(taskConfig.callbacks.say).toHaveBeenCalledTimes(2)
		const failedPayload = JSON.parse(taskConfig.callbacks.say.mock.calls[1]?.[1] ?? "{}")
		expect(failedPayload.webSearch).toMatchObject({
			status: "failed",
			query: "blocked search",
			error: "Web search blocked by workspace policy",
		})
		expect(taskConfig.callbacks.say.mock.calls[1][5]).toBe(searchBlock.ts)
	})

	it("executes an OpenAI local Web Fetch without consulting Cline Auth", async () => {
		const taskConfig = config(true, "local")
		taskConfig.api.getProviderId = () => "openai"
		taskConfig.services.stateManager.getGlobalSettingsKey = (key: string) =>
			key === "clineWebToolsEnabled" ? true : key === "hooksEnabled" ? false : undefined
		taskConfig.autoApprovalSettings = { ...DEFAULT_AUTO_APPROVAL_SETTINGS, enableNotifications: false }
		taskConfig.callbacks.shouldAutoApproveTool = vi.fn(() => true)
		taskConfig.callbacks.say = createSayMock()
		const fetch = vi.fn(async () => ({
			url: "https://example.test/docs",
			prompt: "Extract the release notes",
			content: "# Local OpenAI Web Fetch\n\nNo Cline login required.",
			source: { id: "browser", label: "Browser Web Fetch", execution: "dline" } as const,
		}))
		const provider = { fetch } satisfies LocalWebFetchProvider
		const getAuthToken = vi.spyOn(AuthService.getInstance(), "getAuthToken")
		const fetchBlock = {
			...block("web_fetch"),
			params: { url: "https://example.test/docs", prompt: "Extract the release notes" },
		} as ToolUse

		const result = await new WebFetchToolHandler(provider).execute(asTaskConfig(taskConfig), fetchBlock)

		expect(String(result)).toContain("# Local OpenAI Web Fetch")
		expect(String(result)).toContain("Extract the release notes")
		expect(fetch).toHaveBeenCalledWith({
			url: "https://example.test/docs",
			prompt: "Extract the release notes",
			signal: taskConfig.taskState.operationSignal,
		})
		expect(taskConfig.callbacks.say).toHaveBeenCalledTimes(2)
		const completedPayload = JSON.parse(taskConfig.callbacks.say.mock.calls[1]?.[1] ?? "{}")
		expect(completedPayload.webFetch).toEqual({
			schemaVersion: 1,
			status: "completed",
			source: { id: "browser", label: "Browser Web Fetch", execution: "dline" },
			url: "https://example.test/docs",
			prompt: "Extract the release notes",
			content: "# Local OpenAI Web Fetch\n\nNo Cline login required.",
		})
		expect(taskConfig.callbacks.say.mock.calls[1][5]).toBe(fetchBlock.ts)
		expect(getAuthToken).not.toHaveBeenCalled()
	})

	it("does not write a terminal card or tool result after task cancellation", async () => {
		const taskConfig = config(true, "local")
		taskConfig.services.stateManager.getGlobalSettingsKey = (key: string) =>
			key === "clineWebToolsEnabled" ? true : key === "hooksEnabled" ? false : undefined
		taskConfig.autoApprovalSettings = { ...DEFAULT_AUTO_APPROVAL_SETTINGS, enableNotifications: false }
		taskConfig.callbacks.shouldAutoApproveTool = vi.fn(() => true)
		taskConfig.callbacks.say = createSayMock()
		const operationAbortController = new AbortController()
		taskConfig.taskState.operationSignal = operationAbortController.signal
		const fetch = vi.fn(async () => {
			operationAbortController.abort(new Error("checkpoint_restore"))
			throw new Error("checkpoint_restore")
		})
		const provider = { fetch } satisfies LocalWebFetchProvider
		const fetchBlock = {
			...block("web_fetch"),
			params: { url: "https://example.test/restore", prompt: "Wait for restore" },
		} as ToolUse

		await expect(new WebFetchToolHandler(provider).execute(asTaskConfig(taskConfig), fetchBlock)).resolves.toBe(
			NO_TOOL_RESULT,
		)
		expect(taskConfig.callbacks.say).toHaveBeenCalledTimes(1)
	})

	it("terminates the local Web Fetch card when PreToolUse cancels execution", async () => {
		const taskConfig = config(true, "local")
		taskConfig.services.stateManager.getGlobalSettingsKey = (key: string) =>
			key === "clineWebToolsEnabled" ? true : undefined
		taskConfig.autoApprovalSettings = { ...DEFAULT_AUTO_APPROVAL_SETTINGS, enableNotifications: false }
		taskConfig.callbacks.shouldAutoApproveTool = vi.fn(() => true)
		taskConfig.callbacks.say = createSayMock()
		const fetch = vi.fn()
		const provider = { fetch } satisfies LocalWebFetchProvider
		const runHook = vi
			.spyOn(ToolHookUtils, "runPreToolUseIfEnabled")
			.mockImplementationOnce(async (_config, _block, options) => {
				const message = "Web fetch blocked by workspace policy"
				await options?.beforeTaskCancellation?.(message)
				throw new PreToolUseHookCancellationError(message)
			})
		const fetchBlock = {
			...block("web_fetch"),
			params: { url: "https://example.test/blocked", prompt: "Extract blocked content" },
		} as ToolUse

		try {
			await new WebFetchToolHandler(provider).execute(asTaskConfig(taskConfig), fetchBlock)
		} finally {
			runHook.mockRestore()
		}

		expect(fetch).not.toHaveBeenCalled()
		expect(taskConfig.callbacks.say).toHaveBeenCalledTimes(2)
		const failedPayload = JSON.parse(taskConfig.callbacks.say.mock.calls[1]?.[1] ?? "{}")
		expect(failedPayload.webFetch).toMatchObject({
			status: "failed",
			url: "https://example.test/blocked",
			prompt: "Extract blocked content",
			error: "Web fetch blocked by workspace policy",
		})
		expect(taskConfig.callbacks.say.mock.calls[1][5]).toBe(fetchBlock.ts)
	})
})
