import type { UiMessage } from "@shared/ExtensionMessage"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { userEvent, within } from "storybook/test"
import BrowserSessionRow from "./BrowserSessionRow"
import { BrowserMessageSummary } from "./browser-session/BrowserMessageSummary"
import { browserSessionAnchor } from "./browser-session/browser-session-model"
import { isBrowserSession } from "./chat-view/utils/chatRowKinds"
import { groupChatRows } from "./chat-view/utils/messageUtils"

/** A stand-in screenshot: the real payload is a PNG data URL of the same shape. */
function screenshot(title: string, color: string): string {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="${color}"/><text x="450" y="300" font-family="sans-serif" font-size="42" fill="#fff" text-anchor="middle">${title}</text></svg>`
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

const checkpoint = (ts: number, files = "files-1", checkedOut = false): UiMessage => ({
    ts,
    type: "say",
    say: "checkpoint_created",
    lastCheckpointHash: [files],
    isCheckpointCheckedOut: checkedOut,
    checkpointSource: { kind: "round_start", turnId: `turn-${ts}` },
})
const request = (ts: number): UiMessage => ({ ts, type: "say", say: "api_req_started", text: JSON.stringify({ cost: 0.01 }) })
const reasoning = (ts: number, text: string): UiMessage => ({ ts, type: "say", say: "reasoning", text })
const launch = (ts: number, url: string): UiMessage => ({ ts, type: "say", say: "browser_action_launch", text: url })
const launchApproval = (ts: number, url: string): UiMessage => ({ ts, type: "ask", ask: "browser_action_launch", text: url })
const action = (ts: number, payload: Record<string, string>): UiMessage => ({
    ts,
    type: "say",
    say: "browser_action",
    text: JSON.stringify(payload),
})
const result = (ts: number, url: string, color: string, logs = ""): UiMessage => ({
    ts,
    type: "say",
    say: "browser_action_result",
    text: JSON.stringify({ currentUrl: url, screenshot: screenshot(url, color), currentMousePosition: "620,300", logs }),
})
const error = (ts: number, text: string): UiMessage => ({ ts, type: "say", say: "error", text })

const DOCS = "http://localhost:4321/docs/usage/ide/"

/** A launch round followed by browser rounds, each with its restore point, as the task writes them. */
function browsingRounds(options: { thoughts?: boolean; changedFilesAt?: number; close?: boolean } = {}): UiMessage[] {
    const thought = (ts: number, text: string) => (options.thoughts ? [reasoning(ts, text)] : [])
    const steps: Array<[Record<string, string>, string, string]> = [
        [{ action: "click", coordinate: "860,24" }, `${DOCS}#theme`, "#5b6ee1"],
        [{ action: "scroll_down" }, `${DOCS}#panel`, "#3f8f6b"],
        [{ action: "click", coordinate: "410,320" }, `${DOCS}#light`, "#b0703c"],
        [{ action: "type", text: "light theme" }, `${DOCS}?q=light`, "#8a4fb3"],
        [{ action: "scroll_up" }, DOCS, "#3c7fb0"],
    ]
    const messages: UiMessage[] = [
        checkpoint(100),
        request(101),
        ...thought(102, "Open the docs preview to compare the light and dark captures."),
        launch(103, DOCS),
        { ts: 104, type: "say", say: "browser_action_result", text: "" },
        result(105, DOCS, "#2d2d30"),
    ]
    steps.forEach(([payload, url, color], index) => {
        const ts = 200 + index * 100
        const files = options.changedFilesAt === index ? "files-2" : "files-1"
        messages.push(
            checkpoint(ts, files),
            request(ts + 1),
            ...thought(ts + 2, `Step ${index + 1}: check what the page shows after this action.`),
            action(ts + 3, payload),
            result(ts + 4, url, color, index === 1 ? "[vite] connected." : ""),
        )
    })
    if (options.close !== false) {
        messages.push(checkpoint(800), request(801), ...thought(802, "Both themes look right; close the browser."))
        messages.push(action(803, { action: "close" }))
    }
    return messages
}

interface FixtureProps {
    transcript: UiMessage[]
    isLast?: boolean
    lastModifiedMessage?: UiMessage
    /** Start with the card folded, as if the reader folded it earlier. */
    folded?: boolean
}

