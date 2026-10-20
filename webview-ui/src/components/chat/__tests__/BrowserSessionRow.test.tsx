// @vitest-environment jsdom
import type { UiMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
import React, { type ReactElement } from "react"
import { describe, expect, it, vi } from "vitest"
import BrowserSessionRow from "../BrowserSessionRow"

void React

vi.mock("react-use", () => ({
    useSize: (element: ReactElement) => [element, { height: 100, width: 600 }],
}))

vi.mock("@vscode/webview-ui-toolkit/react", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@vscode/webview-ui-toolkit/react")>()
    return {
        ...actual,
        VSCodeButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
            <button type="button" {...props}>
                {children}
            </button>
        ),
    }
})

vi.mock("@components/browser/BrowserSettingsMenu", () => ({
    BrowserSettingsMenu: () => <button type="button">Browser settings</button>,
}))

vi.mock("@components/chat/ChatRow", () => ({
    ChatRowContent: ({ message }: { message: UiMessage }) => (
        <div data-testid={`conversation-message-${message.ts}`}>{message.text}</div>
    ),
    ProgressIndicator: () => <div>Browsing</div>,
}))

vi.mock("@components/common/CodeBlock", () => ({
    default: ({ source }: { source: string }) => <pre>{source}</pre>,
    CODE_BLOCK_BG_COLOR: "#111",
}))

vi.mock("@context/ExtensionStateContext", () => ({
    useExtensionState: () => ({
        browserSettings: { viewport: { height: 600, width: 900 } },
    }),
}))

vi.mock("../../../services/grpc-client", () => ({
    FileServiceClient: { openImage: vi.fn(async () => undefined) },
}))

vi.mock("@/components/chat/chat-view/components/messages/CheckpointMarker", () => ({
    CheckpointMarker: ({ message }: { message: UiMessage }) => <div data-testid={`checkpoint-${message.ts}`} />,
}))

function checkpoint(ts: number, files = "files-1"): UiMessage {
    return {
        ts,
        type: "say",
        say: "checkpoint_created",
        lastCheckpointHash: [files],
        checkpointSource: { kind: "round_start", turnId: `turn-${ts}` },
    }
}

function reasoning(ts: number, text: string): UiMessage {
    return { ts, type: "say", say: "reasoning", text }
}

function launch(ts: number): UiMessage {
    return { ts, type: "say", say: "browser_action_launch", text: "https://start.example" }
}

function result(ts: number, currentUrl: string): UiMessage {
    return {
        ts,
        type: "say",
        say: "browser_action_result",
        text: JSON.stringify({
            currentUrl,
            screenshot: `data:image/png;base64,${ts}`,
            currentMousePosition: "120,240",
            logs: "",
        }),
    }
}

function action(ts: number, coordinate: string): UiMessage {
    return {
        ts,
        type: "say",
        say: "browser_action",
        text: JSON.stringify({ action: "click", coordinate }),
    }
}

const baseProps = {
    expandedRows: {},
    isLast: false,
    onHeightChange: vi.fn(),
    onSetQuote: vi.fn(),
    onToggleExpand: vi.fn(),
}

/** Launch round, two browser rounds and a close round, each led by its restore point. */
const roundsWithRestorePoints: UiMessage[] = [
    checkpoint(1),
    reasoning(2, "LAUNCH_THOUGHT"),
    launch(3),
    result(4, "https://one.example"),
    checkpoint(10),
    action(11, "20,30"),
    result(12, "https://two.example"),
    checkpoint(20),
    reasoning(21, "SCROLL_THOUGHT"),
    action(22, "40,50"),
    result(23, "https://three.example"),
    checkpoint(30),
    { ts: 31, type: "say", say: "browser_action", text: JSON.stringify({ action: "close" }) },
]

