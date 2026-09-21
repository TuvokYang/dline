import { BUILTIN_INPUT_SEMANTICS, type InputSemanticCatalog } from "@shared/input-semantics/catalog"
import type { SlashCommandInputNode } from "@shared/input-semantics/document"
import { describe, expect, it } from "vitest"
import { LegacyInputAdapter } from "../LegacyInputAdapter"

const catalog: InputSemanticCatalog = { revision: 9, descriptors: BUILTIN_INPUT_SEMANTICS }

function adapter() {
	let issued = 0
	return new LegacyInputAdapter(
		() => catalog,
		() => `legacy-${++issued}`,
	)
}

describe("LegacyInputAdapter", () => {
	it("upgrades legacy text into a document stamped with the current catalog revision", () => {
		const document = adapter().adapt({ text: "/compact now" })

		expect(document.documentId).toBe("legacy-1")
		expect(document.catalogRevision).toBe("9")
		expect(document.rawText).toBe("/compact now")
	})

	it("recognizes a typed command, because a legacy client cannot confirm a candidate", () => {
		const [node] = adapter()
			.adapt({ text: "/compact" })
			.nodes.filter((candidate): candidate is SlashCommandInputNode => candidate.kind === "slash_command")

		expect(node.state).toBe("recognized")
		expect(node.commandId).toBe("command.compact")
	})

	it("produces an empty document for input that carries only attachments", () => {
		const document = adapter().adapt({ images: ["data:image/png;base64,AAA"] })

		expect(document.rawText).toBe("")
		expect(document.nodes).toEqual([])
	})

	it("issues a fresh document id per submission, so two legacy inputs never share identity", () => {
		const legacy = adapter()

		expect(legacy.adapt({ text: "a" }).documentId).not.toBe(legacy.adapt({ text: "b" }).documentId)
	})
})
