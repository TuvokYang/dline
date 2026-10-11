import { BUILTIN_INPUT_SEMANTICS, type InputSemanticCatalog } from "@shared/input-semantics/catalog"
import { isMentionNode, isSlashCommandNode } from "@shared/input-semantics/document"
import { lexSemanticInput } from "@shared/input-semantics/lexer"
import { describe, expect, it } from "vitest"
import { type PasteProvenance, pasteAwareActivation, recordPaste } from "../paste-provenance"
import { applySemanticEdit, type SemanticEditIntent } from "../semantic-edit"

const catalog: InputSemanticCatalog = { revision: 1, descriptors: BUILTIN_INPUT_SEMANTICS }

function draft(text: string): PasteProvenance {
    return { text, spans: [] }
}

function commandIntent(commandId: string, trigger: string): SemanticEditIntent {
    return { kind: "command", commandId, trigger }
}

/** Lex the edited draft the way submission does, honoring its paste spans. */
function entitiesOf(provenance: PasteProvenance) {
    return lexSemanticInput(provenance.text, {
        catalog,
        documentId: "test",
        activationAt: pasteAwareActivation(provenance.spans),
    }).nodes.filter((node) => isSlashCommandNode(node) || isMentionNode(node))
}

describe("applySemanticEdit", () => {
    it("replaces the typed partial command with a recognized command and a separating space", () => {
        const result = applySemanticEdit(
            draft("please /new"),
            { start: 7, end: 11 },
            commandIntent("command.new_task", "/newtask"),
            catalog,
        )

        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.provenance.text).toBe("please /newtask ")
        expect(result.caret).toBe(16)
        expect(result.entity).toEqual({ start: 7, end: 15 })
        const [command] = entitiesOf(result.provenance)
        expect(command).toMatchObject({ kind: "slash_command", commandId: "command.new_task", state: "recognized" })
    })

    it("keeps the spelling the row shows while binding the command's identity", () => {
        const result = applySemanticEdit(
            draft("/s"),
            { start: 0, end: 2 },
            commandIntent("command.compact", "/cmd:smol"),
            catalog,
        )

        expect(result.ok && result.provenance.text).toBe("/cmd:smol ")
        expect(result.ok && entitiesOf(result.provenance)[0]).toMatchObject({ commandId: "command.compact" })
    })

    it("refuses a spelling the catalog now resolves to a different command", () => {
        const result = applySemanticEdit(draft("/"), { start: 0, end: 1 }, commandIntent("command.compact", "/newtask"), catalog)

        expect(result).toEqual({ ok: false, reason: "unknown_command" })
    })

    it("does not add a second space when one already follows", () => {
        const result = applySemanticEdit(
            draft("/ then"),
            { start: 0, end: 1 },
            commandIntent("command.compact", "/compact"),
            catalog,
        )

        expect(result.ok && result.provenance.text).toBe("/compact then")
        expect(result.ok && result.caret).toBe(9)
    })

    it("refuses a command the catalog no longer resolves instead of writing look-alike text", () => {
        const result = applySemanticEdit(
            draft("/sk"),
            { start: 0, end: 3 },
            commandIntent("command.skill.gone", "/skills:gone"),
            catalog,
        )

        expect(result).toEqual({ ok: false, reason: "unknown_command" })
    })

    it("refuses an edit the scanner would read as text", () => {
        const insideCode = applySemanticEdit(
            draft("`run  now`"),
            { start: 5, end: 5 },
            commandIntent("command.compact", "/compact"),
            catalog,
        )
        const quoteInPath = applySemanticEdit(
            draft(""),
            { start: 0, end: 0 },
            { kind: "mention", reference: '/a "b" c.ts' },
            catalog,
        )

        expect(insideCode).toEqual({ ok: false, reason: "unrecognizable_entity" })
        expect(quoteInPath).toEqual({ ok: false, reason: "unrecognizable_entity" })
    })

    it("separates an insertion from the word or escape before it, so it can start an entity", () => {
        const afterWord = applySemanticEdit(
            draft("abc"),
            { start: 3, end: 3 },
            { kind: "mention", reference: "problems" },
            catalog,
        )
        const afterEscape = applySemanticEdit(
            draft("a \\"),
            { start: 3, end: 3 },
            { kind: "mention", reference: "terminal" },
            catalog,
        )
        const afterBracket = applySemanticEdit(draft("("), { start: 1, end: 1 }, { kind: "mention", reference: "/a.ts" }, catalog)

        expect(afterWord.ok && afterWord.provenance.text).toBe("abc @problems ")
        expect(afterWord.ok && afterWord.entity).toEqual({ start: 4, end: 13 })
        expect(afterWord.ok && afterWord.caret).toBe(14)
        expect(afterEscape.ok && afterEscape.provenance.text).toBe("a \\ @terminal ")
        expect(afterBracket.ok && afterBracket.provenance.text).toBe("(@/a.ts ")
    })

    it("confirms the entity even inside pasted text, so the pick is never demoted to a candidate", () => {
        const pasted = recordPaste(draft(""), 0, 0, "pasted @")
        const result = applySemanticEdit(pasted, { start: 7, end: 8 }, { kind: "mention", reference: "problems" }, catalog)

        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.provenance.text).toBe("pasted @problems ")
        expect(entitiesOf(result.provenance)[0]).toMatchObject({ kind: "mention", mentionKind: "problems", state: "recognized" })
    })

    it("quotes a workspace path with spaces and confirms the whole quoted span", () => {
        const result = applySemanticEdit(
            draft("@my"),
            { start: 0, end: 3 },
            { kind: "mention", reference: "/src/my file.ts" },
            catalog,
        )

        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.provenance.text).toBe('@"/src/my file.ts" ')
        expect(result.entity).toEqual({ start: 0, end: 18 })
        expect(entitiesOf(result.provenance)[0]).toMatchObject({
            kind: "mention",
            mentionKind: "file",
            canonicalRef: "/src/my file.ts",
            state: "recognized",
        })
    })

    it("writes a quoted folder and a workspace-prefixed path so they read back as the same entity", () => {
        const folder = applySemanticEdit(draft(""), { start: 0, end: 0 }, { kind: "mention", reference: "/my dir/" }, catalog)
        const rooted = applySemanticEdit(
            draft(""),
            { start: 0, end: 0 },
            { kind: "mention", reference: "web:/src/my file.ts" },
            catalog,
        )

        expect(folder.ok && folder.provenance.text).toBe('@"/my dir/" ')
        expect(folder.ok && entitiesOf(folder.provenance)[0]).toMatchObject({ mentionKind: "folder", canonicalRef: "/my dir/" })
        expect(rooted.ok && rooted.provenance.text).toBe('@web:"/src/my file.ts" ')
        expect(rooted.ok && entitiesOf(rooted.provenance)[0]).toMatchObject({
            mentionKind: "file",
            canonicalRef: "/src/my file.ts",
            workspaceHint: "web",
        })
    })
})
