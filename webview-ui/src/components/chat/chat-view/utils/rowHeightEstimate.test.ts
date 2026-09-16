import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { estimateMessageHeight, estimateRowHeight } from "./rowHeightEstimate"

const say = (text: string): ClineMessage => ({ ts: 1, type: "say", say: "text", text }) as ClineMessage

const fenced = (lines: number) =>
	["intro", "```ts", ...Array.from({ length: lines }, (_, line) => `  const value = ${line}`), "```"].join("\n")

describe("estimateMessageHeight", () => {
	it("lands close to the height an eighteen-line block actually renders at", () => {
		// The measured transcript renders exactly this shape at 431px. An
		// estimate far from that is what moves the view when the real height
		// arrives, so the tolerance is what the fix is worth.
		const estimate = estimateMessageHeight(say(fenced(18)))

		expect(estimate).toBeDefined()
		expect(Math.abs((estimate as number) - 431)).toBeLessThan(60)
	})

	it("grows with the amount of code", () => {
		const small = estimateMessageHeight(say(fenced(5))) as number
		const large = estimateMessageHeight(say(fenced(40))) as number

		expect(large).toBeGreaterThan(small)
	})

	it("leaves ordinary prose to the list's own default", () => {
		expect(estimateMessageHeight(say("a short reply"))).toBeUndefined()
		expect(estimateMessageHeight(say("several\nlines\nof\nplain\ntext"))).toBeUndefined()
	})

	it("leaves a message with no text alone", () => {
		expect(estimateMessageHeight({ ts: 1 } as ClineMessage)).toBeUndefined()
		expect(estimateMessageHeight(say(""))).toBeUndefined()
	})

	it("does not claim a block too short to be worth estimating", () => {
		// Two lines of code render close enough to an ordinary row that guessing
		// adds risk without removing a visible jump.
		expect(estimateMessageHeight(say(fenced(2)))).toBeUndefined()
	})

	it("does not treat inline backticks as a block", () => {
		expect(estimateMessageHeight(say("use `npm run build` to compile"))).toBeUndefined()
	})

	it("counts only the lines inside the fence", () => {
		const withProse = ["a", "b", "c", "```ts", ...Array.from({ length: 18 }, () => "code"), "```", "d", "e"].join("\n")

		expect(estimateMessageHeight(say(withProse))).toBe(estimateMessageHeight(say(fenced(18))))
	})

	it("allows a longer fence to contain a shorter backtick run", () => {
		const nested = ["````md", "```ts", "code", "```", "more", "line", "line", "line", "````"].join("\n")

		// Everything between the four-backtick fences counts as code; the inner
		// three-backtick lines do not close it.
		expect(estimateMessageHeight(say(nested))).toBeDefined()
	})

	it("has no height to offer while a block is still being streamed", () => {
		expect(estimateMessageHeight(say("intro\n```ts"))).toBeUndefined()
	})
})

describe("estimateRowHeight", () => {
	it("adds up the messages stacked into one row", () => {
		const single = estimateMessageHeight(say(fenced(18))) as number
		const grouped = estimateRowHeight([say(fenced(18)), say(fenced(18))]) as number

		expect(grouped).toBe(single * 2)
	})

	it("claims a group when only one of its messages carries a block", () => {
		const grouped = estimateRowHeight([say("chatter"), say(fenced(18))])

		expect(grouped).toBe(estimateMessageHeight(say(fenced(18))))
	})

	it("leaves a group of ordinary messages to the default", () => {
		expect(estimateRowHeight([say("one"), say("two")])).toBeUndefined()
	})
})
