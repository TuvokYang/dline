import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import { ExplicitInstructionRegistry } from "../ExplicitInstructionRegistry"
import { getExplicitInstructionPolicy } from "../policy"

const REQUEST_ONE = { requestId: "request-1", attemptId: "attempt-1" } as const
const REQUEST_TWO = { requestId: "request-2", attemptId: "attempt-1" } as const

function registerSummarize(registry: ExplicitInstructionRegistry) {
    return registry.register({
        ...REQUEST_ONE,
        type: "summarize_task",
        source: "auto_compaction",
        targetTool: ClineDefaultTool.SUMMARIZE_TASK,
    })
}

describe("ExplicitInstructionRegistry", () => {
    it("consumes one exact request, attempt, type, source, and tool authorization", () => {
        const registry = new ExplicitInstructionRegistry()
        const authorization = registerSummarize(registry)

        const result = registry.consume({
            ...REQUEST_ONE,
            instructionId: authorization.instructionId,
            type: "summarize_task",
            source: "auto_compaction",
            targetTool: ClineDefaultTool.SUMMARIZE_TASK,
        })

        expect(result).toEqual({ ok: true, authorization: expect.objectContaining({ state: "consumed" }) })
    })

    it("rejects a tool call when no explicit authorization exists", () => {
        const registry = new ExplicitInstructionRegistry()

        expect(
            registry.consume({
                ...REQUEST_ONE,
                instructionId: "missing",
                type: "summarize_task",
                source: "auto_compaction",
                targetTool: ClineDefaultTool.SUMMARIZE_TASK,
            }),
        ).toEqual({ ok: false, code: "explicit_instruction_missing" })
    })

    it("rejects mismatched target tools without consuming the authorization", () => {
        const registry = new ExplicitInstructionRegistry()
        const authorization = registerSummarize(registry)

        expect(
            registry.consume({
                ...REQUEST_ONE,
                instructionId: authorization.instructionId,
                type: "summarize_task",
                source: "auto_compaction",
                targetTool: ClineDefaultTool.NEW_TASK,
            }),
        ).toEqual({ ok: false, code: "explicit_instruction_tool_mismatch" })
        expect(registry.get(authorization.instructionId)?.state).toBe("pending")
    })

    it("rejects source mismatches without consuming the authorization", () => {
        const registry = new ExplicitInstructionRegistry()
        const authorization = registerSummarize(registry)

        expect(
            registry.consume({
                ...REQUEST_ONE,
                instructionId: authorization.instructionId,
                type: "summarize_task",
                source: "manual_compact_command",
                targetTool: ClineDefaultTool.SUMMARIZE_TASK,
            }),
        ).toEqual({ ok: false, code: "explicit_instruction_source_mismatch" })
        expect(registry.get(authorization.instructionId)?.state).toBe("pending")
    })

    it("rejects cross-request and cross-attempt consumption", () => {
        const registry = new ExplicitInstructionRegistry()
        const authorization = registerSummarize(registry)
        const base = {
            instructionId: authorization.instructionId,
            type: "summarize_task" as const,
            source: "auto_compaction" as const,
            targetTool: ClineDefaultTool.SUMMARIZE_TASK,
        }

        expect(registry.consume({ ...base, ...REQUEST_TWO })).toEqual({
            ok: false,
            code: "explicit_instruction_request_mismatch",
        })
        expect(registry.consume({ ...base, requestId: REQUEST_ONE.requestId, attemptId: "attempt-2" })).toEqual({
            ok: false,
            code: "explicit_instruction_attempt_mismatch",
        })
    })

    it("rejects replay after one successful consumption", () => {
        const registry = new ExplicitInstructionRegistry()
        const authorization = registerSummarize(registry)
        const input = {
            ...REQUEST_ONE,
            instructionId: authorization.instructionId,
            type: "summarize_task" as const,
            source: "auto_compaction" as const,
            targetTool: ClineDefaultTool.SUMMARIZE_TASK,
        }

        expect(registry.consume(input).ok).toBe(true)
        expect(registry.consume(input)).toEqual({ ok: false, code: "explicit_instruction_already_consumed" })
    })

    it("expires every pending authorization when a request closes", () => {
        const registry = new ExplicitInstructionRegistry()
        const authorization = registerSummarize(registry)
        registry.closeRequest(REQUEST_ONE.requestId)

        expect(registry.get(authorization.instructionId)?.state).toBe("expired")
        expect(
            registry.consume({
                ...REQUEST_ONE,
                instructionId: authorization.instructionId,
                type: "summarize_task",
                source: "auto_compaction",
                targetTool: ClineDefaultTool.SUMMARIZE_TASK,
            }),
        ).toEqual({ ok: false, code: "explicit_instruction_expired" })
    })

    it("cancels request authority without making it executable again", () => {
        const registry = new ExplicitInstructionRegistry()
        const authorization = registerSummarize(registry)
        registry.cancelRequest(REQUEST_ONE.requestId)

        expect(registry.get(authorization.instructionId)?.state).toBe("cancelled")
    })

    it("creates a fresh authorization for a retry attempt and rejects the old attempt", () => {
        const registry = new ExplicitInstructionRegistry()
        const first = registerSummarize(registry)
        const second = registry.registerRetry(first.instructionId, "attempt-2")

        expect(second).toMatchObject({
            requestId: REQUEST_ONE.requestId,
            attemptId: "attempt-2",
            type: "summarize_task",
            source: "auto_compaction",
            state: "pending",
        })
        expect(second.instructionId).not.toBe(first.instructionId)
        expect(registry.get(first.instructionId)?.state).toBe("expired")
    })

    it("rejects policy-invalid target registration", () => {
        const registry = new ExplicitInstructionRegistry()
        expect(() =>
            registry.register({
                ...REQUEST_ONE,
                type: "summarize_task",
                source: "auto_compaction",
                targetTool: ClineDefaultTool.NEW_TASK,
            }),
        ).toThrow("must target 'summarize_task'")
        expect(() =>
            registry.register({
                ...REQUEST_ONE,
                type: "skill",
                source: "skill_injection",
                targetTool: ClineDefaultTool.SUMMARIZE_TASK,
            }),
        ).toThrow("cannot authorize a tool")
    })
})

describe("explicit instruction policy", () => {
    it("authorizes only the declared explicit-only target tools", () => {
        expect(getExplicitInstructionPolicy("summarize_task")).toMatchObject({
            authorizesTool: true,
            targetTool: ClineDefaultTool.SUMMARIZE_TASK,
        })
        expect(getExplicitInstructionPolicy("new_rule")).toMatchObject({
            authorizesTool: true,
            targetTool: ClineDefaultTool.NEW_RULE,
        })
        expect(getExplicitInstructionPolicy("deep-planning")).toMatchObject({
            authorizesTool: true,
            targetTool: ClineDefaultTool.NEW_TASK,
        })
    })

    it("does not grant hidden tool authority to skill or workflow instructions", () => {
        expect(getExplicitInstructionPolicy("skill")).toMatchObject({ authorizesTool: false })
        expect(getExplicitInstructionPolicy("workflow")).toMatchObject({ authorizesTool: false })
    })
})
