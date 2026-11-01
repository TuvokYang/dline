import { describe, expect, it } from "vitest"
import { approvalPolicySnapshotOf, ProductionApprovalPolicyAdapter } from "./ProductionApprovalPolicyAdapter"

const signal = new AbortController().signal
const input = {
    interactionId: "policy:b1",
    blockId: "b1",
    attempt: "attempt:b1",
    policyRevision: 1,
    riskFacts: { toolName: "read_file", isExternalPath: false },
    signal,
}

describe("ProductionApprovalPolicyAdapter", () => {
    it("projects configured ceilings from the admission settings snapshot", () => {
        expect(
            approvalPolicySnapshotOf({ actions: {}, ceilings: { read_workspace: "manual_only" } } as never, { approveAll: true }),
        ).toMatchObject({
            settings: { ceilings: { read_workspace: "manual_only" } },
            ceilings: { read_workspace: "manual_only" },
            blanket: { approveAll: true },
        })
    })

    it("approves enabled automatic scopes and keeps manual ceilings closed", async () => {
        const automatic = new ProductionApprovalPolicyAdapter({
            readSnapshot: () => ({ settings: { actions: { readFiles: true } } }),
        })
        await expect(automatic.evaluate(input)).resolves.toEqual({ approved: true })

        const manual = new ProductionApprovalPolicyAdapter({
            readSnapshot: () => ({
                settings: { actions: { readFiles: true } },
                ceilings: { read_workspace: "manual_only" },
            }),
        })
        await expect(manual.evaluate(input)).resolves.toEqual({ approved: false })
    })

    it.each([
        { awayCommand: "workspace", approved: true },
        { awayCommand: "external", approved: false },
    ])("uses the same $awayCommand command scope ahead of ordinary approval settings", async ({ awayCommand, approved }) => {
        const adapter = new ProductionApprovalPolicyAdapter({
            readSnapshot: () => ({ settings: { actions: {} }, blanket: { yoloMode: true, approveAll: true } }),
        })
        await expect(
            adapter.evaluate({
                ...input,
                riskFacts: {
                    toolName: "execute_command",
                    awayCommand,
                    isExternalPath: awayCommand === "external",
                    inheritsApproval: true,
                },
            }),
        ).resolves.toEqual({ approved })
    })

    it("rejects malformed risk facts instead of guessing a tool identity", async () => {
        const adapter = new ProductionApprovalPolicyAdapter({
            readSnapshot: () => ({ settings: { actions: {} } }),
        })
        await expect(adapter.evaluate({ ...input, riskFacts: {} })).rejects.toThrow("MissingPolicyToolName")
    })
})
