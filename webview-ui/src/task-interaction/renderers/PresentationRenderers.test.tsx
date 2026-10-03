// @vitest-environment jsdom

import type { ClineMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApprovalRenderer, CommandRenderer } from "./PresentationRenderers"

const COMMAND_ASK: ClineMessage = {
	ts: 100,
	type: "ask",
	ask: "command",
	text: "npm run check",
	interactionId: "command-1",
}

describe("CommandRenderer", () => {
	beforeEach(() => {
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText: vi.fn(async () => undefined) },
		})
	})

	it("copies the command from its top-right action", async () => {
		render(<CommandRenderer message={COMMAND_ASK} onSelectionChange={vi.fn()} selection={[]} />)

		fireEvent.click(screen.getByRole("button", { name: "Copy command" }))

		await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("npm run check"))
	})

	it("titles the command approval and wraps long commands inside the card", () => {
		const longCommand = `node -e "${"x".repeat(400)}"`
		render(<CommandRenderer message={{ ...COMMAND_ASK, text: longCommand }} onSelectionChange={vi.fn()} selection={[]} />)

		expect(screen.getByText("Dline wants to execute this command:")).toBeTruthy()
		const card = screen.getByTestId("tool-approval-summary")
		expect(card.className).toContain("min-w-0")
		expect(card.className).toContain("max-w-full")
		const body = screen.getByText(longCommand)
		expect(body.className).toContain("[overflow-wrap:anywhere]")
		expect(body.className).toContain("whitespace-pre-wrap")
	})
})

function approvalAsk(ask: ClineMessage["ask"], payload: unknown): ClineMessage {
	return { ts: 200, type: "ask", ask, text: JSON.stringify(payload), interactionId: `${ask}-1` }
}

function renderApproval(message: ClineMessage) {
	return render(<ApprovalRenderer message={message} onSelectionChange={vi.fn()} selection={[]} />)
}

describe("ApprovalRenderer", () => {
	it.each(["README.md", "work-daily-exit-read.txt"])("identifies the pending read of %s despite other path labels", (path) => {
		render(
			<>
				<span>{path}</span>
				<span hidden>{path}</span>
				<button type="button">{path}</button>
				<div role="contentinfo">
					<ApprovalRenderer
						message={approvalAsk("tool", { tool: "readFile", path })}
						onSelectionChange={vi.fn()}
						selection={[]}
					/>
				</div>
			</>,
		)

		expect(screen.getAllByText(path, { exact: true })).toHaveLength(4)
		const summary = within(screen.getByRole("contentinfo")).getByTestId("tool-approval-summary")
		expect(within(summary).getByText("Dline wants to read this file:", { exact: true })).toBeVisible()
		expect(within(summary).getByText(path, { exact: true })).toBeVisible()
	})

	it.each([
		[
			{ tool: "readFile", path: "src/very/long/path/to/file.ts" },
			"Dline wants to read this file:",
			"src/very/long/path/to/file.ts",
		],
		[{ tool: "listFilesTopLevel", path: "src" }, "Dline wants to list this directory:", "src"],
		[{ tool: "searchFiles", path: "src", regex: "TODO" }, "Dline wants to search project files:", '"TODO" in src'],
		[{ tool: "editedExistingFile", path: "README.md" }, "Dline wants to edit this file:", "README.md"],
	])("titles tool approval %j", (payload, title, detail) => {
		renderApproval(approvalAsk("tool", payload))

		expect(screen.getByText(title)).toBeTruthy()
		expect(screen.getByText(detail)).toBeTruthy()
	})

	it("titles an MCP tool approval with the server name and keeps arguments wrapped", () => {
		const args = JSON.stringify({ query: "y".repeat(300) })
		renderApproval(
			approvalAsk("use_mcp_server", {
				serverName: "release-tools",
				type: "use_mcp_tool",
				toolName: "echo",
				arguments: args,
			}),
		)

		expect(screen.getByText("Dline wants to use a tool on the release-tools MCP server:")).toBeTruthy()
		const body = screen.getByTestId("tool-approval-summary").lastElementChild as HTMLElement
		expect(body.textContent).toBe(`echo\n${args}`)
		expect(body.className).toContain("[overflow-wrap:anywhere]")
	})

	it("titles subagent, spawn-task, and browser approvals instead of dumping raw JSON", () => {
		const { unmount } = renderApproval(approvalAsk("use_subagents", { prompts: ["Check interface", "Check timing"] }))
		expect(screen.getByText("Dline wants to run 2 subagents:")).toBeTruthy()
		expect(screen.queryByText(/"prompts"/)).toBeNull()
		unmount()

		const spawn = renderApproval(approvalAsk("spawn_task", { task: "Write release notes" }))
		expect(screen.getByText("Dline wants to start a new task:")).toBeTruthy()
		expect(screen.getByText("Write release notes")).toBeTruthy()
		spawn.unmount()

		renderApproval({ ts: 300, type: "ask", ask: "browser_action_launch", text: "https://example.com", interactionId: "b-1" })
		expect(screen.getByText("Dline wants to use the browser:")).toBeTruthy()
		expect(screen.getByText("https://example.com")).toBeTruthy()
	})

	it("falls back to a generic title for an unrecognized approval payload", () => {
		renderApproval({ ts: 400, type: "ask", ask: "tool", text: "plain approval text", interactionId: "g-1" })

		expect(screen.getByText("Dline wants your approval:")).toBeTruthy()
		expect(screen.getByText("plain approval text")).toBeTruthy()
	})
})
