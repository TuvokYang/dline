import type { UiMessage } from "@shared/ExtensionMessage"

/**
 * Transcripts for the activity-fold stories and render tests.
 *
 * Every row is shaped the way the extension writes it, so the fold step and the
 * renderers see the same payloads they see in a real task.
 */

const say = (ts: number, kind: UiMessage["say"], extra: Partial<UiMessage> = {}): UiMessage => ({
    ts,
    type: "say",
    say: kind,
    ...extra,
})
const ask = (ts: number, kind: UiMessage["ask"], extra: Partial<UiMessage> = {}): UiMessage => ({
    ts,
    type: "ask",
    ask: kind,
    ...extra,
})

export const userTask = (ts: number, text: string) => say(ts, "task", { text })
export const userFeedback = (ts: number, text: string) => say(ts, "user_feedback", { text })
export const finishedRequest = (ts: number) => say(ts, "api_req_started", { text: JSON.stringify({ request: "…", cost: 0.01 }) })
export const streamingRequest = (ts: number) => say(ts, "api_req_started", { text: JSON.stringify({ request: "…" }) })
export const thinking = (ts: number, text: string, extra: Partial<UiMessage> = {}) => say(ts, "reasoning", { text, ...extra })
export const assistantText = (ts: number, text: string) => say(ts, "text", { text })
/** `files` names the workspace state; read-only rounds keep it, so they can join one exploration run. */
export const restorePoint = (ts: number, files: string, extra: Partial<UiMessage> = {}) =>
    say(ts, "checkpoint_created", {
        lastCheckpointHash: [files],
        checkpointSource: { kind: "round_start", turnId: `turn-${ts}` },
        ...extra,
    })
const tool = (ts: number, payload: object) => say(ts, "tool", { text: JSON.stringify(payload) })
export const readFile = (ts: number, path: string) => tool(ts, { tool: "readFile", path })
export const searchFiles = (ts: number, path: string, regex: string) => tool(ts, { tool: "searchFiles", path, regex })
export const editFile = (ts: number, path: string) => tool(ts, { tool: "editedExistingFile", path, diff: "-old\n+new" })
export const createFile = (ts: number, path: string) => tool(ts, { tool: "newFileCreated", path, content: "# Lint\n" })
export const workingRespond = (ts: number, content: string) => tool(ts, { tool: "actModeRespond", content })
export const finishedCommand = (ts: number, command: string) =>
    ask(ts, "command", { text: command, commandStatus: "completed", exitCode: 0 })
export const runningCommand = (ts: number, command: string) => ask(ts, "command", { text: command, commandStatus: "running" })
export const errorRow = (ts: number, text: string) => say(ts, "error", { text })
export const completion = (ts: number, text: string) => ask(ts, "completion_result", { text })

/**
 * One finished turn with every kind of activity row, then a finished follow-up
 * turn and a third turn that is still streaming.
 *
 * - Turn 1 holds an exploration run, a tool group, a command, an edit and a
 *   failed lint run that has to stay visible.
 * - Turn 2 holds a working_respond update and a restore point the user checked
 *   out, which also stays visible.
 * - Turn 3 has not ended, so nothing in it folds.
 */
