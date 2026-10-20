import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import {
    describeBrowserMessage,
    headCheckpoint,
    projectBrowserSession,
    resolveBrowserSessionPhase,
    summarizeBrowserSession,
    unfoldableCheckpoints,
} from "./browser-session-model"

const checkpoint = (ts: number, files = "files-1", checkedOut = false): UiMessage => ({
    ts,
    type: "say",
    say: "checkpoint_created",
    lastCheckpointHash: [files],
    isCheckpointCheckedOut: checkedOut,
    checkpointSource: { kind: "round_start", turnId: `turn-${ts}` },
})
const reasoning = (ts: number, text = `thought ${ts}`): UiMessage => ({ ts, type: "say", say: "reasoning", text })
const launch = (ts: number): UiMessage => ({ ts, type: "say", say: "browser_action_launch", text: "https://example.com" })
const action = (ts: number, payload: Record<string, string>): UiMessage => ({
    ts,
    type: "say",
    say: "browser_action",
    text: JSON.stringify(payload),
})
const result = (ts: number, url: string): UiMessage => ({
    ts,
    type: "say",
    say: "browser_action_result",
    text: JSON.stringify({ currentUrl: url, screenshot: `data:image/png;base64,${"A".repeat(64)}` }),
})

/** launch round, two browser rounds and a close round, each led by its restore point. */
const session: UiMessage[] = [
    checkpoint(10),
    reasoning(11),
    launch(12),
    { ts: 13, type: "say", say: "browser_action_result", text: "" },
    result(14, "https://example.com"),
    checkpoint(20),
    action(21, { action: "click", coordinate: "20,30" }),
    result(22, "https://example.com/a"),
    checkpoint(30),
    reasoning(31),
    action(32, { action: "scroll_down" }),
    result(33, "https://example.com/b"),
    checkpoint(40),
    action(41, { action: "close" }),
]

describe("projectBrowserSession", () => {
    it("splits a session into one step per round, each owning its restore point, thinking, call and page", () => {
        const projection = projectBrowserSession(session)

        expect(
            projection.steps.map((step) => ({
                checkpoint: step.checkpoint?.ts,
                thoughts: step.thoughts.map((thought) => thought.ts),
                actions: step.actions.map((entry) => entry.action),
                pageIndex: step.pageIndex,
            })),
        ).toEqual([
            { checkpoint: 10, thoughts: [11], actions: ["launch"], pageIndex: 0 },
            { checkpoint: 20, thoughts: [], actions: ["click"], pageIndex: 1 },
            { checkpoint: 30, thoughts: [31], actions: ["scroll_down"], pageIndex: 2 },
            { checkpoint: 40, thoughts: [], actions: ["close"], pageIndex: 3 },
        ])
        expect(projection.pages.map((page) => page.state.url)).toEqual([
            "https://example.com",
            "https://example.com/a",
            "https://example.com/b",
            undefined,
        ])
    })

    it("keeps a round's request failure readable as a notice of that round", () => {
        const failure: UiMessage = {
            ts: 25,
            type: "say",
            say: "api_req_started",
            text: JSON.stringify({ streamingFailedMessage: "overloaded" }),
        }
        const projection = projectBrowserSession([launch(1), result(2, "https://example.com"), checkpoint(20), failure])

        expect(projection.steps.at(-1)).toMatchObject({ checkpoint: { ts: 20 }, notices: [failure], actions: [] })
    })

    it("projects approval launches, empty launch results, click, type, and close into pages", () => {
        const projection = projectBrowserSession([
            { ts: 1, type: "ask", ask: "browser_action_launch", text: "https://example.com" },
            { ts: 2, type: "say", say: "browser_action_result", text: "" },
            action(3, { action: "click", coordinate: "20,30" }),
            action(4, { action: "type", text: "hello" }),
            {
                ts: 5,
                type: "say",
                say: "browser_action_result",
                text: JSON.stringify({ currentUrl: "https://example.com/form", screenshot: "form" }),
            },
            action(6, { action: "close" }),
        ])

        expect(projection.initialUrl).toBe("https://example.com")
        expect(projection.isAutoApproved).toBe(false)
        expect(projection.hasPendingApproval).toBe(false)
        expect(projection.pages).toEqual([
            {
                state: { url: "https://example.com/form", screenshot: "form" },
                actions: [
                    { messageTs: 3, action: "click", coordinate: "20,30" },
                    { messageTs: 4, action: "type", text: "hello" },
                ],
            },
            { state: {}, actions: [{ messageTs: 6, action: "close" }] },
        ])
        expect(projection.steps.flatMap((step) => step.notices)).toEqual([])
    })

    it("degrades malformed browser payloads without moving them into notices", () => {
        const projection = projectBrowserSession([
            launch(1),
            { ts: 2, type: "say", say: "browser_action", text: "{" },
            { ts: 3, type: "say", say: "browser_action_result", text: "not-json" },
        ])

        expect(projection.pages).toEqual([{ state: {}, actions: [] }])
        expect(projection.steps.flatMap((step) => step.notices)).toEqual([])
    })
})

