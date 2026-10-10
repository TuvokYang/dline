import { exceedsInlineTextBudget } from "@shared/input-semantics/resource-policy"
import { CreateInputTextResourceRequest } from "@shared/proto/dline/task"
import { TaskServiceClient } from "@/services/grpc-client"

/** A pasted block the active task now owns as a file. */
export interface PastedTextResource {
    readonly absolutePath: string
    readonly displayName: string
    readonly lineCount: number
}

/**
 * Hand an oversized paste to the extension host so it becomes a task-owned file.
 *
 * A long log or source dump buries the composer and is repeated in every later
 * provider request, so beyond the shared inline budget the text is stored once
 * and referenced as a file. The composer keeps the original text whenever the
 * host declines, which happens when no task owns the input yet: silently
 * dropping what the user pasted would be worse than an oversized composer.
 */
export async function storeOversizedPaste(text: string): Promise<PastedTextResource | undefined> {
    if (!exceedsInlineTextBudget(text)) return undefined

    try {
        const response = await TaskServiceClient.createInputTextResource(CreateInputTextResourceRequest.create({ text }))
        if (!response.created || !response.absolutePath) return undefined

        return {
            absolutePath: response.absolutePath,
            displayName: response.displayName ?? response.absolutePath,
            lineCount: response.lineCount ?? 0,
        }
    } catch (error) {
        console.warn("Keeping the paste inline; the host could not store it", error)
        return undefined
    }
}
