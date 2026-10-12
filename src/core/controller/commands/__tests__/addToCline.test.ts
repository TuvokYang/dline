import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Controller } from "../../index"
import { addToCline } from "../addToCline"

const mocks = vi.hoisted(() => ({
    getFileMentionFromPath: vi.fn(async () => "@/sample.ts"),
    singleFileDiagnosticsToProblemsString: vi.fn(async () => "mock problem"),
    sendAddToInputEvent: vi.fn(async () => undefined),
    captureButtonClick: vi.fn(),
}))

vi.mock("@core/mentions", () => ({ getFileMentionFromPath: mocks.getFileMentionFromPath }))
vi.mock("@integrations/diagnostics", () => ({
    singleFileDiagnosticsToProblemsString: mocks.singleFileDiagnosticsToProblemsString,
}))
vi.mock("@services/telemetry", () => ({
    telemetryService: { captureButtonClick: mocks.captureButtonClick },
}))
vi.mock("../../ui/subscribeToAddToInput", () => ({ sendAddToInputEvent: mocks.sendAddToInputEvent }))

const request = {
    selectedText: "const answer = 42",
    filePath: "e:\\workspace\\sample.ts",
    diagnostics: [],
    language: "typescript",
}

describe("addToCline", () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it("starts an independent task when routed to an editor panel", async () => {
        const initTask = vi.fn(async () => "panel-task")
        const controller = { initTask, task: undefined } as unknown as Controller

        await addToCline(controller, request, undefined, { startTask: true })

        expect(initTask).toHaveBeenCalledOnce()
        expect(initTask).toHaveBeenCalledWith(expect.stringContaining("const answer = 42"))
        expect(mocks.sendAddToInputEvent).not.toHaveBeenCalled()
    })

    it("keeps the draft workflow when routed to an idle sidebar", async () => {
        const initTask = vi.fn()
        const controller = { initTask, task: undefined } as unknown as Controller

        await addToCline(controller, request)

        expect(initTask).not.toHaveBeenCalled()
        expect(mocks.sendAddToInputEvent).toHaveBeenCalledOnce()
        const selection = "\n```\nconst answer = 42\n```"
        expect(mocks.sendAddToInputEvent).toHaveBeenCalledWith(controller, {
            text: `@/sample.ts${selection}`,
            mentionReference: "/sample.ts",
            selection,
        })
    })

    it("keeps problems inside the selection literal and normalizes the mention separators", async () => {
        mocks.getFileMentionFromPath.mockResolvedValueOnce("@/src\\nested\\sample.ts")
        const controller = { initTask: vi.fn(), task: undefined } as unknown as Controller

        await addToCline(controller, { ...request, diagnostics: [{} as never] })

        expect(mocks.sendAddToInputEvent).toHaveBeenCalledWith(controller, {
            text: "@/src\\nested\\sample.ts\n```\nconst answer = 42\n```\nProblems:\nmock problem",
            mentionReference: "/src/nested/sample.ts",
            selection: "\n```\nconst answer = 42\n```\nProblems:\nmock problem",
        })
    })

    it("sends no mention when the selection has no file", async () => {
        const controller = { initTask: vi.fn(), task: undefined } as unknown as Controller

        await addToCline(controller, { ...request, filePath: "" })

        expect(mocks.sendAddToInputEvent).toHaveBeenCalledWith(
            controller,
            expect.not.objectContaining({ mentionReference: expect.anything() }),
        )
    })
})
