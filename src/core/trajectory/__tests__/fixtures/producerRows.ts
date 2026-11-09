import { sayFeedbackOnce } from "@core/task/tools/utils/UserFeedbackUtils"
import type { UiAsk, UiMessage, UiSay } from "@shared/ExtensionMessage"
import {
    ADMITTED_SUBMISSION,
    type SubmittedInputRow,
    submittedInputRow,
    submittedRowFields,
} from "@shared/input-semantics/submitted-input"

export const TIMESTAMP_PATTERNS = ["increasing", "equal", "decreasing"] as const
export type TimestampPattern = (typeof TIMESTAMP_PATTERNS)[number]

/** Change identity payloads without changing row kinds, source positions or the original fixture. */
export function withTimestampPattern(rows: readonly UiMessage[], pattern: TimestampPattern): UiMessage[] {
    return rows.map((row, index) => ({
        ...row,
        ts: pattern === "increasing" ? 1_000 + index : pattern === "equal" ? 1_000 : 1_000 + rows.length - index,
    }))
}

type FeedbackConfig = Parameters<typeof sayFeedbackOnce>[0]

/**
 * Producer-shaped committed rows, with each builder naming the source it models.
 *
 * User rows use the shared submitted-input builders. Tool replies execute the
 * real sayFeedbackOnce with producer-shaped callbacks, not an instantiated
 * Controller adapter. Keep these callbacks aligned with that owner's row shape;
 * a producer change is not automatically detected by this fixture.
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
     * The callbacks model ControllerTaskCallbacksOwner.say and sayUserReply:
     * neither adds interactionId or userInputKind. A structured presentation
     * exercises sayUserReply; an unstructured reply exercises say.
     */
    async toolReply(text: string, presentation?: Parameters<typeof sayFeedbackOnce>[5]): Promise<UiMessage> {
        const before = this.rows.length
        const callbacks = {
            say: async (type: UiSay, sayText?: string, images?: string[], files?: string[]) => {
                const ts = this.ts()
                this.push({ ts, type: "say", say: type, text: sayText, images, files, partial: undefined, commandTs: undefined })
                return ts
            },
            sayUserReply: async (row: SubmittedInputRow) => {
                this.push({ ts: this.ts(), type: "say", say: "user_feedback", ...submittedRowFields(row) })
            },
        } satisfies Pick<FeedbackConfig["callbacks"], "say" | "sayUserReply">
        const config = { callbacks, taskState: { ackedFeedback: undefined } } as unknown as FeedbackConfig
        await sayFeedbackOnce(config, "messageResponse", text, [], [], presentation)
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
