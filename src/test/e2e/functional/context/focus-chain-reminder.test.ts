import { readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect } from "@playwright/test"

const REMINDER = "TODO LIST RECOMMENDED"
const CHECKLIST = "# E2E Focus Chain reminder\n\n- [ ] Verify reminder reset"

async function configureFocusChain(dlineDir: string): Promise<void> {
	const settingsFile = path.join(dlineDir, "data", "settings", "settings.json")
	const settings = JSON.parse(await readFile(settingsFile, "utf8")) as Record<string, unknown>
	settings.focusChainSettings = { enabled: true, remindClineInterval: 2 }
	settings.useAutoCondense = false
	await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8")
}

e2e(
	"Focus Chain - ordinary requests honor reminder interval and task_progress resets it",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		await configureFocusChain(dlineDir)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_focus_chain_interval_update",
				name: "read_file",
				arguments: { path: "README.md", task_progress: CHECKLIST },
				expectedRequestIncludes: [REMINDER],
			},
			{
				type: "tool",
				id: "call_focus_chain_interval_done",
				name: "qna_respond",
				arguments: { response: "E2E_FOCUS_CHAIN_INTERVAL_RESET_OK" },
				expectedToolResults: [{ callId: "call_focus_chain_interval_update", contentIncludes: "# Test Workspace" }],
			},
		)

		const app = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			await E2ETestHelper.openClineSidebar(page)
			const sidebar = await helper.getSidebar(page)
			await E2ETestHelper.dismissWhatsNewModal(sidebar)
			await helper.signin(sidebar)

			const input = sidebar.getByTestId("chat-input")
			await input.fill("E2E_FOCUS_CHAIN_INTERVAL_TASK")
			await sidebar.getByTestId("send-button").click()

			await expect(sidebar.getByText("E2E_FOCUS_CHAIN_INTERVAL_RESET_OK", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			const consumptions = server.getMockConsumptions("openai-compatible-chat")
			expect(consumptions).toHaveLength(2)
			expect(consumptions.every((entry) => entry.contractError === undefined)).toBe(true)
			const messages =
				(consumptions[1]?.requestBody as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? []
			const latestEnvironment = messages
				.flatMap((message) =>
					message.role !== "user" || !Array.isArray(message.content)
						? []
						: message.content.flatMap((part) =>
								typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
									? [part.text]
									: [],
							),
				)
				.filter((text) => text.includes("<environment_details>"))
				.at(-1)
			expect(latestEnvironment).toContain("# task_progress")
			expect(latestEnvironment).not.toContain(REMINDER)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)