export const multiTurnTranscript: UiMessage[] = [
    userTask(1, "Fix the failing lint step"),
    restorePoint(10, "files-1"),
    finishedRequest(11),
    thinking(12, "Start with the lint configuration."),
    readFile(13, "eslint.config.js"),
    restorePoint(20, "files-1"),
    finishedRequest(21),
    thinking(22, "Find where the rule is disabled."),
    searchFiles(23, "src", "eslint-disable"),
    restorePoint(30, "files-1"),
    finishedRequest(31),
    assistantText(32, "Two files disable the rule; I will read both."),
    readFile(33, "src/a.ts"),
    readFile(34, "src/b.ts"),
    restorePoint(40, "files-1"),
    finishedRequest(41),
    finishedCommand(42, "npm run lint"),
    restorePoint(50, "files-1"),
    finishedRequest(51),
    editFile(52, "src/a.ts"),
    errorRow(53, "ESLint reported 2 problems in src/b.ts."),
    restorePoint(60, "files-2"),
    finishedRequest(61),
    editFile(62, "src/b.ts"),
    finishedRequest(63),
    completion(64, "The lint step passes again."),
    userFeedback(70, "Also document the rule."),
    restorePoint(71, "files-3"),
    finishedRequest(72),
    workingRespond(73, "Writing the lint notes next."),
    readFile(74, "docs/lint.md"),
    readFile(75, "docs/index.md"),
    restorePoint(80, "files-3", { isCheckpointCheckedOut: true }),
    finishedRequest(81),
    createFile(82, "docs/lint-rules.md"),
    finishedRequest(83),
    completion(84, "Documented the rule in docs/lint-rules.md."),
    userFeedback(90, "Now run the full test suite."),
    restorePoint(91, "files-4"),
    streamingRequest(92),
    thinking(93, "Running the suite", { partial: true }),
]

/**
 * Two finished turns whose restore points each hold a different file tree, so
 * a workspace restore checks out exactly one of them.
 *
 * A finished request row is not drawn, so a fold's members are the drawn rows
 * between its boundaries: restore points, edits and the command.
 */
export const twoTurnTranscript: UiMessage[] = [
    userTask(1, "Split the parser"),
    restorePoint(10, "tree-a"),
    finishedRequest(11),
    editFile(12, "src/a.ts"),
    restorePoint(20, "tree-b"),
    finishedRequest(21),
    editFile(22, "src/b.ts"),
    restorePoint(30, "tree-c"),
    finishedRequest(31),
    editFile(32, "src/c.ts"),
    finishedCommand(33, "npm test"),
    finishedRequest(34),
    completion(35, "The parser is split."),
    userFeedback(40, "Also split the lexer."),
    restorePoint(41, "tree-d"),
    finishedRequest(42),
    editFile(43, "src/lexer.ts"),
    finishedRequest(44),
    completion(45, "The lexer is split."),
]

/**
 * Recompute every checkout marker the way the extension does after a
 * workspace restore: a restore point is checked out exactly when its file
 * references equal the restored ones, so the previous one is released.
 */
export function checkOutFileTree(messages: readonly UiMessage[], tree: string): UiMessage[] {
    return messages.map((message) =>
        message.say === "checkpoint_created"
            ? { ...message, isCheckpointCheckedOut: message.lastCheckpointHash?.[0] === tree }
            : message,
    )
}

/** The row a chat restore writes to account for the requests it discarded; the chat never draws it. */
export const discardedRequests = (ts: number) =>
    say(ts, "deleted_api_reqs", {
        text: JSON.stringify({ tokensIn: 1200, tokensOut: 300, cacheWrites: 0, cacheReads: 0, cost: 0.02 }),
    })

/** One moment of a running task: what the chat holds and what just happened. */
export interface LiveStep {
    readonly caption: string
    readonly messages: readonly UiMessage[]
}

interface LiveEvent {
    readonly caption: string
    /** Rows rewritten in place, matched by ts, the way the extension updates a row. */
    readonly update?: readonly UiMessage[]
    readonly append?: readonly UiMessage[]
}

function playEvents(events: readonly LiveEvent[]): LiveStep[] {
    let messages: readonly UiMessage[] = []
    return events.map(({ caption, update = [], append = [] }) => {
        const updates = new Map(update.map((message) => [message.ts, message]))
        messages = [...messages.map((message) => updates.get(message.ts) ?? message), ...append]
        return { caption, messages }
    })
}

/**
 * Two turns as the extension writes them, one event at a time: every round
 * opens with its restore point and request, streams, runs its tools and ends
 * when the next round starts or the turn-ending interaction settles.
 */
