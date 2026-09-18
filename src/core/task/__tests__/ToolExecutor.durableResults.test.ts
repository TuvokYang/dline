import { strict as assert } from "node:assert"
import { resolveWebSearchRoutingPlan, type WebSearchRoutingPlan } from "@core/api/server-tools"
import type { ToolUse } from "@core/assistant-message"
import { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"
import { WebToolsMode } from "@shared/proto/dline/provider/common"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import type { ClineUserToolResultContentBlock } from "@/shared/messages/content"
import { InteractionCancellationError } from "../interaction/InteractionCancellationError"
import { ToolExecutor } from "../ToolExecutor"
import { ToolResultUtils } from "../tools/utils/ToolResultUtils"

function createBlock(
	name: string = ClineDefaultTool.FILE_READ,
	params: ToolUse["params"] = name === ClineDefaultTool.FILE_READ ? { path: "src/index.ts" } : { path: "src/new.ts" },
): ToolUse {
	return {
		type: "tool_use",
		name: name as ClineDefaultTool,
		params,
		partial: false,
		function_id: `fn-${name}`,
		dline_tid: `tid-${name}`,
		isNativeToolCall: true,
		ts: 1,
	} as ToolUse
}

interface HarnessOptions {
	aborted?: boolean
	rejected?: boolean
	strictPlan?: boolean
	throwFromTool?: boolean
	throwInteractionCancellation?: boolean
	coordinatorHas?: boolean
	allowedNativeToolNames?: string[]
	focusChainEnabled?: boolean
	providerId?: string
	webToolsEnabled?: boolean
	webSearchRoutingPlan?: WebSearchRoutingPlan
}

type ToolExecutorHarness = {
	execute(block: ToolUse, config?: object): Promise<boolean>
	commitRestoredToolResult(content: Parameters<typeof ToolResultUtils.pushToolResult>[0], block: ToolUse): Promise<void>
	pushToolResult: (content: Parameters<typeof ToolResultUtils.pushToolResult>[0], block: ToolUse, isError?: boolean) => void
}

function requireCanonicalResult(content: Parameters<typeof ToolResultUtils.pushToolResult>[2]): ClineUserToolResultContentBlock {
	const result = content.find((item): item is ClineUserToolResultContentBlock => item.type === "tool_result")
	assert.ok(result)
	return result
}

function createHarness(options: HarnessOptions = {}) {
	const userMessageContent: Parameters<typeof ToolResultUtils.pushToolResult>[2] = []
	const say = vi.fn(async () => 1)
	const updateFCListFromToolResponse = vi.fn(async () => undefined)
	const partialRender = vi.fn(async () => undefined)
	const coordinator = {
		has: vi.fn(() => options.coordinatorHas ?? true),
		getHandler: vi.fn(() => ({
			getDescription: (block: ToolUse) => `[${block.name}]`,
			handlePartialBlock: partialRender,
		})),
		execute: vi.fn(async (_config: { webSearchRoutingPlan?: WebSearchRoutingPlan }, _block: ToolUse) => {
			if (options.throwInteractionCancellation) throw new InteractionCancellationError("task_terminated")
			if (options.throwFromTool) throw new Error("handler exploded")
			return "tool completed"
		}),
	}
	const executor = Object.create(ToolExecutor.prototype) as ToolExecutorHarness
	Object.assign(executor, {
		taskState: {
			abort: options.aborted === true,
			consecutiveMistakeCount: 0,
			didAlreadyUseTool: false,
			userMessageContent,
		},
		taskController: {
			wasRejected: vi.fn(() => options.rejected === true),
		},
		stateManager: {
			getGlobalSettingsKey: vi.fn((key: string) => {
				if (key === "strictPlanModeEnabled") return options.strictPlan === true
				if (key === "focusChainSettings") return { enabled: options.focusChainEnabled === true }
				if (key === "hooksEnabled") return false
				if (key === "clineWebToolsEnabled") return options.webToolsEnabled === true
				return false
			}),
		},
		api: {
			getProviderId: () => options.providerId ?? "openai",
		},
		autoApprover: { shouldAutoApproveTool: vi.fn(() => false) },
		getMode: () => (options.strictPlan ? "plan" : "act"),
		browserSession: { closeBrowser: vi.fn(async () => undefined) },
		coordinator,
		say,
		updateFCListFromToolResponse,
		allowedNativeToolNames: new Set(options.allowedNativeToolNames ?? []),
		webToolsEnabled: options.webToolsEnabled,
		webSearchRoutingPlan: options.webSearchRoutingPlan,
		isParallelToolCallingEnabled: () => true,
	})

	// The production method is an instance field. Install the same implementation
	// without constructing the executor's unrelated VS Code services.
	executor.pushToolResult = (content, block, isError) =>
		ToolResultUtils.pushToolResult(
			content,
			block,
			userMessageContent,
			(toolBlock) => `[${toolBlock.name}]`,
			coordinator as never,
			isError,
		)

	return { coordinator, executor, partialRender, say, updateFCListFromToolResponse, userMessageContent }
}

function partialResultRows(say: ReturnType<typeof vi.fn>): string[] {
	return say.mock.calls
		.filter(([type]) => type === "partial_tool_result")
		.map(([, text]) => text)
		.filter((text): text is string => typeof text === "string")
}

function hostedWebSearchPlan(mode: WebToolsMode, localAvailable = true): WebSearchRoutingPlan {
	return resolveWebSearchRoutingPlan({
		enabled: true,
		mode,
		modelInfo: { capabilities: { tools: [ServerTool.WEB_SEARCH] } },
		selectedApiFormat: ApiFormat.OPENAI_RESPONSES,
		localAvailable,
		remoteAdapterAvailable: true,
	})
}

function webSearchCards(say: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
	return say.mock.calls
		.filter(([type]) => type === "tool")
		.map(([, text]) => text)
		.filter((text): text is string => typeof text === "string")
		.map((text) => JSON.parse(text) as Record<string, unknown>)
		.filter((payload) => payload.tool === "webSearch")
}

describe("ToolExecutor durable tool results", () => {
	it("does not enter browser or partial handler side effects after the Task aborts", async () => {
		const { coordinator, executor, partialRender } = createHarness({
			aborted: true,
			allowedNativeToolNames: [ClineDefaultTool.FILE_READ],
		})
		const block = createBlock()
		block.partial = true

		await executor.execute(block, {})

		expect(executor.browserSession.closeBrowser).not.toHaveBeenCalled()
		expect(partialRender).not.toHaveBeenCalled()
		expect(coordinator.execute).not.toHaveBeenCalled()
	})

	it("does not render an unauthorized partial summarize_task block", async () => {
		const { executor, partialRender } = createHarness()
		const block = createBlock(ClineDefaultTool.SUMMARIZE_TASK, { context: "UNAUTHORIZED_SUMMARY_MUST_NOT_RENDER" })
		block.partial = true
		block.isNativeToolCall = false

		await executor.execute(block, { explicitInstructions: undefined })

		expect(partialRender).not.toHaveBeenCalled()
	})

	it("keeps an advertised read_file on its registered execution path", async () => {
		const { coordinator, executor, say } = createHarness({
			allowedNativeToolNames: [ClineDefaultTool.FILE_READ],
		})

		await executor.execute(createBlock(), {})

		expect(coordinator.execute).toHaveBeenCalledOnce()
		expect(JSON.parse(partialResultRows(say)[0])).toMatchObject({ is_error: null })
	})

	it("auto-executes task_progress as an internal tool without an approval gate", async () => {
		const { coordinator, executor, say, updateFCListFromToolResponse } = createHarness({
			allowedNativeToolNames: [],
			coordinatorHas: false,
			focusChainEnabled: true,
		})
		const block = createBlock("task_progress", { task_progress: "- [x] Inspect runtime state" })

		await executor.execute(block, {})

		expect(coordinator.execute).not.toHaveBeenCalled()
		expect(updateFCListFromToolResponse).toHaveBeenCalledWith("- [x] Inspect runtime state")
		expect(JSON.parse(partialResultRows(say)[0])).toMatchObject({
			function_id: "fn-task_progress",
			dline_tid: "tid-task_progress",
			is_error: null,
		})
	})

	it("applies one valid TODO update after an ordinary tool completes", async () => {
		const { coordinator, executor, updateFCListFromToolResponse } = createHarness({
			allowedNativeToolNames: [ClineDefaultTool.ACT_MODE],
			focusChainEnabled: true,
		})
		const taskProgress = "# Plan\n- [ ] Implement"
		const block = createBlock(ClineDefaultTool.ACT_MODE, { response: "Starting", task_progress: taskProgress })

		await executor.execute(block, {})

		expect(coordinator.execute).toHaveBeenCalledOnce()
		expect(updateFCListFromToolResponse).toHaveBeenCalledOnce()
		expect(updateFCListFromToolResponse).toHaveBeenCalledWith(taskProgress)
	})

	it.each([
		{},
		{ task_progress: "" },
		{ task_progress: "  \n\t" },
	])("treats an empty internal task_progress call as a no-op: %j", async (params) => {
		const { coordinator, executor, say, updateFCListFromToolResponse } = createHarness({
			allowedNativeToolNames: [],
			coordinatorHas: false,
			focusChainEnabled: true,
		})
		const block = createBlock("task_progress", params)

		await executor.execute(block, {})

		expect(coordinator.execute).not.toHaveBeenCalled()
		expect(updateFCListFromToolResponse).not.toHaveBeenCalled()
		expect(JSON.parse(partialResultRows(say)[0])).toMatchObject({
			content: [{ text: expect.stringContaining("No TODO list update provided") }],
			is_error: null,
		})
	})

	it("rejects an unadvertised native function non-fatally instead of invoking its registered handler", async () => {
		const { coordinator, executor, say } = createHarness({ allowedNativeToolNames: [] })
		const block = createBlock(ClineDefaultTool.FILE_READ)

		const handled = await executor.execute(block, {})

		expect(handled).toBe(true)
		expect(coordinator.execute).not.toHaveBeenCalled()
		expect(JSON.parse(partialResultRows(say)[0])).toMatchObject({
			function_id: "fn-read_file",
			dline_tid: "tid-read_file",
			is_error: true,
		})
	})

	it("renders a hosted Web Search error before rejecting an unadvertised Force Remote function call", async () => {
		const plan = hostedWebSearchPlan(WebToolsMode.WEB_TOOLS_MODE_FORCE_REMOTE)
		const { coordinator, executor, say } = createHarness({
			allowedNativeToolNames: [],
			providerId: "openai",
			webToolsEnabled: true,
			webSearchRoutingPlan: plan,
		})
		const block = createBlock(ClineDefaultTool.WEB_SEARCH, { query: "current OpenAI news" })

		await executor.execute(block, {
			webToolsEnabled: true,
			webSearchRoutingPlan: plan,
		})

		expect(coordinator.execute).not.toHaveBeenCalled()
		expect(webSearchCards(say)).toEqual([
			expect.objectContaining({
				tool: "webSearch",
				path: "current OpenAI news",
				webSearch: expect.objectContaining({
					source: {
						id: "openai-hosted",
						label: "OpenAI Web Search",
						execution: "hosted",
						provider: "openai",
					},
					error: expect.stringContaining("Force Remote"),
				}),
			}),
		])
		expect(JSON.parse(partialResultRows(say)[0])).toMatchObject({ is_error: true })
	})

	it("renders an actionable error when Auto has no local Web Search fallback", async () => {
		const plan = hostedWebSearchPlan(WebToolsMode.WEB_TOOLS_MODE_AUTO, false)
		const { coordinator, executor, say } = createHarness({
			allowedNativeToolNames: [],
			providerId: "openai",
			webToolsEnabled: true,
			webSearchRoutingPlan: plan,
		})
		const block = createBlock(ClineDefaultTool.WEB_SEARCH, { query: "current OpenAI news" })

		await executor.execute(block, {
			webToolsEnabled: true,
			webSearchRoutingPlan: plan,
		})

		expect(coordinator.execute).not.toHaveBeenCalled()
		expect(webSearchCards(say)).toEqual([
			expect.objectContaining({
				webSearch: expect.objectContaining({
					error: expect.stringContaining("Auto mode has no Dline local Web Search fallback"),
				}),
			}),
		])
		expect(JSON.parse(partialResultRows(say)[0])).toMatchObject({ is_error: true })
	})

	it("falls back to the registered local Web Search handler for an unadvertised Auto function call", async () => {
		const plan = hostedWebSearchPlan(WebToolsMode.WEB_TOOLS_MODE_AUTO)
		const { coordinator, executor, say } = createHarness({
			allowedNativeToolNames: [],
			providerId: "openai",
			webToolsEnabled: true,
			webSearchRoutingPlan: plan,
		})
		const block = createBlock(ClineDefaultTool.WEB_SEARCH, { query: "current OpenAI news" })

		await executor.execute(block, {
			webToolsEnabled: true,
			webSearchRoutingPlan: plan,
		})

		expect(coordinator.execute).toHaveBeenCalledOnce()
		const fallbackConfig = coordinator.execute.mock.calls[0]?.[0]
		expect(fallbackConfig?.webSearchRoutingPlan).toMatchObject({
			mode: WebToolsMode.WEB_TOOLS_MODE_AUTO,
			route: "local",
			localToolEnabled: true,
			serverTools: [],
		})
		expect(webSearchCards(say)).toEqual([
			expect.objectContaining({
				webSearch: expect.objectContaining({
					source: expect.objectContaining({ execution: "hosted", provider: "openai" }),
					error: expect.stringContaining("falling back to Dline local Web Search"),
				}),
			}),
		])
		expect(JSON.parse(partialResultRows(say)[0])).toMatchObject({ is_error: null })
	})

	it("closes an unregistered native function with a durable error result", async () => {
		const { coordinator, executor, say } = createHarness({
			allowedNativeToolNames: [],
			coordinatorHas: false,
		})
		const block = createBlock("not_registered", {})

		const handled = await executor.execute(block, {})

		expect(handled).toBe(true)
		expect(coordinator.execute).not.toHaveBeenCalled()
		expect(JSON.parse(partialResultRows(say)[0])).toMatchObject({ is_error: true })
	})

	it("persists the exact canonical block pushed to the model, including description and approval feedback", async () => {
		const { executor, say, userMessageContent } = createHarness()
		const block = createBlock(ClineDefaultTool.FILE_NEW)
		ToolResultUtils.pushAdditionalToolFeedback(userMessageContent, "keep the public API stable")

		await executor.commitRestoredToolResult("File written.", block)

		assert.equal(userMessageContent.length, 1)
		const canonical = requireCanonicalResult(userMessageContent)
		const rows = partialResultRows(say)
		assert.equal(rows.length, 1)
		expect(JSON.parse(rows[0])).toEqual({
			version: 1,
			function_id: canonical.function_id,
			dline_tid: canonical.dline_tid,
			content: canonical.content,
			is_error: null,
		})
		assert.ok(Array.isArray(canonical.content))
		const [resultText, feedbackText] = canonical.content
		assert.equal(resultText?.type, "text")
		assert.equal(feedbackText?.type, "text")
		expect(resultText?.type === "text" ? resultText.text : "").toContain("[write_to_file] Result:\nFile written.")
		expect(feedbackText?.type === "text" ? feedbackText.text : "").toContain("keep the public API stable")
	})

	it("replaces an interrupted result with restored structured completion feedback", async () => {
		const { executor, say, userMessageContent } = createHarness()
		const block = createBlock(ClineDefaultTool.ATTEMPT, { result: "completed" })
		userMessageContent.push({
			type: "tool_result",
			function_id: block.function_id,
			dline_tid: block.dline_tid,
			content: [{ type: "text", text: "Tool 'attempt_completion' was interrupted before a durable result." }],
			is_error: true,
		})

		await executor.commitRestoredToolResult(
			[{ type: "text", text: "The user provided restored completion feedback." }],
			block,
		)

		expect(userMessageContent).toHaveLength(1)
		expect(userMessageContent[0]).toMatchObject({
			function_id: block.function_id,
			dline_tid: block.dline_tid,
			content: [{ type: "text", text: "The user provided restored completion feedback." }],
		})
		expect(requireCanonicalResult(userMessageContent).is_error).not.toBe(true)
		expect(JSON.parse(partialResultRows(say).at(-1) ?? "null")).toMatchObject({
			function_id: block.function_id,
			dline_tid: block.dline_tid,
			content: [{ type: "text", text: "The user provided restored completion feedback." }],
			is_error: null,
		})
	})

	it("does not persist an expected interaction cancellation as a tool failure", async () => {
		const { coordinator, executor, say, userMessageContent } = createHarness({
			throwInteractionCancellation: true,
			allowedNativeToolNames: [ClineDefaultTool.MAKE_PLAN],
		})

		await executor.execute(createBlock(ClineDefaultTool.MAKE_PLAN, { response: "Plan ready" }), {})

		expect(coordinator.execute).toHaveBeenCalledOnce()
		expect(say).not.toHaveBeenCalledWith("error", expect.any(String))
		expect(partialResultRows(say)).toEqual([])
		expect(userMessageContent).toEqual([])
	})

	it.each([
		["a rejected native tool", { rejected: true }, ClineDefaultTool.FILE_READ],
		["a strict-plan rejection", { strictPlan: true }, ClineDefaultTool.FILE_NEW],
		["a handler error", { throwFromTool: true }, ClineDefaultTool.FILE_READ],
	] as const)("records a durable error result for %s", async (_label, options, toolName) => {
		const { executor, say, userMessageContent } = createHarness({
			...options,
			allowedNativeToolNames: [toolName],
		})

		await executor.execute(createBlock(toolName), {})

		const rows = partialResultRows(say)
		assert.equal(rows.length, 1)
		const persisted = JSON.parse(rows[0])
		const canonical = requireCanonicalResult(userMessageContent)
		expect(persisted).toEqual({
			version: 1,
			function_id: canonical.function_id,
			dline_tid: canonical.dline_tid,
			content: canonical.content,
			is_error: true,
		})
	})
})
