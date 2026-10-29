import type { UiAskNewTask } from "./ExtensionMessage"

/** Encodes the `new_task` approval presentation shared by the extension and the Webview. */
export function encodeNewTaskAsk(ask: UiAskNewTask): string {
    return JSON.stringify({ task: ask.task, context: ask.context })
}

/**
 * Reads a `new_task` approval presentation.
 *
 * Only text carrying both halves is the current shape; the encoder always
 * writes both, even while one is still streaming. Rows written before the tool
 * took a `task` hold the context as plain text. That text was also what the
 * successor started from, so it reads back as the task with no separate context.
 */
export function parseNewTaskAsk(text: string | undefined): UiAskNewTask {
    const raw = text ?? ""
    const encoded = readEncodedAsk(raw)
    return encoded ?? { task: raw, context: "" }
}

function readEncodedAsk(raw: string): UiAskNewTask | undefined {
    if (!raw.trimStart().startsWith("{")) return undefined
    try {
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== "object") return undefined
        const { task, context } = parsed as Partial<Record<keyof UiAskNewTask, unknown>>
        if (typeof task !== "string" || typeof context !== "string") return undefined
        return { task, context }
    } catch {
        return undefined
    }
}
