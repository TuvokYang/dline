import { BUILTIN_INPUT_SEMANTICS, type InputSemanticCatalog } from "@shared/input-semantics/catalog"
import { describe, expect, it } from "vitest"
import { renderSemanticHighlightHtml, segmentSemanticInput, segmentSentMessage } from "../highlight"

const catalog: InputSemanticCatalog = { revision: 1, descriptors: BUILTIN_INPUT_SEMANTICS }

describe("semantic composer highlight", () => {
	it("marks a recognized command and mention as entities", () => {
		expect(segmentSemanticInput("/compact @/src/index.ts", catalog)).toEqual([
			{ text: "/compact", role: "command", active: true },
			{ text: " ", role: "text", active: false },
			{ text: "@/src/index.ts", role: "mention", active: true },
		])
	})

	it("shows text after a lifecycle barrier as literal", () => {
		const segments = segmentSemanticInput("/compact then /explain-changes", catalog)

		expect(segments.filter((segment) => segment.role === "command")).toEqual([
			{ text: "/compact", role: "command", active: true },
			{ text: "/explain-changes", role: "command", active: false },
		])
	})

	it("leaves an unknown command as plain text", () => {
		expect(renderSemanticHighlightHtml("/not-a-command", catalog)).toBe("/not-a-command")
	})

	it("escapes the text it renders", () => {
		expect(renderSemanticHighlightHtml("a < b & c", catalog)).toBe("a &lt; b &amp; c")
	})

	it("keeps a trailing newline visible in the layer", () => {
		expect(renderSemanticHighlightHtml("line\n", catalog)).toBe("line\n\n")
	})
})

describe("sent message highlight", () => {
	it("reads a sent message with the same semantics the task applied", () => {
		expect(segmentSentMessage("/compact @/src/index.ts", catalog)).toEqual([
			{ text: "/compact", role: "command", active: true },
			{ text: " ", role: "text", active: false },
			{ text: "@/src/index.ts", role: "mention", active: true },
		])
	})

	it("does not present a command the task never ran as an entity", () => {
		const segments = segmentSentMessage("Explain why /compact exists, then /explain-changes", catalog)

		expect(segments.filter((segment) => segment.role === "command" && segment.active)).toEqual([
			{ text: "/compact", role: "command", active: true },
		])
		expect(segments).toContainEqual({ text: "/explain-changes", role: "command", active: false })
	})
})
