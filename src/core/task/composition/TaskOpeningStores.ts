import { openTaskMessages } from "../../storage/TaskMessages"
import { openTaskPersistence } from "../shell/TaskPersistenceAssembly"

/** Acquire the stores before transferring their complete lifetime to a session. */
export async function openTaskStores(taskId: string) {
    // Journal schema opening does not consume messages. Import starts only after
    // the session owns both groups, so their independent I/O can overlap safely.
    const [messages, persistence] = await Promise.allSettled([openTaskMessages(taskId), openTaskPersistence(taskId)])
    if (messages.status === "fulfilled" && persistence.status === "fulfilled") {
        return { ...messages.value, persistence: persistence.value }
    }

    const errors: unknown[] = []
    const releases: (() => Promise<void>)[] = []
    if (messages.status === "rejected") errors.push(messages.reason)
    else {
        releases.push(
            () => messages.value.uiMessage.close(),
            () => messages.value.apiConversation.close(),
        )
    }
    if (persistence.status === "rejected") errors.push(persistence.reason)
    else {
        releases.push(async () => {
            await persistence.value.close?.()
        })
    }
    // A failed sibling must not leave a late acquisition or a cleanup in flight.
    const cleanup = await Promise.allSettled(releases.map((release) => release()))
    for (const result of cleanup) {
        if (result.status === "rejected") errors.push(result.reason)
    }
    if (errors.length === 1) throw errors[0]
    throw new AggregateError(errors, "Task store acquisition failed")
}
