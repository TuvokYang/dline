import { describe, expect, it } from "vitest"
import { BUILTIN_INPUT_SEMANTICS, type InputSemanticCatalog } from "../catalog"
import type { MentionInputNode, SemanticInputNode, SlashCommandInputNode } from "../document"
import { lexSemanticInput, semanticCandidateSpans, sigilEscapeRunBefore } from "../lexer"
import { presentationTextOf } from "../presentation"

const catalog: InputSemanticCatalog = { revision: 4, descriptors: BUILTIN_INPUT_SEMANTICS }

function lex(rawText: string, activation?: "auto" | "candidate_only") {
    return lexSemanticInput(rawText, { catalog, documentId: "doc-1", activation })
}

function commands(nodes: readonly SemanticInputNode[]): SlashCommandInputNode[] {
    return nodes.filter((node): node is SlashCommandInputNode => node.kind === "slash_command")
}

function mentions(nodes: readonly SemanticInputNode[]): MentionInputNode[] {
    return nodes.filter((node): node is MentionInputNode => node.kind === "mention")
}

describe("semanticCandidateSpans", () => {
    it("locates every command and mention shape without consulting a catalog", () => {
        const text = "/compac then @/src/a.ts and https://host/compact"

        expect(semanticCandidateSpans(text).map(({ start, end }) => text.slice(start, end))).toEqual(["/compac", "@/src/a.ts"])
    })

    function candidatesOf(text: string): string[] {
        return semanticCandidateSpans(text).map(({ start, end }) => text.slice(start, end))
    }

    it("keeps inline code opaque, matching backtick runs by length", () => {
        expect(candidatesOf("run `/compact` and ``@/a.ts ` still code`` then /newtask")).toEqual(["/newtask"])
        // An unmatched backtick is text, so what follows it is still scanned.
        expect(candidatesOf("a ` b /compact")).toEqual(["/compact"])
    })

    it("keeps fenced code opaque up to its closing fence, or to the end when unclosed", () => {
        const closed = "before /compact\n```ts\n/newtask @/src/a.ts\n```\nafter @problems"
        const unclosed = "~~~\n/compact\n@terminal"

        expect(candidatesOf(closed)).toEqual(["/compact", "@problems"])
        expect(candidatesOf(unclosed)).toEqual([])
    })

    it("escapes a sigil by backslash parity", () => {
        expect(candidatesOf("\\/compact")).toEqual([])
        expect(candidatesOf("\\\\/compact")).toEqual(["/compact"])
        expect(candidatesOf("\\\\\\@/src/a.ts")).toEqual([])
        expect(candidatesOf("\\\\@/src/a.ts")).toEqual(["@/src/a.ts"])
        expect(sigilEscapeRunBefore("x \\\\/compact", 4)).toBe(2)
    })

    it("treats a sigil inside a URL, path, XML tag, attribute or e-mail address as text", () => {
        const text = 'https://host/compact src/compact <task>/compact</task> <a href="@/src/a.ts"> me@deadbeef1 x:@problems'

        expect(candidatesOf(text)).toEqual([])
    })

    it("lets a mention follow an opening bracket", () => {
        expect(candidatesOf("(@/src/a.ts) (@problems)")).toEqual(["@/src/a.ts", "@problems"])
    })

    it("reports UTF-16 offsets around surrogate pairs and CJK text", () => {
        const text = "😀 /compact 中文 @/src/😀.ts"

        const spans = semanticCandidateSpans(text)

        expect(spans).toEqual([
            { start: 3, end: 11 },
            { start: 15, end: text.length },
        ])
        expect(text.slice(spans[1].start, spans[1].end)).toBe("@/src/😀.ts")
        expect(candidatesOf("😀/compact")).toEqual([])
    })
})

