import { describe, expect, it } from "vitest"
import { planTaskHistoryRebuild } from "../reconstructTaskHistory"

describe("planTaskHistoryRebuild", () => {
    it("rebuilds only folders the index lacks and drops only entries whose folder is gone", () => {
        const plan = planTaskHistoryRebuild(["100", "200", "legacy-id"], new Set(["100", "300", "legacy-id", "checkpoints"]))

        expect([...plan.removedTaskIds]).toEqual(["200"])
        expect(plan.missingTaskIds).toEqual(["300"])
    })
})
