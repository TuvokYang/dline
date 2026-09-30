import { combineApiRequests } from "@shared/combineApiRequests"
import { combineCommandSequences } from "@shared/combineCommandSequences"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { getApiMetrics } from "@shared/getApiMetrics"
import { describe, expect, it, vi } from "vitest"
import { MessageUsageProjection } from "../MessageUsageProjection"

function usage(
	say: NonNullable<ClineMessage["say"]>,
	ts: number,
	payload: unknown,
	extra: Partial<ClineMessage> = {},
): ClineMessage {
	return { ts, type: "say", say, text: JSON.stringify(payload), ...extra }
}

const started = (ts: number, payload: unknown, extra: Partial<ClineMessage> = {}) => usage("api_req_started", ts, payload, extra)
const finished = (ts: number, payload: unknown, extra: Partial<ClineMessage> = {}) =>
	usage("api_req_finished", ts, payload, extra)
const legacy = (messages: ClineMessage[]) => getApiMetrics(combineApiRequests(combineCommandSequences(messages)))

function outcome(read: () => ReturnType<typeof getApiMetrics>) {
	try {
		return { metrics: read() }
	} catch (error) {
		if (!(error instanceof Error)) throw error
		return { errorName: error.name, errorMessage: error.message }
	}
}

const cases: { name: string; messages: ClineMessage[] }[] = [
	{
		name: "normal pair and unfinished request",
		messages: [started(1, { request: "body", tokensIn: 10 }), finished(2, { tokensOut: 20 }), started(3, { tokensIn: 5 })],
	},
	{
		name: "missing fields and explicit zero cache",
		messages: [started(1, { tokensIn: 10, cacheReads: 7 }), finished(2, { cacheReads: 0, cacheWrites: 0 })],
	},
	{
		name: "null and invalid fields override earlier numbers",
		messages: [
			started(1, { tokensIn: 10, tokensOut: 20, cost: 1, currency: "USD" }),
			finished(2, { tokensIn: null, tokensOut: "wrong", cost: {}, currency: false }),
		],
	},
	{
		name: "negative and fractional values",
		messages: [started(1, { tokensIn: -2.5, tokensOut: 1.75, cost: -0.25 }), finished(2, { cacheReads: 0.5 })],
	},
	{
		name: "empty first currency and ordered mixed currencies",
		messages: [
			started(1, { currency: "", cost: 0.1 }),
			started(2, { currency: " ", cost: 0.2 }),
			started(3, { currency: "USD", cost: 0.3 }),
		],
	},
	{
		name: "subagent and deleted usage remain independent",
		messages: [
			started(1, { tokensIn: 10 }),
			usage("subagent_usage", 2, { tokensIn: 5, cacheReads: 0 }),
			usage("deleted_api_reqs", 3, { tokensIn: 7, cacheWrites: 3 }),
		],
	},
	{
		name: "interleaved started still contributes independently",
		messages: [started(3, { tokensIn: 10 }), started(1, { tokensIn: 50 }), finished(2, { tokensOut: 4 })],
	},
	{
		name: "duplicate timestamps use the first paired result",
		messages: [
			started(1, { tokensIn: 10 }),
			finished(2, { tokensOut: 20 }),
			started(1, { tokensIn: 99 }),
			finished(4, { tokensOut: 40 }),
		],
	},
	{ name: "orphan malformed finished is removed", messages: [finished(1, {}, { text: "{bad" }), started(2, { tokensIn: 3 })] },
	{
		name: "unpaired malformed usage remains ignored",
		messages: [
			started(1, {}, { text: "{bad" }),
			usage("deleted_api_reqs", 2, null),
			usage("subagent_usage", 3, [1, 2]),
			started(4, { tokensIn: 8 }),
		],
	},
	{
		name: "skipped malformed started is not a pairing error",
		messages: [started(1, { tokensIn: 10 }), started(2, {}, { text: "{bad" }), finished(3, { tokensOut: 20 })],
	},
	{ name: "empty paired text is an empty object", messages: [started(1, {}, { text: "" }), finished(2, { tokensOut: 20 })] },
	{ name: "primitive JSON remains non-statistical", messages: [started(1, "string"), finished(2, null), started(3, 12)] },
	{ name: "unpaired infinite JSON number remains a number", messages: [started(1, {}, { text: '{"tokensIn":1e400}' })] },
	{
		name: "paired infinite JSON number is normalized by JSON",
		messages: [started(1, {}, { text: '{"tokensIn":1e400,"tokensOut":3}' }), finished(2, { cacheReads: 0 })],
	},
	{
		name: "ask rows with usage say names are not counted",
		messages: [started(1, { tokensIn: 10 }, { type: "ask" }), finished(2, { tokensOut: 20 })],
	},
	{
		name: "partial usage is not excluded",
		messages: [started(1, { tokensIn: 10 }, { partial: true }), finished(2, { tokensOut: 20 }, { partial: true })],
	},
	{
		name: "command output filtering precedes usage",
		messages: [started(1, { tokensIn: 10 }, { ask: "command_output", commandTs: 9 }), started(2, { tokensIn: 5 })],
	},
	{
		name: "orphan command output filtering remains unchanged",
		messages: [started(1, { tokensIn: 10 }, { ask: "command_output" }), started(2, { tokensIn: 5 })],
	},
	{
		name: "command rewrites mixed usage text",
		messages: [
			started(1, { tokensIn: 10 }, { ask: "command" }),
			{ ts: 2, type: "say", say: "command_output", commandTs: 1, text: "output" },
		],
	},
	{
		name: "duplicate commands retain last-row replacement",
		messages: [
			started(1, { tokensIn: 10 }, { ask: "command" }),
			{ ts: 1, type: "ask", ask: "command", text: "plain command" },
		],
	},
]

