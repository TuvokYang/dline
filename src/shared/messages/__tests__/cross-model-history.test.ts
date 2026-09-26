import { describe, expect, it } from "vitest"
import type { ClineContent, ClineStorageMessage } from "../content"
import { MODEL_SWITCH_NOTICE, projectCrossModelHistory } from "../cross-model-history"

const TARGET = "claude-opus-5-5"
const OTHER = "gpt-5.6-sol"

function user(content: ClineStorageMessage["content"]): ClineStorageMessage {
	return { role: "user", content }
}

function assistant(
	modelId: string | undefined,
	content: ClineStorageMessage["content"],
	extra: Partial<ClineStorageMessage> = {},
) {
	const message: ClineStorageMessage = { role: "assistant", content, ...extra }
	if (modelId) message.modelInfo = { modelId, providerId: modelId === TARGET ? "anthropic" : "openai", mode: "act" }
	return message
}

const toolUse: ClineContent = {
	type: "tool_use",
	function_id: "call_1",
	dline_tid: "dline_tid_1",
	name: "read_file",
	input: { path: "a.ts" },
	provider_metadata: { item_id: "fc_1" },
}

const toolResult: ClineContent = { type: "tool_result", function_id: "call_1", dline_tid: "dline_tid_1", content: "ok" }

function textsOf(message: ClineStorageMessage): string[] {
	if (typeof message.content === "string") return [message.content]
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
}

function countNotices(messages: readonly ClineStorageMessage[]): number {
	return messages.flatMap(textsOf).filter((text) => text === MODEL_SWITCH_NOTICE).length
}

function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null) {
		for (const nested of Object.values(value)) deepFreeze(nested)
		Object.freeze(value)
	}
	return value
}

