// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest"
import type { UiMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { CheckpointsServiceClient } from "@/services/grpc-client"
import { ChatRowContent } from "../ChatRow"

void React

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({
        backgroundEditEnabled: false,
        checkpointManagerErrorMessage: undefined,
        mcpServers: [],
        mcpMarketplaceCatalog: [],
        onRelinquishControl: () => () => undefined,
        vscodeTerminalExecutionMode: "backgroundExec",
        clineMessages: [],
        showFeatureTips: true,
        taskViewState: { taskId: "task-1", taskInstanceId: "opening-1", phase: "completed" },
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
    isLast: false,
    onSetQuote: vi.fn(),
    onToggleExpand: vi.fn(),
}

function historicalInput(say: "task" | "user_feedback", ts: number, text: string): UiMessage {
    return { ts, type: "say", say, text }
}

describe("ChatRow historical input editing", () => {
    beforeEach(() => {
        vi.mocked(CheckpointsServiceClient.checkpointRestore).mockClear()
    })

    it.each([
        ["task", 101, "original task input", "edited task input"],
        ["user_feedback", 202, "original feedback", "edited feedback"],
    ] as const)("sends edited %s input through the current opening fence", async (say, ts, original, edited) => {
        render(<ChatRowContent {...baseProps} message={historicalInput(say, ts, original)} />)

        fireEvent.click(screen.getByText(original))
        const editor = screen.getByRole("textbox")
        fireEvent.change(editor, { target: { value: edited } })
        fireEvent.keyDown(editor, {
            key: "Enter",
            keyCode: 13,
            shiftKey: false,
            nativeEvent: { isComposing: false },
        })

        await waitFor(() => expect(CheckpointsServiceClient.checkpointRestore).toHaveBeenCalledOnce())
        expect(CheckpointsServiceClient.checkpointRestore).toHaveBeenCalledWith(
            expect.objectContaining({
                number: ts,
                checkpointRowTs: ts,
                taskId: "task-1",
                taskInstanceId: "opening-1",
                restoreType: "task",
                offset: 1,
                editedText: edited,
            }),
        )
    })
})