describe("browser session restore points", () => {
    it("heads the card with the first restore point and folds later ones that bring back the same files", () => {
        const { steps } = projectBrowserSession(session)

        expect(headCheckpoint(steps)?.ts).toBe(10)
        expect(unfoldableCheckpoints(steps)).toEqual([])
    })

    it("keeps a restore point visible when it brings back different files or is checked out", () => {
        const changed = checkpoint(20, "files-2")
        const checkedOut = checkpoint(30, "files-1", true)
        const { steps } = projectBrowserSession(
            session.map((message) => (message.ts === 20 ? changed : message.ts === 30 ? checkedOut : message)),
        )

        expect(unfoldableCheckpoints(steps).map((message) => message.ts)).toEqual([20, 30])
    })
})

describe("summarizeBrowserSession", () => {
    it("counts the rounds that called the browser and the thoughts between them", () => {
        expect(summarizeBrowserSession(projectBrowserSession(session).steps)).toBe("4 steps · 2 thoughts")
        expect(summarizeBrowserSession(projectBrowserSession([launch(1)]).steps)).toBe("1 step")
    })
})

describe("resolveBrowserSessionPhase", () => {
    const running = projectBrowserSession(session.slice(0, 8))
    const pending = projectBrowserSession([{ ts: 1, type: "ask", ask: "browser_action_launch", text: "https://example.com" }])

    it("reports how a finished session stopped", () => {
        const input = { isLast: false, projection: running, messages: session }
        expect(resolveBrowserSessionPhase({ ...input, end: "closed" })).toBe("completed")
        expect(resolveBrowserSessionPhase({ ...input, end: "ended" })).toBe("completed")
        expect(resolveBrowserSessionPhase({ ...input, end: "failed" })).toBe("failed")
        expect(resolveBrowserSessionPhase({ ...input, end: "interrupted" })).toBe("interrupted")
        expect(resolveBrowserSessionPhase({ ...input, end: "ended", projection: pending })).toBe("declined")
    })

    it("reports an open session from the task's latest row", () => {
        const input = { end: "open" as const, isLast: true, projection: running, messages: session.slice(0, 8) }
        expect(resolveBrowserSessionPhase(input)).toBe("running")
        expect(resolveBrowserSessionPhase({ ...input, projection: pending })).toBe("awaiting_approval")
        expect(resolveBrowserSessionPhase({ ...input, lastModifiedMessage: { ts: 99, type: "ask", ask: "resume_task" } })).toBe(
            "interrupted",
        )
        expect(
            resolveBrowserSessionPhase({ ...input, lastModifiedMessage: { ts: 99, type: "ask", ask: "api_req_failed" } }),
        ).toBe("interrupted")
    })
})

describe("describeBrowserMessage", () => {
    it("describes a browser row from its fields and never returns the screenshot payload", () => {
        const page = result(1, "https://example.com/a")

        expect(describeBrowserMessage(page)).toBe("Browser page: https://example.com/a")
        expect(describeBrowserMessage(action(2, { action: "click", coordinate: "20,30" }))).toBe("Click (20, 30)")
        expect(describeBrowserMessage(launch(3))).toBe("Launch browser at https://example.com")
        expect(describeBrowserMessage({ ts: 4, type: "say", say: "browser_action_result", text: "" })).toBe(
            "Opening the browser…",
        )
    })
})
