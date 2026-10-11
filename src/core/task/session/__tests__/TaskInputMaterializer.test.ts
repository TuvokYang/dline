import { semanticInputDiagnostic } from "@shared/input-semantics/diagnostics"
import type { SemanticInputDocument } from "@shared/input-semantics/document"
import { describe, expect, it } from "vitest"
import type { TaskPayloadStore } from "../../stores"
import { decodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { LifecycleCommand, UserInputEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import {
    type AdmittedLifecycleBarrier,
    type LifecycleBarrierPort,
    SemanticInputRejectedError,
    type TaskInputAdmissionPort,
} from "../TaskInputAdmission"
import { TaskInputMaterializer } from "../TaskInputMaterializer"

const document: SemanticInputDocument = {
    schemaVersion: 1,
    parserVersion: "1.0.0",
    catalogRevision: "2",
    documentId: "doc-1",
    rawText: "/compact please",
    nodes: [{ kind: "text", text: "/compact please" }],
    resources: [],
}

function recordingPayloads() {
    const stored: Uint8Array[] = []
    const payloads = {
        put: async (payload: Uint8Array) => {
            stored.push(payload)
            return `ref-${stored.length}`
        },
        read: async () => undefined,
    } as unknown as TaskPayloadStore
    return {
        payloads,
        lastEnvelope: () => decodeTaskPayload<UserInputEnvelope>(stored[stored.length - 1]),
    }
}

const identity = { nextEntryId: () => "entry-1", nextSequence: () => 0 }

const admitting: TaskInputAdmissionPort = {
    admit: async () => ({
        ok: true,
        admitted: {
            document,
            admittedText: "<compact-instructions> please",
            parts: [{ kind: "text", text: "<compact-instructions> please" }],
            authorizedTools: ["summarize_task"],
            explicitInstructions: [{ type: "summarize_task", source: "manual_compact_command" }],
        },
    }),
}

/** "/explain then /compact keep the audit", with the barrier as its own node. */
const barrierDocument: SemanticInputDocument = {
    ...document,
    rawText: "/explain then /compact keep the audit",
    nodes: [
        { kind: "text", text: "/explain then " },
        { kind: "slash_command", entityId: "compact-1", sourceText: "/compact" } as never,
        { kind: "text", text: " keep the audit" },
    ],
}

const compactBarrier: AdmittedLifecycleBarrier = {
    commandId: "command.compact",
    entityId: "compact-1",
    before: "<explain-instructions> then",
    partsBefore: [{ kind: "text", text: "<explain-instructions> then" }],
    premessage: "keep the audit",
    instructionsBefore: [{ type: "skill", source: "skill_injection" }],
    toolsBefore: ["use_skill"],
}

const admittingBarrier: TaskInputAdmissionPort = {
    admit: async () => ({
        ok: true,
        admitted: {
            document: barrierDocument,
            admittedText: "<explain-instructions> then <compact-instructions> keep the audit",
            parts: [{ kind: "text", text: "<explain-instructions> then <compact-instructions> keep the audit" }],
            authorizedTools: ["use_skill", "summarize_task"],
            explicitInstructions: [
                { type: "skill", source: "skill_injection" },
                { type: "summarize_task", source: "manual_compact_command" },
            ],
            barrier: compactBarrier,
        },
    }),
}

function recordingBarriers(owns: boolean) {
    const requested: LifecycleCommand[] = []
    const port: LifecycleBarrierPort = {
        owns: () => owns,
        request: (command) => {
            requested.push(command)
        },
    }
    return { port, requested }
}

const refusing: TaskInputAdmissionPort = {
    admit: async () => ({
        ok: false,
        diagnostics: [semanticInputDiagnostic("semantic_input_catalog_stale", "stale", { documentId: "doc-1" })],
    }),
}

const admittingPlainText: TaskInputAdmissionPort = {
    admit: async (input) => ({
        ok: true,
        admitted: {
            document: { ...document, rawText: input.text ?? "", nodes: [{ kind: "text", text: input.text ?? "" }] },
            admittedText: input.text ?? "",
            parts: input.text ? [{ kind: "text", text: input.text }] : [],
            authorizedTools: [],
            explicitInstructions: [],
        },
    }),
}

describe("TaskInputMaterializer", () => {
    it("stores the raw text, the document and the admitted projection side by side", async () => {
        const store = recordingPayloads()
        const materializer = new TaskInputMaterializer(store.payloads, identity, admitting)

        await materializer.materialize({ text: "/compact please" })

        const envelope = store.lastEnvelope()
        expect(envelope.text).toBe("/compact please")
        expect(envelope.admittedText).toBe("<compact-instructions> please")
        expect(envelope.semanticInput?.documentId).toBe("doc-1")
        expect(envelope.authorizedTools).toEqual(["summarize_task"])
        expect(envelope.explicitInstructions).toEqual([{ type: "summarize_task", source: "manual_compact_command" }])
    })

    it("refuses a rejected submission instead of journaling it", async () => {
        const store = recordingPayloads()
        const materializer = new TaskInputMaterializer(store.payloads, identity, refusing)

        await expect(materializer.materialize({ text: "/compact" })).rejects.toBeInstanceOf(SemanticInputRejectedError)
    })

    it("requires an explicit admission result even for plain text", async () => {
        const store = recordingPayloads()
        const materializer = new TaskInputMaterializer(store.payloads, identity, admittingPlainText)

        const input = await materializer.materialize({ text: "hello" }, "steering")

        expect(input.mode).toBe("steering")
        const envelope = store.lastEnvelope()
        expect(envelope.text).toBe("hello")
        expect(envelope.admittedText).toBe("hello")
        expect(envelope.authorizedTools).toEqual([])
    })

    it("takes an owned barrier out of the turn and carries it with the input instead", async () => {
        const store = recordingPayloads()
        const barriers = recordingBarriers(true)
        const materializer = new TaskInputMaterializer(store.payloads, identity, admittingBarrier, barriers.port)

        await materializer.materialize({ text: "/explain then /compact keep the audit" })

        const envelope = store.lastEnvelope()
        expect(envelope.text).toBe("/explain then /compact keep the audit")
        expect(envelope.admittedText).toBe("<explain-instructions> then")
        expect(envelope.explicitInstructions).toEqual([{ type: "skill", source: "skill_injection" }])
        expect(envelope.authorizedTools).toEqual(["use_skill"])
        expect(envelope.lifecycle).toEqual({ commandId: "command.compact", premessage: "keep the audit" })
        // Materializing is not acceptance: nothing acts until a round admits the input.
        expect(barriers.requested).toEqual([])
    })

    it("persists ordered parts only when the submission carries a resource", async () => {
        const image = {
            kind: "resource" as const,
            entityId: "img-1",
            nodeKind: "image" as const,
            ref: {
                resourceId: "00000000-0000-4000-8000-000000000001",
                expectedContentHash: "a".repeat(64),
                mediaType: "image/png",
                byteLength: 4,
                owner: { kind: "task" as const, taskId: "task-1" },
                generation: 1,
            },
            displayName: "shot.png",
        }
        const parts = [{ kind: "text" as const, text: "look " }, image, { kind: "text" as const, text: " here" }]
        const withResource: TaskInputAdmissionPort = {
            admit: async () => ({
                ok: true,
                admitted: { document, admittedText: "look [image] here", parts, authorizedTools: [], explicitInstructions: [] },
            }),
        }
        const store = recordingPayloads()

        await new TaskInputMaterializer(store.payloads, identity, withResource).materialize({ text: "look here" })
        expect(store.lastEnvelope().admittedParts).toEqual(parts)

        await new TaskInputMaterializer(store.payloads, identity, admittingPlainText).materialize({ text: "hello" })
        expect(store.lastEnvelope().admittedParts).toBeUndefined()

        // A caller-supplied projection is text only, so it may not silently drop the image.
        const override = new TaskInputMaterializer(store.payloads, identity, withResource).materialize({
            text: "look here",
            admittedText: "OVERRIDE",
        })
        await expect(override).rejects.toBeInstanceOf(SemanticInputRejectedError)
        await expect(override).rejects.toMatchObject({ diagnostics: [{ code: "semantic_input_resource_invalid" }] })
    })

    it("keeps the parts before an owned barrier, resources included", async () => {
        const image = {
            kind: "resource" as const,
            entityId: "img-1",
            nodeKind: "image" as const,
            ref: {
                resourceId: "00000000-0000-4000-8000-000000000001",
                expectedContentHash: "a".repeat(64),
                mediaType: "image/png",
                byteLength: 4,
                owner: { kind: "task" as const, taskId: "task-1" },
                generation: 1,
            },
            displayName: "shot.png",
        }
        const partsBefore = [{ kind: "text" as const, text: "see " }, image]
        const barrierWithImage: TaskInputAdmissionPort = {
            admit: async () => ({
                ok: true,
                admitted: {
                    document,
                    admittedText: "see [image] <compact-instructions>",
                    parts: [...partsBefore, { kind: "text" as const, text: " <compact-instructions>" }],
                    authorizedTools: ["summarize_task"],
                    explicitInstructions: [],
                    barrier: { ...compactBarrier, before: "see [image]", partsBefore, instructionsBefore: [], toolsBefore: [] },
                },
            }),
        }
        const store = recordingPayloads()
        const materializer = new TaskInputMaterializer(store.payloads, identity, barrierWithImage, recordingBarriers(true).port)

        await materializer.materialize({ text: "see /compact" })

        expect(store.lastEnvelope().admittedParts).toEqual(partsBefore)
        expect(store.lastEnvelope().lifecycle?.commandId).toBe("command.compact")
    })

    it("keeps an unowned barrier as ordinary content", async () => {
        const store = recordingPayloads()
        const materializer = new TaskInputMaterializer(store.payloads, identity, admittingBarrier, recordingBarriers(false).port)

        await materializer.materialize({ text: "/explain then /compact keep the audit" })

        const envelope = store.lastEnvelope()
        expect(envelope.admittedText).toBe("<explain-instructions> then <compact-instructions> keep the audit")
        expect(envelope.authorizedTools).toEqual(["use_skill", "summarize_task"])
        expect(envelope.explicitInstructions).toHaveLength(2)
        expect(envelope.lifecycle).toBeUndefined()
    })

    describe("reviewReply", () => {
        it("keeps what the user typed before the command and acts only once committed", async () => {
            const barriers = recordingBarriers(true)
            const materializer = new TaskInputMaterializer(
                recordingPayloads().payloads,
                identity,
                admittingBarrier,
                barriers.port,
            )

            const reviewed = await materializer.reviewReply({ text: "/explain then /compact keep the audit" })

            // A reply grants no command authority, so the typed form is kept, not its expansion.
            expect(reviewed?.text).toBe("/explain then")
            // The stored structure stops before the command, so admitting it again cannot repeat it.
            expect(reviewed?.document.nodes).toEqual([{ kind: "text", text: "/explain then" }])
            expect(reviewed?.document.rawText).toBe("/explain then")
            expect(barriers.requested).toEqual([])
            reviewed?.commit()
            expect(barriers.requested).toEqual([{ commandId: "command.compact", premessage: "keep the audit" }])
        })

        it("leaves the reply as typed when no domain owns the barrier", async () => {
            const materializer = new TaskInputMaterializer(
                recordingPayloads().payloads,
                identity,
                admittingBarrier,
                recordingBarriers(false).port,
            )

            expect(await materializer.reviewReply({ text: "/compact keep the audit" })).toBeUndefined()
        })

        it("keeps a refused reply literal instead of dropping the user's answer", async () => {
            const barriers = recordingBarriers(true)
            const materializer = new TaskInputMaterializer(recordingPayloads().payloads, identity, refusing, barriers.port)

            expect(await materializer.reviewReply({ text: "/compact" })).toBeUndefined()
            expect(barriers.requested).toEqual([])
        })

        // A composed reply is read exactly as sent; degrading it to literal text
        // would send something the user never saw in the composer.
        it("refuses a structured reply that admission refused", async () => {
            const barriers = recordingBarriers(true)
            const materializer = new TaskInputMaterializer(recordingPayloads().payloads, identity, refusing, barriers.port)

            await expect(materializer.reviewReply({ text: "/compact please", semanticInput: document })).rejects.toBeInstanceOf(
                SemanticInputRejectedError,
            )
            expect(barriers.requested).toEqual([])
        })

        it("refuses a structured reply carrying a resource no reply renders yet", async () => {
            let admitted = 0
            const counting: TaskInputAdmissionPort = {
                admit: async (input) => {
                    admitted++
                    return admittingBarrier.admit(input)
                },
            }
            const materializer = new TaskInputMaterializer(
                recordingPayloads().payloads,
                identity,
                counting,
                recordingBarriers(true).port,
            )
            const withFile: SemanticInputDocument = {
                ...document,
                rawText: "see input.txt",
                nodes: [
                    { kind: "text", text: "see " },
                    { kind: "file", entityId: "f-1", resourceId: "r-1", fileOrigin: "pasted_text", displayName: "input.txt" },
                ],
            }

            const reviewed = materializer.reviewReply({ text: "see input.txt", semanticInput: withFile })

            await expect(reviewed).rejects.toMatchObject({ diagnostics: [{ code: "semantic_input_resource_invalid" }] })
            expect(admitted).toBe(0)
        })

        it("reviews nothing in an assembly without a barrier owner", async () => {
            let admitted = 0
            const counting: TaskInputAdmissionPort = {
                admit: async (input) => {
                    admitted++
                    return admittingBarrier.admit(input)
                },
            }
            const materializer = new TaskInputMaterializer(recordingPayloads().payloads, identity, counting)

            expect(await materializer.reviewReply({ text: "/compact" })).toBeUndefined()
            expect(admitted).toBe(0)
        })
    })
})
