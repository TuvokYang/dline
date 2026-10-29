import type { UiAskUseMcpServer, UiMessage, UiSayBrowserAction } from "@shared/ExtensionMessage"
import type { ActivityFold } from "./chatRowKinds"

/**
 * Facts a fold header states about its members.
 *
 * Only facts present in the members and their attached checkpoints are
 * counted. Model rounds are not: a successful request draws no row, so the
 * fold cannot tell how many there were.
 */
export interface ActivityFoldSummary {
    /**
     * Tool calls by kind, in the order each kind first appears: built-in tools by
     * name, MCP calls as `server:tool` (`server:resource` for resource reads),
     * browser steps as `browser:<action>`.
     */
    readonly toolCalls: ReadonlyMap<string, number>
    readonly commands: number
    readonly fileEdits: number
    readonly checkpoints: number
    /** Assistant messages; only the `turn` level folds them. */
    readonly assistantMessages: number
}

const FILE_EDIT_TOOLS = new Set(["editedExistingFile", "newFileCreated"])
const ASSISTANT_TOOLS = new Set(["actModeRespond", "statusUpdate"])

export function summarizeActivityFold(
    fold: ActivityFold,
    checkpointAttachments: ReadonlyMap<number, readonly UiMessage[]>,
): ActivityFoldSummary {
    const toolCalls = new Map<string, number>()
    let commands = 0
    let fileEdits = 0
    let checkpoints = 0
    let assistantMessages = 0

    for (const member of fold) {
        checkpoints += checkpointAttachments.get(member.ts)?.length ?? 0
        if (member.say === "checkpoint_created") checkpoints += 1
        else if (member.say === "command" || member.ask === "command") commands += 1
        else if (member.say === "text") assistantMessages += 1
        else if (member.say === "tool" || member.ask === "tool") {
            const name = toolName(member)
            if (!name) continue
            if (FILE_EDIT_TOOLS.has(name)) fileEdits += 1
            else if (ASSISTANT_TOOLS.has(name)) assistantMessages += 1
            else countCall(toolCalls, name)
        } else {
            const name = mcpCallName(member) ?? browserStepName(member)
            if (name) countCall(toolCalls, name)
        }
    }
    return { toolCalls, commands, fileEdits, checkpoints, assistantMessages }
}

function countCall(toolCalls: Map<string, number>, name: string): void {
    toolCalls.set(name, (toolCalls.get(name) ?? 0) + 1)
}

/** The request row is the call; its response row is not counted again. */
function mcpCallName(message: UiMessage): string | undefined {
    if (message.ask !== "use_mcp_server" && message.say !== "use_mcp_server") return undefined
    const use = parseJson<Partial<UiAskUseMcpServer>>(message.text)
    if (typeof use?.serverName !== "string") return undefined
    const target = use.type === "access_mcp_resource" ? "resource" : use.toolName
    return typeof target === "string" ? `${use.serverName}:${target}` : undefined
}

/** A launch and each later action are browser steps; their result rows are not. */
function browserStepName(message: UiMessage): string | undefined {
    if (message.say === "browser_action_launch" || message.ask === "browser_action_launch") return "browser:launch"
    if (message.say !== "browser_action") return undefined
    const action = parseJson<Partial<UiSayBrowserAction>>(message.text)?.action
    return typeof action === "string" ? `browser:${action}` : undefined
}

/** One-line header text, such as "5 tool calls · 1 command · 2 file edits". */
export function describeActivityFold(summary: ActivityFoldSummary): string {
    const toolTotal = Array.from(summary.toolCalls.values()).reduce((sum, count) => sum + count, 0)
    const parts = [
        countOf(toolTotal, "tool call"),
        countOf(summary.commands, "command"),
        countOf(summary.fileEdits, "file edit"),
        countOf(summary.checkpoints, "checkpoint"),
        countOf(summary.assistantMessages, "message"),
    ].filter((part): part is string => part !== undefined)
    return parts.length > 0 ? parts.join(" · ") : "Finished steps"
}

/** Tool names with their counts, for the header's tooltip. */
export function describeToolCalls(summary: ActivityFoldSummary): string {
    return Array.from(summary.toolCalls, ([name, count]) => `${name} ×${count}`).join(", ")
}

function countOf(count: number, noun: string): string | undefined {
    if (count === 0) return undefined
    return `${count} ${noun}${count === 1 ? "" : "s"}`
}

function toolName(message: UiMessage): string | undefined {
    const tool = parseJson<{ tool?: unknown }>(message.text)?.tool
    return typeof tool === "string" ? tool : undefined
}

function parseJson<T>(text: string | undefined): T | undefined {
    try {
        const value: unknown = JSON.parse(text ?? "")
        return value !== null && typeof value === "object" ? (value as T) : undefined
    } catch {
        return undefined
    }
}
