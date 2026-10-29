import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import type { MessageStateHandler } from "../../message-state"
import type { TaskPayloadStore } from "../../stores"
import { encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { UserInputEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import { TaskInputPresenter } from "../TaskInputPresenter"

function messageState() {
    const rows: UiMessage[] = []
    const messages = {
        get clineMessages() {
            return rows
        },
        conversationSize: () => 0,
        addToClineMessages: async (message: Partial<UiMessage>) => {
            rows.push(message as UiMessage)
        },
    } as unknown as MessageStateHandler
    return { messages, rows }
}

function payloadStore(envelope: Partial<UserInputEnvelope>): TaskPayloadStore {
    return {
        read: async () => encodeTaskPayload({ kind: "user_input", entryId: "entry-1", ...envelope }),
    } as unknown as TaskPayloadStore
}

/** A sequence whose ids are recognisable in assertions. */
function sequence(start = 1000): () => number {
    let last = start
    return () => ++last
}

/** Prepare and commit one submission, which is what an accepted submit does. */
async function present(presenter: TaskInputPresenter, entryId: string): Promise<void> {
    const prepared = await presenter.prepare({ entryId, payloadRef: `ref:${entryId}` })
    await prepared.commit()
}

describe("TaskInputPresenter", () => {
    it("opens the task with what the user typed, not the admitted projection", async () => {
        const state = messageState()
        const presenter = new TaskInputPresenter(
            payloadStore({ text: "/compact please", admittedText: "<compact-instructions> please" }),
            state.messages,
            sequence(),
        )

        await present(presenter, "entry-1")

        expect(state.rows).toEqual([
            expect.objectContaining({ type: "say", say: "task", text: "/compact please", interactionId: "entry-1" }),
        ])
    })

    it("withholds the row until the submission is accepted", async () => {
        const state = messageState()
        const presenter = new TaskInputPresenter(payloadStore({ text: "refused" }), state.messages, sequence())

        const prepared = await presenter.prepare({ entryId: "entry-1", payloadRef: "ref-1" })

        expect(state.rows).toEqual([])
        await prepared.commit()
        expect(state.rows).toHaveLength(1)
    })

    it("shows a later submission as user feedback", async () => {
        const state = messageState()
        const ids = sequence()
        const presenter = new TaskInputPresenter(payloadStore({ text: "first" }), state.messages, ids)
        await present(presenter, "entry-1")

        await present(new TaskInputPresenter(payloadStore({ text: "second" }), state.messages, ids), "entry-2")

        expect(state.rows.map((row) => row.say)).toEqual(["task", "user_feedback"])
    })

    it("keeps one row for a replayed entry", async () => {
        const state = messageState()
        const presenter = new TaskInputPresenter(payloadStore({ text: "hello" }), state.messages, sequence())

        await present(presenter, "entry-1")
        await present(presenter, "entry-1")

        expect(state.rows).toHaveLength(1)
    })

    it("carries the images and files the submission attached", async () => {
        const state = messageState()
        const presenter = new TaskInputPresenter(
            payloadStore({ text: "look", images: ["image-1"], files: ["file-1"] }),
            state.messages,
            sequence(),
        )

        await present(presenter, "entry-1")

        expect(state.rows[0]).toMatchObject({ images: ["image-1"], files: ["file-1"] })
    })

    it("does not render an empty internal continuation used only to resume execution", async () => {
        const state = messageState()
        const ids = sequence()
        const presenter = new TaskInputPresenter(
            payloadStore({ text: "", admittedText: "", semanticInput: { schemaVersion: 1, nodes: [], resources: [] } as never }),
            state.messages,
            ids,
        )

        await present(presenter, "entry-1")

        expect(state.rows).toEqual([])
        expect(ids()).toBe(1001)
    })

    // The raw text of a structured input addresses each resource by its stable
    // id; the row is what a person reads, so it names the resource instead, and
    // an input holding nothing but a resource still gets its row.
    it("shows a structured input's resources by name where the user placed them", async () => {
        const state = messageState()
        const resourceId = "00000000-0000-4000-8000-000000000005"
        const semanticInput = {
            schemaVersion: 1,
            parserVersion: "1.0.0",
            catalogRevision: "1",
            documentId: "doc-1",
            rawText: `look [image:${resourceId}]`,
            nodes: [
                { kind: "text", text: "look " },
                { kind: "image", entityId: "img-1", resourceId, displayName: "shot.png" },
            ],
            resources: [],
        }
        const presenter = new TaskInputPresenter(
            payloadStore({ text: semanticInput.rawText, semanticInput: semanticInput as never }),
            state.messages,
            sequence(),
        )

        await present(presenter, "entry-1")

        expect(state.rows).toEqual([expect.objectContaining({ say: "task", text: "look [shot.png]" })])
        expect(JSON.stringify(state.rows)).not.toContain(resourceId)
    })

    // History renders a row from these facts, never by lexing its text against
    // a later catalog, so a literal after the barrier stays literal for good.
    it("records which commands the admitted submission ran", async () => {
        const state = messageState()
        const command = (entityId: string, sourceText: string, compositionMode: string) => ({
            kind: "slash_command",
            entityId,
            commandId: `command.${entityId}`,
            sourceText,
            canonicalName: sourceText.slice(1),
            namespace: "cmd",
            compositionMode,
            state: "recognized",
        })
        const semanticInput = {
            schemaVersion: 1,
            parserVersion: "1.0.0",
            catalogRevision: "1",
            documentId: "doc-2",
            rawText: "/compact then /explain-changes",
            nodes: [
                command("compact", "/compact", "lifecycle_barrier"),
                { kind: "text", text: " then " },
                command("explain", "/explain-changes", "composable"),
            ],
            resources: [],
        }
        const presenter = new TaskInputPresenter(
            payloadStore({ text: semanticInput.rawText, semanticInput: semanticInput as never }),
            state.messages,
            sequence(),
        )

        await present(presenter, "entry-1")

        expect(state.rows).toEqual([
            expect.objectContaining({
                say: "task",
                submittedInputs: [
                    {
                        segments: [
                            { text: "/compact", role: "command", active: true },
                            { text: " then ", role: "text", active: false },
                            { text: "/explain-changes", role: "command", active: false },
                        ],
                    },
                ],
            }),
        ])
    })

    it("records no facts for a legacy input, so its row reads as typed", async () => {
        const state = messageState()
        const presenter = new TaskInputPresenter(payloadStore({ text: "/compact" }), state.messages, sequence())

        await present(presenter, "entry-1")

        expect(state.rows[0]).not.toHaveProperty("submittedInputs")
    })

    it("still renders an attachment-only submission", async () => {
        const state = messageState()
        const presenter = new TaskInputPresenter(payloadStore({ text: "", files: ["context.txt"] }), state.messages, sequence())

        await present(presenter, "entry-1")

        expect(state.rows).toEqual([expect.objectContaining({ say: "task", text: "", files: ["context.txt"] })])
    })
})
