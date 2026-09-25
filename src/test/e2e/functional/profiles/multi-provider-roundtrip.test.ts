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

interface AnthropicRequestBody {
	messages?: unknown[]
}

const MODEL_SWITCH_NOTICE_TAG = "<model_switch_notice>"

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

function withoutCacheControl(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutCacheControl)
	if (typeof value !== "object" || value === null) return value
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([key]) => key !== "cache_control")
			.map(([key, nested]) => [key, withoutCacheControl(nested)]),
	)
}

function normalizedAnthropicMessages(consumption: MockApiConsumption | undefined): unknown[] {
	const messages = (consumption?.requestBody as AnthropicRequestBody | undefined)?.messages
	if (!Array.isArray(messages)) throw new Error("Anthropic Provider request carries no messages array")
	return withoutCacheControl(messages) as unknown[]
}

function countOccurrences(text: string, needle: string): number {
	return text.split(needle).length - 1
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

e2e(
	"Provider roundtrip - repeated Anthropic returns accumulate notices without rewriting the old history prefix",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(240_000)
		const profiles = await prepareProfiles(dlineDir)
		const openAi = profiles[E2E_PROFILE_NAMES.mockOpenAi]
		const anthropic = profiles[E2E_PROFILE_NAMES.mockAnthropic]
		if (!openAi?.modelId || !anthropic?.modelId) throw new Error("Roundtrip Provider fixtures are incomplete")

		server.resetOpenAiMock()
		server.enqueueResponses(
			TARGETS.anthropic,
			{
				type: "tool",
				id: "call_notice_anthropic_initial",
				name: "attempt_completion",
				arguments: { result: "E2E_NOTICE_ANTHROPIC_INITIAL_OK" },
				expectedRequestIncludes: ["E2E_NOTICE_ANTHROPIC_INITIAL_TURN"],
			},
			{
				type: "tool",
				id: "call_notice_anthropic_return_one",
				name: "attempt_completion",
				arguments: { result: "E2E_NOTICE_ANTHROPIC_RETURN_ONE_OK" },
				expectedRequestIncludes: ["E2E_NOTICE_ANTHROPIC_RETURN_ONE_TURN"],
			},
			{
				type: "tool",
				id: "call_notice_anthropic_return_two",
				name: "attempt_completion",
				arguments: { result: "E2E_NOTICE_ANTHROPIC_RETURN_TWO_OK" },
				expectedRequestIncludes: ["E2E_NOTICE_ANTHROPIC_RETURN_TWO_TURN"],
			},
		)
		server.enqueueResponses(
			TARGETS.openAi,
			{
				type: "tool",
				id: "call_notice_openai_one",
				name: "attempt_completion",
				arguments: { result: "E2E_NOTICE_OPENAI_ONE_OK" },
				expectedRequestIncludes: ["E2E_NOTICE_OPENAI_ONE_TURN"],
			},
			{
				type: "tool",
				id: "call_notice_openai_two",
				name: "attempt_completion",
				arguments: { result: "E2E_NOTICE_OPENAI_TWO_OK" },
				expectedRequestIncludes: ["E2E_NOTICE_OPENAI_TWO_TURN"],
			},
		)

		let app: ElectronApplication | undefined
		try {
			app = await openVSCode(workspaceDir)
			const page = await app.firstWindow()
			await E2ETestHelper.openClineSidebar(page)
			const sidebar = await helper.getSidebar(page)
			await E2ETestHelper.dismissWhatsNewModal(sidebar)
			await helper.signin(sidebar)

			await selectProfile(sidebar, anthropic.name)
			await sendTurn(sidebar, "E2E_NOTICE_ANTHROPIC_INITIAL_TURN", "E2E_NOTICE_ANTHROPIC_INITIAL_OK")
			await selectProfile(sidebar, openAi.name)
			await sendTurn(sidebar, "E2E_NOTICE_OPENAI_ONE_TURN", "E2E_NOTICE_OPENAI_ONE_OK")
			await selectProfile(sidebar, anthropic.name)
			await sendTurn(sidebar, "E2E_NOTICE_ANTHROPIC_RETURN_ONE_TURN", "E2E_NOTICE_ANTHROPIC_RETURN_ONE_OK")
			await selectProfile(sidebar, openAi.name)
			await sendTurn(sidebar, "E2E_NOTICE_OPENAI_TWO_TURN", "E2E_NOTICE_OPENAI_TWO_OK")
			await selectProfile(sidebar, anthropic.name)
			await sendTurn(sidebar, "E2E_NOTICE_ANTHROPIC_RETURN_TWO_TURN", "E2E_NOTICE_ANTHROPIC_RETURN_TWO_OK")

			await expect.poll(() => server.getRequestCount(TARGETS.anthropic), { timeout: 60_000 }).toBe(3)
			await expect.poll(() => server.getRequestCount(TARGETS.openAi), { timeout: 60_000 }).toBe(2)
			const anthropicRequests = server.getMockConsumptions(TARGETS.anthropic)
			const openAiRequests = server.getMockConsumptions(TARGETS.openAi)
			for (const request of anthropicRequests) expectProviderRequest(request, "anthropic-messages", anthropic.modelId)
			for (const request of openAiRequests) expectProviderRequest(request, "openai-chat", openAi.modelId)

			const firstReturnMessages = normalizedAnthropicMessages(anthropicRequests[1])
			const secondReturnMessages = normalizedAnthropicMessages(anthropicRequests[2])
			const firstReturnText = JSON.stringify(firstReturnMessages)
			const secondReturnText = JSON.stringify(secondReturnMessages)

			expect(secondReturnMessages.slice(0, firstReturnMessages.length)).toEqual(firstReturnMessages)
			expect(countOccurrences(firstReturnText, MODEL_SWITCH_NOTICE_TAG)).toBe(1)
			expect(countOccurrences(secondReturnText, MODEL_SWITCH_NOTICE_TAG)).toBe(2)
			expect(secondReturnText).toContain("E2E_NOTICE_ANTHROPIC_RETURN_ONE_TURN")
			expect(secondReturnText).toContain("E2E_NOTICE_ANTHROPIC_RETURN_TWO_TURN")
			expect(secondReturnText).not.toContain(openAi.modelId)
			expect(secondReturnText).not.toContain(anthropic.modelId)
			expect(server.getMockConsumptions()).toHaveLength(5)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app?.close()
		}
	},
)
