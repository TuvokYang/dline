import { registerPartialMessageCallback, subscribeToPartialMessage } from "@core/controller/ui/subscribeToPartialMessage"
import type { MessageStateHandler } from "@core/task/message-state"
import { createPresentationIdSequence } from "@core/task/session/PresentationIdSequence"
import type { UiMessage } from "@shared/ExtensionMessage"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ControllerTaskCallbacksOwner } from "../ControllerTaskCallbacksOwner"

/**
 * A command_output row is merged into its command row by commandTs alone, so the
 * host say adapter has to carry that key all the way into the persisted message.
 * Losing it renders the command with no output at all.
 */
function messageStore(): { handler: MessageStateHandler; written: UiMessage[] } {
    const written: UiMessage[] = []
    const handler = {
        get clineMessages() {
            return written
        },
        addToClineMessages: async (message: UiMessage) => {
            written.push(message)
        },
        upsertClineMessageInMemory: async (message: UiMessage) => {
            written.push(message)
            return message
        },
        finalizeClineMessage: async (message: UiMessage) => {
            written.push(message)
            return message
        },
    } as unknown as MessageStateHandler
    return { handler, written }
}

const OPENING = { taskId: "task-1", taskInstanceId: "open-1" }

/** A Controller that currently shows the opening these callbacks serve. */
function showingOpening(opening: { taskId: string; taskInstanceId: string } = OPENING): object {
    return { currentOpening: () => opening }
}

function owner(
    messages: MessageStateHandler,
    controller: object = showingOpening(),
    interactions: { open: ReturnType<typeof vi.fn> } = { open: vi.fn() },
): ControllerTaskCallbacksOwner {
    return new ControllerTaskCallbacksOwner({
        controller: controller as never,
        taskId: "task-1",
        taskInstanceId: "open-1",
        stateManager: {
            getGlobalSettingsKey: () => ({ enabled: false, remindClineInterval: 6 }),
            getGlobalStateKey: () => undefined,
        } as never,
        messages,
        interactions: interactions as never,
        nextPresentationId: createPresentationIdSequence(Date.now, () => messages.clineMessages.at(-1)?.ts),
        api: {} as never,
        toolState: {} as never,
        createBrowser: () => ({}) as never,
    })
}

