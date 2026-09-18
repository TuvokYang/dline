import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { ClineDefaultTool } from "@shared/tools"
import { afterEach, describe, expect, it, vi } from "vitest"
import { prepareRegisteredToolAdmission } from "../../../executors/tool/ToolAdmissionRegistry"

const temporaryRoots: string[] = []

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("write admission target side effects", () => {
	it("keeps an external write closure unstarted while manual approval is pending", async () => {
		const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dline-write-admission-"))
		temporaryRoots.push(temporaryRoot)
		const workspaceDir = path.join(temporaryRoot, "workspace")
		const externalPath = path.join(temporaryRoot, "external", "proof.txt")
		await fs.mkdir(workspaceDir)
		const run = vi.fn(async () => {
			await fs.mkdir(path.dirname(externalPath), { recursive: true })
			await fs.writeFile(externalPath, "external risk proof", "utf8")
		})

		const admission = prepareRegisteredToolAdmission({
			canonicalToolName: ClineDefaultTool.FILE_NEW,
			block: {
				type: "tool_use",
				name: ClineDefaultTool.FILE_NEW,
				params: { absolutePath: externalPath, content: "external risk proof" },
				partial: false,
				ts: 1,
				function_id: "call-external-write",
				dline_tid: "dline-tid-external-write",
			},
			description: "[write_to_file for 'proof.txt']",
			snapshot: {
				taskId: "task-external-write",
				cwd: workspaceDir,
				workspaceRoots: [workspaceDir],
				settings: {
					...DEFAULT_AUTO_APPROVAL_SETTINGS,
					actions: {
						...DEFAULT_AUTO_APPROVAL_SETTINGS.actions,
						editFiles: true,
						editFilesExternally: false,
					},
				},
				blanket: {},
			},
			run,
		})

		expect(admission).toMatchObject({ outcome: "admitted", decision: { kind: "manual", scope: "edit_external" } })
		expect(run).not.toHaveBeenCalled()
		await expect(fs.access(externalPath)).rejects.toMatchObject({ code: "ENOENT" })
	})
})
