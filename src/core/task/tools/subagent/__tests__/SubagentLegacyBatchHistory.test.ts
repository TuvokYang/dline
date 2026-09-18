import { strict as assert } from "node:assert"
import { describe, it } from "vitest"
import { parseUseSubagentsRequest } from "../SubagentRequestParser"

/**
 * A task recorded before the batch parameters changed still holds the removed
 * `prompt_1..prompt_5` shape in its conversation history. Reopening that task
 * replays the pending call, so the removed shape reaches the current parser
 * through the restore path rather than through a fresh model response.
 *
 * Loading such a task must not fail, and the replayed call must produce an
 * actionable tool error the model can correct on its next turn. These tests
 * cover the parser contract that decides between those two outcomes; the
 * handler converts the thrown error into a durable tool error.
 */
describe("legacy use_subagents history", () => {
	it("rejects a restored legacy call with a message naming the replacement", () => {
		// The restore path stringifies every stored parameter, so the legacy
		// shape arrives here exactly as it was persisted.
		const restoredParams = {
			prompt_1: "<task>\nfirst\n</task>\n<context>\nctx first\n</context>",
			prompt_2: "<task>\nsecond\n</task>\n<context>\nctx second\n</context>",
		}

		assert.throws(
			() => parseUseSubagentsRequest(restoredParams),
			(error: Error) => {
				assert.match(error.message, /prompt_1, prompt_2 parameters are no longer supported/)
				assert.match(error.message, /subagents array/)
				// Naming only the absent parameter would describe the symptom
				// without telling the caller the contract changed.
				assert.doesNotMatch(error.message, /^Missing required parameter/)
				return true
			},
		)
	})

	it("reports the legacy shape rather than the absent parameter when both are wrong", () => {
		// A half-migrated caller sends the new parameter empty alongside the old
		// one. The legacy diagnosis is the useful one.
		assert.throws(
			() => parseUseSubagentsRequest({ subagents: "", prompt_1: "<task>\nx\n</task>\n<context>\ny\n</context>" }),
			/no longer supported/,
		)
	})

	it("still accepts the current shape from the same stringified transport", () => {
		// The restore path carries arrays as JSON text. A restored current-shape
		// call has to keep working, otherwise the legacy guard would have made
		// every reopened batch unusable.
		const request = parseUseSubagentsRequest({
			subagents: JSON.stringify([{ task: "first", context: "ctx first" }]),
		})

		assert.equal(request.items.length, 1)
		assert.equal(request.items[0].task, "first")
	})
})
