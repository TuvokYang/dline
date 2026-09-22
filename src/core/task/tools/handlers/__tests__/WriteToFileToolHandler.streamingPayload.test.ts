import type { ClineSayTool } from "@shared/ExtensionMessage"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import { ToolValidator } from "../../ToolValidator"
import type { TaskConfig } from "../../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../../types/UIHelpers"
import { WriteToFileToolHandler } from "../WriteToFileToolHandler"

// The streaming card must go through the same path projection as the final
// card. Marking the call makes the assertion prove that projection happened,
// instead of accidentally passing on a path that is already relative.
vi.mock("@utils/path", async () => {
	const actual = await vi.importActual<typeof import("@utils/path")>("@utils/path")
	return {
		...actual,
		getReadablePath: (_cwd: string, relPath?: string) => `projected:${relPath ?? ""}`,
		isLocatedInWorkspace: vi.fn().mockResolvedValue(true),
	}
})

vi.mock("@/services/telemetry", () => ({
	telemetryService: { captureToolUsage: vi.fn() },
}))

vi.mock("../../utils/AiOutputTelemetry", () => ({
	captureAccepted: vi.fn(),
	captureRejected: vi.fn(),
	getModelInfo: vi.fn().mockReturnValue({ providerId: "test-provider", modelId: "test-model" }),
}))

const ORIGINAL_CONTENT = ["const a = 1", "const b = 2", "const c = 3"].join("\n")

const SEARCH_REPLACE_MARKERS = ["------- SEARCH", "=======", "+++++++ REPLACE"]

/**
 * Build a complete SEARCH/REPLACE block for the streamed diff parameter.
 *
 * @param searchText Lines the model claims to find.
 * @param replaceText Lines the model wants to write.
 * @returns Raw diff text as the model streams it.
 */
function searchReplace(searchText: string, replaceText: string): string {
	return ["------- SEARCH", searchText, "=======", replaceText, "+++++++ REPLACE"].join("\n")
}

/**
 * Create a minimal task config for streaming payload assertions.
 *
 * @param originalContent File content the diff parser matches against.
 * @returns Task config plus the say spy that captures streamed payloads.
 */
function createConfig(originalContent: string): { config: TaskConfig; say: ReturnType<typeof vi.fn> } {
	const say = vi.fn().mockResolvedValue(undefined)
	const config = {
		cwd: "e:/workspace/vscode/dline",
		isSubagentExecution: true,
		services: {
			stateManager: {
				getGlobalSettingsKey: vi.fn().mockReturnValue(false),
				getApiConfiguration: vi.fn().mockReturnValue({}),
			},
			diffViewProvider: { editType: "modify", originalContent, isEditing: false },
			taskFileTracker: { trackModification: vi.fn() },
			fileContextTracker: { markFileAsEditedByCline: vi.fn(), trackFileContext: vi.fn() },
		},
		taskState: { consecutiveMistakeCount: 0, fileReadCache: new Map(), didEditFile: false },
		callbacks: { ask: vi.fn(), say },
	} as unknown as TaskConfig

	return { config, say }
}

/**
 * Create UI helpers whose removeClosingTag keeps the streamed value intact.
 *
 * @param config Task config backing the helpers.
 * @returns UI helpers consumed by handlePartialBlock.
 */
function createHelpers(config: TaskConfig): StronglyTypedUIHelpers {
	return {
		say: config.callbacks.say,
		ask: config.callbacks.ask,
		removeClosingTag: (_block: unknown, _tag: unknown, text?: string) => text ?? "",
		getConfig: () => config,
	} as unknown as StronglyTypedUIHelpers
}

/**
 * Stream one partial replace_in_file block and return the rendered payload.
 *
 * @param diff Raw diff parameter as streamed so far.
 * @param originalContent File content the parser matches against.
 * @returns Parsed ClineSayTool payload handed to the webview.
 */
