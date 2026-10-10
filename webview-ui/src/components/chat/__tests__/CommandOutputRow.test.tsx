import { COMMAND_OUTPUT_STRING, COMMAND_REQ_APP_STRING } from "@shared/combineCommandSequences"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { FileServiceClient } from "@/services/grpc-client"
import { CommandOutputRow } from "../CommandOutputRow"

void React

vi.mock("@/services/grpc-client", () => ({
    FileServiceClient: {
        openFile: vi.fn(async () => ({})),
    },
}))

const baseProps = {
    message: { ts: 1, type: "say" as const, say: "command" as const, text: "sleep 10" },
    isCommandExecuting: true,
    isOutputFullyExpanded: false,
    setIsOutputFullyExpanded: vi.fn(),
    onToggleCollapsed: vi.fn(),
}

describe("CommandOutputRow handoff controls", () => {
    it("does not render a handoff action inside the command card", () => {
        const legacyHandoffProps = {
            ...baseProps,
            canMoveToBackground: true,
            onMoveToBackground: vi.fn(),
        } as unknown as React.ComponentProps<typeof CommandOutputRow>

        render(<CommandOutputRow {...legacyHandoffProps} isCollapsed={false} />)

        expect(screen.queryByRole("button", { name: "Move to background" })).toBeNull()
        expect(screen.queryByRole("button", { name: "Continue in Background" })).toBeNull()
    })
})

