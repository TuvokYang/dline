import { ApiConversation } from "./ApiConversation"
import { UIMessage } from "./UIMessage"

/** Open both message stores before transferring their lifetime to a session. */
export async function openTaskMessages(taskId: string): Promise<{ uiMessage: UIMessage; apiConversation: ApiConversation }> {
    // The chat database and legacy API JSONL have independent migrations and locks.
    // Wait for both even on failure so no late acquisition escapes cleanup.
    const [ui, api] = await Promise.allSettled([UIMessage.open(taskId), ApiConversation.open(taskId)])
    if (ui.status === "fulfilled" && api.status === "fulfilled") {
        return { uiMessage: ui.value, apiConversation: api.value }
    }
    const errors: unknown[] = []
    const acquired: { close(): Promise<void> }[] = []
    for (const result of [ui, api]) {
        if (result.status === "rejected") errors.push(result.reason)
        else acquired.push(result.value)
    }
    const cleanup = await Promise.allSettled(acquired.map((store) => store.close()))
    for (const result of cleanup) {
        if (result.status === "rejected") errors.push(result.reason)
    }
    if (errors.length === 1) throw errors[0]
    throw new AggregateError(errors, "Task message acquisition failed")
}