async function streamPartialEdit(diff: string, originalContent = ORIGINAL_CONTENT): Promise<ClineSayTool> {
	const { config, say } = createConfig(originalContent)
	const handler = new WriteToFileToolHandler(new ToolValidator({ validateAccess: vi.fn().mockReturnValue(true) } as never))

	await handler.handlePartialBlock(
		{
			type: "tool_use",
			name: ClineDefaultTool.FILE_EDIT,
			partial: true,
			ts: 4242,
			params: { absolutePath: "e:/workspace/vscode/dline/src/sample.ts", diff },
		} as never,
		createHelpers(config),
	)

	expect(say).toHaveBeenCalled()
	const [, payload] = say.mock.calls.at(-1) as [string, string]
	return JSON.parse(payload) as ClineSayTool
}

describe("WriteToFileToolHandler streaming payload", () => {
	it("projects the streamed path exactly like the final card", async () => {
		const message = await streamPartialEdit(searchReplace("const b = 2", "const b = 20"))

		// The regression shipped the raw absolutePath parameter, so the card
		// showed a full disk path until the edit finished.
		expect(message.path).toBe("projected:e:/workspace/vscode/dline/src/sample.ts")
	})

	it("streams matched blocks as +/- projected lines without SEARCH/REPLACE markers", async () => {
		const message = await streamPartialEdit(searchReplace("const b = 2", "const b = 20"))

		expect(Array.isArray(message.content)).toBe(true)
		const blocks = message.content as unknown as string[]
		expect(blocks).toEqual(["- const b = 2\n+ const b = 20"])

		// A marker line reaching the webview is what painted the card red on top
		// and green at the bottom, because the renderer colours by first char.
		for (const marker of SEARCH_REPLACE_MARKERS) {
			expect(blocks.join("\n")).not.toContain(marker)
		}
	})

	it("keeps projecting while the SEARCH text has not matched yet", async () => {
		// A match failure is not conclusive mid-stream: the file content may not
		// be loaded yet, and the model may still be streaming the lines that
		// would match. Falling back to the raw block here is what made the card
		// flip between projected and raw output on consecutive chunks, which the
		// webview renders as a diff card collapsing and expanding.
		const message = await streamPartialEdit(searchReplace("const missing = 0", "const missing = 1"))

		const blocks = message.content as unknown as string[]
		expect(Array.isArray(blocks)).toBe(true)
		expect(blocks).toEqual(["- const missing = 0\n+ const missing = 1"])
	})

	it("does not report match failures as streaming block errors", async () => {
		const message = await streamPartialEdit(searchReplace("const missing = 0", "const missing = 1"))

		// SEARCH_NOT_FOUND is not decidable while the diff is still arriving:
		// the model may still be streaming the very lines that would match.
		// JSON transport turns an absent error into null, which the webview
		// reads as "no error" through a truthiness check.
		expect(message.blockErrors?.some((error) => error != null) ?? false).toBe(false)
	})

	it("keeps one block in the same shape across consecutive chunks", async () => {
		// The card flips visual mode when a block moves between the projected
		// lines and the raw block text. Driving the same block through a chunk
		// that cannot match yet and a chunk that can must not produce that flip.
		const diff = searchReplace("const b = 2", "const b = 20")

		const beforeContentLoaded = await streamPartialEdit(diff, "")
		const afterContentLoaded = await streamPartialEdit(diff, ORIGINAL_CONTENT)

		const before = (beforeContentLoaded.content as unknown as string[])[0]
		const after = (afterContentLoaded.content as unknown as string[])[0]

		expect(before).toBe(after)
		expect(before.startsWith("- ")).toBe(true)
	})

	it("falls back to the raw block only for a conclusive syntax error", async () => {
		// A too-short delimiter is decidable from the streamed text alone, so it
		// stays an error on every later chunk too. That makes the raw fallback
		// stable instead of something the next chunk can undo.
		const message = await streamPartialEdit(
			["----- SEARCH", "const b = 2", "=======", "const b = 20", "+++++++ REPLACE"].join("\n"),
		)

		const blocks = message.content as unknown as string[]
		expect(blocks.join("\n")).toContain("----- SEARCH")
		expect(message.blockErrors?.some((error) => error != null)).toBe(true)
	})
})
