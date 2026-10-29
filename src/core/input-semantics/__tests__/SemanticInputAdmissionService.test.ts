import { BUILTIN_INPUT_SEMANTICS, type InputSemanticCatalog } from "@shared/input-semantics/catalog"
import { semanticInputDiagnostic } from "@shared/input-semantics/diagnostics"
import type { SemanticInputDocument } from "@shared/input-semantics/document"
import { lexSemanticInput } from "@shared/input-semantics/lexer"
import { describe, expect, it, vi } from "vitest"
import { SemanticInputAdmissionService } from "../SemanticInputAdmissionService"

const catalog: InputSemanticCatalog = { revision: 4, descriptors: BUILTIN_INPUT_SEMANTICS }

function service(overrides?: { catalog?: InputSemanticCatalog }) {
    return new SemanticInputAdmissionService({
        catalog: () => overrides?.catalog ?? catalog,
        commands: {
            expand: async (descriptor) => ({
                text: `<${descriptor.trigger.slice(1)}-instructions>`,
                explicitInstructions: [{ type: "summarize_task", source: "manual_compact_command" }],
            }),
        },
        mentions: { resolve: async (node) => `<resolved:${node.canonicalRef}>` },
    })
}

function lex(rawText: string, activation?: "auto" | "candidate_only"): SemanticInputDocument {
    return lexSemanticInput(rawText, { catalog, documentId: "doc-1", activation })
}

async function admitText(document: SemanticInputDocument): Promise<string> {
    const result = await service().admit(document)
    if (!result.ok) throw new Error(`admission failed: ${result.diagnostics.map((d) => d.code).join(",")}`)
    return result.admitted.text
}

