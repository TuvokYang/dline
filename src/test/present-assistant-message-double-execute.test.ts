/**
 * Bug repro: When `reRenderUpdatedPartialBlocks` has already executed a tool's
 * complete handler (lifecycle === "complete-done"), `presentAssistantMessage`'s
 * switch statement must NOT execute it again.  Otherwise the tool runs twice,
 * and for replace_in_file the second execution fails with "SEARCH not found"
 * because the file was already modified.
 *
 * This test verifies that the lifecycle state machine correctly prevents
 * double execution in the deferred complete path.
 */
import { strict as assert } from "node:assert"
import { describe, it } from "vitest"
import { advanceLifecycle, getDeferredToolAction } from "../core/task/partial-tool-lifecycle"

describe("presentAssistantMessage double-execute guard", () => {
    const ts = 42

    it("complete-done → skip (no second execution)", () => {
        const action = getDeferredToolAction("complete-done", false, true)
        assert.equal(action, "skip", "Tool with lifecycle 'complete-done' must be skipped by reRenderUpdatedPartialBlocks")
    })

    it("partial-shown → execute → complete-done → skip (full lifecycle)", () => {
        const map = new Map()

        // simulate partial registration in presentAssistantMessage
        map.set(ts, "partial-shown")

        // reRenderUpdatedPartialBlocks: first call → should execute
        const action1 = getDeferredToolAction("partial-shown", false, true)
        assert.equal(action1, "execute")

        advanceLifecycle(map, ts, "start-execute")
        assert.equal(map.get(ts), "complete-running")

        advanceLifecycle(map, ts, "execution-success")
        assert.equal(map.get(ts), "complete-done")

        // reRenderUpdatedPartialBlocks: second call → must skip
        const action2 = getDeferredToolAction("complete-done", false, true)
        assert.equal(action2, "skip", "After deferred complete execution, tool must not be executed again")
    })

    it("complete-running → skip (CAS guard)", () => {
        const action = getDeferredToolAction("complete-running", false, true)
        assert.equal(action, "skip", "Tool that is already being executed must not be re-entered")
    })
})
