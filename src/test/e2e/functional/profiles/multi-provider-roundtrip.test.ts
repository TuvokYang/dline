import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { MockApiConsumption } from "@e2e/fixtures/server"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"
import type { ElectronApplication } from "playwright"

interface StoredProfile {
	id: string
	name: string
	modelId?: string
	webToolsMode?: string
}

const TARGETS = {
	deepSeek: "deepseek-chat",
	openAi: "openai-compatible-chat",
	anthropic: "anthropic-messages",
} as const

async function prepareProfiles(dlineDir: string): Promise<Record<string, StoredProfile>> {
	const profilesPath = path.join(dlineDir, "data", "settings", "api_profiles.json")
	const profiles = JSON.parse(await readFile(profilesPath, "utf8")) as StoredProfile[]
	const selected = Object.fromEntries(
		[E2E_PROFILE_NAMES.mockDeepSeek, E2E_PROFILE_NAMES.mockOpenAi, E2E_PROFILE_NAMES.mockAnthropic].map((name) => {
			const profile = profiles.find((candidate) => candidate.name === name)
			if (!profile?.modelId) throw new Error(`Missing configured E2E Profile: ${name}`)
			profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
			return [name, profile]
		}),
	)
	await writeFile(profilesPath, `${JSON.stringify(profiles, null, 2)}\n`, "utf8")
	const settingsPath = path.join(dlineDir, "data", "settings", "settings.json")
	const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>
	settings.enableCheckpointsSetting = false
	await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8")
	return selected
}

async function selectProfile(sidebar: Frame, profileName: string): Promise<void> {
	const switcher = sidebar.getByRole("button", { name: "Select model" })
	await switcher.click()
	const option = sidebar.getByRole("option").filter({ has: sidebar.getByText(profileName, { exact: true }) })
	await expect(option).toHaveCount(1)
	await option.click()
	await expect(switcher).toHaveText(profileName)
}

async function sendTurn(sidebar: Frame, inputText: string, completion: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled({ timeout: 30_000 })
	await input.fill(inputText)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(completion, { exact: true })).toBeVisible({ timeout: 60_000 })
}

function expectProviderRequest(consumption: MockApiConsumption | undefined, protocol: string, model: string): void {
	if (!consumption) throw new Error(`Missing ${protocol} Provider request`)
	expect(consumption.protocol).toBe(protocol)
	expect((consumption.requestBody as { model?: unknown }).model).toBe(model)
	expect(consumption.contractError).toBeUndefined()
}

e2e(
	"Provider roundtrip - one task routes DeepSeek, OpenAI, and Anthropic turns",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		const profiles = await prepareProfiles(dlineDir)
		const deepSeek = profiles[E2E_PROFILE_NAMES.mockDeepSeek]
		const openAi = profiles[E2E_PROFILE_NAMES.mockOpenAi]
		const anthropic = profiles[E2E_PROFILE_NAMES.mockAnthropic]
		if (!deepSeek?.modelId || !openAi?.modelId || !anthropic?.modelId) throw new Error("Provider fixtures are incomplete")

		server.resetOpenAiMock()
		server.enqueueResponses(TARGETS.deepSeek, {
			type: "tool",
			id: "call_multi_provider_deepseek",
			name: "attempt_completion",
			arguments: { result: "E2E_MULTI_PROVIDER_DEEPSEEK_OK" },
			expectedRequestIncludes: ["E2E_MULTI_PROVIDER_DEEPSEEK_TURN"],
		})
		server.enqueueResponses(TARGETS.openAi, {
			type: "tool",
			id: "call_multi_provider_openai",
			name: "attempt_completion",
			arguments: { result: "E2E_MULTI_PROVIDER_OPENAI_OK" },
			expectedRequestIncludes: ["E2E_MULTI_PROVIDER_OPENAI_TURN"],
		})
		server.enqueueResponses(TARGETS.anthropic, {
			type: "tool",
			id: "call_multi_provider_anthropic",
			name: "attempt_completion",
			arguments: { result: "E2E_MULTI_PROVIDER_ANTHROPIC_OK" },
			expectedRequestIncludes: ["E2E_MULTI_PROVIDER_ANTHROPIC_TURN"],
		})

		let app: ElectronApplication | undefined
		try {
			app = await openVSCode(workspaceDir)
			const page = await app.firstWindow()
			await E2ETestHelper.openClineSidebar(page)
			const sidebar = await helper.getSidebar(page)
			await E2ETestHelper.dismissWhatsNewModal(sidebar)
			await helper.signin(sidebar)

			await selectProfile(sidebar, deepSeek.name)
			await sendTurn(sidebar, "E2E_MULTI_PROVIDER_DEEPSEEK_TURN", "E2E_MULTI_PROVIDER_DEEPSEEK_OK")
			await selectProfile(sidebar, openAi.name)
			await sendTurn(sidebar, "E2E_MULTI_PROVIDER_OPENAI_TURN", "E2E_MULTI_PROVIDER_OPENAI_OK")
			await selectProfile(sidebar, anthropic.name)
			await sendTurn(sidebar, "E2E_MULTI_PROVIDER_ANTHROPIC_TURN", "E2E_MULTI_PROVIDER_ANTHROPIC_OK")

			expectProviderRequest(server.getMockConsumptions(TARGETS.deepSeek)[0], "deepseek-chat", deepSeek.modelId)
			expectProviderRequest(server.getMockConsumptions(TARGETS.openAi)[0], "openai-chat", openAi.modelId)
			expectProviderRequest(server.getMockConsumptions(TARGETS.anthropic)[0], "anthropic-messages", anthropic.modelId)
			expect(server.getMockConsumptions()).toHaveLength(3)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app?.close()
		}
	},
)
