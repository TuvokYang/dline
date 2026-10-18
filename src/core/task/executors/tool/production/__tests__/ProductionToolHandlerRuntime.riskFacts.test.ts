import type { ToolUse } from "@core/assistant-message"
import type { IgnoreController } from "@core/ignore/IgnoreController"
import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import type { ProviderTurnApproval } from "../../../../kernel"
import { ToolValidator } from "../../../../tools/ToolValidator"
import { ProductionApprovalPolicyAdapter } from "../../../policy/ProductionApprovalPolicyAdapter"
import type { ToolAdmissionSnapshot } from "../../ToolAdmissionRegistry"
import { ProductionToolHandlerRuntime } from "../ProductionToolHandlerRuntime"
import { planProductionTool } from "../ProductionToolPlanner"

/**
 * The planner and the policy must reach the same verdict for one call.
 *
 * The planner classifies the call and the policy re-resolves it from value
 * facts alone, so the facts the plan publishes are the only thing keeping the
 * two in agreement. Asserting the fact map alone would not catch a mismatch:
 * these tests run the real policy over the real plan.
 */
const snapshot = (actions: Record<string, boolean>): ToolAdmissionSnapshot => ({
    taskId: "task-1",
    cwd: process.cwd(),
    workspaceRoots: [process.cwd()],
    settings: { actions, enableNotifications: false } as unknown as ToolAdmissionSnapshot["settings"],
    blanket: {},
})

const commandBlock = (requiresApproval: string): ToolUse =>
    ({
        type: "tool_use",
        name: DlineDefaultTool.BASH,
        dline_tid: "block-1",
        params: { command: 'node -e "console.log(1)"', requires_approval: requiresApproval, workdirectory: "." },
        partial: false,
    }) as unknown as ToolUse

function runtime(): ProductionToolHandlerRuntime {
    return new ProductionToolHandlerRuntime(new ToolValidator({ validateAccess: () => true } as unknown as IgnoreController))
}

async function policyVerdict(approval: ProviderTurnApproval, actions: Record<string, boolean>): Promise<boolean> {
    if (approval.kind !== "automatic") throw new Error(`expected an automatic approval, received ${approval.kind}`)
    const adapter = new ProductionApprovalPolicyAdapter({
        readSnapshot: () => ({ settings: { actions } }),
    })
    const result = await adapter.evaluate({
        interactionId: approval.interactionId,
        blockId: "block-1",
        attempt: "attempt-1",
        policyRevision: approval.policyRevision,
        riskFacts: approval.riskFacts,
        signal: new AbortController().signal,
    })
    return result.approved
}

describe("ProductionToolHandlerRuntime approval facts", () => {
    it("keeps a safe command approved when the policy re-resolves it", async () => {
        const actions = { executeSafeCommands: true }
        const toolRuntime = runtime()
        const plan = planProductionTool(toolRuntime.coordinator, commandBlock("false"), snapshot(actions))

        expect(plan.approval.kind).toBe("automatic")
        await expect(policyVerdict(plan.approval, actions)).resolves.toBe(true)
    })

    it("does not let a safe-command grant approve a command that asked for approval", async () => {
        const toolRuntime = runtime()
        const plan = planProductionTool(toolRuntime.coordinator, commandBlock("true"), snapshot({ executeSafeCommands: true }))

        expect(plan.approval.kind).toBe("manual")
    })

    it("publishes the classification facts rather than the resolved scope", async () => {
        const toolRuntime = runtime()
        const plan = planProductionTool(toolRuntime.coordinator, commandBlock("false"), snapshot({ executeSafeCommands: true }))

        if (plan.approval.kind !== "automatic") throw new Error("expected an automatic approval")
        expect(plan.approval.riskFacts).toMatchObject({
            toolName: DlineDefaultTool.BASH,
            isSafeCommand: true,
            isExternalPath: false,
        })
        expect(plan.approval.riskFacts).not.toHaveProperty("scope")
        expect(plan.approval.riskFacts).not.toHaveProperty("ceiling")
    })

    it("publishes lexical admission without touching the target during planning", async () => {
        const toolRuntime = runtime()
        const confirm = vi.fn(async () => ({
            outcome: "admitted",
            decision: { kind: "manual", scope: "external" },
            lanes: ["confirmed:external"],
            presentation: { ask: "tool", body: "confirmed", notify: false },
        }))
        vi.spyOn(toolRuntime.coordinator, "prepareAdmission").mockReturnValue({
            outcome: "admitted",
            decision: { kind: "automatic", scope: "read" },
            lanes: ["lexical:workspace"],
            confirm,
        } as never)

        const plan = planProductionTool(toolRuntime.coordinator, commandBlock("false"), snapshot({ executeSafeCommands: true }))

        expect(confirm).not.toHaveBeenCalled()
        expect(plan.lanes).toEqual(["lexical:workspace"])
        expect(plan.approval.kind).toBe("automatic")
    })

    // The approval takes over the row the call drew while it streamed, so the
    // plan must name that row; a call that drew none leaves it to the anchor.
    it("names the row a manually approved call drew as the approval's row", () => {
        const toolRuntime = runtime()
        const drawn = { ...commandBlock("true"), ts: 42 } as ToolUse
        const plan = planProductionTool(toolRuntime.coordinator, drawn, snapshot({ executeSafeCommands: true }))
        const unanchored = planProductionTool(toolRuntime.coordinator, commandBlock("true"), snapshot({}))

        expect(plan.approval).toMatchObject({ kind: "manual", presentationRow: 42 })
        expect(unanchored.approval.kind).toBe("manual")
        expect(unanchored.approval).not.toHaveProperty("presentationRow")
    })

    it("falls back to manual approval when an ai_approvable scope has no approver", async () => {
        const input = snapshot({})
        input.settings.ceilings = { command_all: "ai_approvable" }

        const toolRuntime = runtime()
        const plan = planProductionTool(toolRuntime.coordinator, commandBlock("true"), input)

        expect(plan.approval.kind).toBe("manual")
    })
})
