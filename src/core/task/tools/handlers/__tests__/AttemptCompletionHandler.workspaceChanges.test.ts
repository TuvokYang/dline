import type { UiMessage } from "@shared/ExtensionMessage"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import type { ToolUse } from "../../../../assistant-message"
import { DefaultToolHandlerState } from "../../state/ToolHandlerState"
import type { TaskConfig } from "../../types/TaskConfig"
import { AttemptCompletionHandler } from "../AttemptCompletionHandler"

const COMPLETION_TS = 123

/**
 * Build a config whose message list behaves like the real one during a
 * completion: `say` publishes the completion row, and the interaction then
 * rewrites that same row into an ask presentation carrying the model's original
 * result text. The rewrite is what previously destroyed any marker appended to
 * the text, so the fixture reproduces it.
 */
function createConfig(options: { hasNewChanges: boolean; rewriteAsAsk?: boolean }): {
	config: TaskConfig
	messages: UiMessage[]
} {
	const messages: UiMessage[] = []
	const updateClineMessage = vi.fn(async (index: number, updates: Partial<UiMessage>) => {
		messages[index] = { ...messages[index], ...updates }
	})
	const config = {
		taskId: "task-1",
		ulid: "ulid-1",
		cwd: "e:\\workspace\\vscode\\dline",
		mode: "act",
		doubleCheckCompletionEnabled: false,
		taskState: new DefaultToolHandlerState(),
		interactions: {
			complete: vi.fn(async () => {
				if (options.rewriteAsAsk !== false) {
					const index = messages.findIndex((message) => message.ts === COMPLETION_TS)
					if (index !== -1) {
						// Mirrors MessageChannel.presentAsk: same ts, original result text.
						messages[index] = {
							...messages[index],
							type: "ask",
							say: undefined,
							ask: "completion_result",
							text: "done",
						}
					}
				}
				return { actionId: "start_new_task" as const, draft: { text: "", images: [], files: [] } }
			}),
			say: vi.fn(async () => undefined),
		},
		messageState: {
			get clineMessages() {
				return messages
			},
			updateClineMessage,
		} as unknown as TaskConfig["messageState"],
		api: {
			getModel: () => ({ id: "test-model", info: { supportsImages: false } }),
		} as unknown as TaskConfig["api"],
		autoApprovalSettings: { enableNotifications: false } as unknown as TaskConfig["autoApprovalSettings"],
		focusChainSettings: { enabled: false } as unknown as TaskConfig["focusChainSettings"],
		services: {
			stateManager: {
				getGlobalSettingsKey: (key: string) => (key === "hooksEnabled" ? false : undefined),
				getApiConfiguration: () => ({ planModeProfile: "openai", actModeProfile: "openai" }),
			} as unknown,
		} as unknown as TaskConfig["services"],
		callbacks: {
			say: vi.fn(async (type: string, text?: string) => {
				messages.push({ ts: COMPLETION_TS, type: "say", say: type, text } as UiMessage)
				return COMPLETION_TS
			}),
			saveCheckpoint: vi.fn().mockResolvedValue(undefined),
			doesLatestTaskCompletionHaveNewChanges: vi.fn().mockResolvedValue(options.hasNewChanges),
			updateFCListFromToolResponse: vi.fn().mockResolvedValue(undefined),
			runUserPromptSubmitHook: vi.fn().mockResolvedValue({}),
		} as unknown as TaskConfig["callbacks"],
	} as unknown as TaskConfig
	return { config, messages }
}

/**
 * Create a complete attempt_completion block.
 * @returns attempt_completion tool block anchored at COMPLETION_TS.
 */
function createBlock(): ToolUse {
	return {
		type: "tool_use",
		function_id: "completion-function-1",
		name: ClineDefaultTool.ATTEMPT,
		params: { result: "done" },
		partial: false,
		ts: COMPLETION_TS,
		dline_tid: "completion-1",
	} as ToolUse
}

describe("AttemptCompletionHandler workspace change verdict", () => {
	it("records the verdict so it survives the ask rewrite of the same row", async () => {
		const { config, messages } = createConfig({ hasNewChanges: true })

		await new AttemptCompletionHandler().execute(config, createBlock())

		const completionRow = messages.find((message) => message.ts === COMPLETION_TS)
		expect(completionRow?.completionHasChanges).toBe(true)
		// The rewrite must not be able to erase the verdict, and the presented
		// text must stay exactly what the model produced.
		expect(completionRow?.text).toBe("done")
	})

	it("leaves the verdict unset when the completion produced no workspace changes", async () => {
		const { config, messages } = createConfig({ hasNewChanges: false })

		await new AttemptCompletionHandler().execute(config, createBlock())

		const completionRow = messages.find((message) => message.ts === COMPLETION_TS)
		expect(completionRow?.completionHasChanges).toBeUndefined()
	})
})
