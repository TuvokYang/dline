import type { UiAskUseMcpServer, UiMessage, UiSayBrowserAction } from "@shared/ExtensionMessage"
import type { ActivityFold, FoldFailureKind } from "./chatRowKinds"

/**
 * Facts a fold header states about its members.
 *
 * Only facts present in the members and their attached checkpoints are
 * counted. The fold records its distinct request rounds when it is built.
 */
export interface ActivityFoldSummary {
    /** Distinct request rounds in the block. */
    readonly rounds?: number
    /**
     * Tool calls by kind, in the order each kind first appears: built-in tools by
     * name, MCP calls as `server:tool` (`server:resource` for resource reads),
     * browser steps as `browser:<action>`.
     */
    readonly toolCalls: ReadonlyMap<string, number>
    readonly commands: number
    readonly fileEdits: number
    readonly checkpoints: number
    /** Reasoning blocks the model streamed in the folded rounds. */
    readonly thoughts: number
    readonly assistantMessages: number
    /**
     * Members that ended in failure, by work category. Only edits, commands and
     * subagents are counted; a failure that keeps its row visible is not part of
     * the block and so is never counted here.
     */
    readonly failures: ReadonlyMap<FoldFailureKind, number>
}

const FILE_EDIT_TOOLS = new Set(["editedExistingFile", "newFileCreated"])
const ASSISTANT_TOOLS = new Set(["actModeRespond", "statusUpdate"])

export function summarizeActivityFold(
    fold: ActivityFold,
    checkpointAttachments: ReadonlyMap<number, readonly UiMessage[]>,
): ActivityFoldSummary {
    const toolCalls = new Map<string, number>()
    const failures = fold._failures ?? new Map<FoldFailureKind, number>()
    let commands = 0
    let fileEdits = 0
    let checkpoints = 0
    let thoughts = 0
    let assistantMessages = 0

    for (const member of fold) {
        checkpoints += checkpointAttachments.get(member.ts)?.length ?? 0
        // A failed edit, command or subagent is reported as an error, not also as
        // a successful call. The block recorded exactly which members failed, so
        // a settled call of the same kind still counts as one.
        if (fold._failedMemberTs?.has(member.ts)) continue
        if (member.say === "checkpoint_created") checkpoints += 1
        else if (member.say === "reasoning") thoughts += 1
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
    const rounds = fold._roundCount
    return { rounds, toolCalls, commands, fileEdits, checkpoints, thoughts, assistantMessages, failures }
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
    return describeActivityFoldParts(summary)
        .map((part) => part.text)
        .join(" · ")
}

/** One stated fact about a block, and whether it is an error count. */
export interface ActivityFoldPart {
    readonly text: string
    readonly isFailure: boolean
}

/**
 * The header facts in reading order, keeping error counts apart from the rest.
 *
 * A reader scans the line for what went wrong, so the renderer needs to know
 * which parts are failure counts without re-parsing the sentence.
 */
export function describeActivityFoldParts(summary: ActivityFoldSummary): ActivityFoldPart[] {
    const toolTotal = Array.from(summary.toolCalls.values()).reduce((sum, count) => sum + count, 0)
    const counted = [
        [summary.rounds ?? 0, "round"],
        [toolTotal, "tool call"],
        [summary.commands, "command"],
        [summary.fileEdits, "file edit"],
        [summary.thoughts, "thought"],
        [summary.checkpoints, "checkpoint"],
        [summary.assistantMessages, "message"],
    ] as const
    const parts: ActivityFoldPart[] = counted.flatMap(([count, noun]) => {
        const text = countOf(count, noun)
        return text === undefined ? [] : [{ text, isFailure: false }]
    })
    for (const [kind, label] of FAILURE_LABELS) {
        const text = countOf(summary.failures?.get(kind) ?? 0, label)
        if (text !== undefined) parts.push({ text, isFailure: true })
    }
    return parts.length > 0 ? parts : [{ text: "Finished steps", isFailure: false }]
}

/** Singular nouns for counted failures, in the order a reader wants them. */
const FAILURE_LABELS: ReadonlyArray<readonly [FoldFailureKind, string]> = [
    ["edit", "edit error"],
    ["subagent", "subagent error"],
    ["command", "command error"],
]

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
