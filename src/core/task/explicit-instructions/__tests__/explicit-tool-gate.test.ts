import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import { authorizeExplicitToolExecution } from "../explicit-tool-gate"
import type { ExplicitInstructionConsumePort } from "../types"

function createPort(result: ReturnType<ExplicitInstructionConsumePort["consumeTool"]>): ExplicitInstructionConsumePort {
    return {
        identity: { requestId: "request-1", attemptId: "attempt-1" },
        getPendingToolAuthorization: vi.fn(() => undefined),
        consumeTool: vi.fn(() => result),
    }
}

describe("authorizeExplicitToolExecution", () => {
    it("allows ordinary tools without consuming explicit authority", () => {
        const port = createPort({ ok: false, code: "explicit_instruction_missing" })

        expect(authorizeExplicitToolExecution(ClineDefaultTool.FILE_READ, port)).toEqual({ ok: true })
        expect(port.consumeTool).not.toHaveBeenCalled()
    })

    it.each([
        ClineDefaultTool.SUMMARIZE_TASK,
        ClineDefaultTool.NEW_TASK,
        ClineDefaultTool.NEW_RULE,
        ClineDefaultTool.REPORT_BUG,
        ClineDefaultTool.GENERATE_EXPLANATION,
    ])("rejects explicit-only tool %s when no request authority exists", (tool) => {
        const port = createPort({ ok: false, code: "explicit_instruction_missing" })

        expect(authorizeExplicitToolExecution(tool, port)).toEqual({
            ok: false,
            code: "explicit_instruction_missing",
        })
        expect(port.consumeTool).toHaveBeenCalledWith(tool)
    })

    it("permanently rejects retired condense without consulting request authority", () => {
        const port = createPort({ ok: true, authorization: {} as never })

        expect(authorizeExplicitToolExecution(ClineDefaultTool.CONDENSE, port)).toEqual({
            ok: false,
            code: "explicit_instruction_retired",
        })
        expect(port.consumeTool).not.toHaveBeenCalled()
    })

    it("returns the consumed authorization for the first matching complete call", () => {
        const authorization = {
            instructionId: "instruction-1",
            requestId: "request-1",
            attemptId: "attempt-1",
            type: "summarize_task" as const,
            source: "task_header" as const,
            targetTool: ClineDefaultTool.SUMMARIZE_TASK,
            state: "consumed" as const,
        }
        const port = createPort({ ok: true, authorization })

        expect(authorizeExplicitToolExecution(ClineDefaultTool.SUMMARIZE_TASK, port)).toEqual({
            ok: true,
            authorization,
        })
    })

    it("rejects replay with the registry failure code", () => {
        const port = createPort({ ok: false, code: "explicit_instruction_already_consumed" })

        expect(authorizeExplicitToolExecution(ClineDefaultTool.SUMMARIZE_TASK, port)).toEqual({
            ok: false,
            code: "explicit_instruction_already_consumed",
        })
    })
})
