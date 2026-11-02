import type { UiAskUseMcpServer, UiMessage, UiSayBrowserAction, UiSaySubagentStatus } from "@shared/ExtensionMessage"
import type { ActivityFold, FoldFailureKind } from "./chatRowKinds"

/**
 * What a block did, by the verb a reader cares about.
 *
 * A single "tool calls" total hides the only distinction that matters in a
 * transcript: whether the model looked at something, changed something, ran
 * something, delegated to an agent, or reached outside the workspace. Each kind
 * is counted on its own so a header can never report a subagent as a tool call.
 */
export type FoldWorkKind = "read" | "write" | "command" | "subagent" | "external" | "other"

/**
 * Facts a fold header states about its members.
 *
 * Only facts present in the members and their attached checkpoints are
 * counted. The fold records its distinct request rounds when it is built.
 */
export interface ActivityFoldSummary {
    /** Distinct request rounds in the block. */
    readonly rounds?: number
    /** Work by kind. */
    readonly work: ReadonlyMap<FoldWorkKind, number>
    /**
     * Providers reached outside the workspace, by destination: `web`, `mcp` or
     * `browser`. Already counted in `work.external`, and stated apart so a reader
     * can tell a search from a browser step.
     */
    readonly external: ReadonlyMap<string, number>
    /** Which built-in tool each read, write and other count came from, for the tooltip. */
    readonly tools: ReadonlyMap<string, number>
    /**
     * Named subagents the block ran, in the order they first appear, with how many
     * agents of that name. A batch names its agents so the header can say what ran
     * instead of only how many.
     */
    readonly subagents: ReadonlyMap<string, number>
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

/** Reads: looking without changing anything. */
const READ_TOOLS = new Set([
    "readFile",
    "listFilesTopLevel",
    "listFilesRecursive",
    "listCodeDefinitionNames",
    "searchFiles",
    "findReferences",
])

/**
 * Writes: every tool that changes the workspace.
 *
 * Deleting and renaming are as destructive as a diff, so they are writes rather
 * than falling through to an unrelated bucket.
 */
const WRITE_TOOLS = new Set(["editedExistingFile", "newFileCreated", "fileDeleted", "renameSymbol", "replaceText", "applyPatch"])

/** Provider-hosted work that reaches outside the workspace. */
const EXTERNAL_TOOLS = new Set(["webFetch", "webSearch", "codeExecution"])

/** Tools that render as an assistant update rather than as work. */
const ASSISTANT_TOOLS = new Set(["actModeRespond", "statusUpdate"])

/** Tools with no reader-facing verb of their own. */
const OTHER_TOOLS = new Set([
    "summarizeTask",
    "generateImage",
    "killCommand",
    "loadCapability",
    "useSkill",
    "focusChainChanged",
    "genericTool",
])

export function summarizeActivityFold(
    fold: ActivityFold,
    checkpointAttachments: ReadonlyMap<number, readonly UiMessage[]>,
): ActivityFoldSummary {
    const work = new Map<FoldWorkKind, number>()
    const external = new Map<string, number>()
    const tools = new Map<string, number>()
    const subagents = new Map<string, number>()
    const failures = fold._failures ?? new Map<FoldFailureKind, number>()
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
        else if (member.say === "command" || member.ask === "command") count(work, "command")
        else if (member.say === "text") assistantMessages += 1
        else if (member.say === "subagent" || member.say === "use_subagents") {
            countSubagents(member, work, subagents)
        } else if (member.say === "tool" || member.ask === "tool") {
            const name = toolName(member)
            if (!name) continue
            // An assistant update is prose the model wrote, not work it performed,
            // so it is counted as a message and never as a tool call.
            if (ASSISTANT_TOOLS.has(name)) {
                assistantMessages += 1
                continue
            }
            count(tools, name)
            if (READ_TOOLS.has(name)) count(work, "read")
            else if (WRITE_TOOLS.has(name)) count(work, "write")
            else if (EXTERNAL_TOOLS.has(name)) countExternal(work, external, "web")
            else count(work, "other")
        } else {
            const mcp = mcpCallName(member)
            if (mcp) {
                count(tools, mcp)
                countExternal(work, external, "mcp")
                continue
            }
            const browser = browserStepName(member)
            if (browser) {
                count(tools, browser)
                countExternal(work, external, "browser")
            }
        }
    }
    const rounds = fold._roundCount
    return { rounds, work, external, tools, subagents, checkpoints, thoughts, assistantMessages, failures }
}

