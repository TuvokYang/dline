import { readTaskConversation } from "@core/task/conversation/TaskConversationReader"
import fs from "fs/promises"
import * as path from "path"
import { UiMessage } from "@/shared/ExtensionMessage"
import { ClineStorageMessage } from "@/shared/messages/content"
import { Logger } from "@/shared/services/Logger"
import { writeJsonAtomic } from "@/shared/storage/atomic-file"
import { ensureTaskDirectoryExists, getSavedClineMessages } from "../../../core/storage/disk"
import { UIMessage } from "../../../core/storage/UIMessage"
import { extractFocusChainListFromText } from "../../task/focus-chain/file-utils"
import { Controller } from ".."

/**
 * Exports the current chat history next to the task before recovery replaces it.
 * @returns Path to the backup file, or undefined when there was no history to keep.
 */
async function backupUiMessages(taskId: string, taskDir: string): Promise<string | undefined> {
    const current = await getSavedClineMessages(taskId)
    if (current.length === 0) return undefined
    const backupPath = path.join(taskDir, `ui_messages.backup.${Date.now()}.json`)
    await writeJsonAtomic(backupPath, current)
    Logger.info(`[recoverUiMessages] Backup created: ${backupPath}`)
    return backupPath
}

/**
 * Stores the recovered history through the task's single `messages.db` writer.
 *
 * The open task already owns that writer, so its message state replaces the
 * history. A task that is not open here is opened just long enough to write.
 */
async function storeRecoveredMessages(controller: Controller | undefined, taskId: string, messages: UiMessage[]) {
    const activeTask = controller?.task?.taskId === taskId ? controller.task : undefined
    if (activeTask) {
        await activeTask.owners.messages.replaceClineMessages(messages)
        return
    }
    const store = await UIMessage.open(taskId)
    try {
        await store.overwrite(messages)
    } finally {
        await store.close()
    }
}

/**
 * Strip XML tags and trim whitespace from text.
 */
function stripXml(text: string, tag: string): string {
    const regex = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "i")
    const match = text.match(regex)
    return match ? match[1].trim() : text.trim()
}

/**
 * Check if a text block is a system-generated block that should be filtered out.
 */
/** Map tool_use names to UiAsk types */
function toolToAskType(name: string): string | undefined {
    const map: Record<string, string> = {
        ask_followup_question: "followup",
        make_plan: "make_plan",
        qna_respond: "qna_respond",
        attempt_completion: "completion_result",
        write_to_file: "tool",
        replace_in_file: "tool",
        new_rule: "tool",
        execute_command: "command",
        browser_action: "browser_action_launch",
        use_mcp_tool: "use_mcp_server",
        access_mcp_resource: "use_mcp_server",
        spawn_task: "spawn_task",
        new_task: "new_task",
        condense: "condense",
        summarize_task: "summarize_task",
        report_bug: "report_bug",
    }
    return map[name]
}

/** Format ask text based on tool type */
function formatAskText(name: string, input: Record<string, unknown>): string {
    switch (name) {
        case "write_to_file":
        case "replace_in_file": {
            const isEdit = name === "replace_in_file"
            const relPath = (input.path || input.absolutePath || "") as string
            return JSON.stringify({
                tool: isEdit ? "editedExistingFile" : "newFileCreated",
                path: relPath,
                content: (input.content || input.diff || "") as string,
            })
        }
        case "execute_command":
            return (input.command as string) || ""
        case "browser_action":
            return JSON.stringify(input)
        case "spawn_task":
            return JSON.stringify({ task: input.task, mode: input.mode, context: input.context })
        case "ask_followup_question":
            return JSON.stringify({ question: input.question, options: input.options })
        case "attempt_completion":
            return (input.result as string) || ""
        default:
            return JSON.stringify(input)
    }
}

function isSystemBlock(text: string): boolean {
    const patterns = [
        /^# task_progress\b/im,
        /^<environment_details>/i,
        /^<user_query>/i,
        /^<system_reminder>/i,
        /^<additional_data>/i,
        /^\[TASK RESUMPTION\]/i,
    ]
    return patterns.some((p) => p.test(text))
}

/**
 * Convert an API conversation history entry to approximate UiMessage entries.
 */
/**
 * Build an api_req_started text payload from the metrics stored on the
 * assistant message in the API conversation history.
 * Extracts tokensIn, tokensOut, cache reads+writes (combined as "cached"),
 * and cost. Fields not persisted in API history (currency, inputPrice,
 * outputPrice, cacheHitRate, separated cacheWrites/cacheReads) are
 * omitted — the frontend treats missing fields gracefully.
 */
function buildApiReqStartedText(metrics?: ClineStorageMessage["metrics"]): string {
    if (!metrics?.tokens) {
        return JSON.stringify({ request: "(recovered from API history)" })
    }
    const { prompt, completion, cached } = metrics.tokens
    return JSON.stringify({
        request: "(recovered from API history)",
        tokensIn: prompt,
        tokensOut: completion,
        cacheWrites: 0, // not separately stored; combined into "cached"
        cacheReads: cached,
        cost: metrics.cost,
    })
}

