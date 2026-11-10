import type { UiMessage } from "@shared/ExtensionMessage"
import { Logger } from "@shared/services/Logger"
import { describe, expect, it, vi } from "vitest"
import { JournalConversationView } from "../../executors/provider/service/JournalConversationView"
import { ProviderJournalMessageMaterializer } from "../../executors/provider/service/ProviderJournalMessageMaterializer"
import { createInitialTaskState, type TaskEvent } from "../../kernel"
import { MessageStateHandler } from "../../message-state"
import type { RuntimeFacade } from "../../runtime"
import { TaskShell } from "../../shell/TaskShell"
import type { TaskPayloadStore } from "../../stores"
import { InMemoryConversationJournal, InMemoryTaskPayloadStore } from "../../stores/InMemoryRuntimeStores"
import { JournalConversationRewind } from "../../stores/JournalConversationRewind"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { UserInputEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import { TaskInputPresenter } from "../TaskInputPresenter"

function messageState() {
    const rows: UiMessage[] = []
    const visibleRows: UiMessage[] = []
    const publishState = async () => {
        visibleRows.splice(0, visibleRows.length, ...rows.map((row) => ({ ...row })))
    }
    const messages = {
        get clineMessages() {
            return rows
        },
        captureConversationPosition: () => ({ conversationHistoryIndex: -1 }),
        addToClineMessages: async (message: Partial<UiMessage>) => {
            rows.push(message as UiMessage)
        },
    } as unknown as MessageStateHandler
    return { messages, rows, visibleRows, publishState }
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

function submissionRuntime(taskId: string, accepts: boolean) {
    const state = createInitialTaskState(taskId)
    const events: TaskEvent[] = []
    const runtime: RuntimeFacade = {
        getState: () => state,
        submit: async (event) => {
            events.push(event)
            return accepts
                ? { kind: "accepted", state, commands: [], receipt: { revision: 0, durable: Promise.resolve() } }
                : {
                      kind: "rejected",
                      reason: "read_only",
                      state,
                      diagnostic: { code: "read_only", message: "Test runtime is read-only" },
                  }
        },
        projectTransient: () => {},
        waitForDurable: async () => {},
        waitForDomainCompletion: async () => {},
        waitForQuiescence: async () => {},
        grantWriteOwnership: () => {},
        isWritable: () => accepts,
        releaseRestoredCommands: () => {},
    }
    return { runtime, events }
}

/** Prepare and commit one submission, which is what an accepted submit does. */
async function present(presenter: TaskInputPresenter, entryId: string): Promise<void> {
    const prepared = await presenter.prepare({ entryId, payloadRef: `ref:${entryId}` })
    await prepared.commit()
}

describe("TaskInputPresenter", () => {
    it("publishes accepted input without waiting for provider output", async () => {
        const state = messageState()
        const ids = sequence()
        const presenter = new TaskInputPresenter(payloadStore({ text: "first input" }), state.messages, ids, state.publishState)
        const prepared = await presenter.prepare({ entryId: "entry-1", payloadRef: "ref-1" })

        expect(state.visibleRows).toEqual([])
        await prepared.commit()
        expect(state.visibleRows).toEqual([
            expect.objectContaining({ say: "task", text: "first input", interactionId: "entry-1" }),
        ])

        await present(
            new TaskInputPresenter(payloadStore({ text: "second input" }), state.messages, ids, state.publishState),
            "entry-2",
        )
        expect(state.visibleRows.map(({ say, text }) => ({ say, text }))).toEqual([
            { say: "task", text: "first input" },
            { say: "user_feedback", text: "second input" },
        ])
    })

    it("publishes only after the accepted row write finishes", async () => {
        const state = messageState()
        let releaseWrite!: () => void
        const writing = new Promise<void>((resolve) => {
            releaseWrite = resolve
        })
        const add = state.messages.addToClineMessages.bind(state.messages)
        state.messages.addToClineMessages = async (row) => {
            await writing
            await add(row)
        }
        const presenter = new TaskInputPresenter(
            payloadStore({ text: "delayed input" }),
            state.messages,
            sequence(),
            state.publishState,
        )
        const prepared = await presenter.prepare({ entryId: "entry-1", payloadRef: "ref-1" })
        const committed = prepared.commit()
        expect(state.visibleRows).toEqual([])
        releaseWrite()
        await committed
        expect(state.visibleRows).toEqual([expect.objectContaining({ say: "task", text: "delayed input" })])
    })

    it("does not publish a row whose write failed", async () => {
        const state = messageState()
        state.messages.addToClineMessages = async () => {
            throw new Error("RowWriteFailed")
        }
        const presenter = new TaskInputPresenter(
            payloadStore({ text: "unwritten" }),
            state.messages,
            sequence(),
            state.publishState,
        )

        await expect(present(presenter, "entry-1")).rejects.toThrow("RowWriteFailed")
        expect(state.rows).toEqual([])
        expect(state.visibleRows).toEqual([])
    })

    it("leaves a rejected runtime input unpublished", async () => {
        const state = messageState()
        const { runtime, events } = submissionRuntime("rejected-input", false)
        const presenter = new TaskInputPresenter(
            payloadStore({ text: "refused" }),
            state.messages,
            sequence(),
            state.publishState,
        )
        const shell = new TaskShell(runtime, { rearm: async () => {}, forceClose: () => {} }, presenter)

        expect(await shell.submitInput({ entryId: "entry-1", payloadRef: "ref-1" })).toMatchObject({ kind: "rejected" })
        expect(events.map((event) => event.type)).toEqual(["user.submit"])
        expect(state.rows).toEqual([])
        expect(state.visibleRows).toEqual([])
    })

    it("does not reject or resubmit accepted input when its publication fails", async () => {
        const state = messageState()
        const { runtime, events } = submissionRuntime("accepted-input", true)
        const failure = new Error("PublicationFailed")
        let report!: () => void
        const reported = new Promise<void>((resolve) => {
            report = resolve
        })
        const log = vi.spyOn(Logger, "error").mockImplementation(() => report())
        try {
            const presenter = new TaskInputPresenter(payloadStore({ text: "accepted" }), state.messages, sequence(), async () => {
                throw failure
            })
            const shell = new TaskShell(runtime, { rearm: async () => {}, forceClose: () => {} }, presenter)
            expect(await shell.submitInput({ entryId: "entry-1", payloadRef: "ref-1" })).toMatchObject({ kind: "accepted" })
            await reported
            await present(presenter, "entry-1")

            expect(events.map((event) => event.type)).toEqual(["user.submit"])
            expect(state.rows).toEqual([expect.objectContaining({ say: "task", text: "accepted", interactionId: "entry-1" })])
            expect(log).toHaveBeenCalledExactlyOnceWith(expect.any(String), failure)
        } finally {
            log.mockRestore()
        }
    })

    it("opens the task with what the user typed, not the admitted projection", async () => {
        const state = messageState()
        const presenter = new TaskInputPresenter(
            payloadStore({ text: "/compact please", admittedText: "<compact-instructions> please" }),
            state.messages,
            sequence(),
            state.publishState,
        )

        await present(presenter, "entry-1")

        expect(state.rows).toEqual([
            expect.objectContaining({ type: "say", say: "task", text: "/compact please", interactionId: "entry-1" }),
        ])
    })

    it("withholds the row until the submission is accepted", async () => {
        const state = messageState()
        const presenter = new TaskInputPresenter(
            payloadStore({ text: "refused" }),
            state.messages,
            sequence(),
            state.publishState,
        )

        const prepared = await presenter.prepare({ entryId: "entry-1", payloadRef: "ref-1" })

        expect(state.rows).toEqual([])
        await prepared.commit()
        expect(state.rows).toHaveLength(1)
    })

    it.each([false, true])("freezes the journal position before accepted work with keepInput=%s", async (keepInput) => {
        const journal = new InMemoryConversationJournal()
        const payloads = new InMemoryTaskPayloadStore()
        const conversation = new JournalConversationView(journal, new ProviderJournalMessageMaterializer(payloads))
        const appendInput = async (entryId: string, text: string) => {
            const payloadRef = await payloads.put(encodeTaskPayload({ kind: "user_input", entryId, text }))
            await journal.append({ operationId: entryId, payloadRef, source: "intake" })
        }
        await appendInput("initial", "initial input")
        await conversation.count()
        const messages = new MessageStateHandler({
            taskId: "prepared-input-position",
            ulid: "prepared-input-position",
            updateTaskHistory: async () => [],
            conversation,
        })
        const published: UiMessage[] = []
        messages.on("clineMessagesChanged", (change) => {
            if (change.message) published.push(change.message)
        })
        const inputRef = await payloads.put(encodeTaskPayload({ kind: "user_input", entryId: "old-input", text: "old input" }))
        const presenter = new TaskInputPresenter(payloads, messages, sequence(), async () => {})
        const prepared = await presenter.prepare({ entryId: "old-input", payloadRef: inputRef })

        // Acceptance journals this input before TaskShell commits its UI row.
        // Other accepted work can move the journal farther while commit is pending.
        await journal.append({ operationId: "old-input", payloadRef: inputRef, source: "intake" })
        await appendInput("later-input", "later input")
        await conversation.count()
        await prepared.commit()

        expect(published).toHaveLength(1)
        const row = published[0]
        if (row.conversationHistoryIndex === undefined) throw new Error("Missing prepared conversation index")
        const rewind = new JournalConversationRewind(journal)
        const boundary = await rewind.resolveRowBoundary(
            {
                keep: row.conversationHistoryIndex + 1,
                seq: row.conversationJournalSeq,
                keepInput,
            },
            { seq: 1 },
        )
        await rewind.restoreTo({ operationId: "edit-prepared-row", target: boundary })
        const retained = await Promise.all(
            (await journal.project()).visibleMessages.map(async (entry) => {
                if (!entry.payloadRef) throw new Error("Missing fixture input payload")
                return decodeTaskPayload<UserInputEnvelope>(await payloads.read(entry.payloadRef)).text
            }),
        )

        expect(retained).toEqual(keepInput ? ["initial input", "old input"] : ["initial input"])
        expect(boundary).toEqual({ seq: keepInput ? 2 : 1 })
        expect(row).toMatchObject({ conversationHistoryIndex: 0, conversationJournalSeq: 1 })
    })

    it("shows a later submission as user feedback", async () => {
        const state = messageState()
        const ids = sequence()
        const presenter = new TaskInputPresenter(payloadStore({ text: "first" }), state.messages, ids, state.publishState)
        await present(presenter, "entry-1")

        await present(
            new TaskInputPresenter(payloadStore({ text: "second" }), state.messages, ids, state.publishState),
            "entry-2",
        )

        expect(state.rows.map((row) => row.say)).toEqual(["task", "user_feedback"])
    })

    it("keeps one row for a replayed entry", async () => {
        const state = messageState()
        const presenter = new TaskInputPresenter(payloadStore({ text: "hello" }), state.messages, sequence(), state.publishState)

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
            state.publishState,
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
            state.publishState,
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
            state.publishState,
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
            state.publishState,
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
        const presenter = new TaskInputPresenter(
            payloadStore({ text: "/compact" }),
            state.messages,
            sequence(),
            state.publishState,
        )

        await present(presenter, "entry-1")

        expect(state.rows[0]).not.toHaveProperty("submittedInputs")
    })

    it("still renders an attachment-only submission", async () => {
        const state = messageState()
        const presenter = new TaskInputPresenter(
            payloadStore({ text: "", files: ["context.txt"] }),
            state.messages,
            sequence(),
            state.publishState,
        )

        await present(presenter, "entry-1")

        expect(state.rows).toEqual([expect.objectContaining({ say: "task", text: "", files: ["context.txt"] })])
    })
})
