import { strict as assert } from "node:assert"
import { ClineDefaultTool } from "@shared/tools"
import { describe, it } from "vitest"
import {
	isForbiddenSubagentTool,
	rejectForbiddenSubagentTools,
	sanitizeSubagentTools,
	sanitizeSubagentToolsForPersistence,
} from "../subagent-tool-policy"

describe("subagent delegation policy", () => {
	it("forbids a subagent from starting another fan-out", () => {
		assert.equal(isForbiddenSubagentTool(ClineDefaultTool.USE_SUBAGENT), true)
		assert.equal(isForbiddenSubagentTool(ClineDefaultTool.USE_SUBAGENTS), true)
	})

	/**
	 * This ban is what actually bounds nesting: no delegation tool inside a
	 * subagent means no nested fan-out can consume the task budget at all. If
	 * it is ever lifted, the budget must first learn to hand a child view to a
	 * nested run, so the ban is pinned here rather than left implicit.
	 */
	it("is the mechanism that keeps fan-out depth bounded", () => {
		const grantedToSubagent = sanitizeSubagentTools([ClineDefaultTool.USE_SUBAGENT, ClineDefaultTool.USE_SUBAGENTS])

		assert.ok(
			!grantedToSubagent.includes(ClineDefaultTool.USE_SUBAGENT),
			"lifting this requires wiring SubagentFanoutBudget.child() into the nested run",
		)
		assert.ok(
			!grantedToSubagent.includes(ClineDefaultTool.USE_SUBAGENTS),
			"lifting this requires wiring SubagentFanoutBudget.child() into the nested run",
		)
	})

	it("strips delegation from a requested allowlist without discarding the rest", () => {
		const allowed = sanitizeSubagentTools([
			ClineDefaultTool.FILE_READ,
			ClineDefaultTool.USE_SUBAGENTS,
			ClineDefaultTool.SEARCH,
		])

		assert.ok(allowed.includes(ClineDefaultTool.FILE_READ))
		assert.ok(allowed.includes(ClineDefaultTool.SEARCH))
		assert.ok(!allowed.includes(ClineDefaultTool.USE_SUBAGENTS))
		// The reporting tool is still granted, so the run can finish.
		assert.ok(allowed.includes(ClineDefaultTool.ATTEMPT))
	})

	it("never persists a delegation tool into a config document", () => {
		const persisted = sanitizeSubagentToolsForPersistence([
			ClineDefaultTool.FILE_READ,
			ClineDefaultTool.USE_SUBAGENT,
			ClineDefaultTool.USE_SUBAGENTS,
		])

		assert.deepEqual(persisted, [ClineDefaultTool.FILE_READ])
	})

	it("rejects delegation at the configuration boundary too", () => {
		const kept = rejectForbiddenSubagentTools([
			ClineDefaultTool.USE_SUBAGENT,
			ClineDefaultTool.FILE_READ,
			ClineDefaultTool.USE_SUBAGENTS,
		])

		assert.deepEqual(kept, [ClineDefaultTool.FILE_READ])
	})

	it("leaves the inherited default allowlist usable", () => {
		const inherited = sanitizeSubagentTools(undefined)

		// The default set must not become empty or lose ordinary research tools
		// as a side effect of forbidding delegation.
		assert.ok(inherited.length > 1)
		assert.ok(inherited.includes(ClineDefaultTool.FILE_READ))
		assert.ok(!inherited.includes(ClineDefaultTool.USE_SUBAGENT))
		assert.ok(!inherited.includes(ClineDefaultTool.USE_SUBAGENTS))
	})

	it("degrades a delegation-only list to the reporting tool rather than inheriting", () => {
		const narrowed = sanitizeSubagentTools([ClineDefaultTool.USE_SUBAGENTS], { explicitlyNarrowed: true })

		assert.deepEqual(narrowed, [ClineDefaultTool.ATTEMPT])
	})
})