/**
 * Count the agents a subagent row ran.
 *
 * A batch states its own total, and its items name the agent each one bound. A
 * row without a readable payload still counts as one delegation, so the header
 * never drops work that happened.
 */
function countSubagents(message: UiMessage, work: Map<FoldWorkKind, number>, subagents: Map<string, number>): void {
    const payload = parseJson<Partial<UiSaySubagentStatus>>(message.text)
    const items = Array.isArray(payload?.items) ? payload.items : []
    const total = items.length > 0 ? items.length : Math.max(1, numberOr(payload?.total, 1))
    count(work, "subagent", total)
    if (items.length === 0) {
        count(subagents, "subagent")
        return
    }
    for (const item of items) count(subagents, item.subagentName ?? "subagent")
}

function count<T>(counter: Map<T, number>, key: T, by = 1): void {
    counter.set(key, (counter.get(key) ?? 0) + by)
}

function countExternal(work: Map<FoldWorkKind, number>, external: Map<string, number>, destination: string): void {
    count(work, "external")
    count(external, destination)
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

/**
 * One-line header text, such as
 * `2 rounds · 8 read · 2 write · 4 cmd · 1 subagent · 2 external`.
 */
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

/** The verb each kind states, in the order a reader scans for it. */
const WORK_LABELS: ReadonlyArray<readonly [FoldWorkKind, string]> = [
    ["read", "read"],
    ["write", "write"],
    ["command", "cmd"],
    ["subagent", "subagent"],
    ["external", "external"],
    ["other", "other"],
]

/**
 * The header facts in reading order, keeping error counts apart from the rest.
 *
 * A reader scans the line for what went wrong, so the renderer needs to know
 * which parts are failure counts without re-parsing the sentence.
 */
export function describeActivityFoldParts(summary: ActivityFoldSummary): ActivityFoldPart[] {
    const counted = [
        [summary.rounds ?? 0, "round"],
        ...WORK_LABELS.map(([kind, label]) => [summary.work.get(kind) ?? 0, label] as const),
        [summary.thoughts, "thought"],
        [summary.checkpoints, "checkpoint"],
        [summary.assistantMessages, "message"],
    ] as const
    const parts: ActivityFoldPart[] = counted.flatMap(([counted, noun]) => {
        const text = countOf(counted, noun)
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
    return Array.from(summary.tools, ([name, count]) => `${name} ×${count}`).join(", ")
}

/**
 * What the block did, spelled out for the tooltip: which tools, which agents,
 * and which outside destination the external count came from.
 */
export function describeFoldDetail(summary: ActivityFoldSummary): string | undefined {
    const lines: string[] = []
    const tools = describeToolCalls(summary)
    if (tools) lines.push(tools)
    const agents = Array.from(summary.subagents, ([name, count]) => `${name} ×${count}`).join(", ")
    if (agents) lines.push(`Subagents: ${agents}`)
    const outside = Array.from(summary.external, ([kind, count]) => `${kind} ×${count}`).join(", ")
    if (outside) lines.push(`External: ${outside}`)
    return lines.length > 0 ? lines.join("\n") : undefined
}

function countOf(count: number, noun: string): string | undefined {
    if (count === 0) return undefined
    return `${count} ${noun}${count === 1 ? "" : "s"}`
}

function numberOr(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback
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
