import os from "node:os"
import path from "node:path"
import { getTaskArtifactDirectory } from "@core/artifacts/runtime"
import type { ToolUse } from "@core/assistant-message"
import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import { prepareRegisteredToolAdmission } from "../../executors/tool/ToolAdmissionRegistry"

function decision(taskId: string, workspaceDirectory: string, toolName: ClineDefaultTool, target: string) {
	const block: ToolUse = {
		type: "tool_use",
		name: toolName,
		params: { path: target },
		partial: false,
		function_id: `function-${toolName}`,
		dline_tid: `dline-${toolName}`,
		ts: 1,
	}
	const admission = prepareRegisteredToolAdmission({
		canonicalToolName: toolName,
		block,
		description: "task read",
		snapshot: {
			taskId,
			cwd: workspaceDirectory,
			workspaceRoots: [workspaceDirectory],
			settings: {
				...DEFAULT_AUTO_APPROVAL_SETTINGS,
				actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, readFiles: true, readFilesExternally: false },
			},
			blanket: {},
		},
		run: async () => undefined,
	})
	if (admission.outcome !== "admitted") throw new Error(admission.rejection.message)
	return admission.decision
}

describe("canonical task read scope", () => {
	it("uses Read project files for only the current task artifacts and tmp directories", () => {
		const taskId = "task-read-scope"
		const workspaceDirectory = path.join(os.tmpdir(), "dline-project-read-scope")
		const taskDirectory = getTaskArtifactDirectory(taskId)
		const artifactPath = path.join(taskDirectory, "artifacts", "images", "generated.png")
		const previewPath = path.join(taskDirectory, "tmp", "image-previews", "preview")
		const taskHistoryPath = path.join(taskDirectory, "ui_messages.jsonl")
		const otherTaskArtifactPath = path.join(getTaskArtifactDirectory("another-task"), "artifacts", "images", "generated.png")

		expect(decision(taskId, workspaceDirectory, ClineDefaultTool.FILE_READ, artifactPath).kind).toBe("automatic")
		expect(decision(taskId, workspaceDirectory, ClineDefaultTool.FILE_READ, previewPath).kind).toBe("automatic")
		expect(decision(taskId, workspaceDirectory, ClineDefaultTool.FILE_READ, taskHistoryPath).kind).toBe("manual")
		expect(decision(taskId, workspaceDirectory, ClineDefaultTool.FILE_READ, otherTaskArtifactPath).kind).toBe("manual")
		expect(decision(taskId, workspaceDirectory, ClineDefaultTool.LIST_FILES, artifactPath).kind).toBe("manual")
	})
})
