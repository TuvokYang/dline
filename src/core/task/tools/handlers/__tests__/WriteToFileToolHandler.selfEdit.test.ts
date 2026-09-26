import * as path from "node:path"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
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

const ORIGINAL = ["const a = 1", "const b = 2", ""].join("\n")

/** One applied block followed by one block that cannot match. */
const PARTIAL_DIFF = [
	"------- SEARCH",
	"const a = 1",
	"=======",
	"const a = 10",
	"+++++++ REPLACE",
	"------- SEARCH",
	"const missing = 0",
	"=======",
	"const missing = 1",
	"+++++++ REPLACE",
].join("\n")

describe("WriteToFileToolHandler self-edit bookkeeping", () => {
	it("records a partially applied edit as a Dline write", async () => {
		const order: string[] = []
		const fileContextTracker = {
			markFileAsEditedByCline: vi.fn(() => order.push("mark")),
			trackFileContext: vi.fn(async (_path: string, operation: string) => {
				order.push(`track:${operation}`)
			}),
			settleClineEdit: vi.fn(() => order.push("settle")),
		}
		const taskFileTracker = { trackModification: vi.fn() }
		const diffViewProvider = {
			editType: "modify",
			originalContent: ORIGINAL,
			isEditing: true,
			open: vi.fn().mockResolvedValue(undefined),
			update: vi.fn().mockResolvedValue(undefined),
			saveChanges: vi.fn(async () => {
				order.push("save")
				return { savedLines: 2 }
			}),
			reset: vi.fn().mockResolvedValue(undefined),
			revertChanges: vi.fn().mockResolvedValue(undefined),
		}
		const absolutePath = path.resolve("e:/workspace/sample.ts")
		const readCache = new Map([[absolutePath.toLowerCase(), "stale"]])
		const taskState = { consecutiveMistakeCount: 0, fileReadCache: readCache, didEditFile: false }
		const config = {
			cwd: "e:/workspace",
			isMultiRootEnabled: false,
			api: { getModel: () => ({ id: "test-model", info: {} }) },
			services: { diffViewProvider, fileContextTracker, taskFileTracker },
			taskState,
			callbacks: { say: vi.fn().mockResolvedValue(undefined), ask: vi.fn() },
		} as unknown as TaskConfig
		const handler = new WriteToFileToolHandler(new ToolValidator({ validateAccess: vi.fn().mockReturnValue(true) } as never))

		const result = await handler.execute(config, {
			type: "tool_use",
			name: ClineDefaultTool.FILE_EDIT,
			partial: false,
			ts: 9,
			params: { absolutePath: "e:/workspace/sample.ts", diff: PARTIAL_DIFF },
		} as never)

		expect(result).toContain("Block #1: success")
		expect(order).toEqual(["mark", "save", "track:cline_edited", "settle"])
		expect(taskFileTracker.trackModification).toHaveBeenCalledWith(absolutePath)
		expect(taskState.didEditFile).toBe(true)
		expect(readCache.has(absolutePath.toLowerCase())).toBe(false)
	})
})
