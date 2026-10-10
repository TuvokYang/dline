import { strict as assert } from "node:assert"
import { beforeEach, describe, it } from "vitest"
import { advanceLifecycle, getDeferredToolAction, type PartialToolLifecycle } from "../core/task/partial-tool-lifecycle"

describe("getDeferredToolAction", () => {
    it("undefined lifecycle => skip", () => {
        assert.equal(getDeferredToolAction(undefined, false, true), "skip")
    })

    it("complete-running => skip", () => {
        assert.equal(getDeferredToolAction("complete-running", false, true), "skip")
    })

    it("complete-done => skip", () => {
        assert.equal(getDeferredToolAction("complete-done", false, true), "skip")
    })

    it("partial-shown + non-turn-ending => execute", () => {
        assert.equal(getDeferredToolAction("partial-shown", false, false), "execute")
        assert.equal(getDeferredToolAction("partial-shown", false, true), "execute")
    })

    it("partial-shown + turn-ending + stream not complete => defer", () => {
        assert.equal(getDeferredToolAction("partial-shown", true, false), "defer")
    })

    it("partial-shown + turn-ending + stream complete => execute", () => {
        assert.equal(getDeferredToolAction("partial-shown", true, true), "execute")
    })
})

describe("advanceLifecycle", () => {
    let map: Map<number, PartialToolLifecycle>
    const ts = 42

    beforeEach(() => {
        map = new Map()
    })

    it("start-execute: partial-shown => complete-running", () => {
        map.set(ts, "partial-shown")
        advanceLifecycle(map, ts, "start-execute")
        assert.equal(map.get(ts), "complete-running")
    })

    it("start-execute: wrong state => no-op", () => {
        map.set(ts, "complete-running")
        advanceLifecycle(map, ts, "start-execute")
        assert.equal(map.get(ts), "complete-running")
    })

    it("start-execute: unknown ts => no-op", () => {
        advanceLifecycle(map, ts, "start-execute")
        assert.equal(map.get(ts), undefined)
    })

    it("execution-success: complete-running => complete-done", () => {
        map.set(ts, "complete-running")
        advanceLifecycle(map, ts, "execution-success")
        assert.equal(map.get(ts), "complete-done")
    })

    it("execution-success: wrong state => no-op", () => {
        map.set(ts, "partial-shown")
        advanceLifecycle(map, ts, "execution-success")
        assert.equal(map.get(ts), "partial-shown")
    })

    it("execution-failed: complete-running => partial-shown", () => {
        map.set(ts, "complete-running")
        advanceLifecycle(map, ts, "execution-failed")
        assert.equal(map.get(ts), "partial-shown")
    })

    it("execution-failed: wrong state => no-op", () => {
        map.set(ts, "complete-done")
        advanceLifecycle(map, ts, "execution-failed")
        assert.equal(map.get(ts), "complete-done")
    })

    it("full lifecycle: partial-shown -> complete-done, then skip", () => {
        map.set(ts, "partial-shown")
        const action1 = getDeferredToolAction("partial-shown", false, true)
        assert.equal(action1, "execute")
        advanceLifecycle(map, ts, "start-execute")
        assert.equal(map.get(ts), "complete-running")

        advanceLifecycle(map, ts, "execution-success")
        assert.equal(map.get(ts), "complete-done")

        const action2 = getDeferredToolAction("complete-done", false, true)
        assert.equal(action2, "skip")
    })

    it("full lifecycle: execute throw -> partial-shown, then retry", () => {
        map.set(ts, "partial-shown")
        advanceLifecycle(map, ts, "start-execute")
        assert.equal(map.get(ts), "complete-running")

        advanceLifecycle(map, ts, "execution-failed")
        assert.equal(map.get(ts), "partial-shown")

        const action = getDeferredToolAction("partial-shown", false, true)
        assert.equal(action, "execute")
    })
})

describe("lifecycle map integration", () => {
    it("retains independent concurrent lifecycle states", () => {
        const lifecycleByTs = new Map<number, PartialToolLifecycle>([
            [10, "partial-shown"],
            [20, "partial-shown"],
        ])

        advanceLifecycle(lifecycleByTs, 10, "start-execute")
        advanceLifecycle(lifecycleByTs, 10, "execution-success")

        assert.equal(lifecycleByTs.get(10), "complete-done")
        assert.equal(lifecycleByTs.get(20), "partial-shown")
        assert.equal(getDeferredToolAction(lifecycleByTs.get(10), false, true), "skip")
        assert.equal(getDeferredToolAction(lifecycleByTs.get(20), false, true), "execute")
    })

    it("clears every turn-scoped lifecycle entry", () => {
        const lifecycleByTs = new Map<number, PartialToolLifecycle>([
            [1, "partial-shown"],
            [2, "complete-done"],
            [3, "complete-running"],
        ])

        lifecycleByTs.clear()

        assert.equal(lifecycleByTs.size, 0)
    })
})
