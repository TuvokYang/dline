import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { IgnoreController } from "@core/ignore/IgnoreController"
import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import { replayDurableToolResult } from "../../../../DurableToolResult"
import { createInitialTaskState, transition } from "../../../../kernel"
import { TaskToolExecutionOwner, type TaskToolExecutionOwnerOptions } from "../../../../session/TaskToolExecutionOwner"
import { ToolValidator } from "../../../../tools/ToolValidator"
import type { TaskConfig } from "../../../../tools/types/TaskConfig"
import type { ToolAdmissionSnapshot } from "../../ToolAdmissionRegistry"
import { reviewRegisteredToolBoundary } from "../../ToolAdmissionRegistry"
import { createDeniedSurface } from "../../ToolDomainSurface"
import { DefaultProductionToolExecutionService } from "../DefaultProductionToolExecutionService"
import { ProductionToolHandlerRuntime } from "../ProductionToolHandlerRuntime"
import { planProductionTool } from "../ProductionToolPlanner"

const block = {
    type: "tool_use" as const,
    name: DlineDefaultTool.BASH,
    params: { command: "echo done", requires_approval: "true" },
    partial: false,
    ts: 1,
    function_id: "call",
    dline_tid: "command",
}
function snapshot(scope: "workspace" | "external"): ToolAdmissionSnapshot {
    return {
        taskId: "task",
        cwd: process.cwd(),
        workspaceRoots: [process.cwd()],
        settings: {
            ...DEFAULT_AUTO_APPROVAL_SETTINGS,
            ceilings: { command_all: "ai_approvable" },
            actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, executeAllCommands: true },
        },
        blanket: { yoloMode: true, approveAll: true },
        inheritsApproval: true,
        awayActive: true,
        awayCommandScope: scope,
    }
}
function runtime() {
    return new ProductionToolHandlerRuntime(new ToolValidator({ validateAccess: () => true } as unknown as IgnoreController))
}

