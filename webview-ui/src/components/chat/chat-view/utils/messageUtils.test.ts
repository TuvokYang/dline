import type { TaskViewState, UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import {
    filterVisibleMessages,
    findGroupedMessageByTs,
    groupLowStakesTools,
    groupMessages,
    isPrimaryCheckpointForUserTurn,
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

describe("isPrimaryCheckpointForUserTurn", () => {
    it("keeps the restore baseline and hides later checkpoints across opaque reasoning and file edits", () => {
        const messages: UiMessage[] = [
            { type: "say", say: "task", text: "update files", ts: 1 },
            { type: "say", say: "checkpoint_created", ts: 2 },
            { type: "say", say: "reasoning", text: "", ts: 3 },
            createToolMessage(4, "editedExistingFile"),
            { type: "say", say: "checkpoint_created", ts: 5 },
            createToolMessage(6, "editedExistingFile"),
            { type: "say", say: "checkpoint_created", ts: 7 },
        ]

        expect(isPrimaryCheckpointForUserTurn(2, messages)).toBe(true)
        expect(isPrimaryCheckpointForUserTurn(5, messages)).toBe(false)
        expect(isPrimaryCheckpointForUserTurn(7, messages)).toBe(false)
    })

    it("starts a new visible baseline after user feedback", () => {
        const messages: UiMessage[] = [
            { type: "say", say: "task", text: "first turn", ts: 1 },
            { type: "say", say: "checkpoint_created", ts: 2 },
            { type: "say", say: "user_feedback", text: "continue", ts: 3 },
            { type: "say", say: "checkpoint_created", ts: 4 },
        ]

        expect(isPrimaryCheckpointForUserTurn(4, messages)).toBe(true)
    })
})

describe("groupLowStakesTools checkpoint visibility", () => {
    // An MCP call or a command only owes its round a restore point, which is
    // committed later and lands after the next round's read rows.
    const mcpTurn: UiMessage[] = [
        { type: "say", say: "checkpoint_created", ts: 2 },
        { type: "say", say: "user_feedback", text: "look it up", ts: 10 },
        createRequestMessage(11, { cost: 0.01 }),
        {
            type: "say",
            say: "use_mcp_server",
            text: JSON.stringify({ type: "use_mcp_tool", serverName: "docs", toolName: "search", arguments: "{}" }),
            ts: 12,
        },
        createRequestMessage(15, { cost: 0.01 }),
        createToolMessage(16, "readFile"),
        { type: "say", say: "checkpoint_created", ts: 17 },
        createToolMessage(18, "readFile"),
        { type: "say", say: "checkpoint_created", ts: 19 },
    ]
    const isPrimary = (ts: number) => isPrimaryCheckpointForUserTurn(ts, mcpTurn)
    const standalone = (grouped: (UiMessage | UiMessage[])[], ts: number) =>
        grouped.some((item) => !Array.isArray(item) && item.say === "checkpoint_created" && item.ts === ts)
    const grouped = (rule?: (ts: number) => boolean) => groupLowStakesTools(groupMessages(filterVisibleMessages(mcpTurn)), rule)

    it("keeps a turn's primary checkpoint out of a read group, so the turn still shows one", () => {
        expect(isPrimary(17)).toBe(true)

        const result = grouped(isPrimary)

        expect(standalone(result, 17)).toBe(true)
        expect(
            result
                .filter(isToolGroup)
                .flat()
                .some((message) => message.ts === 17),
        ).toBe(false)
    })

    it("still absorbs later checkpoints of the same turn into the read group", () => {
        const result = grouped(isPrimary)

        expect(isPrimary(19)).toBe(false)
        expect(standalone(result, 19)).toBe(false)
        expect(
            result
                .filter(isToolGroup)
                .flat()
                .some((message) => message.ts === 19),
        ).toBe(true)
    })
})
