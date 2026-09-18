import path from "node:path"
import { type AutoApprovalSettings, DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import type { ToolUse } from "../../assistant-message"
import { prepareRegisteredToolAdmission } from "../executors/tool/ToolAdmissionRegistry"

function makeBlock(name: ClineDefaultTool, params: ToolUse["params"]): ToolUse {
	return {
		type: "tool_use",
		function_id: `test_${name}`,
		dline_tid: `test_tid_${name}`,
		name,
		params,
		partial: false,
		ts: 1,
	}
}

function decision(name: ClineDefaultTool, params: ToolUse["params"], actions: Partial<AutoApprovalSettings["actions"]>) {
	const admission = prepareRegisteredToolAdmission({
		canonicalToolName: name,
		block: makeBlock(name, params),
		description: `[${name}]`,
		snapshot: {
			taskId: "task-auto-approval",
			cwd: path.resolve("/workspace/project"),
			workspaceRoots: [path.resolve("/workspace/project")],
			settings: {
				...DEFAULT_AUTO_APPROVAL_SETTINGS,
				actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, ...actions },
				enableNotifications: false,
			},
			blanket: {},
		},
		run: async () => undefined,
	})
	if (admission.outcome !== "admitted") throw new Error(admission.rejection.message)
	return admission.decision
}

describe("canonical tool admission", () => {
	it("distinguishes safe and explicitly risky commands", () => {
		expect(
			decision(
				ClineDefaultTool.BASH,
				{ command: "echo ok", requires_approval: "false" },
				{ executeSafeCommands: true, executeAllCommands: false },
			).kind,
		).toBe("automatic")
		expect(
			decision(
				ClineDefaultTool.BASH,
				{ command: "rm -rf build", requires_approval: "true" },
				{ executeSafeCommands: true, executeAllCommands: false },
			).kind,
		).toBe("manual")
	})

	it("classifies workspace and external read scopes before deciding", () => {
		expect(
			decision(ClineDefaultTool.FILE_READ, { path: "src/index.ts" }, { readFiles: true, readFilesExternally: false }),
		).toMatchObject({ kind: "automatic", scope: "read_workspace" })
		expect(
			decision(
				ClineDefaultTool.FILE_READ,
				{ path: path.resolve("/workspace/secret.txt") },
				{
					readFiles: true,
					readFilesExternally: false,
				},
			),
		).toMatchObject({ kind: "manual", scope: "read_external" })
	})

	it("rejects a command whose explicit approval classification is missing", () => {
		const admission = prepareRegisteredToolAdmission({
			canonicalToolName: ClineDefaultTool.BASH,
			block: makeBlock(ClineDefaultTool.BASH, { command: "echo ok" }),
			description: "[execute_command]",
			snapshot: {
				taskId: "task-auto-approval",
				cwd: path.resolve("/workspace/project"),
				workspaceRoots: [path.resolve("/workspace/project")],
				settings: DEFAULT_AUTO_APPROVAL_SETTINGS,
				blanket: {},
			},
			run: async () => undefined,
		})
		expect(admission).toMatchObject({ outcome: "rejected", rejection: { reason: "invalid_parameters" } })
	})
})
