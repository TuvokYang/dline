import { describe, expect, it } from "vitest"
import { planSemanticCommands } from "../command-plan"
import type { SemanticInputDocument, SemanticInputNode, SlashCommandInputNode } from "../document"

function command(overrides: Partial<SlashCommandInputNode> & { entityId: string }): SlashCommandInputNode {
    return {
        kind: "slash_command",
        commandId: "command.deep_planning",
        sourceText: "/deep-planning",
        canonicalName: "deep-planning",
        namespace: "cmd",
        compositionMode: "composable",
        state: "recognized",
        ...overrides,
    }
}

function document(nodes: readonly SemanticInputNode[]): SemanticInputDocument {
    return {
        schemaVersion: 1,
        parserVersion: "1.0.0",
        catalogRevision: "3",
        documentId: "doc-1",
        rawText: "",
        nodes,
        resources: [],
    }
}

const barrier = command({
    entityId: "barrier",
    commandId: "command.compact",
    sourceText: "/compact",
    canonicalName: "compact",
    compositionMode: "lifecycle_barrier",
})

describe("planSemanticCommands", () => {
    it("keeps composable commands in document order", () => {
        const plan = planSemanticCommands(
            document([
                command({ entityId: "a" }),
                { kind: "text", text: " and " },
                command({ entityId: "b", commandId: "command.explain_changes", canonicalName: "explain-changes" }),
            ]),
        )

        expect(plan.invocations.map((invocation) => invocation.entityId)).toEqual(["a", "b"])
        expect(plan.barrier).toBeUndefined()
        expect(plan.premessage).toEqual([])
    })

    it("binds everything after the barrier as its premessage", () => {
        const trailingText: SemanticInputNode = { kind: "text", text: "summarize the audit first" }
        const plan = planSemanticCommands(document([command({ entityId: "a" }), barrier, trailingText]))

        expect(plan.invocations.map((invocation) => invocation.entityId)).toEqual(["a"])
        expect(plan.barrier?.commandId).toBe("command.compact")
        expect(plan.premessage).toEqual([trailingText])
    })

    it("refuses to start a new invocation after the barrier", () => {
        const late = command({ entityId: "late" })
        const plan = planSemanticCommands(document([barrier, late]))

        expect(plan.invocations).toEqual([])
        expect(plan.premessage).toEqual([late])
    })

    it("treats a command that is not recognized as content", () => {
        const plan = planSemanticCommands(
            document([command({ entityId: "a", state: "literal" }), command({ entityId: "b", state: "disabled" })]),
        )

        expect(plan.invocations).toEqual([])
        expect(plan.barrier).toBeUndefined()
    })

    it("ignores a literal barrier, so /compact converted to text does not compact", () => {
        const plan = planSemanticCommands(document([{ ...barrier, state: "literal" }, command({ entityId: "a" })]))

        expect(plan.barrier).toBeUndefined()
        expect(plan.invocations.map((invocation) => invocation.entityId)).toEqual(["a"])
    })
})