export const liveTwoTurnSteps: readonly LiveStep[] = playEvents([
    { caption: "The user sends the task", append: [userTask(1, "Fix the failing lint step")] },
    {
        caption: "Round 1 starts and streams its thinking",
        append: [
            restorePoint(10, "files-1"),
            streamingRequest(11),
            thinking(12, "Start with the lint configuration.", { partial: true }),
        ],
    },
    {
        caption: "Round 1 reads the lint configuration",
        update: [thinking(12, "Start with the lint configuration.")],
        append: [readFile(13, "eslint.config.js")],
    },
    {
        caption: "Round 1 ends as round 2 starts",
        update: [finishedRequest(11)],
        append: [
            restorePoint(20, "files-1"),
            streamingRequest(21),
            thinking(22, "Find where the rule is disabled.", { partial: true }),
        ],
    },
    {
        caption: "Round 2 searches the sources",
        update: [thinking(22, "Find where the rule is disabled.")],
        append: [searchFiles(23, "src", "eslint-disable")],
    },
    {
        caption: "Round 2 ends as round 3 starts and edits a file",
        update: [finishedRequest(21)],
        append: [
            restorePoint(30, "files-1"),
            streamingRequest(31),
            assistantText(32, "Two files disable the rule; I will fix both."),
            editFile(33, "src/a.ts"),
        ],
    },
    { caption: "Round 3 runs the linter", append: [runningCommand(34, "npm run lint")] },
    { caption: "The linter passes", update: [finishedCommand(34, "npm run lint")] },
    {
        caption: "Round 3 ends as round 4 starts",
        update: [finishedRequest(31)],
        append: [
            restorePoint(40, "files-2"),
            streamingRequest(41),
            thinking(42, "The lint step passes; report back.", { partial: true }),
        ],
    },
    {
        caption: "Round 4 completes the turn",
        update: [thinking(42, "The lint step passes; report back."), finishedRequest(41)],
        append: [completion(43, "The lint step passes again.")],
    },
    { caption: "The user asks a follow-up", append: [userFeedback(50, "Also document the rule.")] },
    {
        caption: "Round 5 starts and reads the docs",
        append: [
            restorePoint(51, "files-2"),
            streamingRequest(52),
            workingRespond(53, "Writing the lint notes next."),
            readFile(54, "docs/lint.md"),
        ],
    },
    {
        caption: "Round 5 ends as round 6 writes the notes",
        update: [finishedRequest(52)],
        append: [restorePoint(60, "files-2"), streamingRequest(61), createFile(62, "docs/lint-rules.md")],
    },
    {
        caption: "Round 6 ends as round 7 starts",
        update: [finishedRequest(61)],
        append: [restorePoint(70, "files-3"), streamingRequest(71), thinking(72, "The notes are written.", { partial: true })],
    },
    {
        caption: "Round 7 completes the second turn",
        update: [thinking(72, "The notes are written."), finishedRequest(71)],
        append: [completion(73, "Documented the rule in docs/lint-rules.md.")],
    },
])

/** A single finished turn whose activity folds into one block at the `turn` level. */
export const finishedTurnTranscript: UiMessage[] = [
    userTask(1, "Fix the failing lint step"),
    restorePoint(10, "files-1"),
    finishedRequest(11),
    thinking(12, "Start with the lint configuration."),
    readFile(13, "eslint.config.js"),
    restorePoint(20, "files-1"),
    finishedRequest(21),
    thinking(22, "Find where the rule is disabled."),
    searchFiles(23, "src", "eslint-disable"),
    restorePoint(30, "files-1"),
    finishedRequest(31),
    assistantText(32, "Two files disable the rule; I will read both."),
    readFile(33, "src/a.ts"),
    readFile(34, "src/b.ts"),
    restorePoint(40, "files-1"),
    finishedRequest(41),
    finishedCommand(42, "npm run lint"),
    finishedRequest(50),
    completion(51, "The lint step passes again."),
]
