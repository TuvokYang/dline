import { strict as assert } from "node:assert"
import { describe, it } from "vitest"
import {
    buildContextUsageSection,
    CONTEXT_CONVERGENCE_THRESHOLD,
    describeConvergenceTrigger,
    exceedsContextConvergenceThreshold,
} from "../SubagentConvergenceGate"

const CONTEXT_WINDOW = 200_000
const THRESHOLD_TOKENS = CONTEXT_WINDOW * CONTEXT_CONVERGENCE_THRESHOLD

describe("SubagentConvergenceGate", () => {
    it("does not force convergence just below the threshold", () => {
        const sample = { contextTokens: THRESHOLD_TOKENS - 1, contextWindow: CONTEXT_WINDOW }

        assert.equal(exceedsContextConvergenceThreshold(sample), false)
    })

    it("forces convergence exactly at the threshold", () => {
        const sample = { contextTokens: THRESHOLD_TOKENS, contextWindow: CONTEXT_WINDOW }

        assert.equal(exceedsContextConvergenceThreshold(sample), true)
    })

    it("forces convergence above the threshold", () => {
        const sample = { contextTokens: THRESHOLD_TOKENS + 1, contextWindow: CONTEXT_WINDOW }

        assert.equal(exceedsContextConvergenceThreshold(sample), true)
    })

    // Providers that do not report a window would otherwise be aborted on the
    // first turn, because any usage compares favourably against a zero capacity.
    it("never forces convergence when the window is unknown", () => {
        assert.equal(exceedsContextConvergenceThreshold({ contextTokens: 500_000, contextWindow: 0 }), false)
        assert.equal(exceedsContextConvergenceThreshold({ contextTokens: 500_000, contextWindow: -1 }), false)
        assert.equal(exceedsContextConvergenceThreshold({ contextTokens: 500_000, contextWindow: Number.NaN }), false)
    })

    it("ignores an unusable token reading", () => {
        assert.equal(exceedsContextConvergenceThreshold({ contextTokens: 0, contextWindow: CONTEXT_WINDOW }), false)
        assert.equal(exceedsContextConvergenceThreshold({ contextTokens: Number.NaN, contextWindow: CONTEXT_WINDOW }), false)
    })

    it("reports usage and the convergence threshold to the run", () => {
        const section = buildContextUsageSection({ contextTokens: 100_000, contextWindow: CONTEXT_WINDOW })

        assert.ok(section)
        assert.match(section, /# Context Window Usage/)
        assert.match(section, /100,000 \/ 200K tokens used \(50%\)/)
        assert.match(section, /80%/)
        assert.match(section, /attempt_completion/)
    })

    it("omits the usage section when the window is unknown", () => {
        assert.equal(buildContextUsageSection({ contextTokens: 10, contextWindow: 0 }), undefined)
    })

    it("omits the usage section until a request has reported usage", () => {
        assert.equal(buildContextUsageSection({ contextTokens: 0, contextWindow: CONTEXT_WINDOW }), undefined)
        assert.equal(buildContextUsageSection({ contextTokens: Number.NaN, contextWindow: CONTEXT_WINDOW }), undefined)
    })

    it("distinguishes the convergence triggers", () => {
        assert.match(describeConvergenceTrigger("timeout"), /time limit/i)
        assert.match(describeConvergenceTrigger("context_pressure"), /context window usage reached 80%/i)
        assert.match(describeConvergenceTrigger("user"), /user requested/i)
    })
})
