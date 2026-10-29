import { fireEvent, render, screen } from "@testing-library/react"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import { ChatRowContent } from "../ChatRow"

void React

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({
        backgroundEditEnabled: true,
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

const baseProps = {
    isExpanded: false,
    isLast: true,
    onSetQuote: vi.fn(),
    onToggleExpand: vi.fn(),
}

describe("ChatRow apply_patch rendering", () => {
    it("renders every added file from a completed apply_patch tool message", () => {
        const patch = [
            "*** Begin Patch",
            "*** Add File: first.txt",
            "+alpha",
            "*** Add File: second.txt",
            "+beta",
            "*** End Patch",
        ].join("\n")

        render(
            <ChatRowContent
                {...baseProps}
                message={{
                    ts: 1,
                    type: "say",
                    say: "tool",
                    partial: false,
                    text: JSON.stringify({
                        tool: "newFileCreated",
                        path: "first.txt",
                        content: patch,
                        operationIsLocatedInWorkspace: true,
                    }),
                }}
            />,
        )

        expect(screen.getByText("first.txt")).toBeInTheDocument()
        expect(screen.getByText("second.txt")).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: /first\.txt/ }))
        fireEvent.click(screen.getByRole("button", { name: /second\.txt/ }))
        expect(screen.getByText("alpha")).toHaveClass("text-green-400")
        expect(screen.getByText("beta")).toHaveClass("text-green-400")
    })
})
