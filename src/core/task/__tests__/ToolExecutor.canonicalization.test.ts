import { strict as assert } from "node:assert"
import { ClineDefaultTool } from "@shared/tools"
import { describe, it } from "vitest"
import type { ToolUse } from "../../assistant-message"
import { canonicalizeAttemptCompletionParams } from "../tools/attempt-completion-params"

describe("ToolExecutor canonicalization", () => {
	it("canonicalizes attempt_completion response into result", () => {
		const block: ToolUse = {
			type: "tool_use",
			function_id: "test_attempt_response",
			dline_tid: "test_attempt_response_tid",
			name: ClineDefaultTool.ATTEMPT,
			params: {
				response: "final answer from response field",
				task_progress: "- [x] done",
			},
			partial: false,
			ts: Date.now(),
		}

		const didCanonicalize = canonicalizeAttemptCompletionParams(block)

		assert.equal(didCanonicalize, true)
		assert.equal(block.params.result, "final answer from response field")
		assert.equal(block.params.response, "final answer from response field")
	})

	it("does not canonicalize when attempt_completion already has result", () => {
		const block: ToolUse = {
			type: "tool_use",
			function_id: "test_attempt_result",
			dline_tid: "test_attempt_result_tid",
			name: ClineDefaultTool.ATTEMPT,
			params: {
				result: "already canonical",
				response: "extra text",
			},
			partial: false,
			ts: Date.now(),
		}

		const didCanonicalize = canonicalizeAttemptCompletionParams(block)

		assert.equal(didCanonicalize, false)
		assert.equal(block.params.result, "already canonical")
	})

	it("does not canonicalize non-attempt tools", () => {
		const block: ToolUse = {
			type: "tool_use",
			function_id: "test_act_mode",
			dline_tid: "test_act_mode_tid",
			name: ClineDefaultTool.ACT_MODE,
			params: {
				response: "act mode response",
			},
			partial: false,
			ts: Date.now(),
		}

		const didCanonicalize = canonicalizeAttemptCompletionParams(block)

		assert.equal(didCanonicalize, false)
		assert.equal(block.params.result, undefined)
	})
})