/** Groups the transcript the way the chat list does and owns expansion per message timestamp. */
function BrowserSessionFixture({ transcript, isLast = false, lastModifiedMessage, folded = false }: FixtureProps) {
    const session = groupChatRows(transcript).find(isBrowserSession)
    const anchor = session ? browserSessionAnchor(session) : undefined
    const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>(folded && anchor ? { [anchor.ts]: true } : {})
    if (!session) return <div>The transcript did not group into a browser session.</div>
    return (
        <div style={{ width: "100%", maxWidth: 560, paddingTop: 16 }}>
            <BrowserSessionRow
                end={session._end}
                expandedRows={expandedRows}
                isLast={isLast}
                lastModifiedMessage={lastModifiedMessage ?? transcript.at(-1)}
                messages={session}
                onHeightChange={() => {}}
                onSetQuote={() => {}}
                onToggleExpand={(ts) => setExpandedRows((rows) => ({ ...rows, [ts]: !rows[ts] }))}
            />
        </div>
    )
}

const meta = {
    title: "Chat/Browser Session",
    component: BrowserSessionFixture,
    parameters: { layout: "fullscreen" },
} satisfies Meta<typeof BrowserSessionFixture>

export default meta
type Story = StoryObj<typeof meta>

/** Opens the round list from the toggle at the bottom of the frame. */
async function showSteps({ canvasElement }: { canvasElement: HTMLElement }) {
    await userEvent.click(within(canvasElement).getByTestId("browser-session-steps-toggle"))
}

/** Closed session: the restore point before launch, the header, then the frame with the round toggle at its bottom. */
export const Completed: Story = {
    args: { transcript: browsingRounds() },
}

/** Same session with its rounds listed: each round's restore point and browser call; clicking a call opens its page. */
export const CompletedWithSteps: Story = {
    args: { transcript: browsingRounds() },
    play: showSteps,
}

/** The whole card folded from its header: only the header and the page URL remain. */
export const Folded: Story = {
    args: { transcript: browsingRounds({ thoughts: true }), folded: true },
}

/** A thinking model: each round's thought folds into the card instead of stacking under the frame. */
export const WithThinking: Story = {
    args: { transcript: browsingRounds({ thoughts: true }) },
}

/** Thinking session with its rounds listed: thoughts sit in the round they belong to. */
export const WithThinkingSteps: Story = {
    args: { transcript: browsingRounds({ thoughts: true }) },
    play: showSteps,
}

/** Files changed during the session: that restore point stays visible while the rounds are folded. */
export const FilesChangedMidSession: Story = {
    args: { transcript: browsingRounds({ changedFilesAt: 2 }) },
}

/** Files changed during the session, card folded: the restore point is still reachable. */
export const FilesChangedFolded: Story = {
    args: { transcript: browsingRounds({ changedFilesAt: 2 }), folded: true },
}

/** Still browsing: the transcript ends inside the session. */
export const Running: Story = {
    args: { transcript: browsingRounds({ close: false, thoughts: true }), isLast: true },
}

/** Waiting for the user to approve the launch. */
export const AwaitingApproval: Story = {
    args: { transcript: [checkpoint(100), request(101), launchApproval(102, DOCS)], isLast: true },
}

/** The launch was not approved and the task moved on. */
export const Declined: Story = {
    args: {
        transcript: [
            checkpoint(100),
            request(101),
            launchApproval(102, DOCS),
            { ts: 103, type: "say", say: "user_feedback", text: "Skip the browser." },
        ],
    },
}

/** The task was cancelled while browsing and is waiting to resume. */
export const Interrupted: Story = {
    args: {
        transcript: browsingRounds({ close: false }),
        isLast: true,
        lastModifiedMessage: { ts: 9_000, type: "ask", ask: "resume_task" },
    },
}

/** A browser call failed: the error ends the session without a close action. */
export const Failed: Story = {
    args: {
        transcript: [
            // Through the second browser round's click, before its page arrived.
            ...browsingRounds({ close: false }).slice(0, 13),
            error(9_001, "Error executing browser_action: Navigation timeout of 30000 ms exceeded"),
        ],
    },
}

/** The loaded window starts mid-session: the orphan result still gets a card, never its raw payload. */
export const WindowStartsMidSession: Story = {
    args: { transcript: browsingRounds().slice(8) },
}

/** The generic row renderer's fallback for a browser row: a one-line description, never the screenshot payload. */
export const StandaloneBrowserRow: Story = {
    args: { transcript: [] },
    render: () => (
        <div style={{ display: "grid", gap: 12, maxWidth: 560, paddingTop: 16 }}>
            <BrowserMessageSummary message={launch(1, DOCS)} />
            <BrowserMessageSummary message={action(2, { action: "click", coordinate: "410,320" })} />
            <BrowserMessageSummary message={result(3, `${DOCS}#light`, "#b0703c")} />
            <BrowserMessageSummary message={{ ts: 4, type: "say", say: "browser_action_result", text: "" }} />
        </div>
    ),
}
