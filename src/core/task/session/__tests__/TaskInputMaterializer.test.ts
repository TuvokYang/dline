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
    type TaskInputAdmissionOptions,
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
    turnText: "<explain-instructions> then",
    turnParts: [{ kind: "text", text: "<explain-instructions> then" }],
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

/** "/compact keep the audit" sent on its own: nothing precedes the barrier. */
const bareBarrierDocument: SemanticInputDocument = {
    ...document,
    rawText: "/compact keep the audit",
    nodes: [
        { kind: "slash_command", entityId: "compact-1", sourceText: "/compact" } as never,
        { kind: "text", text: " keep the audit" },
    ],
}

const admittingBareBarrier: TaskInputAdmissionPort = {
    admit: async () => ({
        ok: true,
        admitted: {
            document: bareBarrierDocument,
            admittedText: "<compact-instructions> keep the audit",
            parts: [{ kind: "text", text: "<compact-instructions> keep the audit" }],
            authorizedTools: ["summarize_task"],
            explicitInstructions: [{ type: "summarize_task", source: "manual_compact_command" }],
            barrier: { ...compactBarrier, turnText: "", turnParts: [], instructionsBefore: [], toolsBefore: [] },
        },
    }),
}

function recordingBarriers(owns: boolean) {
    const requested: LifecycleCommand[] = []
    const performed: LifecycleCommand[] = []
    const port: LifecycleBarrierPort = {
        owns: () => owns,
        request: (command) => {
            requested.push(command)
        },
        perform: async (command) => {
            performed.push(command)
            return true
        },
    }
    return { port, requested, performed }
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

    it("pins the catalog revision only for a dialog answer", async () => {
        const store = recordingPayloads()
        const seen: unknown[] = []
        const recording: TaskInputAdmissionPort = {
            admit: async (input, options) => {
                seen.push(options)
                return admittingPlainText.admit(input, options)
            },
        }
        const materializer = new TaskInputMaterializer(store.payloads, identity, recording)

        await materializer.materialize({ text: "fresh" })
        await materializer.materializePayload({ text: "edited" })
        const answer = await materializer.materializeAnswer({ text: "answer" })

        expect(seen).toEqual([undefined, undefined, { pinnedRevision: true }])
        expect(answer.mode).toBe("queued")
        expect(store.lastEnvelope().text).toBe("answer")
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

        // Admission alone writes the projection: a caller cannot replace what the
        // model reads while keeping the authority admission granted.
        await new TaskInputMaterializer(store.payloads, identity, withResource).materialize({
            text: "look here",
            admittedText: "OVERRIDE",
        })
        expect(store.lastEnvelope()).toMatchObject({ admittedText: "look [image] here", admittedParts: parts })
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
        const turnParts = [{ kind: "text" as const, text: "see " }, image]
        const barrierWithImage: TaskInputAdmissionPort = {
            admit: async () => ({
                ok: true,
                admitted: {
                    document,
                    admittedText: "see [image] <compact-instructions>",
                    parts: [...turnParts, { kind: "text" as const, text: " <compact-instructions>" }],
                    authorizedTools: ["summarize_task"],
                    explicitInstructions: [],
                    barrier: { ...compactBarrier, turnText: "see [image]", turnParts, instructionsBefore: [], toolsBefore: [] },
                },
            }),
        }
        const store = recordingPayloads()
        const materializer = new TaskInputMaterializer(store.payloads, identity, barrierWithImage, recordingBarriers(true).port)

        await materializer.materialize({ text: "see /compact" })

        expect(store.lastEnvelope().admittedParts).toEqual(turnParts)
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
            // The kept text is the answer, so the command waits for the round it opens.
            expect(reviewed?.performAlone).toBeUndefined()
            reviewed?.commit()
            expect(barriers.requested).toEqual([{ commandId: "command.compact", premessage: "keep the audit" }])
        })

        it("offers to carry out a command sent on its own instead of answering with nothing", async () => {
            const barriers = recordingBarriers(true)
            const materializer = new TaskInputMaterializer(
                recordingPayloads().payloads,
                identity,
                admittingBareBarrier,
                barriers.port,
            )

            const reviewed = await materializer.reviewReply({ text: "/compact keep the audit" })

            expect(reviewed?.text).toBe("")
            await expect(reviewed?.performAlone?.()).resolves.toBe(true)
            // Performed with its guidance, never also owed to a round.
            expect(barriers.performed).toEqual([{ commandId: "command.compact", premessage: "keep the audit" }])
            expect(barriers.requested).toEqual([])
        })

        it("leaves the reply as typed when admission recognized nothing that acts", async () => {
            const materializer = new TaskInputMaterializer(
                recordingPayloads().payloads,
                identity,
                admittingPlainText,
                recordingBarriers(false).port,
            )

            expect(await materializer.reviewReply({ text: "looks good, ship it" })).toBeUndefined()
        })

        describe("naming a command or mention no lifecycle owner takes", () => {
            /** "/cmd:reportbug the panel froze": the canonical form the composer menu inserts for /reportbug. */
            const reportBugReply: SemanticInputDocument = {
                ...document,
                rawText: "/cmd:reportbug the panel froze",
                nodes: [
                    {
                        kind: "slash_command",
                        entityId: "report-1",
                        commandId: "command.report_bug",
                        sourceText: "/cmd:reportbug",
                        canonicalName: "reportbug",
                        namespace: "cmd",
                        compositionMode: "composable",
                        state: "recognized",
                    },
                    { kind: "text", text: " the panel froze" },
                ],
            }
            const mentionReply: SemanticInputDocument = {
                ...document,
                rawText: "see @/src/app.ts",
                nodes: [
                    { kind: "text", text: "see " },
                    {
                        kind: "mention",
                        entityId: "m-1",
                        mentionKind: "file",
                        sourceText: "@/src/app.ts",
                        canonicalRef: "/src/app.ts",
                        state: "recognized",
                    },
                ],
            }
            const admittingDocument = (admitted: SemanticInputDocument): TaskInputAdmissionPort => ({
                admit: async () => ({
                    ok: true,
                    admitted: {
                        document: admitted,
                        admittedText: "<expanded>",
                        parts: [{ kind: "text", text: "<expanded>" }],
                        authorizedTools: [],
                        explicitInstructions: [],
                    },
                }),
            })

            it("asks for the reply to be carried as a submission instead of literal feedback", async () => {
                const barriers = recordingBarriers(false)
                const materializer = new TaskInputMaterializer(
                    recordingPayloads().payloads,
                    identity,
                    admittingDocument(reportBugReply),
                    barriers.port,
                )

                const reviewed = await materializer.reviewReply({ text: "/cmd:reportbug the panel froze" })

                expect(reviewed?.carriesInput).toBe(true)
                // The typed form is what the submission re-admits; the expansion never rides on a draft.
                expect(reviewed?.text).toBe("/cmd:reportbug the panel froze")
                expect(reviewed?.document).toBe(reportBugReply)
                expect(reviewed?.claimedBarrier).toBeUndefined()
                expect(reviewed?.performAlone).toBeUndefined()
                reviewed?.commit()
                expect(barriers.requested).toEqual([])
            })

            it("carries a recognized mention the same way", async () => {
                const materializer = new TaskInputMaterializer(
                    recordingPayloads().payloads,
                    identity,
                    admittingDocument(mentionReply),
                )

                expect((await materializer.reviewReply({ text: "see @/src/app.ts" }))?.carriesInput).toBe(true)
            })

            it("leaves a command shape admission did not recognize as typed", async () => {
                const unresolved: SemanticInputDocument = {
                    ...reportBugReply,
                    nodes: reportBugReply.nodes.map((node) =>
                        node.kind === "slash_command" ? { ...node, state: "unresolved" as const } : node,
                    ),
                }
                const materializer = new TaskInputMaterializer(
                    recordingPayloads().payloads,
                    identity,
                    admittingDocument(unresolved),
                )

                expect(await materializer.reviewReply({ text: "/cmd:reportbug the panel froze" })).toBeUndefined()
            })

            it("carries it even in an assembly without a barrier owner", async () => {
                const materializer = new TaskInputMaterializer(
                    recordingPayloads().payloads,
                    identity,
                    admittingDocument(reportBugReply),
                )

                expect((await materializer.reviewReply({ text: "/cmd:reportbug the panel froze" }))?.carriesInput).toBe(true)
            })
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

        describe("with resources", () => {
            const pasted = {
                kind: "resource" as const,
                entityId: "f-1",
                nodeKind: "file" as const,
                ref: {
                    resourceId: "00000000-0000-4000-8000-000000000002",
                    expectedContentHash: "b".repeat(64),
                    mediaType: "text/plain",
                    byteLength: 3,
                    owner: { kind: "task" as const, taskId: "task-1" },
                    generation: 1,
                },
                displayName: "input.txt",
            }
            const withFile: SemanticInputDocument = {
                ...document,
                rawText: "see input.txt",
                nodes: [
                    { kind: "text", text: "see " },
                    {
                        kind: "file",
                        entityId: "f-1",
                        resourceId: pasted.ref.resourceId,
                        fileOrigin: "pasted_text",
                        displayName: "input.txt",
                    },
                ],
                resources: [pasted.ref],
            }
            const admittingFile: TaskInputAdmissionPort = {
                admit: async () => ({
                    ok: true,
                    admitted: {
                        document: withFile,
                        admittedText: "see [input.txt]",
                        parts: [{ kind: "text", text: "see " }, pasted],
                        authorizedTools: [],
                        explicitInstructions: [],
                    },
                }),
            }
            it("verifies them through admission and hands them on in place even without a command", async () => {
                const materializer = new TaskInputMaterializer(recordingPayloads().payloads, identity, admittingFile)

                const reviewed = await materializer.reviewReply({ text: "see input.txt", semanticInput: withFile })

                expect(reviewed?.text).toBe("see input.txt")
                expect(reviewed?.document).toBe(withFile)
                // The typed text stays the source; the resource is the reference admission verified.
                expect(reviewed?.parts).toEqual([{ kind: "text", text: "see " }, pasted])
                expect(() => reviewed?.commit()).not.toThrow()
            })

            it("refuses them when admission refuses", async () => {
                const materializer = new TaskInputMaterializer(recordingPayloads().payloads, identity, refusing)

                await expect(materializer.reviewReply({ text: "see input.txt", semanticInput: withFile })).rejects.toBeInstanceOf(
                    SemanticInputRejectedError,
                )
            })

            it("refuses a resource admission did not verify instead of dropping it", async () => {
                const unverified: TaskInputAdmissionPort = {
                    admit: async () => ({
                        ok: true,
                        admitted: {
                            document: withFile,
                            admittedText: "see [input.txt]",
                            parts: [{ kind: "text", text: "see [input.txt]" }],
                            authorizedTools: [],
                            explicitInstructions: [],
                        },
                    }),
                }
                const materializer = new TaskInputMaterializer(recordingPayloads().payloads, identity, unverified)

                await expect(materializer.reviewReply({ text: "see input.txt", semanticInput: withFile })).rejects.toBeInstanceOf(
                    SemanticInputRejectedError,
                )
            })

            it("hands on only the resources before an owned command", async () => {
                const barriers = recordingBarriers(true)
                const before: SemanticInputDocument = {
                    ...withFile,
                    rawText: "see input.txt /compact",
                    nodes: [
                        ...withFile.nodes,
                        { kind: "text", text: " " },
                        ...(barrierDocument.nodes.filter(
                            (node) => node.kind === "slash_command",
                        ) as SemanticInputDocument["nodes"]),
                    ],
                }
                const barrierAfterFile: TaskInputAdmissionPort = {
                    admit: async () => ({
                        ok: true,
                        admitted: {
                            document: before,
                            admittedText: "see [input.txt] <compact-instructions>",
                            parts: [{ kind: "text", text: "see " }, pasted, { kind: "text", text: " <compact-instructions>" }],
                            authorizedTools: [],
                            explicitInstructions: [],
                            barrier: {
                                ...compactBarrier,
                                turnText: "see [input.txt]",
                                turnParts: [{ kind: "text", text: "see " }, pasted],
                                instructionsBefore: [],
                                toolsBefore: [],
                            },
                        },
                    }),
                }
                const materializer = new TaskInputMaterializer(
                    recordingPayloads().payloads,
                    identity,
                    barrierAfterFile,
                    barriers.port,
                )

                const reviewed = await materializer.reviewReply({ text: "see input.txt /compact", semanticInput: before })

                expect(reviewed?.parts.filter((part) => part.kind === "resource")).toEqual([pasted])
                expect(reviewed?.parts.map((part) => (part.kind === "text" ? part.text : "")).join("")).not.toContain("compact")
                expect(barriers.requested).toEqual([])
                reviewed?.commit()
                expect(barriers.requested).toHaveLength(1)
            })
        })

        it("reviews nothing for an empty reply", async () => {
            let admitted = 0
            const counting: TaskInputAdmissionPort = {
                admit: async (input) => {
                    admitted++
                    return admittingPlainText.admit(input)
                },
            }
            const materializer = new TaskInputMaterializer(recordingPayloads().payloads, identity, counting)

            expect(await materializer.reviewReply({ text: "" })).toBeUndefined()
            expect(admitted).toBe(0)
        })
    })

    describe("admitReply", () => {
        /** "/cmd:reportbug the panel froze", typed as the answer to a restored follow-up. */
        const reportBugReply: SemanticInputDocument = {
            ...document,
            rawText: "/cmd:reportbug the panel froze",
            nodes: [
                {
                    kind: "slash_command",
                    entityId: "report-1",
                    commandId: "command.report_bug",
                    sourceText: "/cmd:reportbug",
                    canonicalName: "reportbug",
                    namespace: "cmd",
                    compositionMode: "composable",
                    state: "recognized",
                },
                { kind: "text", text: " the panel froze" },
            ],
        }
        // A restored reply becomes the tool's result, so taking an intake identity would be a defect.
        const noIntakeIdentity = {
            nextEntryId: (): string => {
                throw new Error("a restored reply must not take an intake entry")
            },
            nextSequence: (): number => {
                throw new Error("a restored reply must not take an intake sequence")
            },
        }
        function storing() {
            const stored: Uint8Array[] = []
            const payloads = {
                put: async (payload: Uint8Array) => {
                    stored.push(payload)
                    return `ref-${stored.length}`
                },
                read: async () => undefined,
            } as unknown as TaskPayloadStore
            return { payloads, stored }
        }
        function admittingReportBug(options: TaskInputAdmissionOptions[]): TaskInputAdmissionPort {
            return {
                admit: async (_input, admissionOptions) => {
                    options.push(admissionOptions ?? {})
                    return {
                        ok: true,
                        admitted: {
                            document: reportBugReply,
                            admittedText: "<report-bug-instructions> the panel froze",
                            parts: [{ kind: "text", text: "<report-bug-instructions> the panel froze" }],
                            authorizedTools: ["report_bug"],
                            explicitInstructions: [{ type: "skill", source: "skill_injection" }],
                        },
                    }
                },
            }
        }

        it("stores the admission of a reply that names a command without taking an intake entry", async () => {
            const store = storing()
            const options: TaskInputAdmissionOptions[] = []
            const materializer = new TaskInputMaterializer(store.payloads, noIntakeIdentity, admittingReportBug(options))

            const admitted = await materializer.admitReply({ text: "/cmd:reportbug the panel froze" })

            expect(admitted).toEqual({
                payloadRef: "ref-1",
                modelText: "<report-bug-instructions> the panel froze",
                document: reportBugReply,
            })
            // The reply was durable before the restore, so its catalog revision stays pinned.
            expect(options).toEqual([{ pinnedRevision: true }])
            expect(store.stored).toHaveLength(1)
            const envelope = decodeTaskPayload<UserInputEnvelope>(store.stored[0])
            expect(envelope).toMatchObject({
                kind: "user_input",
                text: "/cmd:reportbug the panel froze",
                admittedText: "<report-bug-instructions> the panel froze",
                authorizedTools: ["report_bug"],
                explicitInstructions: [{ type: "skill", source: "skill_injection" }],
            })
            expect(envelope.semanticInput?.documentId).toBe(reportBugReply.documentId)
        })

        it("leaves a reply in which nothing acts as typed and stores nothing", async () => {
            const store = storing()
            const materializer = new TaskInputMaterializer(store.payloads, noIntakeIdentity, admittingPlainText)

            expect(await materializer.admitReply({ text: "looks good, ship it" })).toBeUndefined()
            expect(await materializer.admitReply({ text: "" })).toBeUndefined()
            expect(store.stored).toHaveLength(0)
        })

        it("leaves a lifecycle command this path cannot carry out as typed instead of half-acting", async () => {
            const store = storing()
            const barriers = recordingBarriers(true)
            const materializer = new TaskInputMaterializer(store.payloads, noIntakeIdentity, admittingBarrier, barriers.port)

            expect(await materializer.admitReply({ text: "/explain then /compact keep the audit" })).toBeUndefined()
            expect(store.stored).toHaveLength(0)
            expect(barriers.requested).toEqual([])
        })

        it("keeps a refused legacy reply literal and refuses a structured one", async () => {
            const store = storing()
            const materializer = new TaskInputMaterializer(store.payloads, noIntakeIdentity, refusing)

            expect(await materializer.admitReply({ text: "/cmd:reportbug the panel froze" })).toBeUndefined()
            await expect(
                materializer.admitReply({ text: reportBugReply.rawText, semanticInput: reportBugReply }),
            ).rejects.toBeInstanceOf(SemanticInputRejectedError)
            expect(store.stored).toHaveLength(0)
        })
    })
})
