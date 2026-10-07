import { readFile } from "node:fs/promises"
import path from "node:path"
import { expect } from "@playwright/test"
import { demo } from "./utils/demo-fixture"
import { WINDOW_RECORDING } from "./utils/recording-presets"

const TASK_TEXT = "Create a small greeting module for this workspace."
const RELATIVE_PATH = "src/greeting.ts"
const FILE_CONTENT = 'export const greeting = "Hello from Dline!"\n'
const COMPLETION_TEXT = "Created src/greeting.ts successfully."

demo("R1", async ({ finishRecording, focusCamera, helper, page, pace, registerRecording, server, sidebar, workspaceDir }) => {
	await helper.signin(sidebar)
	server.resetOpenAiMock()
	server.enqueueOpenAiResponses(
		{
			type: "tool",
			id: "call_demo_write",
			name: "write_to_file",
			arguments: { path: RELATIVE_PATH, content: FILE_CONTENT },
		},
		{
			type: "tool",
			id: "call_demo_complete",
			name: "attempt_completion",
			arguments: { result: COMPLETION_TEXT },
			expectedToolResults: [{ callId: "call_demo_write", contentIncludes: "successfully saved" }],
		},
	)

	const input = sidebar.getByTestId("chat-input")
	await input.fill(TASK_TEXT)
	await pace(500)
	await registerRecording("r1-hero", WINDOW_RECORDING)
	const send = sidebar.getByTestId("send-button")
	await focusCamera([input, send])
	await send.click()

	const approve = sidebar.getByText("Approve", { exact: true })
	await expect(approve).toBeVisible({ timeout: 60_000 })
	await focusCamera(approve)
	await pace()
	await approve.click()

	// Approval admits the write before the handler runs, so the diff editor only opens
	// afterwards; frame it beside the chat while the proposed file is on screen.
	await expect(page.getByText("greeting.ts: New File (Editable)", { exact: false })).toBeVisible({ timeout: 30_000 })
	await focusCamera([sidebar.getByTestId("chat-input"), page.locator(".part.editor")])

	const absolutePath = path.join(workspaceDir, RELATIVE_PATH)
	await expect
		.poll(
			() =>
				readFile(absolutePath, "utf8")
					.then((content) => content.trimEnd())
					.catch(() => ""),
			{
				timeout: 30_000,
			},
		)
		.toBe(FILE_CONTENT.trimEnd())
	const completion = sidebar.getByText(COMPLETION_TEXT, { exact: false }).last()
	await expect(completion).toBeVisible({ timeout: 60_000 })
	await focusCamera(completion)
	await pace(1_600)
	await finishRecording()

	const consumptions = server.getMockConsumptions("openai-compatible-chat")
	expect(consumptions.map((entry) => entry.toolName)).toEqual(["write_to_file", "attempt_completion"])
	expect(consumptions.every((entry) => entry.contractError === undefined)).toBe(true)
})
