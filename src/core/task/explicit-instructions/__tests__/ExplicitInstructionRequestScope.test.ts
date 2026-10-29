import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import { ExplicitInstructionRegistry } from "../ExplicitInstructionRegistry"
import { ExplicitInstructionRequestScope } from "../ExplicitInstructionRequestScope"

const FIRST_ATTEMPT = { requestId: "request-1", attemptId: "attempt-1" } as const

function registerSummary(scope: ExplicitInstructionRequestScope) {
    return scope.register({
        type: "summarize_task",
        source: "auto_compaction",
        targetTool: DlineDefaultTool.SUMMARIZE_TASK,
    })
}

describe("ExplicitInstructionRequestScope", () => {
    it("binds registrations and consumption to one request attempt snapshot", () => {
        const registry = new ExplicitInstructionRegistry()
        const scope = new ExplicitInstructionRequestScope(registry, FIRST_ATTEMPT)
        const authorization = registerSummary(scope)
        const port = scope.createConsumePort()

        expect(authorization).toMatchObject(FIRST_ATTEMPT)
        expect(port.identity).toEqual(FIRST_ATTEMPT)
        expect(port.consumeTool(DlineDefaultTool.SUMMARIZE_TASK)).toEqual({
            ok: true,
            authorization: expect.objectContaining({
                instructionId: authorization.instructionId,
                state: "consumed",
            }),
        })
        expect(port.consumeTool(DlineDefaultTool.SUMMARIZE_TASK)).toEqual({
            ok: false,
            code: "explicit_instruction_already_consumed",
        })
    })

    it("keeps an old attempt port invalid after retry rollover", () => {
        const registry = new ExplicitInstructionRegistry()
        const scope = new ExplicitInstructionRequestScope(registry, FIRST_ATTEMPT)
        const first = registerSummary(scope)
        const oldPort = scope.createConsumePort()
        scope.beginRetryAttempt("attempt-2")
        const current = scope.getPendingToolAuthorization(DlineDefaultTool.SUMMARIZE_TASK)
        const currentPort = scope.createConsumePort()

        expect(current).toMatchObject({ requestId: "request-1", attemptId: "attempt-2", state: "pending" })
        expect(oldPort.consumeTool(DlineDefaultTool.SUMMARIZE_TASK)).toEqual({
            ok: false,
            code: "explicit_instruction_expired",
        })
        expect(currentPort.consumeTool(DlineDefaultTool.SUMMARIZE_TASK).ok).toBe(true)
    })

    it("registers authority without changing the model-visible instruction text", () => {
        const registry = new ExplicitInstructionRegistry()
        const scope = new ExplicitInstructionRequestScope(registry, FIRST_ATTEMPT)
        const template =
            '<explicit_instructions type="new_task">Use <new_task><context>...</context></new_task>.</explicit_instructions>'

        const registered = scope.registerInstruction(template, {
            type: "new_task",
            source: "slash_command",
            targetTool: DlineDefaultTool.NEW_TASK,
        })

        expect(registered.text).toBe(template)
        expect(registered.text).not.toContain("instruction_id")
        expect(registered.authorization).toMatchObject({ ...FIRST_ATTEMPT, type: "new_task", state: "pending" })
    })

    it("rolls provider attempts and consumes behavior authority without rewriting prompt text", () => {
        const registry = new ExplicitInstructionRegistry()
        const scope = new ExplicitInstructionRequestScope(registry, FIRST_ATTEMPT)
        const summary = registerSummary(scope)
        const skill = scope.register({
            type: "skill",
            source: "skill_injection",
            metadata: { name: "reviewer" },
        })
        expect(scope.beginProviderAttempt()).toBeUndefined()
        expect(registry.get(skill.instructionId)?.state).toBe("consumed")

        expect(scope.beginProviderAttempt("attempt-2")).toBeUndefined()
        const current = scope.getPendingToolAuthorization(DlineDefaultTool.SUMMARIZE_TASK)
        expect(current).toMatchObject({ attemptId: "attempt-2", state: "pending" })
    })

    it("expires pending authority when the request closes", () => {
        const registry = new ExplicitInstructionRegistry()
        const scope = new ExplicitInstructionRequestScope(registry, FIRST_ATTEMPT)
        registerSummary(scope)
        const port = scope.createConsumePort()

        scope.close()

        expect(port.consumeTool(DlineDefaultTool.SUMMARIZE_TASK)).toEqual({
            ok: false,
            code: "explicit_instruction_expired",
        })
        expect(() => registerSummary(scope)).toThrow("Explicit instruction request scope is closed")
    })

    it("consumes request-bound behavior instructions without granting a tool", () => {
        const registry = new ExplicitInstructionRegistry()
        const scope = new ExplicitInstructionRequestScope(registry, FIRST_ATTEMPT)
        const skill = scope.register({
            type: "skill",
            source: "skill_injection",
            metadata: { name: "reviewer" },
        })

        expect(scope.consumeBehaviorInstructions()).toEqual([
            expect.objectContaining({ instructionId: skill.instructionId, state: "consumed" }),
        ])
        expect(scope.createConsumePort().consumeTool(DlineDefaultTool.SUMMARIZE_TASK)).toEqual({
            ok: false,
            code: "explicit_instruction_missing",
        })
    })
})
