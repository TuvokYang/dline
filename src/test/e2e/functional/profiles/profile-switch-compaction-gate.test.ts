import { readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

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

async function configureProfileGateScenario(
	dlineDir: string,
): Promise<{ sourceProfile: StoredProfile; targetProfile: StoredProfile }> {
	const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
	const sourceProfile = profiles.find((profile) => profile.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
	const targetProfile = profiles.find((profile) => profile.name === E2E_PROFILE_NAMES.mockOpenAi)
	if (!sourceProfile?.openai?.capabilities || !targetProfile?.openai?.capabilities) {
		throw new Error("Missing configurable OpenAI E2E Profiles for Profile transition recovery")
	}

	sourceProfile.modelId = "gpt-5.6-sol"
	sourceProfile.openai.capabilities.contextWindow = 1_000_000
	sourceProfile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
	targetProfile.modelId = "gpt-5.6-sol"
	targetProfile.openai.capabilities.contextWindow = 372_000
	targetProfile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
	await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

	const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
	await writeFile(
		settingsPath(dlineDir),
		`${JSON.stringify(
			{
				...settings,
				planActSeparateModelsSetting: false,
				planModeProfileId: sourceProfile.id,
				planModeProfile: sourceProfile.name,
				actModeProfileId: sourceProfile.id,
				actModeProfile: sourceProfile.name,
				useAutoCondense: false,
				autoCondenseMaxContextTokens: 0,
			},
			null,
			2,
		)}\n`,
		"utf8",
	)
	return { sourceProfile, targetProfile }
}

async function selectProfile(sidebar: Frame, profileName: string): Promise<void> {
	const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
	if ((await modelSwitcher.innerText()).trim() === profileName) return
	await modelSwitcher.click()
	const option = sidebar.getByRole("option").filter({ has: sidebar.getByText(profileName, { exact: true }) })
	await expect(option).toHaveCount(1)
	await option.click()
}

e2e(
	"Profile switch advisory - persisted 400K occupancy releases the gate and allows switching back to 1M",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(240_000)
		const { sourceProfile, targetProfile } = await configureProfileGateScenario(dlineDir)
		const taskText = "E2E_PROFILE_COMPACTION_GATE_TASK"
		const historyReady = "E2E_PROFILE_COMPACTION_GATE_HISTORY_READY"
		const historyAnswer = "E2E_PROFILE_COMPACTION_GATE_HISTORY_ANSWER"
		const question = "E2E_PROFILE_COMPACTION_GATE_QUESTION"
		const answer = "E2E_PROFILE_COMPACTION_GATE_CONTINUE"
		const completion = "E2E_PROFILE_COMPACTION_GATE_RECOVERED"

		server.resetOpenAiMock()
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_profile_compaction_gate_history",
				name: "qna_respond",
				arguments: { response: historyReady },
				expectedRequestIncludes: [taskText],
			},
			{
				type: "tool",
				id: "call_profile_compaction_gate_question",
				name: "qna_respond",
				arguments: { response: question },
				usage: { inputTokens: 400_000, outputTokens: 100 },
				expectedRequestIncludes: [historyAnswer],
			},
			{
				type: "tool",
				id: "call_profile_compaction_gate_recovered",
				name: "attempt_completion",
				arguments: { result: completion },
				expectedRequestIncludes: [answer],
				expectedRequestExcludes: [COMPACT_INSTRUCTION_MARKER],
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
			await input.fill(taskText)
			await input.press("Enter")
			await expect(sidebar.getByText(historyReady, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await input.fill(historyAnswer)
			await input.press("Enter")
			await expect(sidebar.getByText(question, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(2)

			await selectProfile(sidebar, targetProfile.name)
			const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
			const confirmation = sidebar.getByRole("dialog")
			await expect(confirmation.getByRole("heading", { name: "Switch to a smaller context window?" })).toBeVisible()
			await expect(confirmation).toContainText(`${targetProfile.name} · 372,000 tokens`)
			await expect(confirmation.getByText("Context in use", { exact: true })).toBeVisible()
			await expect(confirmation.getByText("400,100 tokens", { exact: true })).toBeVisible()
			await expect(confirmation).toContainText("nothing is compacted now")
			await expect(confirmation.getByRole("button", { name: "Compact & Switch" })).toHaveCount(0)
			await confirmation.getByRole("button", { name: "Switch", exact: true }).click()

			await expect(modelSwitcher).toHaveText(targetProfile.name, { timeout: 60_000 })
			await expect(sidebar.getByRole("dialog")).toHaveCount(0)
			await expect(sidebar.getByText(/Switch failed —/)).toHaveCount(0)
			await expect(sidebar.getByText("Continue the task after approval to send a message.", { exact: true })).toHaveCount(0)
			await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(0)
			await expect(modelSwitcher).toBeEnabled()
			await selectProfile(sidebar, sourceProfile.name)
			await expect(modelSwitcher).toHaveText(sourceProfile.name, { timeout: 60_000 })
			await expect(sidebar.getByRole("dialog")).toHaveCount(0)

			await expect(input).toBeEnabled()
			await input.fill(answer)
			await input.press("Enter")
			await expect(sidebar.getByText(completion, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(3)
			expect(server.getRequestCount("openai-compatible-chat")).toBe(0)
			const recoveredRequest = server.getMockConsumptions("openai-compatible-responses")[2]
			expect(JSON.stringify(recoveredRequest.requestBody)).toContain(answer)
			expect(JSON.stringify(recoveredRequest.requestBody)).not.toContain(COMPACT_INSTRUCTION_MARKER)
			expect(recoveredRequest.contractError).toBeUndefined()
			await expect(sidebar.getByText("Continue the task after approval to send a message.", { exact: true })).toHaveCount(0)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)
