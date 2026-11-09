import type { IgnoreController } from "@core/ignore/IgnoreController"
import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { DlineDefaultTool } from "@shared/tools"
import { expect, it, vi } from "vitest"
import { DefaultProductionToolExecutionService } from "../../executors/tool/production/DefaultProductionToolExecutionService"
import { ProductionToolHandlerRuntime } from "../../executors/tool/production/ProductionToolHandlerRuntime"
import { createDeniedSurface } from "../../executors/tool/ToolDomainSurface"
import { ToolValidator } from "../../tools/ToolValidator"
import { TaskToolExecutionOwner, type TaskToolExecutionOwnerOptions } from "../TaskToolExecutionOwner"

it("never leaves a suppressed Away interaction's partial row spinning", async () => {
    let active = true
    const rows = [
        { ts: 1, partial: true },
        { ts: 2, partial: false },
    ]
    const runtime = new ProductionToolHandlerRuntime(
        new ToolValidator({ validateAccess: () => true } as unknown as IgnoreController),
    )
    const partial = vi.spyOn(runtime.coordinator, "presentPartial").mockResolvedValue()
    const owner = new TaskToolExecutionOwner({
        taskId: "presentation",
        cwd: process.cwd(),
        toolRuntime: runtime,
        readAwayActive: () => active,
        stateManager: {
            getGlobalStateKey: () => false,
            getGlobalSettingsKey: (key: string) => (key === "autoApprovalSettings" ? DEFAULT_AUTO_APPROVAL_SETTINGS : false),
        },
        messages: {
            clineMessages: rows,
            removeMessagesByTs: async (timestamps: number[]) => {
                for (let i = rows.length - 1; i >= 0; i--) if (timestamps.includes(rows[i].ts)) rows.splice(i, 1)
            },
        },
    } as unknown as TaskToolExecutionOwnerOptions)
    vi.spyOn(owner, "create").mockImplementation(() => {
        throw new Error("No interactive config for feedback-only")
    })
    await owner.presentPartial({
        name: DlineDefaultTool.ASK,
        params: { question: "Choose" },
        type: "tool_use",
        partial: true,
        ts: 1,
        dline_tid: "block",
        function_id: "call",
    })
    expect(partial).not.toHaveBeenCalled()
    active = false
    const service = new DefaultProductionToolExecutionService({ taskId: "presentation", runtime, config: owner })
    const result = await service.execute({
        command: { commandId: "run", turnId: "turn", dlineTid: "block", invocationRef: "ref" },
        invocation: {
            kind: "tool_invocation",
            toolName: DlineDefaultTool.ASK,
            input: { question: "Choose" },
            functionId: "call",
            dlineTid: "block",
            presentationId: 1,
            isNativeToolCall: true,
            disposition: "away_feedback_only",
        },
        surface: createDeniedSurface("detached_domain"),
    })
    expect(result.failed).toBeUndefined()
    expect(rows).toEqual([{ ts: 2, partial: false }])
    expect(owner.create).not.toHaveBeenCalled()
})