describe("BrowserSessionRow", () => {
    it("folds each round's restore point and thinking into the card, keeping only the head restore point", () => {
        render(<BrowserSessionRow {...baseProps} end="closed" messages={roundsWithRestorePoints} />)

        const frame = screen.getByTestId("browser-session-frame")
        expect(frame.style.maxHeight).toBe("60vh")
        expect(frame.style.overflowY).toBe("auto")
        expect(screen.getByTestId("checkpoint-1")).toBeInTheDocument()
        for (const folded of [10, 20, 30]) expect(screen.queryByTestId(`checkpoint-${folded}`)).toBeNull()
        expect(screen.queryByText("LAUNCH_THOUGHT")).toBeNull()
        expect(screen.getByTestId("browser-session-header").textContent).toContain("Dline used the browser")
        expect(screen.getByTestId("browser-session-header").getAttribute("aria-expanded")).toBe("true")
        expect(screen.getByTestId("browser-session-steps-toggle").getAttribute("aria-expanded")).toBe("false")
        expect(screen.getByTestId("browser-session-steps-toggle").textContent).toBe("1 launch, 2 clicks · 2 thoughts · 4 rounds")
    })

    it("lists every round from the toggle under the frame and opens a round's page from its call", () => {
        render(<BrowserSessionRow {...baseProps} end="closed" messages={roundsWithRestorePoints} />)
        fireEvent.click(screen.getByTestId("browser-session-steps-toggle"))

        const steps = screen.getAllByTestId("browser-session-step")
        expect(steps).toHaveLength(4)
        expect(steps.map((step) => step.querySelector("[data-testid^='checkpoint-']")?.getAttribute("data-testid"))).toEqual([
            undefined,
            "checkpoint-10",
            "checkpoint-20",
            "checkpoint-30",
        ])
        expect(steps[2].textContent).toContain("Click (40, 50)")
        fireEvent.click(screen.getAllByTestId("browser-session-step-action")[1])
        expect(screen.getByText("Step 2 of 4")).toBeInTheDocument()
        expect(screen.getByText("https://two.example")).toBeInTheDocument()
    })

    it("folds the whole card from its header down to the header and the page URL", () => {
        const onToggleExpand = vi.fn()
        const { rerender } = render(
            <BrowserSessionRow {...baseProps} end="closed" messages={roundsWithRestorePoints} onToggleExpand={onToggleExpand} />,
        )
        fireEvent.click(screen.getByTestId("browser-session-header"))
        expect(onToggleExpand).toHaveBeenCalledWith(3)

        // The chat list records the reader's toggle as the anchor's flag.
        rerender(
            <BrowserSessionRow
                {...baseProps}
                end="closed"
                expandedRows={{ 3: true }}
                messages={roundsWithRestorePoints}
                onToggleExpand={onToggleExpand}
            />,
        )

        expect(screen.queryByTestId("browser-session-frame")).toBeNull()
        expect(screen.queryByRole("img", { name: "Browser screenshot" })).toBeNull()
        expect(screen.getByTestId("browser-session-header").getAttribute("aria-expanded")).toBe("false")
        expect(screen.getByTestId("browser-session-header").textContent).toContain("1 launch, 2 clicks · 2 thoughts · 4 rounds")
        expect(screen.getByTestId("browser-session-url-line").textContent).toBe("https://three.example")
        expect(screen.getByTestId("checkpoint-1")).toBeInTheDocument()
    })

    it("keeps a restore point that brings back different files visible while folded", () => {
        const messages = roundsWithRestorePoints.map((message) => (message.ts === 20 ? checkpoint(20, "files-2") : message))

        render(<BrowserSessionRow {...baseProps} end="closed" messages={messages} />)

        expect(screen.getByTestId("checkpoint-20")).toBeInTheDocument()
        expect(screen.queryByTestId("checkpoint-10")).toBeNull()
    })

    it("reports a session the transcript ends in as running, and as interrupted once the task waits to resume", () => {
        const open = roundsWithRestorePoints.slice(0, 7)
        const { rerender } = render(<BrowserSessionRow {...baseProps} isLast messages={open} />)
        expect(screen.getByTestId("browser-session-header").textContent).toContain("Dline is using the browser")
        expect(screen.getByText("Browsing")).toBeInTheDocument()

        rerender(
            <BrowserSessionRow
                {...baseProps}
                isLast
                lastModifiedMessage={{ ts: 99, type: "ask", ask: "resume_task" }}
                messages={open}
            />,
        )
        expect(screen.getByTestId("browser-session-header").textContent).toContain("Browser session interrupted")
        expect(screen.queryByText("Browsing")).toBeNull()
    })

    it("never draws a screenshot payload as text", () => {
        const { container } = render(<BrowserSessionRow {...baseProps} end="closed" messages={roundsWithRestorePoints} />)
        fireEvent.click(screen.getByTestId("browser-session-steps-toggle"))

        expect(container.textContent).not.toContain("base64")
    })

    it("reconstructs the latest persisted page after the row is remounted", () => {
        const messages: UiMessage[] = [
            launch(20),
            result(21, "https://one.example"),
            action(22, "40,40"),
            result(23, "https://two.example"),
        ]
        const firstRender = render(<BrowserSessionRow {...baseProps} messages={messages} />)

        fireEvent.click(screen.getByRole("button", { name: "Previous browser step" }))
        expect(screen.getByText("Step 1 of 2")).toBeInTheDocument()
        firstRender.unmount()

        render(<BrowserSessionRow {...baseProps} messages={messages} />)
        expect(screen.getByText("Step 2 of 2")).toBeInTheDocument()
        expect(screen.getByText("https://two.example")).toBeInTheDocument()
    })

    it("keeps the selected historical page when a newer browser result arrives", () => {
        const initialMessages: UiMessage[] = [
            launch(10),
            result(11, "https://one.example"),
            action(12, "10,10"),
            result(13, "https://two.example"),
        ]
        const { rerender } = render(<BrowserSessionRow {...baseProps} messages={initialMessages} />)

        fireEvent.click(screen.getByRole("button", { name: "Previous browser step" }))
        expect(screen.getByText("Step 1 of 2")).toBeInTheDocument()
        expect(screen.getByText("https://one.example")).toBeInTheDocument()

        rerender(
            <BrowserSessionRow
                {...baseProps}
                messages={[...initialMessages, action(14, "30,30"), result(15, "https://three.example")]}
            />,
        )

        expect(screen.getByText("Step 1 of 3")).toBeInTheDocument()
        expect(screen.getByText("https://one.example")).toBeInTheDocument()
        expect(screen.queryByText("https://three.example")).not.toBeInTheDocument()
    })
})
