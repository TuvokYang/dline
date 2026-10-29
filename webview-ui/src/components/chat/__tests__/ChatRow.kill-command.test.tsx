import { fireEvent, render, screen, within } from "@testing-library/react"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import { TaskActivityNavigationProvider } from "../activity/TaskActivityNavigationContext"
import { ChatRowContent } from "../ChatRow"

void React

const target = vi.hoisted(() => ({ status: undefined as string | undefined }))

vi.mock("../activity/useTaskActivities", () => ({
    useTaskActivities: () => ({
        activities: [],
        activeCount: 0,
        getById: (activityId: string) => (target.status ? { activityId, status: target.status } : undefined),
    }),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({
        backgroundEditEnabled: false,
        mcpServers: [],
        mcpMarketplaceCatalog: [],
        onRelinquishControl: () => () => undefined,
        vscodeTerminalExecutionMode: "backgroundExec",
        clineMessages: [],
        showFeatureTips: false,
        taskViewState: undefined,
        currentTaskItem: { id: "task-1" },
    }),
}))

const REQUESTED = "Termination was requested for the running command."

/** `null` renders the row the backend writes when the function id matched no command. */
function renderKillRow(activity: string | null = "command-activity", navigate = vi.fn()) {
    const activityId = activity ?? undefined
    render(
        <TaskActivityNavigationProvider onNavigate={navigate}>
            <ChatRowContent
                isExpanded={false}
                isLast
                message={{
                    ts: 1,
                    type: "say",
                    say: "tool",
                    text: JSON.stringify({ tool: "killCommand", path: "npm install", content: REQUESTED, activityId }),
                }}
                onSetQuote={vi.fn()}
                onToggleExpand={vi.fn()}
            />
        </TaskActivityNavigationProvider>,
    )
    return screen.getByTestId("kill-command-result")
}

describe("ChatRow kill command result", () => {
    it("renders the command and navigates to its activity", () => {
        target.status = undefined
        const navigate = vi.fn()
        const result = renderKillRow("command-activity", navigate)

        expect(screen.getByTestId("kill-command-scroll")).toHaveClass("max-h-[60vh]", "overflow-y-auto", "overscroll-x-contain")
        // Until the activity status arrives, the tool's own result is the only outcome known.
        expect(within(result).getByText("Dline requested command termination")).toBeVisible()
        expect(within(result).getByText(REQUESTED)).toBeVisible()
        expect(within(result).getByText("npm install")).toBeVisible()
        fireEvent.click(within(result).getByRole("button", { name: "View command activity" }))
        expect(navigate).toHaveBeenCalledWith("command-activity")
    })

    it.each([
        ["cancelling", "terminating", "Terminating command…"],
        ["cancelled", "terminated", "Command terminated"],
        ["completed", "already_finished", "Command had already finished"],
        ["timeout", "already_finished", "Command had already finished"],
        ["interrupted", "interrupted", "Command was interrupted"],
    ])("follows the targeted command to %s", (status, phase, label) => {
        target.status = status
        const result = renderKillRow()

        expect(result.getAttribute("data-phase")).toBe(phase)
        expect(within(result).getByText(label)).toBeVisible()
        expect(within(result).queryByText(REQUESTED)).toBeNull()
    })

    it("says no command matched when the function id named none", () => {
        target.status = undefined
        const result = renderKillRow(null)

        expect(result.getAttribute("data-phase")).toBe("not_running")
        expect(within(result).getByText("No running command matched")).toBeVisible()
    })
})
