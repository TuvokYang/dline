import { strict as assert } from "node:assert"
import { MAX_SUBAGENTS_PER_BATCH } from "@shared/concurrency-limits"
import { describe, it } from "vitest"
import { parseUseSubagentRequest, parseUseSubagentsRequest } from "../SubagentRequestParser"

describe("SubagentRequestParser", () => {
	it("defaults use_subagent to the built-in default profile when no name is provided", () => {
		const request = parseUseSubagentRequest({
			task: "review code",
			context: "check quality",
		})

		assert.equal(request.agentName, "default")
		assert.equal(request.context, "check quality")
	})

	it("parses stable use_subagent defaults", () => {
		const request = parseUseSubagentRequest({
			agent_name: "reviewer",
			task: "review code",
			context: "check quality",
		})

		assert.equal(request.kind, "single")
		assert.equal(request.agentName, "reviewer")
		assert.equal(request.context, "check quality")
		assert.equal(request.options.background, false)
		assert.equal(request.options.timeoutSeconds, 1_200)
		assert.match(request.prompt, /<task>\s*review code\s*<\/task>/)
	})

	it("parses background and timeout in seconds", () => {
		const request = parseUseSubagentRequest({
			agent_name: "reviewer",
			task: "review code",
			context: "check quality",
			background: "true",
			timeout: "30",
		})

		assert.equal(request.options.background, true)
		assert.equal(request.options.timeoutSeconds, 30)
	})

	it("rejects the removed use_subagent parameter names", () => {
		assert.throws(
			() =>
				parseUseSubagentRequest({
					subagent_name: "reviewer",
					task: "review code",
					content: "legacy context",
				}),
			/Missing required parameter: context/,
		)
	})

	it("parses a structured batch with per-item agent, profile and timeout", () => {
		const request = parseUseSubagentsRequest({
			subagents: [
				{ agent_name: "reviewer", task: "one", context: "ctx one", profile: "gpt", timeout: 90 },
				{ task: "two", context: "ctx two" },
			],
			timeout: "600",
		})

		assert.equal(request.kind, "batch")
		assert.equal(request.items.length, 2)

		assert.equal(request.items[0].index, 1)
		assert.equal(request.items[0].agentName, "reviewer")
		assert.equal(request.items[0].profile, "gpt")
		assert.equal(request.items[0].timeoutSeconds, 90)
		assert.match(request.items[0].prompt, /<task>\s*one\s*<\/task>/)
		assert.match(request.items[0].prompt, /<context>\s*ctx one\s*<\/context>/)

		assert.equal(request.items[1].index, 2)
		assert.equal(request.items[1].agentName, "default")
		assert.equal(request.items[1].profile, undefined)
		// An item without its own timeout inherits the batch option instead of
		// carrying a copy of it.
		assert.equal(request.items[1].timeoutSeconds, undefined)
		assert.equal(request.options.timeoutSeconds, 600)
	})

	it("parses the same batch when the transport delivers JSON text", () => {
		const items = [
			{ agent_name: "reviewer", task: "one", context: "ctx one", profile: "gpt", timeout: 90 },
			{ task: "two", context: "ctx two" },
		]

		const fromArray = parseUseSubagentsRequest({ subagents: items, timeout: "600" })
		const fromText = parseUseSubagentsRequest({ subagents: JSON.stringify(items), timeout: "600" })

		assert.deepEqual(fromText, fromArray)
	})

	it("rejects a subagents value that is not a JSON array", () => {
		assert.throws(() => parseUseSubagentsRequest({ subagents: "{not json" }), /Expected a JSON array of subagent items/)
		assert.throws(() => parseUseSubagentsRequest({ subagents: '{"task":"one"}' }), /Expected a JSON array of subagent items/)
	})

	it("rejects a missing or empty batch", () => {
		assert.throws(() => parseUseSubagentsRequest({}), /Missing required parameter: subagents/)
		assert.throws(() => parseUseSubagentsRequest({ subagents: [] }), /Missing required parameter: subagents/)
		assert.throws(() => parseUseSubagentsRequest({ subagents: "   " }), /Missing required parameter: subagents/)
	})

	it("names the failing item when a required field is missing", () => {
		assert.throws(
			() =>
				parseUseSubagentsRequest({
					subagents: [{ task: "one", context: "ctx one" }, { task: "two" }],
				}),
			/Subagent item 2 is missing required field: context/,
		)

		assert.throws(
			() =>
				parseUseSubagentsRequest({
					subagents: [{ context: "ctx one" }],
				}),
			/Subagent item 1 is missing required field: task/,
		)

		assert.throws(
			() => parseUseSubagentsRequest({ subagents: ["<task>one</task>"] }),
			/Subagent item 1 must be an object with task and context fields/,
		)
	})

	it("accepts the maximum batch size and rejects one more", () => {
		const item = (n: number) => ({ task: `task ${n}`, context: `ctx ${n}` })
		const atLimit = Array.from({ length: MAX_SUBAGENTS_PER_BATCH }, (_unused, index) => item(index + 1))

		const request = parseUseSubagentsRequest({ subagents: atLimit })
		assert.equal(request.items.length, MAX_SUBAGENTS_PER_BATCH)
		assert.equal(request.items[MAX_SUBAGENTS_PER_BATCH - 1].index, MAX_SUBAGENTS_PER_BATCH)

		assert.throws(
			() => parseUseSubagentsRequest({ subagents: [...atLimit, item(MAX_SUBAGENTS_PER_BATCH + 1)] }),
			new RegExp(`Too many subagents: ${MAX_SUBAGENTS_PER_BATCH + 1}\\. At most ${MAX_SUBAGENTS_PER_BATCH} items`),
		)
	})

	it("rejects the removed per-slot prompt parameters with the replacement shape", () => {
		assert.throws(
			() => parseUseSubagentsRequest({ prompt_1: "<task>one</task><context>ctx one</context>" }),
			/The prompt_1 parameter is no longer supported\. Send a single subagents array instead, where each item has agent_name, task, context, and optionally profile and timeout\./,
		)

		assert.throws(
			() =>
				parseUseSubagentsRequest({
					prompt_1: "<task>one</task><context>ctx one</context>",
					prompt_2: "<task>two</task><context>ctx two</context>",
				}),
			/The prompt_1, prompt_2 parameters are no longer supported/,
		)

		// The removed shape is reported even when a valid batch is also present,
		// so a half-migrated call is corrected instead of silently dropping the
		// slots the model believed it had sent.
		assert.throws(
			() =>
				parseUseSubagentsRequest({
					subagents: [{ task: "one", context: "ctx one" }],
					prompt_5: "<task>five</task><context>ctx five</context>",
				}),
			/The prompt_5 parameter is no longer supported/,
		)
	})
})
