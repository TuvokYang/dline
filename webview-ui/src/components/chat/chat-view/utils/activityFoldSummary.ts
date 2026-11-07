import { readCommandRow } from "@shared/commandRow"
import type { UiAskUseMcpServer, UiMessage, UiSayBrowserAction, UiSaySubagentStatus } from "@shared/ExtensionMessage"
import type { ActivityFold, FoldFailureKind } from "./chatRowKinds"

/**
 * What a block did, by the verb a reader cares about.
 *
 * A single "tool calls" total hides the only distinction that matters in a
 * transcript: whether the model looked at something, changed something, ran
 * something, or delegated to an agent. Each kind is counted on its own so a
 * header can never report a subagent as a tool call. A hosted web lookup and a
 * browser step are kinds of their own rather than reads: neither one touches a
 * workspace file. Reaching outside the workspace is not a kind either; it
 * qualifies only the file and command kinds.
 */
export type FoldWorkKind = "read" | "write" | "command" | "subagent" | "web" | "browser" | "other"

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
     * How much of each kind reached outside the workspace, by kind.
     *
     * External reach is a property of a read, a write or a command, never a peer
     * category: "12 read (3 external)" says the reads went outside, while a
     * separate `external` tally would make a reader add it to the total.
     */
    readonly external: ReadonlyMap<FoldWorkKind, number>
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
     * Members that ended in failure, by work category. Only countable work is
     * reported; a failure that keeps its row visible is not part of the block and
     * so is never counted here.
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

/**
 * Hosted web lookups.
 *
 * A fetch or a search leaves the machine, but it reads no workspace file, so it
 * is counted apart from `file read` instead of being folded into it.
 */
const WEB_TOOLS = new Set(["webFetch", "webSearch"])
/** Reads that leave the workspace: a definition or reference lookup in another tree. */
const EXTERNAL_READ_TOOLS = new Set(["findReferences"])
/** Hosted execution: the verb is running something, and it runs outside the workspace. */
const EXTERNAL_COMMAND_TOOLS = new Set(["codeExecution"])

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

export interface FoldSummaryContext {
    /** Directories a command may run in and still be inside the workspace. */
    readonly workspaceRoots?: readonly string[]
}

