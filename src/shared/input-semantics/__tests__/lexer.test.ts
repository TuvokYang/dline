import { describe, expect, it } from "vitest"
import { BUILTIN_INPUT_SEMANTICS, type InputSemanticCatalog } from "../catalog"
import type { MentionInputNode, SemanticInputNode, SlashCommandInputNode } from "../document"
import { lexSemanticInput, semanticCandidateSpans } from "../lexer"
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

    it("keeps the text partitioned, so the projection reproduces the input", () => {
        const rawText = "run /compact then read @/src/index.ts carefully"

        expect(presentationTextOf(lex(rawText))).toBe(rawText)
    })

    it("stamps the catalog revision and parser version it lexed against", () => {
        const document = lex("hello")

        expect(document.catalogRevision).toBe("4")
        expect(document.parserVersion).toBe("1.0.0")
        expect(document.nodes).toEqual([{ kind: "text", text: "hello" }])
    })
})
