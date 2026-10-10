import { strict as assert } from "node:assert"
import { describe, it } from "vitest"
import { parseCommandExecutionOptions } from "../command-execution-options"

describe("parseCommandExecutionOptions", () => {
    it("leaves timeout unset so execution can use the current terminal setting", () => {
        assert.deepEqual(parseCommandExecutionOptions("echo ready", undefined, undefined), {
            background: false,
            synchronous: false,
            timeoutSeconds: undefined,
            muteStdout: false,
        })
    })

    it("does not infer a different timeout for recognized long-running commands", () => {
        assert.deepEqual(parseCommandExecutionOptions("npm test", undefined, undefined), {
            background: false,
            synchronous: false,
            timeoutSeconds: undefined,
            muteStdout: false,
        })
    })

    it("parses explicit background and positive integer timeout values", () => {
        assert.deepEqual(parseCommandExecutionOptions("npm test", "true", "45"), {
            background: true,
            synchronous: false,
            timeoutSeconds: 45,
            muteStdout: false,
        })
        assert.deepEqual(parseCommandExecutionOptions("npm test", "false", "15"), {
            background: false,
            synchronous: false,
            timeoutSeconds: 15,
            muteStdout: false,
        })
    })

    it("preserves any non-positive integer as an explicit no-timeout request", () => {
        for (const timeout of ["-1", "0", "-2"]) {
            assert.equal(parseCommandExecutionOptions("echo ready", undefined, timeout).timeoutSeconds, Number(timeout))
        }
    })

    it("leaves omitted and non-integer values for the runtime setting", () => {
        for (const timeout of [undefined, "invalid", "2.5"]) {
            assert.equal(parseCommandExecutionOptions("echo ready", undefined, timeout).timeoutSeconds, undefined)
        }
    })

    it("parses synchronous mode and lets explicit background take precedence", () => {
        assert.deepEqual(parseCommandExecutionOptions("npm test", "false", "120", "true"), {
            background: false,
            synchronous: true,
            timeoutSeconds: 120,
            muteStdout: false,
        })
        assert.deepEqual(parseCommandExecutionOptions("npm test", "true", "120", "true"), {
            background: true,
            synchronous: false,
            timeoutSeconds: 120,
            muteStdout: false,
        })
    })

    it("enables stdout muting only for the exact true value", () => {
        assert.equal(parseCommandExecutionOptions("echo ready", undefined, undefined, undefined, "true").muteStdout, true)
        for (const muteStdout of [undefined, "", "false", "TRUE", "1"]) {
            assert.equal(
                parseCommandExecutionOptions("echo ready", undefined, undefined, undefined, muteStdout).muteStdout,
                false,
            )
        }
    })

    it("treats every non-true background value as false", () => {
        for (const background of [undefined, "", "false", "TRUE ", "1"]) {
            assert.equal(parseCommandExecutionOptions("echo ready", background, undefined).background, false)
        }
    })
})
