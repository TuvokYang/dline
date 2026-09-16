import { readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { expect, type Frame } from "@playwright/test"
import type { MockApiTarget } from "./fixtures/server"
import { E2E_PROFILE_NAMES } from "./utils/api-profile"
import { E2ETestHelper, e2e } from "./utils/helpers"

interface GenerateReportProtocolCase {
	id: string
	profileName: string
	target: MockApiTarget
}

const PROTOCOL_CASES: readonly GenerateReportProtocolCase[] = [
	{
		id: "openai-chat",
		profileName: E2E_PROFILE_NAMES.mockOpenAi,
		target: "openai-compatible-chat",
	},
	{
		id: "openai-responses",
		profileName: E2E_PROFILE_NAMES.mockOpenAiResponses,
		target: "openai-compatible-responses",
	},
	{
		id: "anthropic-messages",
		profileName: E2E_PROFILE_NAMES.mockAnthropic,
		target: "anthropic-messages",
	},
] as const

const REPORT_CHUNK_SIZE = 113
const REPORT_SECTION_COUNT = 320

function buildLargeReport(protocolId: string): {
	title: string
	content: string
	startMarker: string
	middleMarker: string
	endMarker: string
} {
	const startMarker = `E2E_REPORT_STREAM_START_${protocolId}`
	const middleMarker = `E2E_REPORT_STREAM_MIDDLE_${protocolId}`
	const endMarker = `E2E_REPORT_STREAM_END_${protocolId}`
	const sections = Array.from(
		{ length: REPORT_SECTION_COUNT },
		(_, index) =>
			`Section ${index + 1}: ${"large report stream payload ".repeat(8)}${index + 1}. ` +
			`The report must preserve this content while native tool arguments arrive in small deltas.`,
	)
	const content = [
		startMarker,
		...sections.slice(0, REPORT_SECTION_COUNT / 2),
		middleMarker,
		...sections.slice(REPORT_SECTION_COUNT / 2),
		endMarker,
	].join("\n\n")
	return {
		title: `E2E_LARGE_REPORT_${protocolId}`,
		content,
		startMarker,
		middleMarker,
		endMarker,
	}
}

async function disableWebSearch(dlineDir: string, profileName: string): Promise<void> {
	const profilesPath = path.join(dlineDir, "data", "settings", "api_profiles.json")
	const profiles = JSON.parse(await readFile(profilesPath, "utf8")) as Array<{
		name: string
		webToolsMode?: string
	}>
	const profile = profiles.find((candidate) => candidate.name === profileName)
	if (!profile) throw new Error(`Missing E2E profile: ${profileName}`)
	profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
	await writeFile(profilesPath, `${JSON.stringify(profiles, null, 2)}\n`, "utf8")
}

async function selectProfile(sidebar: Frame, profileName: string): Promise<void> {
	const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
	if ((await modelSwitcher.innerText()).trim() === profileName) return
	await modelSwitcher.click()
	await expect(sidebar.getByText("Available Models", { exact: true })).toBeVisible()
	const profileOption = sidebar.getByRole("option").filter({ has: sidebar.getByText(profileName, { exact: true }) })
	await expect(profileOption).toHaveCount(1)
	await profileOption.click()
	await expect(modelSwitcher).toHaveText(profileName)
}

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

async function expectNoDecisionButtons(sidebar: Frame): Promise<void> {
	const footer = sidebar.getByRole("contentinfo")
	for (const label of ["Resume", "Approve", "Reject", "Start New Task"]) {
		await expect(footer.getByText(label, { exact: true })).toHaveCount(0)
	}
}

async function closeAndReopenTask(sidebar: Frame, taskText: string): Promise<void> {
	const closeButton = sidebar.getByRole("button", { name: "Close Task", exact: true })
	await expect(closeButton).toBeVisible()
	await closeButton.click()
	await expect(sidebar.getByTestId("chat-input")).toBeVisible()

	const historyTask = sidebar.getByText(taskText, { exact: true }).last()
	await expect(historyTask).toBeVisible({ timeout: 30_000 })
	await historyTask.click()
	await expect(sidebar.getByText(taskText, { exact: true }).first()).toBeVisible()
}

for (const protocolCase of PROTOCOL_CASES) {
	e2e(
		`generate_report - large streamed arguments preserve turn-end interaction for ${protocolCase.id}`,
		async ({ dlineDir, helper, server, sidebar, userDataDir }) => {
			e2e.setTimeout(240_000)
			await helper.signin(sidebar)
			await disableWebSearch(dlineDir, protocolCase.profileName)
			await selectProfile(sidebar, protocolCase.profileName)

			const report = buildLargeReport(protocolCase.id)
			const taskText = `E2E_LARGE_REPORT_STREAM_TASK_${protocolCase.id}`
			const feedback = `E2E_LARGE_REPORT_STREAM_FEEDBACK_${protocolCase.id}`
			const completion = `E2E_LARGE_REPORT_STREAM_COMPLETION_${protocolCase.id}`
			server.resetOpenAiMock()
			server.enqueueResponses(
				protocolCase.target,
				{
					type: "tool",
					id: `call_large_report_${protocolCase.id}`,
					name: "generate_report",
					arguments: { title: report.title, content: report.content },
					toolArgumentChunkSize: REPORT_CHUNK_SIZE,
				},
				{
					type: "tool",
					id: `call_large_report_completion_${protocolCase.id}`,
					name: "attempt_completion",
					arguments: { result: completion },
					expectedRequestIncludes: [feedback],
				},
			)

			await sendTask(sidebar, taskText)
			await expect(sidebar.getByText(report.title, { exact: true })).toBeVisible({ timeout: 60_000 })
			await expect(sidebar.getByText(report.startMarker, { exact: true })).toBeVisible({ timeout: 60_000 })
			await expect(sidebar.getByText(report.middleMarker, { exact: true })).toBeVisible({ timeout: 60_000 })
			await expect(sidebar.getByText(report.endMarker, { exact: true })).toBeVisible({ timeout: 60_000 })
			await expect(sidebar.getByText(report.startMarker, { exact: true })).toHaveCount(1)
			await expect(sidebar.getByText(report.middleMarker, { exact: true })).toHaveCount(1)
			await expect(sidebar.getByText(report.endMarker, { exact: true })).toHaveCount(1)
			await expect(sidebar.getByTestId("chat-input")).toBeEnabled()
			await expectNoDecisionButtons(sidebar)

			await closeAndReopenTask(sidebar, taskText)
			await expect(sidebar.getByText(report.title, { exact: true })).toBeVisible({ timeout: 30_000 })
			await expect(sidebar.getByText(report.startMarker, { exact: true })).toBeVisible()
			await expect(sidebar.getByText(report.middleMarker, { exact: true })).toBeVisible()
			await expect(sidebar.getByText(report.endMarker, { exact: true })).toBeVisible()
			await expectNoDecisionButtons(sidebar)
			await expect(sidebar.getByTestId("chat-input")).toBeEnabled()
			expect(server.getRequestCount(protocolCase.target)).toBe(1)

			const input = sidebar.getByTestId("chat-input")
			await input.fill(feedback)
			await input.press("Enter")
			await expect(input).toHaveValue("")
			const feedbackRow = sidebar.getByTestId("direct-user-input").filter({ hasText: feedback })
			await expect(feedbackRow).toHaveCount(1)
			await expect(feedbackRow).toHaveText(feedback)
			await expect(sidebar.getByText(completion, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect(sidebar.getByRole("contentinfo").getByText("Start New Task", { exact: true })).toBeVisible()
			await expect.poll(() => server.getRequestCount(protocolCase.target), { timeout: 60_000 }).toBe(2)

			const consumptions = server.getMockConsumptions(protocolCase.target)
			expect(consumptions).toHaveLength(2)
			expect(consumptions.every((consumption) => consumption.contractError === undefined)).toBe(true)
			expect(JSON.stringify(consumptions[1]?.requestBody)).toContain(feedback)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		},
	)
}