describe("CommandOutputRow cancellation", () => {
    beforeEach(() => {
        vi.mocked(FileServiceClient.openFile).mockClear()
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText: vi.fn(async () => undefined) },
        })
    })

    it("copies only the executable command from the top-right action", async () => {
        render(
            <CommandOutputRow
                {...baseProps}
                isCollapsed={false}
                message={{
                    ...baseProps.message,
                    text: `echo ready${COMMAND_REQ_APP_STRING}\n${COMMAND_OUTPUT_STRING}\nready`,
                }}
            />,
        )

        fireEvent.click(screen.getByRole("button", { name: "Copy command" }))

        await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("echo ready"))
    })

    it("renders the working directory outside the command block as the final metadata row", async () => {
        const workdirectory = "E:\\workspace\\omnispace\\core"
        const logPath = "E:\\logs\\npm-install.log"
        render(
            <CommandOutputRow
                {...baseProps}
                isCollapsed={false}
                message={{
                    ...baseProps.message,
                    logPath,
                    text: `npm install\n\nWorking directory: ${workdirectory}${COMMAND_REQ_APP_STRING}\n${COMMAND_OUTPUT_STRING}\ninstalled`,
                }}
            />,
        )

        const commandBlock = screen.getByTestId("command-line")
        const output = await screen.findByText("installed")
        const logLink = screen.getByRole("button", { name: "Open log file npm-install.log" })
        const approvalNotice = screen.getByText("The model has determined this command requires explicit approval.")
        const workdirectoryRow = screen.getByTestId("command-workdirectory")

        await waitFor(() => expect(commandBlock).toHaveTextContent("npm install"))
        expect(within(commandBlock).queryByText(/Working directory:/)).not.toBeInTheDocument()
        expect(within(workdirectoryRow).getByLabelText("Working directory")).toHaveAttribute("title", "Working directory")
        expect(within(workdirectoryRow).queryByText("Working directory:", { exact: true })).not.toBeInTheDocument()
        expect(workdirectoryRow).toHaveTextContent(workdirectory)
        expect(output.compareDocumentPosition(logLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(logLink.compareDocumentPosition(approvalNotice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(approvalNotice.compareDocumentPosition(workdirectoryRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(screen.getByTestId("command-card")).toHaveClass("border-editor-group-border", "rounded-sm")
        expect(screen.queryByTestId("activity-command-output")).not.toBeInTheDocument()
    })

    it("caps fully expanded long output at 80vh and keeps it scrollable", () => {
        const longOutput = Array.from({ length: 8 }, (_, index) => `output line ${index + 1}`).join("\n")
        const message = {
            ...baseProps.message,
            text: `run report${COMMAND_OUTPUT_STRING}${longOutput}`,
        }
        const { rerender } = render(
            <CommandOutputRow {...baseProps} isCollapsed={false} isOutputFullyExpanded={false} message={message} />,
        )

        const output = screen.getByTestId("command-output-scroll")
        expect(output).toHaveClass("max-h-[120px]", "overflow-auto")
        expect(output).not.toHaveClass("max-h-[80vh]")

        rerender(<CommandOutputRow {...baseProps} isCollapsed={false} isOutputFullyExpanded={true} message={message} />)

        expect(output).toHaveClass("max-h-[80vh]", "overflow-auto")
        expect(output).not.toHaveClass("max-h-[120px]")
    })

    it("keeps command copy available when the row is collapsed", () => {
        render(<CommandOutputRow {...baseProps} isCollapsed={true} />)

        expect(screen.getByRole("button", { name: "Copy command" })).toBeVisible()
    })

    it("shows the sanitized final output line when the row is collapsed", () => {
        const command = "npm run test"
        render(
            <CommandOutputRow
                {...baseProps}
                isCollapsed={true}
                message={{
                    ...baseProps.message,
                    text:
                        command +
                        COMMAND_OUTPUT_STRING +
                        "old progress\r\x1b[31m最终_🚀\x1b[0m\tCOLUMN\b\n📋 Output is being logged to: C:\\Temp\\command.log",
                }}
            />,
        )

        expect(screen.getByRole("button", { name: command })).toBeVisible()
        const summary = screen.getByTestId("command-output-summary")
        expect(summary.textContent).toBe("最终_🚀→   COLUMN⌫")
        expect(summary.textContent).not.toContain("\x1b")
    })

    it("updates the colored top indicator when a command moves to the background", () => {
        const { rerender } = render(<CommandOutputRow {...baseProps} isBackgroundExec={false} isCollapsed={false} />)

        const foregroundIndicator = screen.getByTestId("command-execution-mode")
        expect(foregroundIndicator).toHaveTextContent("Foreground")
        expect(foregroundIndicator).toHaveClass("text-info")
        expect(
            foregroundIndicator.compareDocumentPosition(screen.getByTestId("command-line")) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy()

        rerender(<CommandOutputRow {...baseProps} isBackgroundExec={true} isCollapsed={false} />)

        const backgroundIndicator = screen.getByTestId("command-execution-mode")
        expect(backgroundIndicator).toHaveTextContent("Background")
        expect(backgroundIndicator).toHaveClass("text-editor-warning-foreground")
    })

    it("shows Cancel for a running VS Code terminal command", () => {
        const onCancelCommand = vi.fn()
        render(<CommandOutputRow {...baseProps} isBackgroundExec={false} isCollapsed={false} onCancelCommand={onCancelCommand} />)

        fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
        expect(onCancelCommand).toHaveBeenCalledOnce()
    })

    it("keeps Cancel visible when the running command row is collapsed", () => {
        const onCancelCommand = vi.fn()
        render(<CommandOutputRow {...baseProps} isBackgroundExec={false} isCollapsed={true} onCancelCommand={onCancelCommand} />)

        fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
        expect(onCancelCommand).toHaveBeenCalledOnce()
    })

    it("shows Failed instead of Skipped for a failed command", () => {
        render(<CommandOutputRow {...baseProps} isCollapsed={false} isCommandExecuting={false} isCommandFailed={true} />)

        expect(screen.getByText("Failed")).toBeInTheDocument()
        expect(screen.queryByText("Skipped")).not.toBeInTheDocument()
    })

    it.each([
        ["cancelled", { isCommandCancelled: true }],
        ["interrupted", { isCommandInterrupted: true }],
        ["skipped", { isCommandSkipped: true }],
    ])("uses the neutral stopped icon for a %s command", (_status, statusProps) => {
        render(<CommandOutputRow {...baseProps} {...statusProps} isCollapsed={false} isCommandExecuting={false} />)

        const statusIcon = screen.getByTestId("command-status-icon")
        expect(statusIcon).toHaveClass("lucide-circle-slash", "text-description")
        expect(statusIcon).not.toHaveClass("lucide-circle-x")
    })

    it("keeps the neutral stopped icon when a cancelled command is collapsed", () => {
        render(<CommandOutputRow {...baseProps} isCollapsed={true} isCommandCancelled={true} isCommandExecuting={false} />)

        expect(screen.getByTestId("command-status-icon")).toHaveClass("lucide-circle-slash", "text-description")
    })

    it("prefers the structured log path when opening command output", () => {
        const structuredPath = "C:\\Temp\\structured.log"
        const legacyPath = "C:\\Temp\\legacy.log"
        render(
            <CommandOutputRow
                {...baseProps}
                isCollapsed={false}
                message={{
                    ...baseProps.message,
                    logPath: structuredPath,
                    text: `serve${COMMAND_OUTPUT_STRING}⏱️ Command timed out. Output is being logged to: ${legacyPath}`,
                }}
            />,
        )

        fireEvent.click(screen.getByRole("button", { name: "Open log file structured.log" }))
        expect(FileServiceClient.openFile).toHaveBeenCalledWith(expect.objectContaining({ value: structuredPath }))
    })

    it("renders the foreground large-output notice as a clickable log link", () => {
        const foregroundPath = "C:\\Temp\\dline\\command_1788858026082_162.log"
        render(
            <CommandOutputRow
                {...baseProps}
                isCollapsed={false}
                message={{
                    ...baseProps.message,
                    text: `run scan${COMMAND_OUTPUT_STRING}shard 396 done\n📋 Output is large (401 lines, 13KB). Writing to: ${foregroundPath}`,
                }}
            />,
        )

        fireEvent.click(screen.getByRole("button", { name: "Open log file command_1788858026082_162.log" }))
        expect(FileServiceClient.openFile).toHaveBeenCalledWith(expect.objectContaining({ value: foregroundPath }))
        expect(screen.queryByText(/Output is large/)).not.toBeInTheDocument()
    })

    it("renders the structured log path even when the output carries no notice line", () => {
        const structuredPath = "C:\\Temp\\dline\\command_no_notice.log"
        render(
            <CommandOutputRow
                {...baseProps}
                isCollapsed={false}
                message={{
                    ...baseProps.message,
                    logPath: structuredPath,
                    text: `run scan${COMMAND_OUTPUT_STRING}shard 396 done`,
                }}
            />,
        )

        fireEvent.click(screen.getByRole("button", { name: "Open log file command_no_notice.log" }))
        expect(FileServiceClient.openFile).toHaveBeenCalledWith(expect.objectContaining({ value: structuredPath }))
    })

    it("opens a timeout log path from legacy command output", () => {
        const legacyPath = "C:\\Temp\\timeout.log"
        render(
            <CommandOutputRow
                {...baseProps}
                isCollapsed={false}
                message={{
                    ...baseProps.message,
                    text: `serve${COMMAND_OUTPUT_STRING}⏱️ Command timed out. Output is being logged to: ${legacyPath}`,
                }}
            />,
        )

        fireEvent.click(screen.getByRole("button", { name: "Open log file timeout.log" }))
        expect(FileServiceClient.openFile).toHaveBeenCalledWith(expect.objectContaining({ value: legacyPath }))
    })
})