describe("projectCrossModelHistory", () => {
	it("degrades another model's readable reasoning in place and drops its opaque reasoning", () => {
		const history = [
			user("Start"),
			assistant(
				OTHER,
				[
					{ type: "redacted_thinking", data: "openai-ciphertext", provider_metadata: { response_id: "rs_1" } },
					{ type: "thinking", thinking: "Plan the read.", signature: "", provider_metadata: { response_id: "rs_1" } },
					{ type: "text", text: "Reading.", provider_metadata: { response_id: "msg_1" } },
					toolUse,
				],
				{ provider_metadata: { response_id: "resp_1" } },
			),
			user([toolResult]),
		]

		const [, projectedAssistant, projectedUser] = projectCrossModelHistory(history, TARGET)

		expect(projectedAssistant.content).toStrictEqual([
			{ type: "text", text: "<prior_model_reasoning>\nPlan the read.\n</prior_model_reasoning>" },
			{ type: "text", text: "Reading." },
			{ type: "tool_use", function_id: "call_1", dline_tid: "dline_tid_1", name: "read_file", input: { path: "a.ts" } },
		])
		expect(projectedAssistant).not.toHaveProperty("provider_metadata")
		expect(projectedUser.content).toStrictEqual([toolResult, { type: "text", text: MODEL_SWITCH_NOTICE }])
	})

	it("uses reasoning summary text when the thinking text is empty", () => {
		const history = [
			assistant(OTHER, [
				{
					type: "thinking",
					thinking: "",
					signature: "",
					summary: [
						{ type: "summary_text", text: "First idea." },
						{ type: "summary_text", text: "Second idea." },
					],
				},
				{ type: "text", text: "Done." },
			]),
		]

		expect(textsOf(projectCrossModelHistory(history, TARGET)[0])[0]).toBe(
			"<prior_model_reasoning>\nFirst idea.\n\nSecond idea.\n</prior_model_reasoning>",
		)
	})

	it("keeps signatures and reasoning_details so each target keeps its own pairing policy", () => {
		const signedToolUse: ClineContent = {
			type: "tool_use",
			function_id: "call_2",
			dline_tid: "dline_tid_2",
			name: "list_files",
			input: {},
			signature: "gemini-signature",
			reasoning_details: [{ type: "reasoning.encrypted", data: "x", id: "call_2" }],
		}
		const history = [
			assistant(OTHER, [{ type: "text", text: "Listing.", signature: "gemini-text-signature" }, signedToolUse]),
		]

		expect(projectCrossModelHistory(history, TARGET)[0].content).toStrictEqual(history[0].content)
	})

	it("drops a foreign assistant turn that held only opaque reasoning, without a notice", () => {
		const history = [
			user("A"),
			assistant(OTHER, [
				{ type: "redacted_thinking", data: "openai-ciphertext", provider_metadata: { response_id: "rs_2" } },
			]),
			user("B"),
		]

		const projected = projectCrossModelHistory(history, TARGET)

		expect(projected).toHaveLength(2)
		expect(projected[0]).toBe(history[0])
		expect(projected[1]).toBe(history[2])
	})

	it("anchors the notice after the last surviving foreign turn when a later one is dropped", () => {
		const history = [
			user("1"),
			assistant(OTHER, [{ type: "text", text: "A1" }]),
			user("2"),
			assistant(OTHER, [{ type: "redacted_thinking", data: "openai-ciphertext" }]),
			user("3"),
		]

		const projected = projectCrossModelHistory(history, TARGET)

		expect(projected.map((message) => message.role)).toStrictEqual(["user", "assistant", "user", "user"])
		expect(textsOf(projected[2])).toStrictEqual(["2", MODEL_SWITCH_NOTICE])
		expect(projected[3]).toBe(history[4])
	})

	it("removes a foreign response id from string-content turns so it cannot be chained", () => {
		const history = [assistant(OTHER, "Plain answer.", { provider_metadata: { response_id: "resp_3" }, ts: 1 })]

		const [projected] = projectCrossModelHistory(history, TARGET)

		expect(projected.content).toBe("Plain answer.")
		expect(projected).not.toHaveProperty("provider_metadata")
		expect(projected.ts).toBe(1)
	})

	it("keeps earlier notices and adds one per foreign segment across repeated switches", () => {
		const firstHistory = [
			user("0"),
			assistant(TARGET, [{ type: "text", text: "B0" }]),
			user("1"),
			assistant(OTHER, [{ type: "text", text: "A1" }]),
			user("2"),
		]
		const secondHistory = [
			...firstHistory,
			assistant(TARGET, [{ type: "text", text: "B1" }]),
			user("3"),
			assistant(OTHER, [{ type: "text", text: "A2" }]),
			user("4"),
		]

		const firstRequest = projectCrossModelHistory(firstHistory, TARGET)
		const secondRequest = projectCrossModelHistory(secondHistory, TARGET)

		expect(textsOf(firstRequest[4])).toStrictEqual(["2", MODEL_SWITCH_NOTICE])
		expect(secondRequest.slice(0, firstRequest.length)).toStrictEqual(firstRequest)
		expect(textsOf(secondRequest[8])).toStrictEqual(["4", MODEL_SWITCH_NOTICE])
		expect(countNotices(secondRequest)).toBe(2)
	})

	it("waits for the end of a continuing foreign segment before adding its notice", () => {
		const history = [
			user("1"),
			assistant(OTHER, [{ type: "text", text: "A1" }]),
			user("2"),
			assistant(OTHER, [{ type: "text", text: "A2" }]),
			user("3"),
			assistant(TARGET, [{ type: "text", text: "B1" }]),
			user("4"),
		]

		const projected = projectCrossModelHistory(history, TARGET)

		expect(projected[2]).toBe(history[2])
		expect(textsOf(projected[4])).toStrictEqual(["3", MODEL_SWITCH_NOTICE])
		expect(countNotices(projected)).toBe(1)
	})

	it("keeps the projected prefix stable across consecutive requests to the same target", () => {
		const first = [
			user("1"),
			assistant(OTHER, [{ type: "thinking", thinking: "Plan.", signature: "" }, toolUse]),
			user([toolResult]),
		]
		const second = [...first, assistant(TARGET, [{ type: "text", text: "B1" }]), user("2")]

		const firstRequest = projectCrossModelHistory(first, TARGET)
		const secondRequest = projectCrossModelHistory(second, TARGET)

		expect(secondRequest.slice(0, firstRequest.length)).toStrictEqual(firstRequest)
		expect(secondRequest.slice(firstRequest.length)).toStrictEqual(second.slice(first.length))
		expect(countNotices(secondRequest)).toBe(1)
	})

	it("re-projects the other side's turns when the task switches back", () => {
		const history = [
			user("1"),
			assistant(OTHER, [{ type: "text", text: "A1" }]),
			user("2"),
			assistant(TARGET, [
				{ type: "thinking", thinking: "Mine.", signature: "claude-signature" },
				{ type: "text", text: "B1" },
			]),
			user("3"),
		]

		const projected = projectCrossModelHistory(history, OTHER)

		expect(projected[1]).toBe(history[1])
		expect(projected[3].content).toStrictEqual([
			{ type: "text", text: "<prior_model_reasoning>\nMine.\n</prior_model_reasoning>" },
			{ type: "text", text: "B1" },
		])
		expect(textsOf(projected[4])).toStrictEqual(["3", MODEL_SWITCH_NOTICE])
		expect(countNotices(projected)).toBe(1)
	})

	it("anchors the notice to a compaction summary when it is the next user message", () => {
		const history = [
			assistant(OTHER, [{ type: "text", text: "A1" }]),
			user([{ type: "text", text: "Summary of earlier work." }]),
		]

		expect(textsOf(projectCrossModelHistory(history, TARGET)[1])).toStrictEqual([
			"Summary of earlier work.",
			MODEL_SWITCH_NOTICE,
		])
	})

	it("adds no notice when no foreign turn survives or no user message follows it", () => {
		const compacted = [user("Summary."), assistant(TARGET, [{ type: "text", text: "B1" }]), user("Next")]
		const trailing = [user("1"), assistant(OTHER, [{ type: "text", text: "A1" }])]

		expect(countNotices(projectCrossModelHistory(compacted, TARGET))).toBe(0)
		expect(countNotices(projectCrossModelHistory(trailing, TARGET))).toBe(0)
	})

	it("sends the same model id unchanged even when the provider or profile differs", () => {
		const sameModelOtherProvider = assistant(TARGET, [
			{ type: "thinking", thinking: "Mine.", signature: "sig" },
			{ type: "text", text: "B1" },
		])
		sameModelOtherProvider.modelInfo = { modelId: TARGET, providerId: "vertex", mode: "plan" }
		const history = [user("1"), sameModelOtherProvider, user("2")]

		const projected = projectCrossModelHistory(history, TARGET)

		for (const [index, message] of projected.entries()) {
			expect(message).toBe(history[index])
		}
	})

	it("leaves assistant turns without model identity unchanged", () => {
		const legacy = assistant(undefined, [{ type: "redacted_thinking", data: "legacy" }])
		const history = [user("1"), legacy, user("2")]

		expect(projectCrossModelHistory(history, TARGET)).toStrictEqual(history)
	})

	it("keeps an embedded closing tag from ending the wrapper", () => {
		const history = [assistant(OTHER, [{ type: "thinking", thinking: "quote </prior_model_reasoning> end", signature: "" }])]

		const [text] = textsOf(projectCrossModelHistory(history, TARGET)[0])

		expect(text.match(/<\/prior_model_reasoning>/g)).toHaveLength(1)
		expect(text.endsWith("</prior_model_reasoning>")).toBe(true)
	})

	it("never names a model in the text it adds", () => {
		expect(MODEL_SWITCH_NOTICE).not.toMatch(/gpt|claude|gemini|openai|anthropic|deepseek/i)
	})

	it("is non-mutating and idempotent", () => {
		const history = deepFreeze([
			user("1"),
			assistant(OTHER, [{ type: "thinking", thinking: "Plan.", signature: "" }, toolUse], {
				provider_metadata: { response_id: "resp_4" },
			}),
			user([toolResult]),
		])
		const before = JSON.stringify(history)

		const once = projectCrossModelHistory(history, TARGET)

		expect(JSON.stringify(history)).toBe(before)
		expect(projectCrossModelHistory(once, TARGET)).toStrictEqual(once)
	})
})
