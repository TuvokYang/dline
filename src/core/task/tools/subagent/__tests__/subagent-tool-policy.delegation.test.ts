import { strict as assert } from "node:assert"
import { DlineDefaultTool } from "@shared/tools"
import { describe, it } from "vitest"
import {
    isForbiddenSubagentTool,
    rejectForbiddenSubagentTools,
    sanitizeSubagentTools,
    sanitizeSubagentToolsForPersistence,
} from "../subagent-tool-policy"

describe("subagent delegation policy", () => {
    it("forbids a subagent from starting another fan-out", () => {
        assert.equal(isForbiddenSubagentTool(DlineDefaultTool.USE_SUBAGENT), true)
        assert.equal(isForbiddenSubagentTool(DlineDefaultTool.USE_SUBAGENTS), true)
    })

    /**
     * This ban is what actually bounds nesting: no delegation tool inside a
     * subagent means no nested fan-out can consume the task budget at all. If
     * it is ever lifted, the budget must first learn to hand a child view to a
     * nested run, so the ban is pinned here rather than left implicit.
     */
    it("is the mechanism that keeps fan-out depth bounded", () => {
        const grantedToSubagent = sanitizeSubagentTools([DlineDefaultTool.USE_SUBAGENT, DlineDefaultTool.USE_SUBAGENTS])

        assert.ok(
            !grantedToSubagent.includes(DlineDefaultTool.USE_SUBAGENT),
            "lifting this requires wiring SubagentFanoutBudget.child() into the nested run",
        )
        assert.ok(
            !grantedToSubagent.includes(DlineDefaultTool.USE_SUBAGENTS),
            "lifting this requires wiring SubagentFanoutBudget.child() into the nested run",
        )
    })

    it("strips delegation from a requested allowlist without discarding the rest", () => {
        const allowed = sanitizeSubagentTools([
            DlineDefaultTool.FILE_READ,
            DlineDefaultTool.USE_SUBAGENTS,
            DlineDefaultTool.SEARCH,
        ])

        assert.ok(allowed.includes(DlineDefaultTool.FILE_READ))
        assert.ok(allowed.includes(DlineDefaultTool.SEARCH))
        assert.ok(!allowed.includes(DlineDefaultTool.USE_SUBAGENTS))
        // The reporting tool is still granted, so the run can finish.
        assert.ok(allowed.includes(DlineDefaultTool.ATTEMPT))
    })

    it("never persists a delegation tool into a config document", () => {
        const persisted = sanitizeSubagentToolsForPersistence([
            DlineDefaultTool.FILE_READ,
            DlineDefaultTool.USE_SUBAGENT,
            DlineDefaultTool.USE_SUBAGENTS,
        ])

        assert.deepEqual(persisted, [DlineDefaultTool.FILE_READ])
    })

    it("rejects delegation at the configuration boundary too", () => {
        const kept = rejectForbiddenSubagentTools([
            DlineDefaultTool.USE_SUBAGENT,
            DlineDefaultTool.FILE_READ,
            DlineDefaultTool.USE_SUBAGENTS,
        ])

        assert.deepEqual(kept, [DlineDefaultTool.FILE_READ])
    })

    it("leaves the inherited default allowlist usable", () => {
        const inherited = sanitizeSubagentTools(undefined)

        // The default set must not become empty or lose ordinary research tools
        // as a side effect of forbidding delegation.
        assert.ok(inherited.length > 1)
        assert.ok(inherited.includes(DlineDefaultTool.FILE_READ))
        assert.ok(!inherited.includes(DlineDefaultTool.USE_SUBAGENT))
        assert.ok(!inherited.includes(DlineDefaultTool.USE_SUBAGENTS))
    })

    it("degrades a delegation-only list to the reporting tool rather than inheriting", () => {
        const narrowed = sanitizeSubagentTools([DlineDefaultTool.USE_SUBAGENTS], { explicitlyNarrowed: true })

        assert.deepEqual(narrowed, [DlineDefaultTool.ATTEMPT])
    })
})