describe("SemanticInputAdmissionService", () => {
    it("expands the commands and mentions the document names, in node order", async () => {
        expect(await admitText(lex("/compact then read @/src/index.ts"))).toBe(
            "<compact-instructions> then read <resolved:/src/index.ts>",
        )
    })

    it("derives the authorized tool from catalog identity", async () => {
        const result = await service().admit(lex("/compact"))

        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.admitted.authorizedTools).toEqual(["summarize_task"])
        expect(result.admitted.plan.barrier?.commandId).toBe("command.compact")
        // The expansion's declaration travels with the submission so the provider
        // request can register one-shot authority for the compaction tool.
        expect(result.admitted.explicitInstructions).toEqual([{ type: "summarize_task", source: "manual_compact_command" }])
    })

    it("collects no authority when no command was planned", async () => {
        const result = await service().admit(lex("just text"))

        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.admitted.explicitInstructions).toEqual([])
    })

    it("binds text after the barrier as its premessage without expanding a later command", async () => {
        const result = await service().admit(lex("/compact summarize the audit /explain-changes"))

        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.admitted.plan.premessage.length).toBeGreaterThan(0)
        // The later command is content for the barrier, so it reaches the model as typed.
        expect(result.admitted.text).toContain("/explain-changes")
        expect(result.admitted.authorizedTools).toEqual(["summarize_task"])
    })

    it("splits the projection around the barrier so its premessage can be routed apart from the turn", async () => {
        const result = await service().admit(lex("/explain-changes then /compact keep the audit"))

        expect(result.ok).toBe(true)
        if (!result.ok) return
        // The fake expander attaches one identical declaration per expanded command,
        // so declarations are told apart by position: the first belongs to
        // /explain-changes, the second to the /compact barrier itself.
        expect(result.admitted.explicitInstructions).toHaveLength(2)
        expect(result.admitted.barrier).toEqual({
            commandId: "command.compact",
            // The barrier's own entity lets a reply carrier slice the document in front of it.
            entityId: "doc-1#1",
            turnText: "<explain-changes-instructions> then",
            turnParts: [{ kind: "text", text: "<explain-changes-instructions> then" }],
            premessage: "keep the audit",
            // Claiming the barrier drops only its own authority, never an earlier command's.
            instructionsBefore: result.admitted.explicitInstructions.slice(0, 1),
            // /explain-changes authorizes no tool; summarize_task belongs to the barrier alone.
            toolsBefore: [],
        })
        expect(result.admitted.authorizedTools).toEqual(["summarize_task"])
    })

    it("reports no barrier when the user placed none", async () => {
        const result = await service().admit(lex("/explain-changes please"))

        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.admitted.barrier).toBeUndefined()
    })

    it("rejects a document that declares two lifecycle barriers", async () => {
        const result = await service().admit(lex("/compact and /newtask"))

        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.diagnostics[0].code).toBe("semantic_input_lifecycle_barrier_invalid")
    })

    it("expands a composable command that runs before the barrier", async () => {
        const result = await service().admit(lex("/explain-changes then /compact"))

        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.admitted.plan.invocations.map((invocation) => invocation.commandId)).toEqual(["command.explain_changes"])
        expect(result.admitted.text).toBe("<explain-changes-instructions> then <compact-instructions>")
    })

    it("never promotes text that carries no entity, so a pasted /compact stays literal", async () => {
        const pasted = lex("log: /compact and @/etc/hosts", "candidate_only")

        const text = await admitText(pasted)

        expect(text).toBe("log: /compact and @/etc/hosts")
    })

    it("fails closed when the catalog moved on", async () => {
        const stale = { ...lex("/compact"), catalogRevision: "3" }

        const result = await service().admit(stale)

        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.diagnostics[0].code).toBe("semantic_input_catalog_stale")
    })

    it("reviews against the catalog a submission was composed with, not one published since", async () => {
        // Discovery advanced between lexing and admission. The document is not
        // stale — it names exactly the catalog it was built from — so refusing it
        // would drop a submission the user just made.
        const advanced: InputSemanticCatalog = { revision: 5, descriptors: BUILTIN_INPUT_SEMANTICS }

        const result = await service({ catalog: advanced }).admit(lex("/compact"), { composedWith: catalog })

        expect(result.ok).toBe(true)
    })

    it("admits a recovered document under the revision it was accepted with, whatever the catalog is now", async () => {
        // A reply stored by an earlier process names a revision of that process's
        // counter; the catalog moving on must not refuse what the user already sent.
        const recovered = { ...lex("/compact keep the audit"), catalogRevision: "1" }

        const result = await service().admit(recovered, { pinnedRevision: true })

        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.admitted.plan.barrier?.commandId).toBe("command.compact")
    })

    it("still refuses a recovered command the catalog withdrew, rather than running it as text", async () => {
        const withdrawn: InputSemanticCatalog = {
            revision: 9,
            descriptors: BUILTIN_INPUT_SEMANTICS.filter((descriptor) => descriptor.id !== "command.compact"),
        }
        const recovered = { ...lex("/compact"), catalogRevision: "1" }

        const result = await service({ catalog: withdrawn }).admit(recovered, { pinnedRevision: true })

        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.diagnostics[0].code).toBe("semantic_input_command_unknown")
    })

    it("still refuses a recovered node whose trigger is not the one its visible text names", async () => {
        // Pinning skips only the revision: recovery is not a way to run a command
        // the user never typed.
        const document = lex("/compact")
        const [command] = document.nodes
        if (command.kind !== "slash_command") throw new Error("expected a command node")
        const forged: SemanticInputDocument = {
            ...document,
            catalogRevision: "1",
            rawText: "/hello",
            nodes: [{ ...command, sourceText: "/hello" }],
        }

        const result = await service().admit(forged, { pinnedRevision: true })

        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.diagnostics[0].code).toBe("semantic_input_node_invalid")
    })

    it("fails closed when a recognized command left the catalog, and names the node", async () => {
        const withdrawn: InputSemanticCatalog = {
            revision: 4,
            descriptors: BUILTIN_INPUT_SEMANTICS.filter((descriptor) => descriptor.id !== "command.compact"),
        }

        const result = await service({ catalog: withdrawn }).admit(lex("/compact"))

        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.diagnostics[0].code).toBe("semantic_input_command_unknown")
        expect(result.diagnostics[0].entityId).toBe("doc-1#0")
    })

    it("refuses a structure whose nodes do not reproduce the text the user submitted", async () => {
        // The visible text asks for a review; the forged node would run /compact instead.
        const forged: SemanticInputDocument = { ...lex("/compact"), rawText: "review this" }

        const result = await service().admit(forged)

        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.diagnostics[0].code).toBe("semantic_input_node_invalid")
    })

    it("refuses an active command typed as text that is not one of its triggers", async () => {
        const lexed = lex("/compact")
        const [node] = lexed.nodes
        if (node?.kind !== "slash_command") throw new Error("expected a command node")
        const forged: SemanticInputDocument = {
            ...lexed,
            rawText: "/review",
            nodes: [{ ...node, sourceText: "/review" }],
        }

        const result = await service().admit(forged)

        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.diagnostics[0]).toMatchObject({ code: "semantic_input_node_invalid", entityId: node.entityId })
    })

    it("refuses an active command that claims a different composition than its descriptor", async () => {
        const lexed = lex("/compact")
        const [node] = lexed.nodes
        if (node?.kind !== "slash_command") throw new Error("expected a command node")
        // Downgrading the barrier to composable would expand /compact into the turn itself.
        const forged: SemanticInputDocument = { ...lexed, nodes: [{ ...node, compositionMode: "composable" }] }

        const result = await service().admit(forged)

        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.diagnostics[0].code).toBe("semantic_input_node_invalid")
    })

    it("fails closed on a structurally broken document before touching any port", async () => {
        const broken: SemanticInputDocument = { ...lex("hi"), documentId: "" }

        const result = await service().admit(broken)

        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("semantic_input_schema_unsupported")
    })

    it("refuses a mention whose typed identity disagrees with its visible text", async () => {
        const lexed = lex("read @/src/index.ts")
        const forged: SemanticInputDocument = {
            ...lexed,
            nodes: lexed.nodes.map((node) => (node.kind === "mention" ? { ...node, canonicalRef: "/.env" } : node)),
        }
        const resolve = vi.fn(async () => "resolved")

        const result = await new SemanticInputAdmissionService({
            catalog: () => catalog,
            commands: { expand: async () => ({ text: "" }) },
            mentions: { resolve },
        }).admit(forged)

        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["semantic_input_source_mismatch"])
        expect(resolve).not.toHaveBeenCalled()
    })

    it("refuses the whole submission when the plan rejects a command, naming the node", async () => {
        const document = lex("/explain-changes and /explain-changes")

        const result = await service().admit(document)

        expect(result.ok).toBe(false)
        if (result.ok) return
        const repeated = document.nodes.filter((node) => node.kind === "slash_command")[1]
        expect(result.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.entityId])).toEqual([
            ["semantic_input_lifecycle_barrier_invalid", repeated && "entityId" in repeated ? repeated.entityId : undefined],
        ])
    })

    it("refuses a command whose capability is no longer available instead of sending its trigger", async () => {
        const result = await new SemanticInputAdmissionService({
            catalog: () => catalog,
            commands: { expand: async () => undefined },
            mentions: { resolve: async () => "" },
        }).admit(lex("/compact"))

        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["semantic_input_command_disabled"])
    })

    it("explains an unknown command with the catalog conflict that withdrew it", async () => {
        const result = await new SemanticInputAdmissionService({
            catalog: () => ({ revision: 4, descriptors: BUILTIN_INPUT_SEMANTICS.filter((d) => d.id !== "command.compact") }),
            commands: { expand: async () => ({ text: "" }) },
            mentions: { resolve: async () => "" },
            conflicts: () => [
                {
                    code: "duplicate_trigger",
                    descriptorId: "command.compact",
                    heldBy: "command.workflow.compact",
                    trigger: "/compact",
                },
            ],
        }).admit(lex("/compact"))

        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.diagnostics[0].code).toBe("semantic_input_command_unknown")
        expect(result.diagnostics[0].message).toContain("command.workflow.compact")
    })

    describe("resources", () => {
        const resourceId = "4f9c2b2e-8d3a-4c1e-9b6a-2f1e3d4c5b6a"
        const ref = {
            resourceId,
            expectedContentHash: "a".repeat(64),
            mediaType: "image/png",
            byteLength: 3,
            owner: { kind: "task", taskId: "task-1" },
            generation: 1,
        } as const

        function withImage(): SemanticInputDocument {
            const before = lex("see ")
            const after = lex(" now")
            const image = { kind: "image", entityId: "doc-1#img", resourceId, displayName: "shot.png" } as const
            return {
                ...before,
                rawText: `see [image:${resourceId}] now`,
                nodes: [...before.nodes, image, ...after.nodes],
                resources: [ref],
            }
        }

        it("refuses a resource when no verifier can check it", async () => {
            const result = await service().admit(withImage())

            expect(result.ok).toBe(false)
            if (result.ok) return
            expect(result.diagnostics.map((d) => [d.code, d.resourceId])).toEqual([
                ["semantic_input_resource_invalid", resourceId],
            ])
        })

        it("refuses with the verifier's located diagnostic", async () => {
            const result = await new SemanticInputAdmissionService({
                catalog: () => catalog,
                commands: { expand: async () => ({ text: "" }) },
                mentions: { resolve: async () => "" },
                resources: {
                    verify: async (document, node) => [
                        semanticInputDiagnostic("semantic_input_resource_changed", "content changed", {
                            documentId: document.documentId,
                            entityId: node.entityId,
                            resourceId: node.resourceId,
                        }),
                    ],
                },
            }).admit(withImage())

            expect(result.ok).toBe(false)
            if (result.ok) return
            expect(result.diagnostics.map((d) => [d.code, d.entityId])).toEqual([
                ["semantic_input_resource_changed", "doc-1#img"],
            ])
        })

        it("keeps a verified resource as its own part, in place", async () => {
            const result = await new SemanticInputAdmissionService({
                catalog: () => catalog,
                commands: { expand: async () => ({ text: "" }) },
                mentions: { resolve: async () => "" },
                resources: { verify: async () => [] },
            }).admit(withImage())

            expect(result.ok).toBe(true)
            if (!result.ok) return
            expect(result.admitted.parts).toEqual([
                { kind: "text", text: "see " },
                { kind: "resource", entityId: "doc-1#img", nodeKind: "image", ref, displayName: "shot.png" },
                { kind: "text", text: " now" },
            ])
        })

        // The words after a lifecycle command steer the command, but an
        // attachment there is still something the user attached: it stays with
        // the turn the command opens instead of being folded into its guidance.
        it("keeps an attachment placed after a lifecycle command with the turn, not the premessage", async () => {
            const typed = lex("see /compact keep the audit ")
            const image = { kind: "image", entityId: "doc-1#img", resourceId, displayName: "shot.png" } as const
            const result = await new SemanticInputAdmissionService({
                catalog: () => catalog,
                commands: { expand: async () => ({ text: "" }) },
                mentions: { resolve: async () => "" },
                resources: { verify: async () => [] },
            }).admit({
                ...typed,
                rawText: `see /compact keep the audit [image:${resourceId}]`,
                nodes: [...typed.nodes, image],
                resources: [ref],
            })

            expect(result.ok).toBe(true)
            if (!result.ok) return
            expect(result.admitted.barrier).toMatchObject({
                commandId: "command.compact",
                turnText: `see [image:${resourceId}]`,
                turnParts: [
                    { kind: "text", text: "see " },
                    { kind: "resource", entityId: "doc-1#img", nodeKind: "image", ref, displayName: "shot.png" },
                ],
                premessage: "keep the audit",
            })
        })
    })
})
