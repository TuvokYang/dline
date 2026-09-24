import type { ToolUse } from "@core/assistant-message"
import type { IgnoreController } from "@core/ignore/IgnoreController"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import { ToolValidator } from "../../../../tools/ToolValidator"
import { ProductionApprovalPolicyAdapter } from "../../../policy/ProductionApprovalPolicyAdapter"
import type { ToolAdmissionSnapshot } from "../../ToolAdmissionRegistry"
import { ProductionToolHandlerRuntime } from "../ProductionToolHandlerRuntime"

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
		name: ClineDefaultTool.BASH,
		dline_tid: "block-1",
		params: { command: 'node -e "console.log(1)"', requires_approval: requiresApproval, workdirectory: "." },
		partial: false,
	}) as unknown as ToolUse

function runtime(): ProductionToolHandlerRuntime {
	return new ProductionToolHandlerRuntime(new ToolValidator({ validateAccess: () => true } as unknown as IgnoreController))
}

async function policyVerdict(
	approval: ReturnType<ProductionToolHandlerRuntime["plan"]>["approval"],
	actions: Record<string, boolean>,
): Promise<boolean> {
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
		const plan = runtime().plan(commandBlock("false"), snapshot(actions))

		expect(plan.approval.kind).toBe("automatic")
		await expect(policyVerdict(plan.approval, actions)).resolves.toBe(true)
	})

	it("does not let a safe-command grant approve a command that asked for approval", () => {
		const plan = runtime().plan(commandBlock("true"), snapshot({ executeSafeCommands: true }))

		expect(plan.approval.kind).toBe("manual")
	})

	it("publishes the classification facts rather than the resolved scope", () => {
		const plan = runtime().plan(commandBlock("false"), snapshot({ executeSafeCommands: true }))

		if (plan.approval.kind !== "automatic") throw new Error("expected an automatic approval")
		expect(plan.approval.riskFacts).toMatchObject({
			toolName: ClineDefaultTool.BASH,
			isSafeCommand: true,
			isExternalPath: false,
		})
		expect(plan.approval.riskFacts).not.toHaveProperty("scope")
		expect(plan.approval.riskFacts).not.toHaveProperty("ceiling")
	})
})