describe("MessageUsageProjection", () => {
	it.each(cases)("preserves legacy metrics: $name", ({ messages }) => {
		const projection = new MessageUsageProjection()
		expect(outcome(() => projection.read(messages))).toStrictEqual(outcome(() => legacy(messages)))
		expect(outcome(() => projection.read(messages.slice(1)))).toStrictEqual(outcome(() => legacy(messages.slice(1))))
	})

	it.each([
		[started(1, {}, { text: "{bad" }), finished(2, {})],
		[started(1, {}), finished(2, {}, { text: "{bad" })],
		[started(1, {}), finished(2, {}), started(1, {}, { text: "{bad" }), finished(4, {})],
	])("preserves paired parse errors", (...messages) => {
		expect(() => legacy(messages)).toThrow(SyntaxError)
		expect(() => new MessageUsageProjection().read(messages)).toThrow(SyntaxError)
	})

	it("detects same-object text and classification mutations", () => {
		const message = started(1, { tokensIn: 10 })
		const messages = [message]
		const projection = new MessageUsageProjection()
		expect(projection.read(messages).totalTokensIn).toBe(10)
		message.text = JSON.stringify({ tokensIn: 22 })
		expect(projection.read(messages).totalTokensIn).toBe(22)
		message.type = "ask"
		expect(projection.read(messages).totalTokensIn).toBe(0)
		message.type = "say"
		message.ask = "command_output"
		expect(projection.read(messages).totalTokensIn).toBe(0)
		message.ask = undefined
		message.say = "subagent_usage"
		expect(projection.read(messages).totalTokensIn).toBe(22)
	})

	it("detects timestamp changes that alter duplicate pairing", () => {
		const first = started(1, { tokensIn: 10 })
		const second = started(3, { tokensIn: 30 })
		const messages = [first, finished(2, {}), second, finished(4, {})]
		const projection = new MessageUsageProjection()
		expect(projection.read(messages).totalTokensIn).toBe(40)
		second.ts = 1
		expect(projection.read(messages).totalTokensIn).toBe(20)
		expect(projection.read(messages)).toStrictEqual(legacy(messages))
	})

	it("reuses scalar projections across state and history reads and refreshes changed rows", () => {
		const text = JSON.stringify({ request: "synthetic request ".repeat(8_000), tokensIn: 10 })
		const message = started(2, {}, { text })
		const messages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "Task" },
			message,
			finished(3, { tokensOut: 20 }),
		]
		const projection = new MessageUsageProjection()
		const parse = vi.spyOn(JSON, "parse")
		try {
			expect(projection.read(messages).totalTokensIn).toBe(10)
			expect(projection.read(messages.slice(1)).totalTokensOut).toBe(20)
			messages.push({ ts: 4, type: "say", say: "text", partial: true, text: "Streaming" })
			expect(projection.read(messages).totalTokensIn).toBe(10)
			expect(parse.mock.calls.filter(([input]) => input === text)).toHaveLength(1)
			messages[1] = started(2, { tokensIn: 99 })
			expect(projection.read(messages).totalTokensIn).toBe(99)
		} finally {
			parse.mockRestore()
		}
	})
})
