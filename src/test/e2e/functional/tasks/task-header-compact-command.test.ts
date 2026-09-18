import { readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"
import type { ElectronApplication } from "playwright"

interface StoredProfile {
	id: string
	name: string
	modelId?: string
	webToolsMode?: "WEB_TOOLS_MODE_FORCE_OFF"
	openai?: {
		capabilities?: {
			contextWindow?: number
		}
	}
}

const COMPACT_INSTRUCTION_MARKER = "The current conversation is rapidly running out of context"
const profilesPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "api_profiles.json")
const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")

async function configureManualCompaction(dlineDir: string): Promise<void> {
	const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
	const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
	if (!profile?.openai?.capabilities) throw new Error("Missing configurable OpenAI Responses E2E profile")
	profile.modelId = "gpt-5.4-mini"
	profile.openai.capabilities.contextWindow = 131_072
	profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
	await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

	const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
	await writeFile(
		settingsPath(dlineDir),
		`${JSON.stringify(
			{
				...settings,
				actModeProfileId: profile.id,
				actModeProfile: profile.name,
				planModeProfileId: profile.id,
				planModeProfile: profile.name,
				useAutoCondense: false,
			},
			null,
			2,
		)}\n`,
		"utf8",
	)
}

async function openSidebar(app: ElectronApplication, helper: E2ETestHelper): Promise<Frame> {
	const page = await app.firstWindow()
	await E2ETestHelper.openClineSidebar(page)
	const sidebar = await helper.getSidebar(page)
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	await helper.signin(sidebar)
	return sidebar
}

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled()
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(input).toHaveValue("")
	await expect(sidebar.getByText(text, { exact: true }).last()).toBeVisible()
}

e2e(
	"TaskHeader Compact sends /cmd:compact through the active conversation",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		await configureManualCompaction(dlineDir)
		server.resetOpenAiMock()
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_task_header_compact_ready",
				name: "qna_respond",
				arguments: { response: "E2E_TASK_HEADER_COMPACT_READY" },
				usage: { inputTokens: 80_000, outputTokens: 100 },
				expectedRequestIncludes: ["E2E_TASK_HEADER_COMPACT_TASK"],
			},
			{
				type: "tool",
				id: "call_task_header_compact_summary",
				name: "summarize_task",
				arguments: { context: "E2E_TASK_HEADER_COMPACT_SUMMARY preserves the active task." },
				delayMs: 1_500,
				expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER, "E2E_TASK_HEADER_COMPACT_TASK"],
				expectedRequestExcludes: ["/cmd:compact"],
			},
			{
				type: "tool",
				id: "call_task_header_compact_continued",
				name: "qna_respond",
				arguments: { response: "E2E_TASK_HEADER_COMPACT_CONTINUED" },
				expectedRequestIncludes: ["E2E_TASK_HEADER_COMPACT_SUMMARY"],
				expectedRequestExcludes: [COMPACT_INSTRUCTION_MARKER, "/cmd:compact"],
			},
		)

		const app = await openVSCode(workspaceDir)
		try {
			const sidebar = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_TASK_HEADER_COMPACT_TASK")
			await expect(sidebar.getByText("E2E_TASK_HEADER_COMPACT_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})

			const input = sidebar.getByTestId("chat-input")
			await expect(input).toBeEnabled()
			await input.fill("E2E_TASK_HEADER_COMPACT_PRESERVED_DRAFT")
			const expandTaskHeader = sidebar.getByLabel("Expand task header")
			if (await expandTaskHeader.isVisible()) await expandTaskHeader.click()
			const compactButton = sidebar.getByRole("button", { name: "Compact task" })
			await expect(compactButton).toBeEnabled()
			await compactButton.click()
			await expect(sidebar.getByText("Compact the current task?", { exact: true })).toBeVisible()
			await sidebar.getByTitle("Yes, compact the task").click()

			const progress = sidebar.getByTestId("context-window-segmented-progress")
			const durableSegment = sidebar.getByTestId("context-window-segment-durable")
			await expect(progress).toHaveAttribute("data-phase", "sending", { timeout: 30_000 })
			const durableBeforeCompaction = Number(await durableSegment.getAttribute("data-authoritative-tokens"))
			expect(durableBeforeCompaction).toBeGreaterThan(50_000)

			await expect(sidebar.getByText("E2E_TASK_HEADER_COMPACT_SUMMARY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await expect(input).toHaveValue("E2E_TASK_HEADER_COMPACT_PRESERVED_DRAFT")
			await sidebar.locator('vscode-button[aria-label="Condense Conversation"]').click()

			const compactionPass = sidebar.getByTestId("compaction-pass").last()
			await expect(compactionPass).toHaveAttribute("data-compaction-operation-id", /^manual-compaction:/, {
				timeout: 60_000,
			})
			await expect(compactionPass).toHaveAttribute("data-compaction-status", "completed", { timeout: 60_000 })
			await expect
				.poll(async () => Number(await durableSegment.getAttribute("data-authoritative-tokens")), { timeout: 30_000 })
				.toBeLessThan(durableBeforeCompaction)
			await expect(sidebar.getByText("E2E_TASK_HEADER_COMPACT_CONTINUED", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(3)
			const requests = server.getMockConsumptions("openai-compatible-responses")
			expect(requests[1]).toMatchObject({ responseType: "tool", toolName: "summarize_task" })
			expect(requests[1].contractError).toBeUndefined()
			expect(requests[2].contractError).toBeUndefined()
			await expect(input).toHaveValue("E2E_TASK_HEADER_COMPACT_PRESERVED_DRAFT")
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)
