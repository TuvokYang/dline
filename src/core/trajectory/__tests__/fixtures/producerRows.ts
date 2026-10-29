import { sayFeedbackOnce } from "@core/task/tools/utils/UserFeedbackUtils"
import type { UiAsk, UiMessage, UiSay } from "@shared/ExtensionMessage"
import { ADMITTED_SUBMISSION, submittedInputRow, submittedRowFields } from "@shared/input-semantics/submitted-input"

/**
 * Chat rows in the exact shapes their production producers persist.
 *
 * Each builder names the producer it reproduces. User rows go through the same
 * shared row builders the producers call (`submittedInputRow`,
 * `submittedRowFields`), and tool-dialog replies go through the real
 * `sayFeedbackOnce`, so a producer that starts tagging or stops tagging its rows
 * changes these fixtures and fails the rule tests.
 */
export class ProducerRows {
    private nextTs = 1_000
    readonly rows: UiMessage[] = []

    private ts(): number {
        this.nextTs += 1
        return this.nextTs
    }

    private push(row: UiMessage): UiMessage {
        this.rows.push(row)
        return row
    }

    /** `TaskInputPresenter.prepare` for the first input of a task. */
    task(text: string): UiMessage {
        return this.push({
            ts: this.ts(),
            type: "say",
            say: "task",
            ...submittedRowFields(submittedInputRow([{ text }], ADMITTED_SUBMISSION)),
            conversationHistoryIndex: 0,
            interactionId: `entry-${this.nextTs}`,
        })
    }

    /** `TaskInputPresenter.prepare` for a later input submitted directly. */
    directInput(text: string): UiMessage {
        return this.push({
            ts: this.ts(),
            type: "say",
            say: "user_feedback",
            ...submittedRowFields(submittedInputRow([{ text }], ADMITTED_SUBMISSION)),
            conversationHistoryIndex: 1,
            interactionId: `entry-${this.nextTs}`,
        })
    }

    /** `RetainedInputPresenter.prepare`: one row for a queued batch. */
    queuedBatch(texts: readonly string[]): UiMessage {
        return this.push({
            ts: this.ts(),
            type: "say",
            say: "user_feedback",
            ...submittedRowFields(
                submittedInputRow(
                    texts.map((text) => ({ text })),
                    ADMITTED_SUBMISSION,
                ),
            ),
            interactionId: `delivery-${this.nextTs}`,
            userInputKind: "queued",
            queuedInputMode: "queued",
        })
    }

    /** A consumed reply that dispatch tags with the `reply:` interaction prefix. */
    consumedReply(text: string): UiMessage {
        return this.push({ ts: this.ts(), type: "say", say: "user_feedback", text, interactionId: `reply:${this.nextTs}` })
    }

    /**
     * A reply a tool handler shows through `sayFeedbackOnce`.
     *
     * The callbacks build rows the way `ControllerTaskCallbacksOwner.say` and
     * `sayUserReply` do (`ControllerTaskCallbacksOwner.ts:251–282,335–346`): no
     * `interactionId` and no `userInputKind`.
     */
    async toolReply(text: string): Promise<UiMessage> {
        const before = this.rows.length
        const callbacks = {
            say: async (type: UiSay, sayText?: string, images?: string[], files?: string[]) => {
                const ts = this.ts()
                this.push({ ts, type: "say", say: type, text: sayText, images, files, partial: undefined, commandTs: undefined })
                return ts
            },
            sayUserReply: async (row: Parameters<typeof submittedRowFields>[0]) => {
                this.push({ ts: this.ts(), type: "say", say: "user_feedback", ...submittedRowFields(row) })
            },
        }
        const config = { callbacks, taskState: { ackedFeedback: undefined } } as unknown as Parameters<typeof sayFeedbackOnce>[0]
        await sayFeedbackOnce(config, "messageResponse", text, [], [])
        const added = this.rows[before]
        if (!added) throw new Error("sayFeedbackOnce did not write a row")
        return added
    }

    ask(ask: UiAsk, text = ""): UiMessage {
        return this.push({ ts: this.ts(), type: "ask", ask, text })
    }

    say(say: UiSay, text = "", extra: Partial<UiMessage> = {}): UiMessage {
        return this.push({ ts: this.ts(), type: "say", say, text, ...extra })
    }

    apiRequest(): UiMessage {
        return this.say("api_req_started", JSON.stringify({ request: "…" }))
    }

    tool(tool: string): UiMessage {
        return this.say("tool", JSON.stringify({ tool, path: "src/a.ts" }))
    }

    checkpoint(hash = ""): UiMessage {
        return this.say("checkpoint_created", "", { lastCheckpointHash: hash ? [hash] : [] })
    }

    compactionCard(): UiMessage {
        return this.say("tool", JSON.stringify({ tool: "summarizeTask", content: "summary", compactionStatus: "completed" }))
    }

    /** A completion presented to the user: written as a say row, then rewritten at the same ts as an ask. */
    acceptedCompletion(text = "done"): UiMessage {
        return this.push({ ts: this.ts(), type: "ask", ask: "completion_result", text })
    }

    /** A completion the user refused; it closes with empty text and keeps the attempt open. */
    refusedCompletion(): UiMessage {
        return this.say("completion_result", "")
    }
}
