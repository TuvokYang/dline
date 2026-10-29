import assert from "node:assert/strict"
import { describe, it } from "vitest"
import { resolveCommandTimeoutSeconds } from "../ExecuteCommandToolHandler"

describe("ExecuteCommandToolHandler timeout policy", () => {
    it("uses explicit timeout when provided", () => {
        const timeout = resolveCommandTimeoutSeconds("45")
        assert.equal(timeout, 45)
    })

    it.each([
        ["0", 0],
        ["-1", -1],
        ["-2", -2],
    ] as const)("preserves %s as an explicit no-timeout request", (value, expected) => {
        assert.equal(resolveCommandTimeoutSeconds(value), expected)
    })

    it("leaves omitted and invalid values for the runtime setting", () => {
        assert.equal(resolveCommandTimeoutSeconds(undefined), undefined)
        assert.equal(resolveCommandTimeoutSeconds("invalid"), undefined)
        assert.equal(resolveCommandTimeoutSeconds("1.5"), undefined)
    })
})