function convertApiToUiMessages(apiMessages: ClineStorageMessage[]): UiMessage[] {
    const result: UiMessage[] = []
    const baseTs = Date.now()
    const genTs = (offset: number): number => baseTs + offset

    for (let i = 0; i < apiMessages.length; i++) {
        const msg = apiMessages[i]
        const contentBlocks = Array.isArray(msg.content) ? msg.content : [{ type: "text" as const, text: msg.content as string }]

        if (msg.role === "user") {
            let isFirstUser = !result.some((m) => m.type === "say" && m.say === "task")
            for (const block of contentBlocks) {
                if (block.type !== "text" || !block.text) continue

                let text = block.text.trim()
                if (isFirstUser) {
                    // Strip <task> XML wrapper from the task description
                    text = stripXml(text, "task")
                    if (text) {
                        result.push({ ts: genTs(result.length), type: "say", say: "task", text } as UiMessage)
                        isFirstUser = false
                    }
                    continue
                }

                // Skip system-generated blocks in subsequent user messages
                if (isSystemBlock(text)) continue

                // Strip <user_response> wrapper
                text = stripXml(text, "user_response")

                result.push({ ts: genTs(result.length), type: "say", say: "user_feedback", text } as UiMessage)
            }
            // Build api_req_started from the NEXT assistant message's metrics
            const nextMsg = apiMessages[i + 1] as ClineStorageMessage | undefined
            result.push({
                ts: genTs(result.length),
                type: "say",
                say: "api_req_started",
                text: buildApiReqStartedText(nextMsg?.metrics),
            } as UiMessage)
        } else if (msg.role === "assistant") {
            for (const block of contentBlocks) {
                if (block.type === "text" && block.text) {
                    result.push({ ts: genTs(result.length), type: "say", say: "text", text: block.text } as UiMessage)
                } else if (block.type === "tool_use") {
                    const input = (block.input as Record<string, unknown>) || {}
                    const askType = toolToAskType(block.name)
                    if (askType) {
                        const askText = formatAskText(block.name, input)
                        result.push({
                            ts: genTs(result.length),
                            type: "ask",
                            ask: askType,
                            text: askText,
                            interactionId: block.dline_tid,
                        } as UiMessage)
                    } else {
                        // Read-only tools: render as text
                        const toolDesc = `**Tool: ${block.name}**\n\`\`\`json\n${JSON.stringify(block.input, null, 2)}\n\`\`\``
                        result.push({ ts: genTs(result.length), type: "say", say: "text", text: toolDesc } as UiMessage)
                    }
                }
            }
        }
    }

    return result
}

/**
 * Recover UI messages from API conversation history.
 *
 * 1. Exports the existing chat history (if any) to a JSON backup
 * 2. Reads the API conversation history
 * 3. Converts API messages to UI messages
 * 4. Replaces the chat history through the task's single writer
 * 5. Refreshes the active task so the recovered messages show immediately
 */
export async function recoverUiMessages(controller: Controller | undefined, taskId?: string): Promise<void> {
    const id = taskId || controller?.task?.taskId
    if (!id) {
        throw new Error("No task ID available. Open a task first or provide a task ID.")
    }

    const taskDir = await ensureTaskDirectoryExists(id)

    // 1. Backup existing UI messages
    const backupPath = await backupUiMessages(id, taskDir)

    // 2. Read the provider conversation, from the journal or a legacy task's history file
    const apiMessages = await readTaskConversation(id)
    if (apiMessages.length === 0) {
        throw new Error(`No API conversation history found for task ${id}`)
    }

    // 3. Convert to UI messages — token/cost data is extracted from
    //    each assistant message's metrics field in the API history.
    const uiMessages = convertApiToUiMessages(apiMessages)

    // 4. Write new UI messages
    await storeRecoveredMessages(controller, id, uiMessages)

    Logger.info(
        `[recoverUiMessages] Recovered ${uiMessages.length} UI messages from ${apiMessages.length} API messages for task ${id}` +
            (backupPath ? ` (backup: ${backupPath})` : ""),
    )

    // 5. If controller has an active task for this ID, reload it to show recovered messages
    if (controller?.task?.taskId === id) {
        try {
            // Reload focus chain checklist from disk so TODOs reflect recovered state
            const fcPath = path.join(taskDir, `focus_chain_taskid_${id}.md`)
            try {
                const fcContent = await fs.readFile(fcPath, "utf-8")
                if (fcContent.trim()) {
                    const checklist = extractFocusChainListFromText(fcContent) || fcContent
                    controller.task.owners.toolState.currentFocusChainChecklist = checklist
                }
            } catch {
                // Focus chain file may not exist — that's OK
            }
            await controller.postStateToWebview()
        } catch (error) {
            Logger.error("[recoverUiMessages] Failed to reload task:", error)
        }
    }
}
