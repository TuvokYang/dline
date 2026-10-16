import { BUILTIN_INPUT_SEMANTICS, type InputSemanticCatalog } from "@shared/input-semantics/catalog"
import type { SlashCommandInputNode } from "@shared/input-semantics/document"
import { describe, expect, it } from "vitest"
import { LegacyInputAdapter } from "../LegacyInputAdapter"

const catalog: InputSemanticCatalog = { revision: 9, descriptors: BUILTIN_INPUT_SEMANTICS }

function adapter(source: () => Promise<InputSemanticCatalog> = async () => catalog) {
    let issued = 0
    return new LegacyInputAdapter(source, () => `legacy-${++issued}`)
}

describe("LegacyInputAdapter", () => {
    it("upgrades legacy text into a document stamped with the current catalog revision", async () => {
        const { document } = await adapter().adapt({ text: "/compact now" })

        expect(document.documentId).toBe("legacy-1")
        expect(document.catalogRevision).toBe("9")
        expect(document.rawText).toBe("/compact now")
    })

    it("returns the exact catalog it lexed against, so admission cannot check a newer revision", async () => {
        const { document, catalog: used } = await adapter().adapt({ text: "/compact now" })

        expect(used).toBe(catalog)
        expect(document.catalogRevision).toBe(String(used.revision))
    })

    it("recognizes a typed command, because a legacy client cannot confirm a candidate", async () => {
        const { document } = await adapter().adapt({ text: "/compact" })
        const [node] = document.nodes.filter(
            (candidate): candidate is SlashCommandInputNode => candidate.kind === "slash_command",
        )

        expect(node.state).toBe("recognized")
        expect(node.commandId).toBe("command.compact")
    })

    it("admits plain text from the current snapshot without starting capability discovery", async () => {
        let discoveryRequested = false
        const pendingDiscovery = new Promise<InputSemanticCatalog>(() => undefined)
        const legacy = new LegacyInputAdapter(
            () => {
                discoveryRequested = true
                return pendingDiscovery
            },
            () => "legacy-plain",
            () => catalog,
        )

        const { document, catalog: used } = await legacy.adapt({ text: "ordinary text without semantic candidates" })

        expect(discoveryRequested).toBe(false)
        expect(used).toBe(catalog)
        expect(document).toMatchObject({
            documentId: "legacy-plain",
            catalogRevision: "9",
            rawText: "ordinary text without semantic candidates",
            nodes: [{ kind: "text", text: "ordinary text without semantic candidates" }],
        })
    })

    it("waits for capability discovery, so a workspace command is not demoted to plain text", async () => {
        const discovered: InputSemanticCatalog = {
            revision: 1,
            descriptors: [
                ...BUILTIN_INPUT_SEMANTICS,
                {
                    id: "command.skill.work-smoke-health",
                    kind: "command",
                    trigger: "/skills:work-smoke-health",
                    payload: "text",
                    composition: "combinable",
                    lifecycle: "turn",
                    dynamic: true,
                },
            ],
        }
        const { document } = await adapter(async () => discovered).adapt({ text: "/skills:work-smoke-health go" })
        const [node] = document.nodes.filter(
            (candidate): candidate is SlashCommandInputNode => candidate.kind === "slash_command",
        )

        expect(node.state).toBe("recognized")
        expect(node.commandId).toBe("command.skill.work-smoke-health")
    })

    it("produces an empty document for input that carries only attachments", async () => {
        const { document } = await adapter().adapt({ images: ["data:image/png;base64,AAA"] })

        expect(document.rawText).toBe("")
        expect(document.nodes).toEqual([])
    })

    it("issues a fresh document id per submission, so two legacy inputs never share identity", async () => {
        const legacy = adapter()

        const first = await legacy.adapt({ text: "a" })
        const second = await legacy.adapt({ text: "b" })

        expect(first.document.documentId).not.toBe(second.document.documentId)
    })
})