describe("Away command permission and deadline", () => {
    it("uses the canonical command target in both the production owner planner and the post-approval boundary", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-away-scope-"))
        try {
            const workspace = path.join(root, "workspace")
            const external = path.join(root, "external")
            await fs.mkdir(workspace)
            await fs.mkdir(external)
            await fs.symlink(external, path.join(workspace, "linked"), process.platform === "win32" ? "junction" : "dir")
            const handlerRuntime = runtime()
            const owner = new TaskToolExecutionOwner({
                taskId: "scope",
                cwd: workspace,
                toolRuntime: handlerRuntime,
                readAwayActive: () => true,
                stateManager: {
                    getGlobalStateKey: () => false,
                    getGlobalSettingsKey: (key: string) =>
                        key === "autoApprovalSettings" ? DEFAULT_AUTO_APPROVAL_SETTINGS : key === "yoloModeToggled",
                },
            } as unknown as TaskToolExecutionOwnerOptions)
            const call = { ...block, params: { ...block.params, workdirectory: "linked" } }
            const facts = await owner.prepareAdmissionSnapshot(call)
            expect(facts.awayCommandScope).toBe("external")
            expect(planProductionTool(handlerRuntime.coordinator, call, facts).approval).toMatchObject({
                kind: "manual",
                externalCommand: true,
            })
            expect(await reviewRegisteredToolBoundary(call, DlineDefaultTool.BASH, facts)).toMatchObject({ outcome: "approved" })
            // A previously admitted workspace target still cannot widen at execution.
            expect(
                await reviewRegisteredToolBoundary(call, DlineDefaultTool.BASH, { ...facts, awayCommandScope: "workspace" }),
            ).toEqual({ outcome: "rejected", code: "scope_widened" })
        } finally {
            await fs.rm(root, { recursive: true, force: true })
        }
    })

    it("keeps external commands manual ahead of blanket, inherited, toggled and AI approval", () => {
        const planner = runtime()
        expect(planProductionTool(planner.coordinator, block, snapshot("workspace")).approval).toEqual({
            kind: "none",
            awayCommand: true,
        })
        expect(
            planProductionTool(planner.coordinator, block, snapshot("external"), { aiApproverAvailable: true }).approval,
        ).toMatchObject({ kind: "manual", externalCommand: true })
    })

    it("arms the absolute external deadline once without requiring automatic Away", () => {
        const plan = planProductionTool(runtime().coordinator, block, snapshot("external"))
        const state = {
            ...createInitialTaskState("task"),
            away: {
                configuration: { enabled: true, automatic: false, modeRevocation: 0, automaticRevocation: 2 },
                mode: { source: "command" as const, enteredRevision: 0, modeRevocation: 0 },
            },
            flow: {
                phase: "running" as const,
                provider: { commandId: "provider", originRevision: 0, status: "running" as const },
            },
        }
        const result = transition(state, {
            type: "provider.turn_ready",
            generation: 0,
            now: 1_000,
            commandId: "provider",
            originRevision: 0,
            turnId: "turn",
            journalWatermark: { seq: 0 },
            finalPayloadRef: "final",
            turnPlan: { mode: "serial", blocks: [{ ...plan, blockId: "command", index: 0, invocationRef: "invocation" }] },
        })
        if (result.kind !== "accepted") throw new Error(result.diagnostic.message)
        expect(result.state.dialog.approvalsByBlock.command.deadline).toEqual({
            kind: "external_command",
            deadlineAt: 61_000,
            modeRevocation: 0,
            automaticRevocation: 2,
        })
        const stopped = transition(result.state, { type: "away.stopped", generation: 0 })
        expect(stopped.state.dialog.approvalsByBlock.command.deadline).toBeUndefined()
        expect(stopped.state.turn).toEqual(result.state.turn)
    })

    it("does not keep a workspace Away grant after Stop when ordinary permission requires a decision", async () => {
        const handlerRuntime = runtime()
        const execute = vi.spyOn(handlerRuntime, "execute").mockResolvedValue("executed")
        const open = vi.fn(async () => ({ actionId: "reject" as const }))
        const config = { taskState: { consecutiveMistakeCount: 0 }, interactions: { open } } as unknown as TaskConfig
        const current = {
            ...snapshot("workspace"),
            awayActive: false,
            blanket: {},
            inheritsApproval: false,
            settings: DEFAULT_AUTO_APPROVAL_SETTINGS,
        }
        const service = new DefaultProductionToolExecutionService({
            taskId: "task",
            runtime: handlerRuntime,
            config: { create: () => config, readAdmissionSnapshot: () => current },
        })
        await service.execute({
            command: { commandId: "run", turnId: "turn", dlineTid: "command", invocationRef: "ref" },
            invocation: {
                kind: "tool_invocation",
                toolName: block.name,
                input: block.params,
                functionId: "call",
                dlineTid: "command",
                presentationId: 1,
                isNativeToolCall: true,
                awayCommandApproval: "workspace",
            },
            surface: createDeniedSurface("detached_domain"),
        })
        expect(open).toHaveBeenCalledWith(expect.objectContaining({ interactionId: "command", kind: "command_approval" }))
        expect(execute).not.toHaveBeenCalled()
    })

    it("requires a human decision when an automatic call becomes external in Away", async () => {
        const handlerRuntime = runtime()
        const execute = vi.spyOn(handlerRuntime, "execute").mockResolvedValue("executed")
        const open = vi.fn(async () => ({ actionId: "reject" as const, origin: "timeout" as const }))
        const config = { taskState: { consecutiveMistakeCount: 0 }, interactions: { open } } as unknown as TaskConfig
        const service = new DefaultProductionToolExecutionService({
            taskId: "task",
            runtime: handlerRuntime,
            config: { create: () => config, readAdmissionSnapshot: () => snapshot("external") },
        })
        const result = await service.execute({
            command: { commandId: "run", turnId: "turn", dlineTid: "command", invocationRef: "ref" },
            invocation: {
                kind: "tool_invocation",
                toolName: block.name,
                input: block.params,
                functionId: "call",
                dlineTid: "command",
                presentationId: 1,
                isNativeToolCall: true,
            },
            surface: createDeniedSurface("detached_domain"),
        })
        expect(open).toHaveBeenCalledWith(expect.objectContaining({ kind: "command_approval", externalCommand: true }))
        expect(execute).not.toHaveBeenCalled()
        expect(config.taskState.consecutiveMistakeCount).toBe(0)
        expect(replayDurableToolResult(result.content)![0]).toMatchObject({
            type: "tool_result",
            function_id: "call",
            dline_tid: "command",
        })
        expect(result.failed).toBeUndefined()
    })
})