describe("ControllerTaskCallbacksOwner say", () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    // A consumed `/compact` reply is shown by the dispatch path, and the dialog's
    // own echo follows within the same millisecond. A clock-stamped echo took the
    // reply's id and replaced the user's row with an empty one.
    it("gives a new row its own id even when another row holds the current millisecond", async () => {
        const { handler, written } = messageStore()
        const now = 1_791_348_446_133
        vi.spyOn(Date, "now").mockReturnValue(now)
        const reply: UiMessage = {
            ts: now,
            type: "say",
            say: "user_feedback",
            text: "/compact keep the API notes",
            interactionId: "reply:dialog-1",
        }
        const callbacks = owner(handler).callbacks
        written.push(reply)

        const ts = await callbacks.say("user_feedback", "")

        expect(ts).toBeGreaterThan(now)
        expect(written).toEqual([reply, expect.objectContaining({ ts, say: "user_feedback", text: "" })])
    })

    it("writes a reply row with the facts the user submitted and no resolved content", async () => {
        const { handler, written } = messageStore()
        const facts = { segments: [{ text: "[shot.png]", role: "resource" as const, active: true }] }

        await owner(handler).callbacks.sayUserReply({ text: "[shot.png]", images: [], files: [], submittedInputs: [facts] })

        expect(written).toEqual([
            expect.objectContaining({
                type: "say",
                say: "user_feedback",
                text: "[shot.png]",
                images: [],
                files: [],
                submittedInputs: [facts],
            }),
        ])
    })

    it("carries commandTs onto the persisted command_output row", async () => {
        const { handler, written } = messageStore()

        await owner(handler).callbacks.say("command_output", "line-1", undefined, undefined, false, undefined, 4242)

        expect(written).toHaveLength(1)
        expect(written[0]).toMatchObject({ say: "command_output", text: "line-1", commandTs: 4242 })
    })

    it("leaves commandTs unset for rows that do not belong to a command", async () => {
        const { handler, written } = messageStore()

        await owner(handler).callbacks.say("text", "hello")

        expect(written).toHaveLength(1)
        expect(written[0].commandTs).toBeUndefined()
    })

    it("finalizes a command row as pending so its execution can mark it running", async () => {
        const { handler, written } = messageStore()
        written.push({ ts: 77, type: "say", say: "command", text: "npm test", partial: true })

        await owner(handler).callbacks.say("command", "npm test", undefined, undefined, false, 77)

        expect(written.at(-1)).toMatchObject({ ts: 77, say: "command", partial: false, commandStatus: "pending" })
    })

    // The directory is a field, not a suffix of the command line. Losing it here
    // is what made every new command look like it ran inside the workspace.
    it("states a command row's directory as a field when the caller knows it", async () => {
        const { handler, written } = messageStore()

        await owner(handler).callbacks.say("command", "npm test", undefined, undefined, false, 55, undefined, {
            commandLine: "npm test",
            workingDirectory: "/elsewhere",
        })

        expect(written.at(-1)).toMatchObject({
            ts: 55,
            text: "npm test",
            command: "npm test",
            commandWorkingDirectory: "/elsewhere",
            commandOutput: "",
            commandAsksApproval: false,
        })
    })

    // A caller that has no directory still gets a row whose text is the command
    // line alone, so a reader never has to split it to find one.
    it("writes a command row without a directory when the caller states none", async () => {
        const { handler, written } = messageStore()

        await owner(handler).callbacks.say("command", "npm test", undefined, undefined, false, 56)

        expect(written.at(-1)).toMatchObject({ ts: 56, text: "npm test", command: "npm test" })
        expect(written.at(-1)?.commandWorkingDirectory).toBeUndefined()
    })

    it("keeps the status a command row already reached when it is finalized again", async () => {
        const { handler, written } = messageStore()
        written.push({ ts: 78, type: "say", say: "command", text: "npm test", commandStatus: "running" })

        await owner(handler).callbacks.say("command", "npm test", undefined, undefined, false, 78)

        expect(written.at(-1)).toMatchObject({ ts: 78, commandStatus: "running" })
    })

    it("publishes a finalized row after replacing its in-memory partial", async () => {
        const { handler, written } = messageStore()
        written.push({ ts: 99, type: "ask", ask: "tool", text: "awaiting", partial: true })
        const delivered: Array<{ ts: number; text: string; partial: boolean }> = []
        const unsubscribe = registerPartialMessageCallback((message) => {
            delivered.push({ ts: Number(message.ts), text: message.text, partial: message.partial })
        })

        try {
            await owner(handler).callbacks.say("tool", "rejected", undefined, undefined, false, 99)
        } finally {
            unsubscribe()
        }

        expect(written).toContainEqual(expect.objectContaining({ ts: 99, type: "say", text: "rejected", partial: false }))
        expect(delivered).toEqual([{ ts: 99, text: "rejected", partial: false }])
    })

    // The view refetches its window by index, so a complete row inserted behind
    // one it already received was only ever drawn if a later refetch reached it.
    it("publishes a new complete row once it was added", async () => {
        const { handler, written } = messageStore()
        const delivered: Array<{ ts: number; text: string; partial: boolean }> = []
        const unsubscribe = registerPartialMessageCallback((message) => {
            delivered.push({ ts: Number(message.ts), text: message.text, partial: message.partial })
        })

        let ts: number | undefined
        try {
            ts = await owner(handler).callbacks.say("tool", "hosted search failed", undefined, undefined, false)
        } finally {
            unsubscribe()
        }

        expect(written).toEqual([expect.objectContaining({ ts, text: "hosted search failed", partial: false })])
        expect(delivered).toEqual([{ ts, text: "hosted search failed", partial: false }])
    })

    // An approved write says the user's note before it saves the file. Waiting
    // for the view to take that row held the save back by seconds.
    it("returns from a new complete row without waiting for the view to take it", async () => {
        const { handler, written } = messageStore()
        const controller = showingOpening()
        let offered = 0
        await subscribeToPartialMessage(controller as never, {} as never, () => {
            offered++
            return new Promise<void>(() => {})
        })

        const said = owner(handler, controller).callbacks.say("user_feedback", "E2E_WRITE_APPROVAL_NOTE")
        const outcome = await Promise.race([
            said.then(() => "returned"),
            new Promise((resolve) => setTimeout(resolve, 50, "held")),
        ])

        expect(outcome).toBe("returned")
        expect(offered).toBe(1)
        expect(written).toEqual([expect.objectContaining({ say: "user_feedback", text: "E2E_WRITE_APPROVAL_NOTE" })])
    })

    it("publishes a partial row after updating the in-memory message", async () => {
        const { handler, written } = messageStore()
        const delivered: Array<{ ts: number; text: string; partial: boolean }> = []
        const unsubscribe = registerPartialMessageCallback((message) => {
            delivered.push({ ts: Number(message.ts), text: message.text, partial: message.partial })
        })

        try {
            await owner(handler).callbacks.say("tool", "preview", undefined, undefined, true, 99)
        } finally {
            unsubscribe()
        }

        expect(written).toContainEqual(expect.objectContaining({ ts: 99, text: "preview", partial: true }))
        expect(delivered).toEqual([{ ts: 99, text: "preview", partial: true }])
    })

    // The store refuses a partial over a row that already settled and answers
    // with the settled row. Publishing the caller's own partial copy would put a
    // partial frame of that row on the stream after its final one.
    it("publishes the stored row when the store refuses a late partial", async () => {
        const settled: UiMessage = { ts: 99, type: "say", say: "tool", text: "final", partial: false }
        const handler = {
            get clineMessages() {
                return [settled]
            },
            upsertClineMessageInMemory: async () => settled,
        } as unknown as MessageStateHandler
        const delivered: Array<{ ts: number; text: string; partial: boolean }> = []
        const unsubscribe = registerPartialMessageCallback((message) => {
            delivered.push({ ts: Number(message.ts), text: message.text, partial: message.partial })
        })

        try {
            await owner(handler).callbacks.say("tool", "late preview", undefined, undefined, true, 99)
        } finally {
            unsubscribe()
        }

        expect(delivered).toEqual([{ ts: 99, text: "final", partial: false }])
    })

    it("presents a partial ask without opening a competing host interaction", async () => {
        const { handler, written } = messageStore()
        const interactions = { open: vi.fn() }
        const callbacks = owner(handler, showingOpening(), interactions).callbacks

        await expect(callbacks.ask("qna_respond", '{"response":"preview"}', true, { existingTs: 99 })).rejects.toThrow(
            "Current ask promise was ignored",
        )

        expect(interactions.open).not.toHaveBeenCalled()
        expect(written).toContainEqual(expect.objectContaining({ ts: 99, type: "ask", ask: "qna_respond", partial: true }))
    })

    // A rejected call never ran, so its streamed preview must not stay partial:
    // the chat draws a partial command as still working, and folding therefore
    // never counts it as the failure the model was told about.
    it("settles the streamed command preview as failed when a required parameter is missing", async () => {
        const { handler, written } = messageStore()
        written.push({ ts: 4242, type: "say", say: "command", text: "npm test", partial: true })
        const delivered: Array<{ ts: number; partial: boolean; commandStatus?: string }> = []
        const unsubscribe = registerPartialMessageCallback((message) => {
            delivered.push({ ts: Number(message.ts), partial: message.partial, commandStatus: message.commandStatus })
        })

        try {
            await owner(handler).callbacks.sayAndCreateMissingParamError(
                "execute_command" as never,
                "requires_approval",
                undefined,
                4242,
            )
        } finally {
            unsubscribe()
        }

        expect(written).toContainEqual(
            expect.objectContaining({ ts: 4242, say: "command", partial: false, commandStatus: "failed" }),
        )
        expect(delivered).toEqual([{ ts: 4242, partial: false, commandStatus: "failed" }])
    })

    it("leaves a row that already ended untouched when a required parameter is missing", async () => {
        const { handler, written } = messageStore()
        written.push({ ts: 4243, type: "say", say: "command", text: "npm test", partial: false, commandStatus: "completed" })

        await owner(handler).callbacks.sayAndCreateMissingParamError(
            "execute_command" as never,
            "requires_approval",
            undefined,
            4243,
        )

        expect(written).toEqual([expect.objectContaining({ ts: 4243, commandStatus: "completed" })])
    })

    // A late row from a replaced opening must not land in the view that now shows another one.
    it("keeps the row but does not publish it once the view shows a different opening", async () => {
        const { handler, written } = messageStore()
        const delivered: number[] = []
        const unsubscribe = registerPartialMessageCallback((message) => {
            delivered.push(Number(message.ts))
        })
        const replaced = showingOpening({ taskId: "task-1", taskInstanceId: "open-2" })

        try {
            await owner(handler, replaced).callbacks.say("tool", "late preview", undefined, undefined, true, 99)
        } finally {
            unsubscribe()
        }

        expect(written).toContainEqual(expect.objectContaining({ ts: 99, text: "late preview", partial: true }))
        expect(delivered).toEqual([])
    })
})
