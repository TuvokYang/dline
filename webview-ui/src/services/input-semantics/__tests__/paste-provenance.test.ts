import type { InputSemanticCatalog } from "@shared/input-semantics/catalog"
import { isMentionNode, isSlashCommandNode } from "@shared/input-semantics/document"
import { describe, expect, it } from "vitest"
import {
    composeSubmission,
    confirmRange,
    EMPTY_PASTE_PROVENANCE,
    followNativePaste,
    heldPastedCandidates,
    type PasteProvenance,
    provenanceForRecalledDraft,
    provenanceForRecalledText,
    provenanceFromDocument,
    rebaseProvenance,
    recordPaste,
} from "../paste-provenance"

const catalog: InputSemanticCatalog = {
    revision: 7,
    descriptors: [
        {
            id: "command.compact",
            kind: "command",
            trigger: "/compact",
            lifecycle: "task",
            label: "compact",
        },
        { id: "mention.file", kind: "mention", trigger: "@", label: "file" },
    ],
} as unknown as InputSemanticCatalog

const typed = (text: string) => rebaseProvenance(EMPTY_PASTE_PROVENANCE, text)
const compose = (provenance: PasteProvenance, extra: { literalPrefix?: string; trim?: boolean } = {}) =>
    composeSubmission({ text: provenance.text, spans: provenance.spans, catalog, documentId: "doc-1", ...extra })
const composeDocument = (provenance: PasteProvenance) => compose(provenance).semanticInput