export function summarizeActivityFold(
    fold: ActivityFold,
    checkpointAttachments: ReadonlyMap<number, readonly UiMessage[]>,
    context: FoldSummaryContext = {},
): ActivityFoldSummary {
    const work = new Map<FoldWorkKind, number>()
    const external = new Map<FoldWorkKind, number>()
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
        else if (member.say === "command" || member.ask === "command") {
            count(work, "command")
            // A command that runs outside every workspace root reached outside the
            // workspace; the row states its directory, so this is a fact, not a guess.
            if (runsOutsideWorkspace(member, context.workspaceRoots)) count(external, "command")
        } else if (member.say === "text") assistantMessages += 1
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
            if (READ_TOOLS.has(name)) {
                count(work, "read")
                if (EXTERNAL_READ_TOOLS.has(name)) count(external, "read")
            } else if (WRITE_TOOLS.has(name)) count(work, "write")
            else if (WEB_TOOLS.has(name)) count(work, "web")
            else if (EXTERNAL_COMMAND_TOOLS.has(name)) {
                // Hosted execution runs elsewhere, so it is a command that reached
                // outside the workspace rather than a category of its own.
                count(work, "command")
                count(external, "command")
            } else count(work, "other")
        } else {
            const mcp = mcpCallName(member)
            if (mcp) {
                // A server call is neither a workspace file operation nor a shell
                // command, so it is neither a `file read` nor external.
                count(tools, mcp)
                count(work, "other")
                continue
            }
            const browser = browserStepName(member)
            if (browser) {
                // A browser step is driven through the browser, not through a file.
                count(tools, browser)
                count(work, "browser")
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

/**
 * Whether a command row states a directory outside every workspace root.
 *
 * The row appends its working directory after the command line, so the block can
 * tell a command that reached outside the workspace from one that stayed in it.
 * A row without the marker is a command from before the directory was recorded,
 * and an unknown directory is never reported as external: a reader must not see
 * a figure the row does not support.
 */
function runsOutsideWorkspace(message: UiMessage, roots: readonly string[] | undefined): boolean {
    const workingDirectory = readCommandRow(message).workingDirectory
    if (workingDirectory === undefined || !roots || roots.length === 0) return false
    const from = normalizeDirectory(workingDirectory)
    return !roots.some((root) => isSameOrInside(from, normalizeDirectory(root)))
}

/** Windows accepts either separator, and a trailing one does not change the directory. */
function normalizeDirectory(directory: string): string {
    return directory.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

/** Windows paths compare case-insensitively; a sibling with a shared prefix is not inside. */
function isSameOrInside(directory: string, root: string): boolean {
    return directory === root || directory.startsWith(`${root}/`)
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
 * `2 rounds · 8 file read (3 external) · 2 file edit · 4 cmd · 1 subagent`.
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

/**
 * The verb each kind states, in the order a reader scans for it, with the form a
 * count of more than one uses.
 *
 * A label names what happened to what: `file read` and `file edit` say a file was
 * touched, `cmd` says a shell ran, `subagent` says work was delegated, and
 * `web tools` and `browser` say the request left the machine through a remote
 * tool rather than through a local one. Reaching outside the workspace is not a
 * kind: it qualifies only the local file and command kinds, which is why
 * `OUTSIDE_KINDS` below is narrower than this list.
 */
const WORK_LABELS: ReadonlyArray<readonly [FoldWorkKind, string, string]> = [
    ["read", "file read", "file reads"],
    ["write", "file edit", "file edits"],
    ["command", "cmd", "cmds"],
    ["subagent", "subagent", "subagents"],
    ["web", "web tools", "web tools"],
    ["browser", "browser", "browsers"],
    ["other", "other", "others"],
]

/**
 * The kinds a workspace boundary can qualify.
 *
 * Only a file operation or a command carries a directory, so only those can be outside the
 * workspace. A web tool or a subagent is not a local operation, and calling one "external" would
 * describe the tool rather than where it ran.
 */
const OUTSIDE_KINDS: ReadonlySet<FoldWorkKind> = new Set<FoldWorkKind>(["read", "write", "command"])

/**
 * The header facts in reading order, keeping error counts apart from the rest.
 *
 * A reader scans the line for what went wrong, so the renderer needs to know
 * which parts are failure counts without re-parsing the sentence.
 */
export function describeActivityFoldParts(summary: ActivityFoldSummary): ActivityFoldPart[] {
    // A fact states a count and a noun; work facts also name their kind so their
    // external share can qualify them.
    const facts: Array<readonly [number, string, string, FoldWorkKind?]> = [
        [summary.rounds ?? 0, "round", "rounds"],
        ...WORK_LABELS.map(([kind, singular, plural]) => [summary.work.get(kind) ?? 0, singular, plural, kind] as const),
        [summary.thoughts, "thought", "thoughts"],
        [summary.checkpoints, "checkpoint", "checkpoints"],
        [summary.assistantMessages, "message", "messages"],
    ]
    const parts: ActivityFoldPart[] = facts.flatMap(([total, singular, plural, kind]) => {
        const text = countOf(total, singular, plural)
        if (text === undefined) return []
        // Reaching outside the workspace qualifies the verb rather than adding a
        // tally a reader would sum: "12 file reads (3 external)".
        const outside = kind === undefined || !OUTSIDE_KINDS.has(kind) ? undefined : outsideCount(summary.external.get(kind) ?? 0)
        return [{ text: outside === undefined ? text : `${text} (${outside})`, isFailure: false }]
    })
    for (const [kind, label] of FAILURE_LABELS) {
        // A failure label already ends in "failed", so it never takes a plural.
        const total = summary.failures?.get(kind) ?? 0
        if (total !== 0) parts.push({ text: `${total} ${label}`, isFailure: true })
    }
    return parts.length > 0 ? parts : [{ text: "Finished steps", isFailure: false }]
}

/** Singular nouns for counted failures, in the order a reader wants them. */
const FAILURE_LABELS: ReadonlyArray<readonly [FoldFailureKind, string]> = [
    ["edit", "file edit failed"],
    ["read", "file read failed"],
    ["subagent", "subagent failed"],
    ["command", "cmd failed"],
    ["web", "web tools failed"],
    ["browser", "browser failed"],
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
    if (outside) lines.push(`External by verb: ${outside}`)
    return lines.length > 0 ? lines.join("\n") : undefined
}

function countOf(count: number, singular: string, plural: string): string | undefined {
    if (count === 0) return undefined
    return `${count} ${count === 1 ? singular : plural}`
}

/** `external` is uncountable, so its parenthetical never takes a plural. */
function outsideCount(count: number): string | undefined {
    return count === 0 ? undefined : `${count} external`
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