describe("lexSemanticInput", () => {
    it("recognizes a built-in command and records its catalog identity and barrier role", () => {
        const document = lex("/compact please")

        expect(commands(document.nodes)).toEqual([
            {
                kind: "slash_command",
                entityId: "doc-1#0",
                commandId: "command.compact",
                sourceText: "/compact",
                canonicalName: "compact",
                namespace: "cmd",
                compositionMode: "lifecycle_barrier",
                state: "recognized",
            },
        ])
    })

    it("resolves an alias to the same catalog descriptor", () => {
        expect(commands(lex("/smol").nodes)[0].commandId).toBe("command.compact")
    })

    it("resolves a discovered capability to its namespace", () => {
        const withSkill: InputSemanticCatalog = {
            revision: 5,
            descriptors: [
                ...BUILTIN_INPUT_SEMANTICS,
                {
                    id: "command.skill.use-e2e",
                    kind: "command",
                    trigger: "/skills:use-e2e",
                    payload: "text",
                    composition: "combinable",
                    lifecycle: "turn",
                    dynamic: true,
                },
            ],
        }

        const [node] = commands(lexSemanticInput("/skills:use-e2e now", { catalog: withSkill, documentId: "d" }).nodes)

        expect(node.namespace).toBe("skill")
        expect(node.canonicalName).toBe("use-e2e")
        expect(node.compositionMode).toBe("composable")
    })

    it("leaves an unknown command unresolved instead of guessing one", () => {
        const [node] = commands(lex("/unknown-command").nodes)

        expect(node.state).toBe("unresolved")
        expect(node.commandId).toBe("")
    })

    it("keeps a slash inside a URL or path as plain text", () => {
        expect(commands(lex("see https://host/compact and src/compact").nodes)).toEqual([])
        expect(lex("see https://host/compact").nodes.some((node) => node.kind === "text")).toBe(true)
    })

    it("types every mention shape it recognizes", () => {
        const document = lex("@/src/index.ts @/src/ @problems @terminal @git-changes @https://example.com @a1b2c3d4e5f")

        expect(mentions(document.nodes).map((node) => node.mentionKind)).toEqual([
            "file",
            "folder",
            "problems",
            "terminal",
            "git_changes",
            "url",
            "git_commit",
        ])
    })

    it("captures a mention at submit time by default", () => {
        expect(mentions(lex("@/src/index.ts").nodes)[0].capturePolicy).toBe("snapshot_at_submit")
    })

    it("never activates a candidate that arrived by paste", () => {
        const document = lex("log line: /compact @/etc/hosts", "candidate_only")

        expect(commands(document.nodes)[0].state).toBe("unresolved")
        expect(mentions(document.nodes)[0].state).toBe("unresolved")
    })

    it("keeps an opaque candidate inside its text, so model or selected text never becomes an entity", () => {
        const rawText = "quoted: /compact and @/src/a.ts"
        const document = lexSemanticInput(rawText, { catalog, documentId: "doc-1", activation: "opaque" })

        expect(document.nodes).toEqual([{ kind: "text", text: rawText }])
    })

    it("decides each candidate by its own source when the draft mixes typed and opaque text", () => {
        const rawText = "/compact selected: /newtask"
        const selectedFrom = rawText.indexOf("selected")
        const document = lexSemanticInput(rawText, {
            catalog,
            documentId: "doc-1",
            activationAt: (start) => (start >= selectedFrom ? "opaque" : "auto"),
        })

        expect(commands(document.nodes).map((node) => node.sourceText)).toEqual(["/compact"])
        expect(presentationTextOf(document)).toBe(rawText)
    })

    it("keeps the text partitioned, so the projection reproduces the input", () => {
        const rawText = "run /compact then read @/src/index.ts carefully"

        expect(presentationTextOf(lex(rawText))).toBe(rawText)
    })

    it("stamps the catalog revision and parser version it lexed against", () => {
        const document = lex("hello")

        expect(document.catalogRevision).toBe("4")
        expect(document.parserVersion).toBe("1.1.0")
        expect(document.nodes).toEqual([{ kind: "text", text: "hello" }])
    })
})
