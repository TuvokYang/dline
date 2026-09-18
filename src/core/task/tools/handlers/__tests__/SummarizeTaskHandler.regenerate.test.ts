import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import type { TaskConfig } from "../../types/TaskConfig"
import { SummarizeTaskHandler } from "../SummarizeTaskHandler"

const summaryBlock = {
	type: "tool_use",
	name: ClineDefaultTool.SUMMARIZE_TASK,
	partial: false,
	function_id: "call-summary-first",
	dline_tid: "dline-summary-first",
	ts: 12345,
	params: { context: "First generated summary" },
} as const

describe("SummarizeTaskHandler manual compatibility", () => {
	it("does not own regeneration, deleted-range, or canonical mutation", async () => {
		const apiConversationHistory = [
			{ role: "user", content: [{ type: "text", text: "Initial task" }] },
			{ role: "assistant", content: [{ type: "text", text: "Previous response" }] },
		]
		const updateTaskHistory = vi.fn(async () => undefined)
		const taskState = {
			consecutiveMistakeCount: 0,
			isManualContextCompactionRequest: false,
			isInternalContextCompactionRequest: false,
			pendingManualCompactionRegeneration: undefined,
			conversationHistoryDeletedRange: undefined,
		}
		const config = {
			taskId: "task-regenerate",
			ulid: "task-regenerate",
			explicitInstructionAuthorization: {
				type: "summarize_task",
				targetTool: ClineDefaultTool.SUMMARIZE_TASK,
				state: "consumed",
				source: "manual_compact_command",
				operationId: "manual-operation",
			},
			taskState,
			messageState: {
				apiConversationHistory,
				clineMessages: [],
				updateTaskHistory,
			},
			services: {
				stateManager: {
					getGlobalSettingsKey: vi.fn(() => false),
				},
				contextManager: {
					getContextTelemetryData: vi.fn(() => undefined),
				},
			},
			callbacks: {
				say: vi.fn(async () => undefined),
				sayAndCreateMissingParamError: vi.fn(),
			},
		} as unknown as TaskConfig
		const handler = new SummarizeTaskHandler({} as never)

		const result = await handler.execute(config, summaryBlock as never)

		expect(result).toContain("First generated summary")
		expect(taskState.pendingManualCompactionRegeneration).toBeUndefined()
		expect(taskState.conversationHistoryDeletedRange).toBeUndefined()
		expect(updateTaskHistory).not.toHaveBeenCalled()
		expect(apiConversationHistory).toHaveLength(2)
	})

	it("executes approved enrichment through the retained admission effect", async () => {
		const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "dline-summary-workspace-"))
		try {
			await fs.writeFile(path.join(workspaceDir, "proof.txt"), "workspace proof", "utf8")
			const trackFileContext = vi.fn(async () => undefined)
			const context = "Summary\n\n9. Required Files:\n- proof.txt"
			const config = {
				taskId: "task-workspace-summary",
				ulid: "task-workspace-summary",
				cwd: workspaceDir,
				workspaceManager: {
					getRoots: () => [{ name: "workspace", path: workspaceDir }],
					getPrimaryRoot: () => ({ name: "workspace", path: workspaceDir }),
				},
				yoloModeToggled: false,
				isSubagentExecution: false,
				autoApprovalSettings: DEFAULT_AUTO_APPROVAL_SETTINGS,
				explicitInstructionAuthorization: {
					type: "summarize_task",
					targetTool: ClineDefaultTool.SUMMARIZE_TASK,
					state: "consumed",
					source: "manual_compact_command",
					operationId: "manual-workspace-operation",
				},
				taskState: {
					consecutiveMistakeCount: 0,
					isManualContextCompactionRequest: false,
					isInternalContextCompactionRequest: false,
				},
				messageState: {
					apiConversationHistory: [],
					clineMessages: [],
				},
				services: {
					stateManager: {
						getGlobalSettingsKey: vi.fn(() => false),
					},
					contextManager: {
						getContextTelemetryData: vi.fn(() => undefined),
					},
					fileContextTracker: { trackFileContext },
				},
				callbacks: {
					say: vi.fn(async () => undefined),
					sayAndCreateMissingParamError: vi.fn(),
				},
			} as unknown as TaskConfig
			const handler = new SummarizeTaskHandler({ checkClineIgnorePath: () => ({ ok: true }) } as never)
			const block = { ...summaryBlock, params: { context } }

			const result = await handler.execute(config, block as never)

			expect(JSON.stringify(result)).toContain("workspace proof")
			expect(trackFileContext).toHaveBeenCalledWith("proof.txt", "file_mentioned")
		} finally {
			await fs.rm(workspaceDir, { recursive: true, force: true })
		}
	})

	it("does not enrich from a workspace junction whose canonical target requires manual approval", async () => {
		const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dline-summary-junction-"))
		try {
			const workspaceDir = path.join(temporaryRoot, "workspace")
			const externalDir = path.join(temporaryRoot, "external")
			const linkedDir = path.join(workspaceDir, "linked-outside")
			await fs.mkdir(workspaceDir)
			await fs.mkdir(externalDir)
			await fs.writeFile(path.join(externalDir, "proof.txt"), "external secret", "utf8")
			await fs.symlink(externalDir, linkedDir, process.platform === "win32" ? "junction" : "dir")
			const trackFileContext = vi.fn(async () => undefined)
			const context = "Summary\n\n9. Required Files:\n- linked-outside/proof.txt"
			const config = {
				taskId: "task-junction-summary",
				ulid: "task-junction-summary",
				cwd: workspaceDir,
				workspaceManager: {
					getRoots: () => [{ name: "workspace", path: workspaceDir }],
					getPrimaryRoot: () => ({ name: "workspace", path: workspaceDir }),
				},
				yoloModeToggled: false,
				isSubagentExecution: false,
				autoApprovalSettings: {
					...DEFAULT_AUTO_APPROVAL_SETTINGS,
					actions: {
						...DEFAULT_AUTO_APPROVAL_SETTINGS.actions,
						readFiles: true,
						readFilesExternally: true,
					},
					ceilings: { read_external: "manual_only" },
				},
				explicitInstructionAuthorization: {
					type: "summarize_task",
					targetTool: ClineDefaultTool.SUMMARIZE_TASK,
					state: "consumed",
					source: "manual_compact_command",
					operationId: "manual-junction-operation",
				},
				taskState: {
					consecutiveMistakeCount: 0,
					isManualContextCompactionRequest: false,
					isInternalContextCompactionRequest: false,
				},
				messageState: {
					apiConversationHistory: [],
					clineMessages: [],
				},
				services: {
					stateManager: {
						getGlobalSettingsKey: vi.fn(() => false),
					},
					contextManager: {
						getContextTelemetryData: vi.fn(() => undefined),
					},
					fileContextTracker: { trackFileContext },
				},
				callbacks: {
					say: vi.fn(async () => undefined),
					sayAndCreateMissingParamError: vi.fn(),
				},
			} as unknown as TaskConfig
			const handler = new SummarizeTaskHandler({ checkClineIgnorePath: () => ({ ok: true }) } as never)
			const block = { ...summaryBlock, params: { context } }

			const result = await handler.execute(config, block as never)

			expect(JSON.stringify(result)).not.toContain("external secret")
			expect(trackFileContext).not.toHaveBeenCalled()
		} finally {
			await fs.rm(temporaryRoot, { recursive: true, force: true })
		}
	})
})
