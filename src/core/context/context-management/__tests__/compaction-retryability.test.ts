import { describe, expect, it } from "vitest"
import { extractHttpStatus, isDeterministicToolPairingError, isRetryableCompactionError } from "../compaction-retryability"

describe("compaction retryability", () => {
	it.each([
		new Error("HTTP 400: No tool output found for function call fc_1."),
		new Error("OpenAI API Error 400: No tool output found for function call fc_1."),
		new Error("Request failed with status code 400: tool messages must follow tool_calls."),
		Object.assign(new Error("No tool output found for function call fc_1."), { response: { status: 400 } }),
	])("extracts wrapped HTTP 400 status", (error) => {
		expect(extractHttpStatus(error)).toBe(400)
	})

	it.each([
		new Error("HTTP 400: No tool output found for function call fc_1."),
		new Error("API Error 400: Messages with role 'tool' must be a response to a preceding message with 'tool_calls'."),
		Object.assign(new Error("tool_result has no corresponding tool_use"), { statusCode: 400 }),
		Object.assign(
			new Error(
				"messages.188: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_1. Each `tool_use` block must have a corresponding `tool_result` block in the next message.",
			),
			{ status: 400 },
		),
	])("classifies an explicit tool-pairing 400 as deterministic", (error) => {
		expect(isDeterministicToolPairingError(error)).toBe(true)
		expect(isRetryableCompactionError(error)).toBe(false)
	})

	it.each([
		new Error("API Error 400: Invalid API key"),
		Object.assign(new Error("context length exceeded"), { status: 400 }),
		Object.assign(new Error("No tool output found for function call fc_1."), { status: 503 }),
	])("does not misclassify unrelated or transient failures as deterministic tool-pairing 400", (error) => {
		expect(isDeterministicToolPairingError(error)).toBe(false)
	})
})
