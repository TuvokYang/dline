import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { Controller } from "../index"

/**
 * `materializeMessageWindow` is the only place state projection reads the visible
 * message sequence. It must keep the window length and the durable message count as
 * separate quantities: a history display holds one page while its total spans the
 * whole conversation, and `firstItemIndex` is the gap between them.
 *
 * The controller is not constructed here; only the method under test reads the three
 * collaborators it depends on, so a structural subject with those three surfaces is
 * the smallest boundary that can still catch a regression.
 */
type WindowOwner = Pick<Controller, "materializeMessageWindow">

/** The three collaborators the window read reaches through `this`. */
interface WindowSubject {
    getCurrentTaskMessages(): readonly UiMessage[]
    task?: { owners: { messages: { clineMessages: UiMessage[] } } }
    historyDisplaySession?: {
        getMessages(): readonly UiMessage[]
        getMessageCount(): number
        getTaskTitleMessage(): UiMessage | undefined
        historyItem: { checkpointManagerErrorMessage?: string }
    }
}

const materializeMessageWindow = (subject: WindowSubject) =>
    (Controller.prototype as unknown as WindowOwner).materializeMessageWindow.call(subject)

function messages(count: number): UiMessage[] {
    return Array.from({ length: count }, (_, index) => ({
        ts: index,
        type: "say",
        say: "text",
        text: `message ${index}`,
    })) as UiMessage[]
}

describe("Controller.materializeMessageWindow", () => {
    it("derives the page offset from the durable total, not from the window length", () => {
        // A history display retains the newest 200 of 260 durable messages.
        const window = messages(200)
        const subject: WindowSubject = {
            getCurrentTaskMessages: () => window,
            historyDisplaySession: {
                getMessages: () => window,
                getMessageCount: () => 260,
                getTaskTitleMessage: () => undefined,
                historyItem: {},
            },
        }

        const result = materializeMessageWindow(subject)

        expect(result.messages).toHaveLength(200)
        expect(result.totalCount).toBe(260)
        expect(result.firstItemIndex).toBe(60)
    })

    it("treats a runtime task window as the whole conversation", () => {
        const window = messages(12)
        const subject: WindowSubject = {
            getCurrentTaskMessages: () => window,
            task: { owners: { messages: { clineMessages: window } } },
        }

        const result = materializeMessageWindow(subject)

        expect(result.totalCount).toBe(12)
        expect(result.firstItemIndex).toBe(0)
    })

    it("prefers the session title so a bounded window does not lose it", () => {
        const title = { ts: 0, type: "say", say: "task", text: "session title" } as UiMessage
        // The page itself carries no task message: only the session can name it.
        const window = messages(3)
        const subject: WindowSubject = {
            getCurrentTaskMessages: () => window,
            historyDisplaySession: {
                getMessages: () => window,
                getMessageCount: () => 3,
                getTaskTitleMessage: () => title,
                historyItem: {},
            },
        }

        expect(materializeMessageWindow(subject).titleMessage).toBe(title)
    })

    it("returns a new array so a caller cannot mutate the session window", () => {
        const window = messages(2)
        const subject: WindowSubject = {
            getCurrentTaskMessages: () => window,
            historyDisplaySession: {
                getMessages: () => window,
                getMessageCount: () => 2,
                getTaskTitleMessage: () => undefined,
                historyItem: {},
            },
        }

        const result = materializeMessageWindow(subject)
        result.messages.pop()

        expect(window).toHaveLength(2)
    })

    it("keeps a synchronous raw window whose source indexes need not equal its page coordinates", () => {
        const title: UiMessage = { ts: 100, type: "say", say: "task", messageIndex: 0 }
        const window: UiMessage[] = [
            title,
            { ts: 200, type: "say", say: "tool", messageIndex: 2 },
            { ts: 250, type: "say", say: "checkpoint_created", partial: true },
            { ts: 300, type: "say", say: "user_feedback", messageIndex: 1 },
        ]
        const subject: WindowSubject = {
            getCurrentTaskMessages: () => window,
            task: { owners: { messages: { clineMessages: window } } },
        }
        const result = materializeMessageWindow(subject)
        expect(result).not.toHaveProperty("then")
        expect(result.firstItemIndex).toBe(0)
        expect(result.totalCount).toBe(4)
        expect(result.messages.map((message) => message.messageIndex)).toEqual([0, 2, undefined, 1])
        expect(result.messages[3]).toBe(window[3])
        expect(result.titleMessage).toBe(title)
    })

    it("keeps canonical history title0 separate from a body window beginning at source60", () => {
        const title: UiMessage = { ts: 1, type: "say", say: "task", messageIndex: 0 }
        const window: UiMessage[] = [
            { ts: 61, type: "say", say: "text", messageIndex: 60 },
            { ts: 62, type: "say", say: "text", messageIndex: 61 },
        ]
        const subject: WindowSubject = {
            getCurrentTaskMessages: () => window,
            historyDisplaySession: {
                getMessages: () => window,
                getMessageCount: () => 62,
                getTaskTitleMessage: () => title,
                historyItem: {},
            },
        }
        const result = materializeMessageWindow(subject)
        expect(result.firstItemIndex).toBe(60)
        expect(result.totalCount).toBe(62)
        expect(result.titleMessage?.messageIndex).toBe(0)
        expect(result.messages.map((message) => message.messageIndex)).toEqual([60, 61])
    })
})
