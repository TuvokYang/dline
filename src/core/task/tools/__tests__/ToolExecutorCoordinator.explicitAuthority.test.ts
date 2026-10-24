import type { ToolUse } from "@core/assistant-message"
import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import { TaskTurnAuthority } from "../../explicit-instructions/TurnAuthority"
import type { IToolHandler } from "../ToolExecutorCoordinator"
import { ToolExecutorCoordinator } from "../ToolExecutorCoordinator"
import type { TaskConfig } from "../types/TaskConfig"

function block(name: DlineDefaultTool): ToolUse {
    return { type: "tool_use", name, params: {}, partial: false } as ToolUse
}

function recordingHandler(name: DlineDefaultTool) {
    const seen: TaskConfig[] = []
    const handler: IToolHandler = {
        name,
        getDescription: () => `[${name}]`,
        execute: async (config: TaskConfig) => {
            seen.push(config)
            return "done"
        },
    }
    return { handler, calls: () => seen.length, lastConfig: () => seen[seen.length - 1] }
}

function coordinatorWith(handler: IToolHandler): ToolExecutorCoordinator {
    const coordinator = new ToolExecutorCoordinator()
    coordinator.register(handler)
    return coordinator
}

describe("ToolExecutorCoordinator explicit authority", () => {
    it("hands the handler one consumed authorization when the turn granted it", async () => {
        const authority = new TaskTurnAuthority()
        authority.grant("turn-1", [
            { type: "summarize_task", source: "manual_compact_command", targetTool: DlineDefaultTool.SUMMARIZE_TASK },
        ])
        const recording = recordingHandler(DlineDefaultTool.SUMMARIZE_TASK)
        const coordinator = coordinatorWith(recording.handler)
        const config = { explicitInstructions: authority.read("turn-1") } as TaskConfig

        await coordinator.execute(config, block(DlineDefaultTool.SUMMARIZE_TASK))

        expect(recording.lastConfig().explicitInstructionAuthorization).toMatchObject({
            type: "summarize_task",
            targetTool: DlineDefaultTool.SUMMARIZE_TASK,
            state: "consumed",
        })
    })

    it("consumes report_bug authority before the report handler runs", async () => {
        const authority = new TaskTurnAuthority()
        authority.grant("turn-report", [{ type: "report_bug", source: "slash_command", targetTool: DlineDefaultTool.REPORT_BUG }])
        const recording = recordingHandler(DlineDefaultTool.REPORT_BUG)
        const coordinator = coordinatorWith(recording.handler)

        await coordinator.execute(
            { explicitInstructions: authority.read("turn-report") } as TaskConfig,
            block(DlineDefaultTool.REPORT_BUG),
        )

        expect(recording.lastConfig().explicitInstructionAuthorization).toMatchObject({
            type: "report_bug",
            targetTool: DlineDefaultTool.REPORT_BUG,
            state: "consumed",
        })
    })

    it("consumes the authority once, so a second call is refused before its handler runs", async () => {
        const authority = new TaskTurnAuthority()
        authority.grant("turn-1", [
            { type: "summarize_task", source: "manual_compact_command", targetTool: DlineDefaultTool.SUMMARIZE_TASK },
        ])
        const recording = recordingHandler(DlineDefaultTool.SUMMARIZE_TASK)
        const coordinator = coordinatorWith(recording.handler)
        const config = { explicitInstructions: authority.read("turn-1") } as TaskConfig

        await coordinator.execute(config, block(DlineDefaultTool.SUMMARIZE_TASK))
        const second = await coordinator.execute(config, block(DlineDefaultTool.SUMMARIZE_TASK))

        expect(recording.calls()).toBe(1)
        expect(JSON.stringify(second)).toMatch(/explicit_instruction_(already_consumed|missing)/)
    })

    // WS-013: an explicit-only tool nobody authorized is refused centrally with a
    // code the model reads back, and none of its effects run.
    it("refuses an explicit-only tool without granted authority and never runs its handler", async () => {
        const recording = recordingHandler(DlineDefaultTool.SUMMARIZE_TASK)
        const coordinator = coordinatorWith(recording.handler)

        const result = await coordinator.execute({} as TaskConfig, block(DlineDefaultTool.SUMMARIZE_TASK))

        expect(recording.calls()).toBe(0)
        expect(JSON.stringify(result)).toContain("explicit_instruction_missing")
    })

    // summarize_task text is owned by ContextCompactionSession, so production
    // registers no handler for it. The model still has to read the gate's reason.
    it("refuses an unauthorized handler-less summarize_task with the explicit gate code", async () => {
        const coordinator = new ToolExecutorCoordinator()

        const result = await coordinator.execute({} as TaskConfig, block(DlineDefaultTool.SUMMARIZE_TASK))

        expect(JSON.stringify(result)).toContain(
            "Explicit-only tool 'summarize_task' was rejected: explicit_instruction_missing.",
        )
        expect(JSON.stringify(result)).not.toContain("No handler registered")
    })

    it("refuses the retired condense tool with the retirement code", async () => {
        const coordinator = new ToolExecutorCoordinator()

        const result = await coordinator.execute({} as TaskConfig, block(DlineDefaultTool.CONDENSE))

        expect(JSON.stringify(result)).toContain("explicit_instruction_retired")
    })

    it("leaves pending authority unconsumed when a handler-less explicit tool is called", async () => {
        const authority = new TaskTurnAuthority()
        authority.grant("turn-1", [
            { type: "summarize_task", source: "manual_compact_command", targetTool: DlineDefaultTool.SUMMARIZE_TASK },
        ])
        const coordinator = new ToolExecutorCoordinator()
        const config = { explicitInstructions: authority.read("turn-1") } as TaskConfig

        await expect(coordinator.execute(config, block(DlineDefaultTool.SUMMARIZE_TASK))).rejects.toThrow(
            "No handler registered for tool: summarize_task",
        )
        expect(authority.read("turn-1")?.getPendingToolAuthorization(DlineDefaultTool.SUMMARIZE_TASK)).toBeDefined()
    })

    it("keeps a missing handler an ordinary failure for tools outside the explicit gate", async () => {
        const coordinator = new ToolExecutorCoordinator()

        await expect(coordinator.execute({} as TaskConfig, block(DlineDefaultTool.FILE_READ))).rejects.toThrow(
            "No handler registered for tool: read_file",
        )
    })

    it("does not touch a tool that needs no explicit authority", async () => {
        const authority = new TaskTurnAuthority()
        authority.grant("turn-1", [
            { type: "summarize_task", source: "manual_compact_command", targetTool: DlineDefaultTool.SUMMARIZE_TASK },
        ])
        const recording = recordingHandler(DlineDefaultTool.FILE_READ)
        const coordinator = coordinatorWith(recording.handler)
        const config = { explicitInstructions: authority.read("turn-1") } as TaskConfig

        await coordinator.execute(config, block(DlineDefaultTool.FILE_READ))

        expect(recording.lastConfig().explicitInstructionAuthorization).toBeUndefined()
        expect(authority.read("turn-1")?.getPendingToolAuthorization(DlineDefaultTool.SUMMARIZE_TASK)).toBeDefined()
    })
})
