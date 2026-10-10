// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest"
import { render, screen } from "@testing-library/react"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import { ChatRowContent } from "../ChatRow"

void React

vi.mock("@context/ExtensionStateContext", () => ({
    useExtensionState: () => ({
        backgroundEditEnabled: false,
        checkpointManagerErrorMessage: undefined,
        mcpServers: [],
        mcpMarketplaceCatalog: [],
        onRelinquishControl: () => () => undefined,
        vscodeTerminalExecutionMode: "backgroundExec",
        clineMessages: [],
        showFeatureTips: true,
        taskViewState: { taskId: "task-1", phase: "completed" },
        currentTaskItem: { id: "task-1" },
    }),
}))

vi.mock("@/services/grpc-client", () => ({
    CheckpointsServiceClient: { checkpointRestore: vi.fn(async () => undefined) },
    FileServiceClient: {
        ifFileExistsRelativePath: vi.fn(async () => ({ value: false })),
        openFile: vi.fn(async () => undefined),
    },
}))

const baseProps = {
    isExpanded: false,
    isLast: true,
    onSetQuote: vi.fn(),
    onToggleExpand: vi.fn(),
}

describe("ChatRow queued user input", () => {
    it("forwards persisted queue semantics through the user_feedback branch", () => {
        render(
            <ChatRowContent
                {...baseProps}
                message={{
                    ts: 1,
                    type: "say",
                    say: "user_feedback",
                    text: "## Queued heading",
                    userInputKind: "queued",
                    queuedInputMode: "steering",
                }}
            />,
        )

        const message = screen.getByTestId("queued-user-input")
        expect(message).toHaveAttribute("data-queued-input-mode", "steering")
        expect(screen.getByRole("heading", { name: "Queued heading" })).toBeInTheDocument()
    })
})
