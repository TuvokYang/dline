import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ClineSayTool } from "@shared/ExtensionMessage"
import { ClineDefaultTool } from "@shared/tools"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ToolValidator } from "../../ToolValidator"
import type { TaskConfig } from "../../types/TaskConfig"
import { WriteToFileToolHandler } from "../WriteToFileToolHandler"

vi.mock("@utils/path", async () => {
	const actual = await vi.importActual<typeof import("@utils/path")>("@utils/path")
	return { ...actual, isLocatedInWorkspace: vi.fn().mockResolvedValue(true) }
})

vi.mock("@/services/telemetry", () => ({
	telemetryService: { captureToolUsage: vi.fn(), captureDiffEditFailure: vi.fn() },
}))

vi.mock("../../utils/AiOutputTelemetry", () => ({
	captureAccepted: vi.fn(),
	captureRejected: vi.fn(),
	getModelInfo: vi.fn().mockReturnValue({ providerId: "test-provider", modelId: "test-model" }),
}))

const temporaryRoots: string[] = []

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

const DIFF = ["------- SEARCH", "const a = 1", "=======", "const a = 2", "+++++++ REPLACE"].join("\n")

/**
 * Build a task config whose diff view has not been opened yet.
 *
 * @param cwd Workspace root the relative path resolves against.
 * @returns Config plus the spies the assertions inspect.
 */
function createConfig(cwd: string) {
	const say = vi.fn().mockResolvedValue(undefined)
	const diffViewProvider = {
		editType: undefined as string | undefined,
		originalContent: undefined,
		isEditing: false,
		open: vi.fn().mockResolvedValue(undefined),
		reset: vi.fn().mockResolvedValue(undefined),
		revertChanges: vi.fn().mockResolvedValue(undefined),
	}
	const taskState = { consecutiveMistakeCount: 0, fileReadCache: new Map(), didEditFile: false }
	const config = {
		cwd,
		isMultiRootEnabled: false,
		ulid: "test-ulid",
		api: { getModel: () => ({ id: "test-model", info: {} }) },
		services: { diffViewProvider },
		taskState,
		callbacks: { say, ask: vi.fn() },
	} as unknown as TaskConfig
	return { config, say, diffViewProvider, taskState }
}

describe("WriteToFileToolHandler missing replace_in_file target", () => {
	it("refuses a missing file without opening the editor or creating anything", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "dline-replace-missing-"))
		temporaryRoots.push(workspace)
		const relPath = path.join("missing-dir", "not_exist_file.md")
		const { config, say, diffViewProvider, taskState } = createConfig(workspace)
		const handler = new WriteToFileToolHandler(new ToolValidator({ validateAccess: vi.fn().mockReturnValue(true) } as never))

		const result = await handler.execute(config, {
			type: "tool_use",
			name: ClineDefaultTool.FILE_EDIT,
			partial: false,
			ts: 7,
			params: { path: relPath, diff: DIFF },
		} as never)

		expect(result).toContain("the file does not exist, so nothing was changed or created")
		expect(result).toContain("write_to_file")
		expect(result).not.toContain("was not found in the file")
		expect(diffViewProvider.open).not.toHaveBeenCalled()
		expect(diffViewProvider.editType).toBeUndefined()
		expect(taskState.consecutiveMistakeCount).toBe(1)
		await expect(fs.access(path.join(workspace, "missing-dir"))).rejects.toMatchObject({ code: "ENOENT" })

		const [, payload] = say.mock.calls.at(-1) as [string, string]
		const card = JSON.parse(payload) as ClineSayTool
		expect(card.blockErrors).toEqual(["File not found"])
	})
})
