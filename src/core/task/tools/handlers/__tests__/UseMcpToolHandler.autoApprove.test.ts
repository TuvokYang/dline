import type { ToolParamName, ToolUse } from "@core/assistant-message"
import { ClineDefaultTool } from "@shared/tools"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { TaskConfig } from "../../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../../types/UIHelpers"
import { UseMcpToolHandler } from "../UseMcpToolHandler"

vi.mock("@core/api", () => ({ resolveProvider: () => "openai" }))
vi.mock("@/services/telemetry", () => ({ telemetryService: { captureToolUsage: vi.fn() } }))
vi.mock("../../utils/ToolHookUtils", () => ({ ToolHookUtils: { runPreToolUseIfEnabled: vi.fn(async () => {}) } }))

const block: ToolUse = {
	type: "tool_use",
	name: ClineDefaultTool.MCP_USE,
	params: { server_name: "docs", tool_name: "search", arguments: "{}" },
	partial: false,
	ts: 42,
	function_id: "mcp-function-1",
	dline_tid: "mcp-call-1",
}

function createConfig(globalEnabled: boolean, toolEnabled: boolean): TaskConfig {
	return {
		taskId: "task-1",
		ulid: "ulid-1",
		cwd: "e:/workspace/vscode/dline",
		mode: "act",
		yoloModeToggled: false,
		autoApprovalSettings: { actions: { useMcp: globalEnabled }, enableNotifications: false },
		capabilityToggles: { mcpServers: { docs: true } },
		taskState: { consecutiveMistakeCount: 0 },
		api: { getModel: () => ({ id: "test-model", info: { capabilities: { supportsImages: false } } }) },
		services: {
			stateManager: {
				getApiConfiguration: () => ({}),
				getGlobalSettingsKey: (key: string) => (key === "mode" ? "act" : false),
			},
			mcpHub: {
				connections: [
					{
						server: { name: "docs", tools: [{ name: "search", autoApprove: toolEnabled }] },
					},
				],
				getPendingNotifications: () => [],
				callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
			},
		},
		callbacks: {
			say: vi.fn(async () => undefined),
			ask: vi.fn(async () => ({ response: "yesButtonClicked" })),
			sayAndCreateMissingParamError: vi.fn(async () => "missing"),
		},
	} as unknown as TaskConfig
}

function createHelpers(config: TaskConfig): StronglyTypedUIHelpers {
	return {
		getConfig: () => config,
		removeClosingTag: (_block: ToolUse, _tag: ToolParamName, text?: string) => text ?? "",
		say: vi.fn(async () => undefined),
		ask: vi.fn(async () => ({ response: "yesButtonClicked" })),
	} as unknown as StronglyTypedUIHelpers
}

describe("UseMcpToolHandler auto-approval", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("keeps partial MCP rendering presentation-only", async () => {
		const config = createConfig(true, false)
		const helpers = createHelpers(config)
		const handler = new UseMcpToolHandler()

		await handler.handlePartialBlock(block, helpers)

		expect(helpers.say).toHaveBeenCalledOnce()
		expect(helpers.ask).not.toHaveBeenCalled()
	})

	it("executes only after the caller has satisfied Admission", async () => {
		const config = createConfig(false, true)
		const handler = new UseMcpToolHandler()

		await handler.execute(config, block)

		expect(config.services.mcpHub.callTool).toHaveBeenCalledWith("docs", "search", {}, "ulid-1")
	})
})
