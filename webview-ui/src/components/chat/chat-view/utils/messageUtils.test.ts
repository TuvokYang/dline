import type { TaskViewState, UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { isBrowserSession, isExplorationRun } from "./chatRowKinds"
import {
    filterVisibleMessages,
    findGroupedMessageByTs,
    groupChatRows,
    groupLowStakesTools,
    groupMessages,
    isToolGroup,
    resolveApiErrorMessage,
    resolveMessageRowExpanded,
    toggleMessageRowExpansion,
} from "./messageUtils"

const createTextMessage = (ts: number, text: string): UiMessage => ({
    type: "say",
    say: "text",
    text,
    ts,
})

const createToolMessage = (ts: number, tool: string): UiMessage => ({
    type: "say",
    say: "tool",
    text: JSON.stringify({ tool, path: "src/file.ts" }),
    ts,
})

const createReasoningMessage = (ts: number, text: string): UiMessage => ({
    type: "say",
    say: "reasoning",
    text,
    ts,
})

const createRequestMessage = (ts: number, info: Record<string, unknown>): UiMessage => ({
    type: "say",
    say: "api_req_started",
    text: JSON.stringify(info),
    ts,
})

describe("turn-ending row order", () => {
    it("keeps one ending after every other row of its round without moving it into the next round", () => {
        const messages: UiMessage[] = [
            createRequestMessage(1, {}),
            createReasoningMessage(2, "first thought"),
            { ts: 3, type: "ask", ask: "completion_result", text: "done", partial: false },
            { ts: 4, type: "say", say: "command", text: "npm test", partial: true },
            createReasoningMessage(5, "late thought"),
            { ts: 6, type: "ask", ask: "qna_respond", text: "duplicate ending", partial: true },
            createRequestMessage(7, {}),
            createReasoningMessage(8, "next thought"),
            { ts: 9, type: "ask", ask: "followup", text: "next question" },
        ]
        const identities = () =>
            groupChatRows(messages)
                .flatMap((row) => (Array.isArray(row) ? row : [row]))
                .map((row) => row.ts)
        expect(identities()).toEqual([2, 4, 5, 3, 8, 9])
        messages[3] = { ...messages[3], partial: false }
        messages[4] = { ...messages[4], text: "late thought finalized", partial: false }
        expect(identities()).toEqual([2, 4, 5, 3, 8, 9])
    })
})

describe("response visibility across streaming frames", () => {
    it.each([
        "completion_result",
        "qna_respond",
        "followup",
        "generate_report",
        "make_plan",
    ] as const)("preserves the %s response identity at the round tail through finalization", (ask) => {
        const partial: UiMessage = { ts: 2, type: "ask", ask, partial: true, text: "Answer" }
        const final: UiMessage = { ...partial, partial: false, interactionId: "interaction-1" }
        const thought = createReasoningMessage(3, "Late thought")
        const rows = (messages: UiMessage[]) => groupChatRows(messages).flatMap((row) => (Array.isArray(row) ? row : [row]))

        expect(rows([createRequestMessage(1, {}), partial, thought])).toEqual([thought, partial])
        expect(rows([createRequestMessage(1, { cost: 0.01 }), final, thought])).toEqual([thought, final])
    })

    it("never renders assistant prose before, during, or after tool execution", () => {
        const prose = { ...createTextMessage(2, "I will inspect the files"), partial: true }
        const tool = createToolMessage(3, "readFile")
        const visibleIdentities = (messages: UiMessage[]) =>
            groupChatRows(messages)
                .flatMap((row) => (Array.isArray(row) ? row : [row]))
                .map((row) => row.ts)

        expect(visibleIdentities([createRequestMessage(1, {}), prose])).toEqual([])
        expect(visibleIdentities([createRequestMessage(1, {}), prose, tool])).toEqual([3])
        expect(visibleIdentities([createRequestMessage(1, { cost: 0.01 }), { ...prose, partial: false }, tool])).toEqual([3])
    })

    it.each([
        "actModeRespond",
        "statusUpdate",
    ])("keeps the %s tool-owned response at the same row through finalization", (tool) => {
        const partial: UiMessage = {
            ts: 2,
            type: "say",
            say: "tool",
            partial: true,
            text: JSON.stringify({ tool, content: "Inspecting" }),
        }
        const final: UiMessage = { ...partial, partial: false, text: JSON.stringify({ tool, content: "Inspecting the files" }) }
        const request = createRequestMessage(1, {})
        const nextTool = createToolMessage(3, "readFile")
        const rows = (messages: UiMessage[]) => groupChatRows(messages).flatMap((row) => (Array.isArray(row) ? row : [row]))

        expect(rows([request, partial])).toEqual([partial])
        expect(rows([request, partial, nextTool])).toEqual([partial, nextTool])
        expect(rows([request, partial, final, nextTool])).toEqual([final, nextTool])
        expect(rows([request, final, nextTool])).toEqual([final, nextTool])
    })
})

describe("filterVisibleMessages request rows", () => {
    it("hides legacy empty resume continuations without hiding attachment-only feedback", () => {
        const emptyContinuation: UiMessage = { ts: 1, type: "say", say: "user_feedback", text: "" }
        const attachmentOnly: UiMessage = {
            ts: 2,
            type: "say",
            say: "user_feedback",
            text: "",
            files: ["context.txt"],
        }

        expect(filterVisibleMessages([emptyContinuation, attachmentOnly])).toEqual([attachmentOnly])
    })

    it("hides legacy blank content rows across continuation, text, Q&A, report, and completion projections", () => {
        const blankRows: UiMessage[] = [
            { ts: 1, type: "say", say: "user_feedback", text: " \n " },
            { ts: 2, type: "say", say: "text", text: "\t" },
            { ts: 3, type: "say", say: "qna_respond", text: "" },
            { ts: 4, type: "ask", ask: "generate_report", text: " " },
            { ts: 5, type: "say", say: "completion_result", text: "" },
            { ts: 6, type: "ask", ask: "completion_result" },
            { ts: 7, type: "ask", ask: "status_acknowledgment", text: "" },
        ]

        expect(filterVisibleMessages(blankRows)).toEqual([])
    })

    it("hides a cancelled request so its reasoning renders once", () => {
        const request = createRequestMessage(1, { cost: 0, cancelReason: "user_cancelled" })
        const reasoning = createReasoningMessage(2, "thought")

        expect(filterVisibleMessages([request, reasoning])).toEqual([reasoning])
    })

    it("keeps a request whose stream failed", () => {
        const request = createRequestMessage(1, { cost: 0, streamingFailedMessage: "boom" })

        expect(filterVisibleMessages([request])).toEqual([request])
    })

    it("keeps only the request that carries a failure, not every earlier request", () => {
        // A failure belongs to the request it follows. Earlier settled requests have
        // nothing to show; keeping them re-rendered their reasoning a second time.
        const earlierRequest = createRequestMessage(1, { cost: 0.01 })
        const earlierReasoning = createReasoningMessage(2, "**Performing typechecking**")
        const failingRequest = createRequestMessage(3, {})
        const failure: UiMessage = { ts: 4, type: "ask", ask: "api_req_failed", text: "boom" }

        const visible = filterVisibleMessages([earlierRequest, earlierReasoning, failingRequest, failure])

        expect(visible).toContain(failingRequest)
        expect(visible).not.toContain(earlierRequest)
        expect(visible).toContain(earlierReasoning)
    })

    it("shows one checkpoint after Retry supersedes the failure between equal restore points", () => {
        const roots = ["C:/workspace"]
        const firstCheckpoint: UiMessage = {
            ts: 1,
            type: "say",
            say: "checkpoint_created",
            checkpointSource: { kind: "round_start", turnId: "failed-turn" },
            lastCheckpointHash: ["same-files"],
            checkpointWorkspaceRoots: roots,
        }
        const failedRequest = createRequestMessage(2, { streamingFailedMessage: "402 insufficient credits" })
        const failure: UiMessage = { ts: 3, type: "ask", ask: "api_req_failed", text: "402 insufficient credits" }
        const retryCheckpoint: UiMessage = { ...firstCheckpoint, ts: 4 }
        const retryRequest = createRequestMessage(5, {})

        const visible = filterVisibleMessages([firstCheckpoint, failedRequest, failure, retryCheckpoint, retryRequest])

        expect(visible.filter((message) => message.say === "checkpoint_created").map((message) => message.ts)).toEqual([4])
    })
})

/**
 * Create an error-recovery task UI state for message resolution tests.
 */
const createErrorTaskViewState = (): TaskViewState => ({
    taskId: "task-1",
    phase: "paused",
    stateRevision: 2,
    activeInteraction: {
        taskId: "task-1",
        turnId: "turn-1",
        interactionId: "interaction-1",
        kind: "error_retry",
        status: "awaiting",
        stateRevision: 2,
        taskAsk: "api_req_failed",
        presentationKind: "api_req_failed",
        askMessageTs: 2,
    },
    input: { enabled: false, acceptsText: false, acceptsImages: false, acceptsFiles: false },
    footer: { actions: [] },
})

describe("resolveApiErrorMessage", () => {
    it("uses the projected error interaction with the current presentation message", () => {
        const resolved = resolveApiErrorMessage({
            isLast: true,
            lastModifiedMessage: { type: "ask", ask: "api_req_failed", text: "API request failed", ts: 2 },
            taskViewState: createErrorTaskViewState(),
        })

        expect(resolved).toBe("API request failed")
    })

    it("does not attach the projected error interaction to an earlier request row", () => {
        const resolved = resolveApiErrorMessage({
            isLast: false,
            lastModifiedMessage: { type: "ask", ask: "api_req_failed", text: "API request failed", ts: 2 },
            taskViewState: createErrorTaskViewState(),
        })

        expect(resolved).toBeUndefined()
    })

    it("does not attach a projected error before its presentation message is synchronized", () => {
        const resolved = resolveApiErrorMessage({
            isLast: true,
            lastModifiedMessage: { type: "ask", ask: "api_req_failed", text: "Previous API error", ts: 1 },
            taskViewState: createErrorTaskViewState(),
        })

        expect(resolved).toBeUndefined()
    })

    it("uses the verified presentation text while the exact ask row is outside the loaded message window", () => {
        const taskViewState = createErrorTaskViewState()
        if (!taskViewState.activeInteraction) throw new Error("Expected active interaction")
        taskViewState.activeInteraction.presentationText = "Current API request failed"
        taskViewState.activeInteraction.anchorVerified = true

        const resolved = resolveApiErrorMessage({
            isLast: true,
            lastModifiedMessage: { type: "ask", ask: "api_req_failed", text: "Previous API error", ts: 1 },
            taskViewState,
        })

        expect(resolved).toBe("Current API request failed")
    })

    it("clears both persisted API error carriers when canonical Task state has recovered", () => {
        const recoveredView: TaskViewState = {
            taskId: "task-1",
            phase: "between_turns",
            stateRevision: 3,
            input: { enabled: true, acceptsText: true, acceptsImages: true, acceptsFiles: true, enterAction: "reply" },
            footer: { actions: [] },
        }
        const resolved = resolveApiErrorMessage({
            isLast: true,
            lastModifiedMessage: { type: "ask", ask: "api_req_failed", text: "Profile not valid", ts: 2 },
            streamingFailedMessage: "Profile not valid",
            taskViewState: recoveredView,
        })

        expect(resolved).toBeUndefined()
    })

    it("keeps a streaming failure that is not owned by an api_req_failed interaction", () => {
        const resolved = resolveApiErrorMessage({
            isLast: true,
            lastModifiedMessage: { type: "say", say: "text", text: "Partial response", ts: 2 },
            streamingFailedMessage: "Connection interrupted",
            taskViewState: {
                taskId: "task-1",
                phase: "paused",
                stateRevision: 3,
                input: { enabled: true, acceptsText: true, acceptsImages: true, acceptsFiles: true, enterAction: "reply" },
                footer: { actions: [] },
            },
        })

        expect(resolved).toBe("Connection interrupted")
    })

    it("keeps legacy api_req_failed message when snapshot-first message is unavailable", () => {
        const resolved = resolveApiErrorMessage({
            isLast: true,
            lastModifiedMessage: { type: "ask", ask: "api_req_failed", text: "Legacy API error", ts: 1 },
        })

        expect(resolved).toBe("Legacy API error")
    })

    it("does not show stale legacy api_req_failed message on non-last rows", () => {
        const resolved = resolveApiErrorMessage({
            isLast: false,
            lastModifiedMessage: { type: "ask", ask: "api_req_failed", text: "Legacy API error", ts: 1 },
        })

        expect(resolved).toBeUndefined()
    })
})

describe("image generation row expansion", () => {
    const imageMessage: UiMessage = {
        ts: 42,
        type: "say",
        say: "tool",
        text: JSON.stringify({
            tool: "generateImage",
            imageGeneration: {
                schemaVersion: 1,
                status: "completed",
                requestId: "request-1",
                prompt: "A blue owl",
                count: 1,
            },
        }),
    }

    it("defaults image rows to expanded and toggles from the effective state", () => {
        expect(resolveMessageRowExpanded(imageMessage, {})).toBe(true)
        const collapsed = toggleMessageRowExpansion(imageMessage, {})
        expect(collapsed).toEqual({ 42: false })
        expect(resolveMessageRowExpanded(imageMessage, collapsed)).toBe(false)
        expect(toggleMessageRowExpansion(imageMessage, collapsed)).toEqual({ 42: true })
    })

    it("keeps ordinary rows collapsed by default", () => {
        expect(resolveMessageRowExpanded(createTextMessage(7, "answer"), {})).toBe(false)
    })
})

describe("groupMessages", () => {
    it("finds expandable conversation messages nested in a browser-session row", () => {
        const reasoning = createReasoningMessage(3, "Browser reasoning")
        const grouped = groupMessages([
            { ts: 1, type: "say", say: "browser_action_launch", text: "https://one.example" },
            { ts: 2, type: "say", say: "browser_action_result", text: JSON.stringify({ currentUrl: "https://one.example" }) },
            reasoning,
        ])

        expect(findGroupedMessageByTs(grouped, reasoning.ts)).toEqual({ groupIndex: 0, message: reasoning })
        expect(findGroupedMessageByTs(grouped, 999)).toBeUndefined()
    })

    it("keeps consecutive browser sessions in separate virtual rows", () => {
        const grouped = groupMessages([
            { ts: 1, type: "say", say: "browser_action_launch", text: "https://one.example" },
            { ts: 2, type: "say", say: "browser_action_result", text: JSON.stringify({ currentUrl: "https://one.example" }) },
            createReasoningMessage(3, "First session reasoning"),
            { ts: 4, type: "say", say: "browser_action_launch", text: "https://two.example" },
            { ts: 5, type: "say", say: "browser_action_result", text: JSON.stringify({ currentUrl: "https://two.example" }) },
        ])

        expect(grouped).toHaveLength(2)
        expect(grouped.every(Array.isArray)).toBe(true)
        expect((grouped[0] as UiMessage[]).map((message) => message.ts)).toEqual([1, 2, 3])
        expect((grouped[1] as UiMessage[]).map((message) => message.ts)).toEqual([4, 5])
    })
})

describe("browser session rows", () => {
    const roundCheckpoint = (ts: number): UiMessage => ({
        ts,
        type: "say",
        say: "checkpoint_created",
        lastCheckpointHash: ["files-1"],
        checkpointSource: { kind: "round_start", turnId: `turn-${ts}` },
    })
    const completedRequest = (ts: number) => createRequestMessage(ts, { cost: 0.01 })
    const launch = (ts: number): UiMessage => ({ ts, type: "say", say: "browser_action_launch", text: "https://example.com" })
    const browserAction = (ts: number, action: string): UiMessage => ({
        ts,
        type: "say",
        say: "browser_action",
        text: JSON.stringify({ action, coordinate: "10,10" }),
    })
    const browserResult = (ts: number): UiMessage => ({
        ts,
        type: "say",
        say: "browser_action_result",
        text: JSON.stringify({ currentUrl: "https://example.com", screenshot: `data:image/png;base64,${"A".repeat(64)}` }),
    })
    const command = (ts: number): UiMessage => ({ ts, type: "say", say: "command", text: "npm test" })
    const timestamps = (row: UiMessage | UiMessage[]) => (Array.isArray(row) ? row.map((message) => message.ts) : row.ts)

    /** Launch round, one browser round, a close round, then a command round. */
    const transcript: UiMessage[] = [
        roundCheckpoint(10),
        completedRequest(11),
        createReasoningMessage(12, "open the docs"),
        launch(13),
        browserResult(14),
        roundCheckpoint(20),
        completedRequest(21),
        browserAction(22, "click"),
        browserResult(23),
        roundCheckpoint(30),
        completedRequest(31),
        browserAction(32, "close"),
        roundCheckpoint(40),
        completedRequest(41),
        command(42),
    ]

    it("folds every browser round, including the launch round's restore point and thinking, into one closed session", () => {
        const rows = groupChatRows(transcript)

        expect(rows.map(timestamps)).toEqual([[10, 12, 13, 14, 20, 22, 23, 30, 32], 40, 42])
        const [session] = rows
        expect(isBrowserSession(session) && session._end).toBe("closed")
        expect(isBrowserSession(session) && session._browserSessionId).toBe("browser:13")
    })

    it("hands the restore point and thinking of the round that leaves the browser back to the timeline", () => {
        const rows = groupChatRows([
            ...transcript.slice(0, 9),
            roundCheckpoint(30),
            completedRequest(31),
            createReasoningMessage(33, "now run the tests"),
            command(34),
        ])

        expect(rows.map(timestamps)).toEqual([[10, 12, 13, 14, 20, 22, 23], 30, 33, 34])
        expect(isBrowserSession(rows[0]) && rows[0]._end).toBe("ended")
    })

    it("records an error that ends the session as a failure", () => {
        const rows = groupMessages([
            launch(1),
            browserResult(2),
            browserAction(3, "click"),
            { ts: 4, type: "say", say: "error", text: "Navigation timeout" },
        ])

        expect(rows.map(timestamps)).toEqual([[1, 2, 3], 4])
        expect(isBrowserSession(rows[0]) && rows[0]._end).toBe("failed")
    })

    it("ends the session as interrupted when the request it waited on was cancelled", () => {
        const rows = groupMessages([
            launch(1),
            browserResult(2),
            createRequestMessage(3, { cancelReason: "user_cancelled" }),
            createRequestMessage(4, {}),
        ])

        expect(rows.map(timestamps)).toEqual([[1, 2, 3], 4])
        expect(isBrowserSession(rows[0]) && rows[0]._end).toBe("interrupted")
    })

    it("gives browser rows whose launch is not loaded a session card instead of ordinary rows", () => {
        const rows = groupChatRows(transcript.slice(7))

        expect(rows.map(timestamps)).toEqual([[22, 23, 30, 32], 40, 42])
        expect(isBrowserSession(rows[0])).toBe(true)
        expect(rows.filter((row) => !Array.isArray(row) && row.say?.startsWith("browser_action"))).toEqual([])
    })

    it("leaves a session the transcript still ends in open", () => {
        const rows = groupChatRows(transcript.slice(0, 9))

        expect(isBrowserSession(rows[0]) && rows[0]._end).toBe("open")
    })
})

describe("groupLowStakesTools", () => {
    it("ignores text that arrives after a low-stakes tool group has started", () => {
        const grouped = groupLowStakesTools([
            createTextMessage(1, "Initial text"),
            createToolMessage(2, "readFile"),
            createTextMessage(3, "Late text that should be ignored"),
        ])

        expect(grouped).toHaveLength(2)
        expect(grouped[0]).toMatchObject({ type: "say", say: "text", text: "Initial text" })
        expect(isToolGroup(grouped[1])).toBe(true)

        if (isToolGroup(grouped[1])) {
            expect(grouped[1].every((message) => message.say !== "text")).toBe(true)
        }
    })

    it("keeps text when no low-stakes tool group is active", () => {
        const grouped = groupLowStakesTools([
            createTextMessage(1, "Initial text"),
            createToolMessage(2, "editedExistingFile"),
            createTextMessage(3, "Follow-up text"),
        ])

        expect(grouped).toHaveLength(3)
        expect(grouped[0]).toMatchObject({ type: "say", say: "text", text: "Initial text" })
        expect(grouped[1]).toMatchObject({ type: "say", say: "tool" })
        expect(grouped[2]).toMatchObject({ type: "say", say: "text", text: "Follow-up text" })
    })

    it("keeps standalone reasoning when no low-stakes tool group follows", () => {
        const grouped = groupLowStakesTools([
            createReasoningMessage(1, "Thinking through options"),
            createTextMessage(2, "Answer text"),
        ])

        expect(grouped).toHaveLength(2)
        expect(grouped[0]).toMatchObject({ type: "say", say: "reasoning", text: "Thinking through options" })
        expect(grouped[1]).toMatchObject({ type: "say", say: "text", text: "Answer text" })
    })

    it("keeps standalone reasoning before a non-low-stakes tool", () => {
        const grouped = groupLowStakesTools([
            createReasoningMessage(1, "Thinking through options"),
            createToolMessage(2, "editedExistingFile"),
        ])

        expect(grouped).toHaveLength(2)
        expect(grouped[0]).toMatchObject({ type: "say", say: "reasoning", text: "Thinking through options" })
        expect(grouped[1]).toMatchObject({ type: "say", say: "tool" })
    })

    it("keeps reasoning visible when low-stakes tool group starts immediately after", () => {
        const grouped = groupLowStakesTools([createReasoningMessage(1, "Planning next read"), createToolMessage(2, "readFile")])

        expect(grouped).toHaveLength(2)
        expect(grouped[0]).toMatchObject({ type: "say", say: "reasoning", text: "Planning next read" })
        expect(isToolGroup(grouped[1])).toBe(true)
    })
})

describe("groupLowStakesTools round boundaries", () => {
    const request = (ts: number) => ({ ts, type: "say", say: "api_req_started", text: "{}" }) as UiMessage
    const groupMembers = (grouped: ReturnType<typeof groupLowStakesTools>) =>
        grouped.filter(isToolGroup).map((group) => group.map((message) => message.ts))

    // Each request is a round of its own: its tools never join the group of the
    // round before, so a later round cannot change what an earlier one shows.
    it("closes a group at the next request so each round keeps its own tools", () => {
        const grouped = groupLowStakesTools([
            request(1),
            createToolMessage(2, "readFile"),
            request(3),
            createToolMessage(4, "searchFiles"),
        ])

        expect(groupMembers(grouped)).toEqual([
            [1, 2],
            [3, 4],
        ])
    })

    it("keeps a finished round's group fixed while the next round streams", () => {
        const finished = [request(1), createToolMessage(2, "readFile")]

        const whileRequesting = groupMembers(groupLowStakesTools([...finished, request(3)]))
        const afterNextRead = groupMembers(groupLowStakesTools([...finished, request(3), createToolMessage(4, "readFile")]))

        expect(whileRequesting[0]).toEqual([1, 2])
        expect(afterNextRead[0]).toEqual([1, 2])
    })

    it("keeps the logical group id stable while tools append to one round", () => {
        const before = groupLowStakesTools([request(1), createToolMessage(2, "readFile")]).find(isToolGroup)
        const after = groupLowStakesTools([
            request(1),
            createToolMessage(2, "readFile"),
            createToolMessage(3, "searchFiles"),
        ]).find(isToolGroup)

        expect(before?._toolGroupId).toBe("tool:2")
        expect(after?._toolGroupId).toBe(before?._toolGroupId)
    })

    it("shows the text of a later round instead of folding it into an earlier group", () => {
        const grouped = groupLowStakesTools([
            request(1),
            createToolMessage(2, "readFile"),
            request(3),
            createTextMessage(4, "Second round answer"),
        ])

        expect(grouped.some((item) => !Array.isArray(item) && item.ts === 4)).toBe(true)
    })
})

describe("groupChatRows request rounds", () => {
    const completedRequest = (ts: number) => createRequestMessage(ts, { cost: 0.01 })
    const streamingRequest = (ts: number) => createRequestMessage(ts, {})
    // Read-only rounds may fold into one exploration run; each round keeps its own group inside it.
    const groupMembers = (grouped: ReturnType<typeof groupChatRows>) =>
        grouped
            .flatMap((row) => (isExplorationRun(row) ? row._rounds.flatMap((round) => round.entries.filter(isToolGroup)) : [row]))
            .filter(isToolGroup)
            .map((group) => group.map((message) => message.ts))

    // A successful request draws no row, so it is gone from the visible list
    // before grouping. Rounds therefore come from the whole transcript: two
    // rounds stay apart even when no checkpoint row was written between them.
    it("keeps each round's tools in their own group when no checkpoint separates the rounds", () => {
        const transcript = [
            completedRequest(1),
            createToolMessage(2, "readFile"),
            completedRequest(3),
            createToolMessage(4, "searchFiles"),
        ]

        expect(groupMembers(groupChatRows(transcript))).toEqual([[2], [4]])
    })

    it("keeps a finished round's group fixed while the next round streams", () => {
        const finished = [completedRequest(1), createToolMessage(2, "readFile"), createToolMessage(3, "readFile")]

        const before = groupMembers(groupChatRows(finished))
        const whileStreaming = groupMembers(groupChatRows([...finished, streamingRequest(4), createToolMessage(5, "readFile")]))

        expect(whileStreaming[0]).toEqual(before[0])
        expect(whileStreaming).toEqual([[2, 3], [5]])
    })

    it("keeps a later round's tool-owned response separate from an earlier read group", () => {
        const response = createToolMessage(4, "actModeRespond")
        const transcript = [completedRequest(1), createToolMessage(2, "readFile"), completedRequest(3), response]
        const grouped = groupChatRows(transcript)

        expect(groupMembers(grouped)).toEqual([[2]])
        expect(grouped[1]).toEqual(response)
    })

    it("stops drawing a failed request once the next round's request ran, without folding it into that round", () => {
        const transcript = [
            createRequestMessage(1, { streamingFailedMessage: "stream dropped" }),
            completedRequest(2),
            createToolMessage(3, "readFile"),
        ]

        const grouped = groupChatRows(transcript)

        expect(groupMembers(grouped)).toEqual([[3]])
        expect(grouped).toHaveLength(1)
    })

    it("still groups the tools of one round together", () => {
        const transcript = [completedRequest(1), createToolMessage(2, "readFile"), createToolMessage(3, "searchFiles")]

        expect(groupMembers(groupChatRows(transcript))).toEqual([[2, 3]])
    })
})

describe("groupLowStakesTools checkpoint visibility", () => {
    // Round checkpoints are written before each request, and an edit adds its
    // own file restore point; every one of them is a row the user can restore.
    const turn: UiMessage[] = [
        { type: "say", say: "user_feedback", text: "look it up", ts: 10 },
        { type: "say", say: "checkpoint_created", ts: 11 },
        createRequestMessage(12, { cost: 0.01 }),
        createToolMessage(13, "readFile"),
        createToolMessage(14, "readFile"),
        { type: "say", say: "checkpoint_created", ts: 15 },
        createRequestMessage(16, { cost: 0.01 }),
        createToolMessage(17, "readFile"),
        { type: "say", say: "checkpoint_created", ts: 18, checkpointAnchorTs: 15 },
        createToolMessage(19, "editedExistingFile"),
    ]
    const grouped = groupLowStakesTools(groupMessages(filterVisibleMessages(turn)))
    const standalone = (ts: number) =>
        grouped.some((item) => !Array.isArray(item) && item.say === "checkpoint_created" && item.ts === ts)

    it.each([11, 15, 18])("renders checkpoint %i as its own row", (ts) => {
        expect(standalone(ts)).toBe(true)
    })

    it("never absorbs a checkpoint into a read group", () => {
        const absorbed = grouped
            .filter(isToolGroup)
            .flat()
            .filter((message) => message.say === "checkpoint_created")

        expect(absorbed).toEqual([])
    })

    it("ends the read group at the checkpoint that follows it", () => {
        const groupIndex = grouped.findIndex(
            (item) => isToolGroup(item) && item.some((message) => message.ts === 13 || message.ts === 14),
        )
        const next = grouped[groupIndex + 1]

        expect(groupIndex).toBeGreaterThanOrEqual(0)
        expect(!Array.isArray(next) && next.say === "checkpoint_created" && next.ts).toBe(15)
    })
})

describe("pre-edit checkpoint card association", () => {
    const tool = createToolMessage(50, "editedExistingFile")
    const checkpoint: UiMessage = {
        type: "say",
        say: "checkpoint_created",
        ts: 51,
        checkpointSource: {
            kind: "pre_edit",
            toolTs: 50,
            toolName: "replace_in_file",
            dlineTid: "tool-50",
        },
    }

    it("does not allocate another rendered row when the source tool is loaded", () => {
        expect(filterVisibleMessages([tool, checkpoint])).toEqual([tool])
        expect(groupChatRows([tool, checkpoint])).toHaveLength(1)
    })

    it("keeps the restore row when paging omitted the source tool", () => {
        expect(filterVisibleMessages([checkpoint])).toEqual([checkpoint])
    })

    it("hides only the checkpoint row when another message shares the checkpoint timestamp", () => {
        const sameTimestamp = createReasoningMessage(51, "keep this row")

        expect(filterVisibleMessages([tool, sameTimestamp, checkpoint])).toEqual([tool, sameTimestamp])
    })

    it("does not attach to an unrelated or backend-only row that merely shares the timestamp", () => {
        const unrelated = createReasoningMessage(50, "not a tool")
        const backendOnly: UiMessage = { ts: 50, type: "say", say: "state_snapshot" }

        expect(filterVisibleMessages([unrelated, checkpoint])).toEqual([unrelated, checkpoint])
        expect(filterVisibleMessages([backendOnly, checkpoint])).toEqual([checkpoint])
    })

    it("keeps the restore row when duplicate completed tool presentations make the owner ambiguous", () => {
        const duplicate = { ...tool, text: JSON.stringify({ tool: "newFileCreated", path: "src/other.ts" }) }

        expect(filterVisibleMessages([tool, duplicate, checkpoint])).toContain(checkpoint)
    })

    it("associates a completed tool update when its earlier partial has the same timestamp", () => {
        const partial = { ...tool, partial: true }
        const complete = { ...tool, partial: false }

        expect(filterVisibleMessages([partial, complete, checkpoint])).not.toContain(checkpoint)
    })

    it("keeps round checkpoints independent even when a tool shares their window", () => {
        const round: UiMessage = {
            type: "say",
            say: "checkpoint_created",
            ts: 52,
            checkpointSource: { kind: "round_start", turnId: "turn-52" },
        }

        expect(filterVisibleMessages([tool, round])).toEqual([tool, round])
    })
})
