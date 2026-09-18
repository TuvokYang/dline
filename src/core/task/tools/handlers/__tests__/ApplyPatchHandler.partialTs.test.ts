import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import { ToolValidator } from "../../ToolValidator"
import type { TaskConfig } from "../../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../../types/UIHelpers"
import { FileProviderOperations } from "../../utils/FileProviderOperations"
import { ApplyPatchHandler, formatApplyPatchOutcomes } from "../ApplyPatchHandler"

vi.mock("@utils/path", async () => {
	const actual = await vi.importActual<typeof import("@utils/path")>("@utils/path")
	return {
		...actual,
		getReadablePath: (_cwd: string, relPath?: string) => relPath ?? "",
		isLocatedInWorkspace: vi.fn().mockResolvedValue(true),
	}
})

vi.mock("@/services/telemetry", () => ({
	telemetryService: {
		captureToolUsage: vi.fn(),
	},
}))

vi.mock("../../utils/AiOutputTelemetry", () => ({
	captureAccepted: vi.fn(),
	captureRejected: vi.fn(),
	getModelInfo: vi.fn().mockReturnValue({ providerId: "test-provider", modelId: "test-model" }),
}))

/**
 * Create a minimal task config for apply_patch partial rendering tests.
 *
 * @returns Task config and callback spies used by the handler.
 */
function createConfig(options?: {
	ask?: ReturnType<typeof vi.fn>
	say?: ReturnType<typeof vi.fn>
	provider?: Record<string, unknown>
}): { config: TaskConfig; ask: ReturnType<typeof vi.fn>; say: ReturnType<typeof vi.fn> } {
	const ask = options?.ask ?? vi.fn().mockRejectedValue(new Error("partial ask ignored"))
	const say = options?.say ?? vi.fn().mockResolvedValue(undefined)
	const config = {
		cwd: "e:/workspace/vscode/dline",
		isSubagentExecution: true,
		services: {
			stateManager: {
				getGlobalSettingsKey: vi.fn().mockReturnValue(false),
				getApiConfiguration: vi.fn().mockReturnValue({}),
			},
			diffViewProvider: options?.provider ?? {
				editType: undefined,
				originalContent: "",
			},
			taskFileTracker: { trackModification: vi.fn() },
			fileContextTracker: { markFileAsEditedByCline: vi.fn(), trackFileContext: vi.fn() },
		},
		taskState: { consecutiveMistakeCount: 0, fileReadCache: new Map(), didEditFile: false },
		callbacks: {
			ask,
			say,
		},
	} as unknown as TaskConfig

	return { config, ask, say }
}

/**
 * Create typed UI helpers backed by the minimal task config.
 *
 * @param config Task config returned by createConfig.
 * @returns UI helpers used by ApplyPatchHandler.handlePartialBlock.
 */
function createHelpers(config: TaskConfig): StronglyTypedUIHelpers {
	return {
		say: config.callbacks.say,
		ask: config.callbacks.ask,
		removeClosingTag: vi.fn(),
		getConfig: () => config,
	} as StronglyTypedUIHelpers
}

/**
 * Create a validator that allows all file paths.
 *
 * @returns ToolValidator instance for handler construction.
 */
function createValidator(): ToolValidator {
	return new ToolValidator({ validateAccess: vi.fn().mockReturnValue(true) } as never)
}

describe("ApplyPatchHandler result rendering", () => {
	it("maps each Add result to its file path", () => {
		expect(
			formatApplyPatchOutcomes([
				{ path: "first.txt", status: "added", result: { wroteLines: 2, savedLines: 2 } },
				{ path: "second.txt", status: "added", result: { wroteLines: 3, savedLines: 3 } },
			]),
		).toEqual(["first.txt: [added] (wrote 2 lines, saved 2 lines)", "second.txt: [added] (wrote 3 lines, saved 3 lines)"])
	})
})

describe("ApplyPatchHandler partial rendering", () => {
	it("uses block ts for partial presentation updates", async () => {
		const { config, say } = createConfig()
		const handler = new ApplyPatchHandler(createValidator())
		const blockTs = 123456

		await handler.handlePartialBlock(
			{
				type: "tool_use",
				name: ClineDefaultTool.APPLY_PATCH,
				partial: true,
				ts: blockTs,
				params: {
					input: "*** Begin Patch\n*** Add File: src/new-file.ts\n+export const value = 1\n*** End Patch",
				},
			} as never,
			createHelpers(config),
		)

		expect(say).toHaveBeenCalledWith("tool", expect.any(String), undefined, undefined, true, blockTs)
	})
})

describe("FileProviderOperations delete flow", () => {
	it("previews an existing file without reopening it before final deletion", async () => {
		const provider = {
			editType: undefined,
			isEditing: false,
			open: vi.fn(async () => {
				provider.isEditing = true
			}),
			update: vi.fn(async () => {}),
			deleteFile: vi.fn(async () => {
				provider.isEditing = false
			}),
		}
		const operations = new FileProviderOperations(provider as never)

		await operations.deleteFile("src/deleted.ts", false)

		expect(provider.editType).toBe("modify")
		expect(provider.open).toHaveBeenCalledTimes(1)
		expect(provider.update).toHaveBeenCalledWith("", true)

		await operations.deleteFile("src/deleted.ts")

		expect(provider.open).toHaveBeenCalledTimes(1)
		expect(provider.deleteFile).toHaveBeenCalledWith("src/deleted.ts")
	})
})
