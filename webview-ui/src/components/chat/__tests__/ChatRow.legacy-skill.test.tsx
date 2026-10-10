import { render, screen } from "@testing-library/react"
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

describe("ChatRow legacy Skill rendering", () => {
    it("keeps historical useSkill messages readable after the model tool is retired", () => {
        render(
            <ChatRowContent
                {...baseProps}
                message={{
                    ts: 1,
                    type: "say",
                    say: "tool",
                    partial: false,
                    text: JSON.stringify({ tool: "useSkill", path: "review-code" }),
                }}
            />,
        )

        expect(screen.getByText("Dline loaded the skill:")).toBeInTheDocument()
        expect(screen.getByText("review-code")).toBeInTheDocument()
    })
})