describe("paste provenance", () => {
    it("keeps a pasted /compact as a candidate, so the task receives it as literal text", () => {
        const pasted = recordPaste(typed("see log: "), 9, 9, "/compact now")

        const document = composeDocument(pasted)

        const command = document?.nodes.find(isSlashCommandNode)
        expect(command?.sourceText).toBe("/compact")
        expect(command?.state).toBe("unresolved")
        expect(document?.catalogRevision).toBe("7")
    })

    it("never reads a pasted @/file mention", () => {
        const pasted = recordPaste(EMPTY_PASTE_PROVENANCE, 0, 0, "check @/etc/passwd please")

        const mention = composeDocument(pasted)?.nodes.find(isMentionNode)

        expect(mention?.state).toBe("unresolved")
    })

    it("sends no document for typed input, because the legacy path already activates it the same way", () => {
        expect(composeDocument(typed("/compact keep the plan"))).toBeUndefined()
    })

    it("sends no document when the pasted text holds no candidate", () => {
        const pasted = recordPaste(typed("/compact "), 9, 9, "plain log line")

        expect(composeDocument(pasted)).toBeUndefined()
    })

    it("keeps a typed command active next to a pasted one", () => {
        const pasted = recordPaste(typed("/compact "), 9, 9, "quoted /compact")

        const document = composeDocument(pasted)
        const states = document?.nodes.filter(isSlashCommandNode).map((node) => node.state)

        expect(states).toEqual(["recognized", "unresolved"])
    })

    it("follows typing before and after the paste without losing the pasted range", () => {
        const pasted = recordPaste(EMPTY_PASTE_PROVENANCE, 0, 0, "/compact")
        const edited = rebaseProvenance(rebaseProvenance(pasted, "run /compact"), "run /compact now")

        expect(edited.spans).toEqual([{ start: 4, end: 12 }])
        expect(heldPastedCandidates(edited.text, catalog, edited.spans)).toEqual(["/compact"])
    })

    it("drops the provenance of pasted characters the user deleted", () => {
        const pasted = recordPaste(EMPTY_PASTE_PROVENANCE, 0, 0, "/compact")

        expect(rebaseProvenance(pasted, "").spans).toEqual([])
    })

    it("confirms a pasted candidate once the user picks it", () => {
        const pasted = recordPaste(EMPTY_PASTE_PROVENANCE, 0, 0, "/compact keep")
        const confirmed = confirmRange(pasted, { start: 0, end: 8 })

        expect(heldPastedCandidates(confirmed.text, catalog, confirmed.spans)).toEqual([])
        expect(composeDocument(confirmed)).toBeUndefined()
    })

    it("reports only candidates the catalog would actually run", () => {
        const pasted = recordPaste(EMPTY_PASTE_PROVENANCE, 0, 0, "/unknown and /compact")

        expect(heldPastedCandidates(pasted.text, catalog, pasted.spans)).toEqual(["/compact"])
    })

    it("keeps the pasted copy held when the user deletes the typed copy of the same command", () => {
        // Deleting either copy of "/compact /compact" yields the same text, so the
        // survivor must stay held: it may be the pasted one.
        const pasted = recordPaste(typed("/compact "), 9, 9, "/compact")

        const survivor = rebaseProvenance(pasted, "/compact")

        expect(survivor.spans).toEqual([{ start: 0, end: 8 }])
        expect(composeDocument(survivor)?.nodes.find(isSlashCommandNode)?.state).toBe("unresolved")
    })

    it("holds every character a typed insertion between repeated pasted characters could have displaced", () => {
        const pasted = { text: "x//y", spans: [{ start: 1, end: 3 }] }

        expect(rebaseProvenance(pasted, "x///y").spans).toEqual([{ start: 1, end: 4 }])
    })

    it("counts a native paste as pasted even when the browser keeps line endings it was expected to normalise", () => {
        const next = followNativePaste(typed("/compact"), { start: 0, end: 0, text: "/compact\r\n" }, "/compact\r\n/compact")

        expect(heldPastedCandidates(next.text, catalog, next.spans)[0]).toBe("/compact")
        expect(next.spans[0]).toEqual({ start: 0, end: next.text.length })
    })

    it("holds a candidate inside a quote the composer adds, even when the user's own text is typed", () => {
        const submission = compose(typed("please continue"), { literalPrefix: "[context] \n> /compact now\n[/context] \n\n" })

        expect(submission.text).toBe("[context] \n> /compact now\n[/context] \n\nplease continue")
        const commands = submission.semanticInput?.nodes.filter(isSlashCommandNode)
        expect(commands?.map((node) => node.state)).toEqual(["unresolved"])
    })

    it("keeps a typed command active behind a quote that holds no candidate", () => {
        const submission = compose(typed("/compact keep"), { literalPrefix: "[context] \n> plain\n[/context] \n\n" })

        expect(submission.semanticInput).toBeUndefined()
        expect(submission.text).toBe("[context] \n> plain\n[/context] \n\n/compact keep")
    })

    it("holds a model-authored follow-up option prefixed to the reply", () => {
        const submission = compose(typed("yes"), { literalPrefix: "/compact the log: " })

        expect(submission.text).toBe("/compact the log: yes")
        expect(submission.semanticInput?.nodes.find(isSlashCommandNode)?.state).toBe("unresolved")
    })

    it("trims the user's text without moving the held range off its command", () => {
        const pasted = recordPaste(typed("  "), 2, 2, "/compact x  ")

        const submission = compose(pasted, { trim: true })

        expect(submission.text).toBe("/compact x")
        expect(submission.semanticInput?.nodes.find(isSlashCommandNode)?.state).toBe("unresolved")
    })

    it("recovers the held candidates of a document that left the composer", () => {
        const pasted = recordPaste(typed("run "), 4, 4, "/compact @/etc/hosts")
        const document = composeDocument(pasted)
        if (!document) throw new Error("expected a document")

        const recalled = provenanceFromDocument(document)

        expect(recalled.text).toBe(pasted.text)
        expect(heldPastedCandidates(recalled.text, catalog, recalled.spans)).toEqual(["/compact", "@/etc/hosts"])
    })

    it("sends a document for a pasted fragment the catalog does not know", () => {
        // Without it, a queued "/compac" would come back looking typed.
        const document = composeDocument(recordPaste(EMPTY_PASTE_PROVENANCE, 0, 0, "/compac"))

        expect(document?.nodes.find(isSlashCommandNode)?.state).toBe("unresolved")
    })

    it("holds a recalled pasted fragment that an edit completes into a command", () => {
        const document = composeDocument(recordPaste(EMPTY_PASTE_PROVENANCE, 0, 0, "/compac"))
        const edited = rebaseProvenance(provenanceForRecalledDraft("/compac", document), "/compact")

        expect(heldPastedCandidates(edited.text, catalog, edited.spans)).toEqual(["/compact"])
        expect(composeDocument(edited)?.nodes.find(isSlashCommandNode)?.state).toBe("unresolved")
    })

    it("keeps only the typed command live when a recalled draft mixes it with a pasted fragment", () => {
        const document = composeDocument(recordPaste(typed("/compact "), 9, 9, "/compac"))
        const edited = rebaseProvenance(provenanceForRecalledDraft("/compact /compac", document), "/compact /compact")

        const states = composeDocument(edited)
            ?.nodes.filter(isSlashCommandNode)
            .map((node) => node.state)
        expect(states).toEqual(["recognized", "unresolved"])
    })

    it("keeps a pasted command held after recall even when the catalog has learnt it since", () => {
        const earlier = { revision: 6, descriptors: [] } as unknown as InputSemanticCatalog
        const pasted = recordPaste(EMPTY_PASTE_PROVENANCE, 0, 0, "/compact")
        const document = composeSubmission({
            text: pasted.text,
            spans: pasted.spans,
            catalog: earlier,
            documentId: "d",
        }).semanticInput

        const recalled = provenanceForRecalledDraft("/compact", document)

        expect(heldPastedCandidates(recalled.text, catalog, recalled.spans)).toEqual(["/compact"])
    })

    it("keeps typed candidates live in a recalled draft without a document and holds the rest", () => {
        // A pasted character touching any candidate always travels with a document.
        const recalled = provenanceForRecalledText("/compact now")

        expect(recalled.spans).toEqual([{ start: 8, end: 12 }])
        expect(composeDocument(recalled)).toBeUndefined()
        expect(heldPastedCandidates(recalled.text, catalog, recalled.spans)).toEqual([])
    })

    it("holds recalled plain text so an edit cannot complete it into a command", () => {
        const edited = rebaseProvenance(provenanceForRecalledText("compact"), "/compact")

        expect(heldPastedCandidates(edited.text, catalog, edited.spans)).toEqual(["/compact"])
    })

    it("falls back to the text when the document describes other text", () => {
        const document = composeDocument(recordPaste(EMPTY_PASTE_PROVENANCE, 0, 0, "/compact"))

        expect(provenanceForRecalledDraft("other", document)).toEqual(provenanceForRecalledText("other"))
    })
})
