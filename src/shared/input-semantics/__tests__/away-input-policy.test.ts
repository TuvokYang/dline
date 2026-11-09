import { describe, expect, it } from "vitest"
import { InputSemanticCatalog as WireCatalog } from "../../proto/dline/slash"
import { fromProtoInputSemanticCatalog, toProtoInputSemanticCatalog } from "../../proto-conversions/input-semantics/catalog"
import { BUILTIN_INPUT_SEMANTICS, establishesLifecycleBarrier, validateComposition } from "../catalog"
import { lexSemanticInput } from "../lexer"
import { validateSemanticInputDocument } from "../validation"

const domain = { revision: 7, descriptors: BUILTIN_INPUT_SEMANTICS }
const transported = () =>
    fromProtoInputSemanticCatalog(WireCatalog.decode(WireCatalog.encode(toProtoInputSemanticCatalog(domain)).finish()))

// A missing policy, a lossy wire bridge, or task => barrier shorthand would all
// truncate the user's real task after the Away command.
describe("Away input policy through the catalog transport", () => {
    it.each([
        { text: "/away fix this @/src/a.ts", mentions: [{ canonicalRef: "/src/a.ts" }] },
        { text: "/cmd:away @/src/a.ts fix this", mentions: [{ canonicalRef: "/src/a.ts" }] },
        { text: "/away fix this @src/a.ts", mentions: [] },
        { text: "/cmd:away @src/a.ts fix this", mentions: [] },
    ])("keeps $text composable after a real wire round trip", ({ text, mentions }) => {
        const catalog = transported()
        const doc = lexSemanticInput(text, { catalog, documentId: "away" })
        const command = doc.nodes.find((node) => node.kind === "slash_command")
        expect(command).toMatchObject({ commandId: "command.away", state: "recognized", compositionMode: "composable" })
        expect(doc.nodes.filter((node) => node.kind === "mention")).toMatchObject(mentions)
        expect(doc.rawText).toBe(text)
        expect(catalog.descriptors.find((d) => d.id === "command.away")).toMatchObject({
            lifecycle: "task",
            composition: "combinable",
            inputPolicy: "consume_token_keep_content",
        })
        expect(establishesLifecycleBarrier(catalog, ["command.away", "mention.file"])).toBe(false)
        expect(validateComposition(catalog, ["command.away", "mention.file"])).toEqual([])
    })

    it("keeps old task barriers and their independent exclusivity constraint", () => {
        const catalog = transported()
        const document = lexSemanticInput("/compact /newtask next", { catalog, documentId: "barriers" })
        expect(document.nodes.filter((node) => node.kind === "slash_command").map((node) => node.compositionMode)).toEqual([
            "lifecycle_barrier",
            "lifecycle_barrier",
        ])
        expect(establishesLifecycleBarrier(catalog, ["command.compact"])).toBe(true)
        expect(validateComposition(catalog, ["command.compact", "mention.file"])).toEqual([
            { code: "exclusive_node_combined", nodeId: "command.compact" },
        ])
        expect(validateSemanticInputDocument(document).length).toBeGreaterThan(0)
    })

    it("does not activate a pasted Away token", () => {
        const catalog = transported()
        const doc = lexSemanticInput("/away continue", { catalog, documentId: "pasted", activation: "candidate_only" })
        expect(doc.nodes.filter((node) => node.kind === "slash_command")).toMatchObject([
            { state: "unresolved", sourceText: "/away" },
        ])
    })
})
