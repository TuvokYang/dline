import { describe, expect, it } from "vitest"
import { KeyedToolResultAccumulator } from "../KeyedToolResultAccumulator"

describe("KeyedToolResultAccumulator", () => {
	describe("attribution", () => {
		it("gives each tool only its own approval feedback", () => {
			const accumulator = new KeyedToolResultAccumulator()

			accumulator.addFeedback({ dlineTid: "edit", content: "run it in the src folder" })
			accumulator.addFeedback({ dlineTid: "command", content: "use the dev script" })

			// Completion order is deliberately the reverse of the tool-call
			// order: this is the interleaving the shared drain got wrong.
			accumulator.addOutcome({ dlineTid: "command", index: 1, content: "command ran" })
			accumulator.addOutcome({ dlineTid: "edit", index: 0, content: "file written" })

			expect(accumulator.feedbackFor("edit")).toEqual(["run it in the src folder"])
			expect(accumulator.feedbackFor("command")).toEqual(["use the dev script"])
		})

		it("leaves a tool without feedback empty rather than borrowing another's", () => {
			const accumulator = new KeyedToolResultAccumulator()

			accumulator.addFeedback({ dlineTid: "edit", content: "careful here" })
			accumulator.addOutcome({ dlineTid: "edit", index: 0, content: "written" })
			accumulator.addOutcome({ dlineTid: "read", index: 1, content: "contents" })

			expect(accumulator.feedbackFor("read")).toEqual([])
		})

		it("keeps several feedback entries for one tool in arrival order", () => {
			const accumulator = new KeyedToolResultAccumulator()

			accumulator.addFeedback({ dlineTid: "edit", content: "first" })
			accumulator.addFeedback({ dlineTid: "edit", content: "second" })
			accumulator.addOutcome({ dlineTid: "edit", index: 0, content: "written" })

			expect(accumulator.feedbackFor("edit")).toEqual(["first", "second"])
		})

		it("returns a copy so a caller cannot mutate stored feedback", () => {
			const accumulator = new KeyedToolResultAccumulator()
			accumulator.addFeedback({ dlineTid: "edit", content: "keep me" })

			accumulator.feedbackFor("edit").push("injected")

			expect(accumulator.feedbackFor("edit")).toEqual(["keep me"])
		})
	})

	describe("assembly order", () => {
		it("orders results by assistant tool-call position, not completion order", () => {
			const accumulator = new KeyedToolResultAccumulator()

			accumulator.addOutcome({ dlineTid: "third", index: 2, content: "c" })
			accumulator.addOutcome({ dlineTid: "first", index: 0, content: "a" })
			accumulator.addOutcome({ dlineTid: "second", index: 1, content: "b" })

			expect(accumulator.assemble().map((entry) => entry.dlineTid)).toEqual(["first", "second", "third"])
		})

		it("attaches each result's own feedback during assembly", () => {
			const accumulator = new KeyedToolResultAccumulator()

			accumulator.addOutcome({ dlineTid: "b", index: 1, content: "second result" })
			accumulator.addFeedback({ dlineTid: "b", content: "note for b" })
			accumulator.addOutcome({ dlineTid: "a", index: 0, content: "first result" })

			expect(accumulator.assemble()).toEqual([
				{ dlineTid: "a", index: 0, content: "first result", feedback: [] },
				{ dlineTid: "b", index: 1, content: "second result", feedback: ["note for b"] },
			])
		})

		it("preserves the error flag only when it was recorded", () => {
			const accumulator = new KeyedToolResultAccumulator()

			accumulator.addOutcome({ dlineTid: "ok", index: 0, content: "fine" })
			accumulator.addOutcome({ dlineTid: "bad", index: 1, content: "failed", isError: true })

			const [ok, bad] = accumulator.assemble()
			expect(ok).not.toHaveProperty("isError")
			expect(bad.isError).toBe(true)
		})
	})

	describe("re-execution", () => {
		it("replaces an earlier outcome for the same identity", () => {
			const accumulator = new KeyedToolResultAccumulator()

			accumulator.addOutcome({ dlineTid: "edit", index: 0, content: "SEARCH block not found", isError: true })
			accumulator.addOutcome({ dlineTid: "edit", index: 0, content: "written" })

			expect(accumulator.size).toBe(1)
			expect(accumulator.assemble()[0]).toEqual({
				dlineTid: "edit",
				index: 0,
				content: "written",
				feedback: [],
			})
		})

		it("keeps feedback recorded before the replacement", () => {
			const accumulator = new KeyedToolResultAccumulator()

			accumulator.addFeedback({ dlineTid: "edit", content: "try again" })
			accumulator.addOutcome({ dlineTid: "edit", index: 0, content: "failed", isError: true })
			accumulator.addOutcome({ dlineTid: "edit", index: 0, content: "written" })

			expect(accumulator.assemble()[0].feedback).toEqual(["try again"])
		})
	})

	describe("orphaned feedback", () => {
		it("reports feedback whose execution never produced an outcome", () => {
			const accumulator = new KeyedToolResultAccumulator()

			accumulator.addFeedback({ dlineTid: "cancelled", content: "stop" })
			accumulator.addFeedback({ dlineTid: "completed", content: "go ahead" })
			accumulator.addOutcome({ dlineTid: "completed", index: 0, content: "done" })

			// A rejected or cancelled block leaves feedback behind; dropping it
			// silently would lose what the user typed.
			expect(accumulator.orphanedFeedback()).toEqual([{ dlineTid: "cancelled", content: "stop" }])
		})

		it("reports nothing when every execution completed", () => {
			const accumulator = new KeyedToolResultAccumulator()

			accumulator.addFeedback({ dlineTid: "a", content: "note" })
			accumulator.addOutcome({ dlineTid: "a", index: 0, content: "done" })

			expect(accumulator.orphanedFeedback()).toEqual([])
		})
	})

	describe("bookkeeping", () => {
		it("tracks recorded identities", () => {
			const accumulator = new KeyedToolResultAccumulator()
			expect(accumulator.has("a")).toBe(false)

			accumulator.addOutcome({ dlineTid: "a", index: 0, content: "done" })
			expect(accumulator.has("a")).toBe(true)
			expect(accumulator.size).toBe(1)
		})

		it("clears both outcomes and feedback", () => {
			const accumulator = new KeyedToolResultAccumulator()
			accumulator.addFeedback({ dlineTid: "a", content: "note" })
			accumulator.addOutcome({ dlineTid: "a", index: 0, content: "done" })

			accumulator.clear()

			expect(accumulator.size).toBe(0)
			expect(accumulator.assemble()).toEqual([])
			expect(accumulator.orphanedFeedback()).toEqual([])
		})
	})

	describe("structured content", () => {
		it("carries structured result blocks through unchanged", () => {
			const accumulator = new KeyedToolResultAccumulator()
			const content = [
				{ type: "text" as const, text: "here is the file" },
				{ type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: "x" } },
			]

			accumulator.addOutcome({ dlineTid: "read", index: 0, content })

			expect(accumulator.assemble()[0].content).toBe(content)
		})
	})
})
