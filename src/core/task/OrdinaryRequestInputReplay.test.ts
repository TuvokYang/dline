import type { CompactionProviderInput } from "@core/task/compaction/CompactionProviderInput"
import { describe, expect, it } from "vitest"
import { OrdinaryRequestInputReplay } from "./OrdinaryRequestInputReplay"

function providerInput(marker: string): CompactionProviderInput {
	return {
		systemPrompt: `system-${marker}`,
		messages: [{ role: "user", content: `message-${marker}` }],
		serverTools: [],
	}
}

describe("OrdinaryRequestInputReplay", () => {
	it("returns detached copies of one frozen logical request until it is acknowledged", () => {
		const replay = new OrdinaryRequestInputReplay()
		const input = providerInput("frozen")
		replay.freeze(7, input)

		const first = replay.get(7)
		const retry = replay.get(7)

		expect(first).toEqual(input)
		expect(retry).toEqual(input)
		expect(first).not.toBe(retry)
		if (!first) throw new Error("Frozen ordinary input was not available")
		first.messages[0].content = "mutated"
		expect(replay.get(7)).toEqual(input)
		expect(replay.get(8)).toBeUndefined()

		replay.acknowledge(7)
		expect(replay.get(7)).toBeUndefined()
	})

	it("allows exactly one canonical rebuild replacement for a deterministic request failure", () => {
		const replay = new OrdinaryRequestInputReplay()
		const repaired = providerInput("repaired")
		replay.freeze(7, providerInput("frozen"))

		expect(replay.prepareCanonicalRebuild(7)).toBe("rebuild")
		replay.replaceAfterCanonicalRebuild(7, repaired)
		expect(replay.get(7)).toEqual(repaired)
		expect(replay.prepareCanonicalRebuild(7)).toBe("exhausted")
		expect(replay.prepareCanonicalRebuild(8)).toBe("unavailable")
	})

	it("replaces a stale logical request and clears the current request before canonical changes", () => {
		const replay = new OrdinaryRequestInputReplay()
		const second = providerInput("second")
		replay.freeze(3, providerInput("first"))
		replay.freeze(4, second)

		expect(replay.get(3)).toBeUndefined()
		expect(replay.get(4)).toEqual(second)

		replay.clear()
		expect(replay.get(4)).toBeUndefined()
	})
})
