import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import { serializeDurableToolResult } from "../../../../DurableToolResult"
import type { TaskPayloadStore } from "../../../../stores"
import { encodeTaskPayload } from "../../../../stores/payload/TaskPayloadCodec"
import { ProviderJournalMessageMaterializer } from "../ProviderJournalMessageMaterializer"

const attachedPdf = {
    type: "attached_document" as const,
    path: "/work/spec.pdf",
    media_type: "application/pdf" as const,
    data: "JVBERi0xLjQKJSVFT0YK",
    byte_length: 16,
    page_count: 1,
    fallback_text: '<file_content path="/work/spec.pdf">\nHello PDF\n</file_content>',
}

function payloadStore(payloads: Readonly<Record<string, Uint8Array>>): TaskPayloadStore {
    return {
        read: async (ref: string) => payloads[ref],
    } as unknown as TaskPayloadStore
}

describe("ProviderJournalMessageMaterializer", () => {
    it("collects the authority the admitted inputs of the turn granted", async () => {
        const materializer = new ProviderJournalMessageMaterializer(
            payloadStore({
                "ref-1": encodeTaskPayload({
                    kind: "user_input",
                    entryId: "entry-1",
                    text: "/compact",
                    explicitInstructions: [
                        {
                            type: "summarize_task",
                            source: "manual_compact_command",
                            targetTool: DlineDefaultTool.SUMMARIZE_TASK,
                        },
                    ],
                }),
                "ref-2": encodeTaskPayload({ kind: "user_input", entryId: "entry-2", text: "and then continue" }),
            }),
        )

        const declarations = await materializer.collectAuthority(["ref-1", "ref-2"])

        expect(declarations).toEqual([
            { type: "summarize_task", source: "manual_compact_command", targetTool: DlineDefaultTool.SUMMARIZE_TASK },
        ])
    })

    it("builds an input that carries resources from its ordered parts and the verified bytes", async () => {
        const ref = {
            resourceId: "00000000-0000-4000-8000-000000000001",
            expectedContentHash: "a".repeat(64),
            mediaType: "image/png",
            byteLength: 4,
            owner: { kind: "task" as const, taskId: "task-1" },
            generation: 1,
        }
        const reads: string[] = []
        const materializer = new ProviderJournalMessageMaterializer(
            payloadStore({
                "ref-1": encodeTaskPayload({
                    kind: "user_input",
                    text: "look here",
                    admittedText: "look [image] here",
                    admittedParts: [
                        { kind: "text", text: "look " },
                        { kind: "resource", entityId: "img-1", nodeKind: "image", ref, displayName: "shot.png" },
                        { kind: "text", text: " here" },
                    ],
                }),
            }),
            {
                readBytes: async (resourceRef) => {
                    reads.push(resourceRef.resourceId)
                    return { ok: true, value: { record: { mediaType: "image/png" }, bytes: Buffer.from([1, 2, 3, 4]) } }
                },
            },
        )

        const [message] = await materializer.materialize(["ref-1"])

        expect(reads).toEqual([ref.resourceId])
        expect(message?.content).toEqual([
            { type: "text", text: "<user_message>\nlook " },
            {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: Buffer.from([1, 2, 3, 4]).toString("base64") },
            },
            { type: "text", text: " here\n</user_message>" },
        ])
    })

    // A retained batch can merge an input that placed a resource with a legacy
    // one that carried a flat attachment; neither may vanish from the request.
    it("keeps a batch's flat attachments after the content of its ordered parts", async () => {
        const ref = {
            resourceId: "00000000-0000-4000-8000-000000000002",
            expectedContentHash: "b".repeat(64),
            mediaType: "image/png",
            byteLength: 4,
            owner: { kind: "task" as const, taskId: "task-1" },
            generation: 1,
        }
        const materializer = new ProviderJournalMessageMaterializer(
            payloadStore({
                "ref-1": encodeTaskPayload({
                    kind: "user_input",
                    text: "look\n\nlegacy",
                    admittedText: "look [image]\n\nlegacy",
                    images: ["data:image/png;base64,TEdFR0FDWQ=="],
                    admittedParts: [
                        { kind: "text", text: "look " },
                        { kind: "resource", entityId: "img-1", nodeKind: "image", ref, displayName: "shot.png" },
                        { kind: "text", text: "\n\nlegacy" },
                    ],
                }),
            }),
            {
                readBytes: async () => ({
                    ok: true,
                    value: { record: { mediaType: "image/png" }, bytes: Buffer.from([1, 2, 3, 4]) },
                }),
            },
        )

        const [message] = await materializer.materialize(["ref-1"])

        const content = Array.isArray(message?.content) ? message.content : []
        expect(content.map((block) => block.type)).toEqual(["text", "image", "text", "image"])
        expect(content.at(-1)).toMatchObject({ type: "image", source: { data: "TEdFR0FDWQ==" } })
    })

    it("ignores payloads that are not admitted user input", async () => {
        const materializer = new ProviderJournalMessageMaterializer(
            payloadStore({
                "ref-1": encodeTaskPayload({ kind: "environment_details", text: "environment" }),
                "ref-2": encodeTaskPayload({ kind: "dialog_selection", values: ["yes"] }),
            }),
        )

        expect(await materializer.collectAuthority(["ref-1", "ref-2"])).toEqual([])
    })

    // Submission context is separate from what the user typed: a TaskStart hook or
    // a spawn handoff records it alongside the text, and dropping it silently
    // removed the workspace policy the first turn was supposed to obey.
    it("appends the submission context to the admitted text", async () => {
        const materializer = new ProviderJournalMessageMaterializer(
            payloadStore({
                "ref-1": encodeTaskPayload({
                    kind: "user_input",
                    entryId: "entry-1",
                    text: "do the thing",
                    context: "WORKSPACE_POLICY",
                }),
            }),
        )

        const [message] = await materializer.materialize(["ref-1"])

        expect(message?.content).toEqual([
            { type: "text", text: "<user_message>\ndo the thing\n\nWORKSPACE_POLICY\n</user_message>" },
        ])
    })

    it("materializes context-only input when the submission carried no text", async () => {
        const materializer = new ProviderJournalMessageMaterializer(
            payloadStore({
                "ref-1": encodeTaskPayload({ kind: "user_input", entryId: "entry-1", context: "WORKSPACE_POLICY" }),
            }),
        )

        const [message] = await materializer.materialize(["ref-1"])

        expect(message?.content).toEqual([{ type: "text", text: "<user_message>\nWORKSPACE_POLICY\n</user_message>" }])
    })

    it("leaves the admitted text untouched when no context was recorded", async () => {
        const materializer = new ProviderJournalMessageMaterializer(
            payloadStore({
                "ref-1": encodeTaskPayload({
                    kind: "user_input",
                    entryId: "entry-1",
                    text: "raw mirror",
                    admittedText: "expanded text",
                }),
            }),
        )

        const [message] = await materializer.materialize(["ref-1"])

        expect(message?.content).toEqual([{ type: "text", text: "<user_message>\nexpanded text\n</user_message>" }])
    })

    // The submission that opens a task reaches the model as `<task>`, exactly as
    // the legacy runtime sent it; only later input is a `<user_message>`.
    it("sends the task's opening submission as the task", async () => {
        const materializer = new ProviderJournalMessageMaterializer(
            payloadStore({
                "ref-1": encodeTaskPayload({
                    kind: "user_input",
                    entryId: "entry-1",
                    text: "raw mirror",
                    admittedText: "E2E_OPENING_TASK",
                    opensTask: true,
                }),
            }),
        )

        const [message] = await materializer.materialize(["ref-1"])

        expect(message?.content).toEqual([{ type: "text", text: "<task>\nE2E_OPENING_TASK\n</task>" }])
    })

    it("keeps the opening submission's context as its own block after the task", async () => {
        const materializer = new ProviderJournalMessageMaterializer(
            payloadStore({
                "ref-1": encodeTaskPayload({
                    kind: "user_input",
                    entryId: "entry-1",
                    text: "do the thing",
                    context: "WORKSPACE_POLICY",
                    opensTask: true,
                }),
            }),
        )

        const [message] = await materializer.materialize(["ref-1"])

        expect(message?.content).toEqual([
            { type: "text", text: "<task>\ndo the thing\n</task>" },
            { type: "text", text: "<context>\nWORKSPACE_POLICY\n</context>" },
        ])
    })

    const refused = {
        type: "tool_result" as const,
        function_id: "dline_function_01",
        dline_tid: "dline_tid_01",
        content: [
            { type: "text" as const, text: "Explicit-only tool 'summarize_task' was rejected: explicit_instruction_missing." },
        ],
    }

    it("replays a result paired with a recorded call as the canonical tool result", async () => {
        const materializer = new ProviderJournalMessageMaterializer(
            payloadStore({
                "ref-1": encodeTaskPayload({
                    kind: "tool_result",
                    blockId: "dline_tid_01",
                    content: serializeDurableToolResult(refused),
                }),
            }),
        )

        const [message] = await materializer.materialize(["ref-1"])

        expect(message).toMatchObject({ role: "user", content: [refused] })
    })

    // The call was kept in the history as the markup the model wrote, so there is
    // no provider call to pair with; the result speaks as prose instead.
    it("replays a result whose call was never recorded as prose without the call identity", async () => {
        const image = {
            type: "image" as const,
            source: { type: "base64" as const, media_type: "image/png" as const, data: "AA==" },
        }
        const materializer = new ProviderJournalMessageMaterializer(
            payloadStore({
                "ref-1": encodeTaskPayload({
                    kind: "tool_result",
                    blockId: "dline_tid_01",
                    content: serializeDurableToolResult(
                        { ...refused, content: [...refused.content, image] },
                        { kind: "text", toolName: "summarize_task" },
                    ),
                }),
            }),
        )

        const [message] = await materializer.materialize(["ref-1"])

        expect(message?.content).toEqual([
            {
                type: "text",
                text: "[summarize_task] Result:\nExplicit-only tool 'summarize_task' was rejected: explicit_instruction_missing.",
            },
            image,
        ])
        expect(JSON.stringify(message)).not.toContain("dline_function_")
    })

    // The legacy tool path merged a refusal's feedback into the refused call's
    // result; a separate user block leaves the model's view of that call without it.
    it("merges approval feedback into the result of the call it answered", async () => {
        const denied = { ...refused, content: [{ type: "text" as const, text: "The user denied this operation." }] }
        const materializer = new ProviderJournalMessageMaterializer(
            payloadStore({
                manifest: encodeTaskPayload({
                    kind: "tool_terminal_manifest",
                    turnId: "turn-1",
                    results: [
                        {
                            blockId: "dline_tid_01",
                            phase: "rejected",
                            content: serializeDurableToolResult(denied),
                            failed: true,
                            feedbackRef: "feedback",
                        },
                    ],
                    supersededPayloadRefs: [],
                }),
                feedback: encodeTaskPayload({ kind: "dialog_draft", text: "read the docs instead", images: [], files: [] }),
            }),
        )

        const [message] = await materializer.materialize(["manifest"])

        expect(message?.content).toEqual([
            {
                ...denied,
                content: [
                    ...denied.content,
                    {
                        type: "text",
                        text: "The user provided the following feedback:\n<feedback>\nread the docs instead\n</feedback>",
                    },
                ],
            },
        ])
    })

    describe("a structured reply's resources", () => {
        const imageRef = {
            resourceId: "00000000-0000-4000-8000-000000000003",
            expectedContentHash: "c".repeat(64),
            mediaType: "image/png",
            byteLength: 4,
            owner: { kind: "task" as const, taskId: "task-1" },
            generation: 1,
        }
        const imagePart = {
            kind: "resource" as const,
            entityId: "img-1",
            nodeKind: "image" as const,
            ref: imageRef,
            displayName: "shot.png",
        }
        const imageBlock = {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: Buffer.from([5, 6, 7, 8]).toString("base64") },
        }
        const readsImage = {
            readBytes: async () => ({
                ok: true as const,
                value: { record: { mediaType: "image/png" }, bytes: Buffer.from([5, 6, 7, 8]) },
            }),
        }

        it("places a dialog reply's image where the user put it, read from its verified bytes", async () => {
            const materializer = new ProviderJournalMessageMaterializer(
                payloadStore({
                    draft: encodeTaskPayload({
                        kind: "dialog_draft",
                        text: "like this one",
                        images: [],
                        files: [],
                        admittedParts: [{ kind: "text", text: "like " }, imagePart, { kind: "text", text: " this one" }],
                    }),
                }),
                readsImage,
            )

            const [message] = await materializer.materialize(["draft"])

            expect(message?.content).toEqual([
                { type: "text", text: "<user_message>\nlike " },
                imageBlock,
                { type: "text", text: " this one\n</user_message>" },
            ])
        })

        it("keeps approval feedback's image inside the result of the call it answered", async () => {
            const denied = { ...refused, content: [{ type: "text" as const, text: "The user denied this operation." }] }
            const materializer = new ProviderJournalMessageMaterializer(
                payloadStore({
                    manifest: encodeTaskPayload({
                        kind: "tool_terminal_manifest",
                        turnId: "turn-1",
                        results: [
                            {
                                blockId: "dline_tid_01",
                                phase: "rejected",
                                content: serializeDurableToolResult(denied),
                                failed: true,
                                feedbackRef: "feedback",
                            },
                        ],
                        supersededPayloadRefs: [],
                    }),
                    feedback: encodeTaskPayload({
                        kind: "dialog_draft",
                        text: "match this",
                        images: [],
                        files: [],
                        admittedParts: [{ kind: "text", text: "match " }, imagePart],
                    }),
                }),
                readsImage,
            )

            const [message] = await materializer.materialize(["manifest"])

            expect(message?.content).toEqual([
                {
                    ...denied,
                    content: [
                        ...denied.content,
                        { type: "text", text: "The user provided the following feedback:\n<feedback>\nmatch " },
                        imageBlock,
                        { type: "text", text: "\n</feedback>" },
                    ],
                },
            ])
        })

        it("names a reply resource that can no longer be read instead of dropping it", async () => {
            const materializer = new ProviderJournalMessageMaterializer(
                payloadStore({
                    draft: encodeTaskPayload({
                        kind: "dialog_draft",
                        text: "",
                        images: [],
                        files: [],
                        admittedParts: [imagePart],
                    }),
                }),
                { readBytes: async () => ({ ok: false as const, failure: { code: "semantic_input_resource_missing" } }) },
            )

            const [message] = await materializer.materialize(["draft"])

            expect(JSON.stringify(message?.content)).toContain("semantic_input_resource_missing")
            expect(JSON.stringify(message?.content)).toContain("shot.png")
        })
    })

    // A tool result holds only text and images, so a PDF the user attached to an
    // answer travels as its own payload and reaches the model after the result.
    it("places the documents attached to a raw result after that result", async () => {
        const materializer = new ProviderJournalMessageMaterializer(
            payloadStore({
                "ref-1": encodeTaskPayload({
                    kind: "tool_result",
                    blockId: "dline_tid_01",
                    content: serializeDurableToolResult(refused),
                    documentPayloadRefs: ["doc-1"],
                }),
                "doc-1": encodeTaskPayload({ kind: "attached_document", document: attachedPdf }),
            }),
        )

        const [message] = await materializer.materialize(["ref-1"])

        expect(message?.content).toEqual([refused, attachedPdf])
    })

    // Providers require every result of the previous assistant turn at the start of
    // the next user message; a document between two results would break the pairing.
    it("opens a terminal manifest with every result and appends the attached documents", async () => {
        const second = { ...refused, function_id: "dline_function_02", dline_tid: "dline_tid_02" }
        const materializer = new ProviderJournalMessageMaterializer(
            payloadStore({
                manifest: encodeTaskPayload({
                    kind: "tool_terminal_manifest",
                    turnId: "turn-1",
                    results: [
                        {
                            blockId: "dline_tid_01",
                            phase: "completed",
                            content: serializeDurableToolResult(refused),
                            documentPayloadRefs: ["doc-1"],
                        },
                        { blockId: "dline_tid_02", phase: "completed", content: serializeDurableToolResult(second) },
                    ],
                    supersededPayloadRefs: [],
                }),
                "doc-1": encodeTaskPayload({ kind: "attached_document", document: attachedPdf }),
            }),
        )

        const [message] = await materializer.materialize(["manifest"])

        expect(message?.content).toEqual([refused, second, attachedPdf])
    })

    it("rejects a document reference that names another payload kind", async () => {
        const materializer = new ProviderJournalMessageMaterializer(
            payloadStore({
                "ref-1": encodeTaskPayload({
                    kind: "tool_result",
                    blockId: "dline_tid_01",
                    content: serializeDurableToolResult(refused),
                    documentPayloadRefs: ["not-a-doc"],
                }),
                "not-a-doc": encodeTaskPayload({ kind: "dialog_draft", text: "x", images: [], files: [] }),
            }),
        )

        await expect(materializer.materialize(["ref-1"])).rejects.toThrow("InvalidAttachedDocumentPayload")
    })

    // A request to another model projects this turn as foreign history only if
    // the producer survives the journal; without it a switch loses the reasoning.
    it("restores the model that wrote a reply", async () => {
        const modelInfo = { modelId: "source-model", providerId: "anthropic", mode: "act" as const }
        const materializer = new ProviderJournalMessageMaterializer(
            payloadStore({
                "ref-1": encodeTaskPayload({
                    kind: "provider_final",
                    content: [{ type: "text", text: "answer" }],
                    modelInfo,
                    turnPlan: { mode: "serial", blocks: [] },
                }),
                "ref-2": encodeTaskPayload({
                    kind: "provider_final",
                    text: "older answer",
                    turnPlan: { mode: "serial", blocks: [] },
                }),
            }),
        )

        const [attributed, unattributed] = await materializer.materialize(["ref-1", "ref-2"])

        expect(attributed).toMatchObject({ role: "assistant", modelInfo })
        expect(unattributed).toMatchObject({ role: "assistant" })
        expect(unattributed).not.toHaveProperty("modelInfo")
    })

    it("rejects a durable result whose replay marker is malformed", async () => {
        const malformed = JSON.stringify({ ...JSON.parse(serializeDurableToolResult(refused)), replay: { kind: "native" } })
        const materializer = new ProviderJournalMessageMaterializer(
            payloadStore({ "ref-1": encodeTaskPayload({ kind: "tool_result", blockId: "dline_tid_01", content: malformed }) }),
        )

        await expect(materializer.materialize(["ref-1"])).rejects.toThrow("InvalidDurableToolResult:dline_tid_01")
    })
})
