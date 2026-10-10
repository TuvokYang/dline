import { fireEvent, render, screen, within } from "@testing-library/react"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import { TaskActivityNavigationProvider } from "../activity/TaskActivityNavigationContext"
import { ChatRowContent } from "../ChatRow"

void React

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

describe("ChatRow kill command result", () => {
    it("renders the command and navigates to its activity", () => {
        const navigate = vi.fn()
        render(
            <TaskActivityNavigationProvider onNavigate={navigate}>
                <ChatRowContent
                    isExpanded={false}
                    isLast
                    message={{
                        ts: 1,
                        type: "say",
                        say: "tool",
                        text: JSON.stringify({
                            tool: "killCommand",
                            path: "npm install",
                            content: "Termination was requested for the running command.",
                            activityId: "command-activity",
                        }),
                    }}
                    onSetQuote={vi.fn()}
                    onToggleExpand={vi.fn()}
                />
                ,
            </TaskActivityNavigationProvider>,
        )

        const result = screen.getByTestId("kill-command-result")
        expect(screen.getByTestId("kill-command-scroll")).toHaveClass("max-h-[60vh]", "overflow-y-auto", "overscroll-x-contain")
        expect(within(result).getByText("Dline requested command termination:")).toBeVisible()
        expect(within(result).getByText("npm install")).toBeVisible()
        fireEvent.click(within(result).getByRole("button", { name: "View command activity" }))
        expect(navigate).toHaveBeenCalledWith("command-activity")
    })
})
