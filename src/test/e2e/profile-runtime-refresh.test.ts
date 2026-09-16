import { readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { expect, type Frame } from "@playwright/test"
import { E2E_PROFILE_NAMES } from "./utils/api-profile"
import { E2ETestHelper, e2e } from "./utils/helpers"

interface StoredProfile {
	id: string
	name: string
	modelId: string
	openai?: {
		capabilities?: {
			contextWindow?: number
		}
	}
}

interface StoredApiKey {
	apiKey: string
	name: string
}

async function send(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled({ timeout: 60_000 })
	await input.fill(text)
	await input.press("Enter")
}

async function expandTaskHeader(sidebar: Frame): Promise<void> {
	const expand = sidebar.getByLabel("Expand task header")
	if (await expand.isVisible()) await expand.click()
	await expect(sidebar.getByTestId("context-window-segmented-progress")).toBeVisible({ timeout: 60_000 })
}

e2e(
	"Task refreshes the latest Profile Catalog, Secret, context max, and invalid-state diagnostic before each request",
	async ({ dlineDir, helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		server.resetOpenAiMock()
		server.enqueueResponses(
			"openai-compatible-chat",
			{
				type: "tool",
				name: "qna_respond",
				arguments: { response: "E2E_FRESH_PROFILE_READY" },
				expectedRequestIncludes: ["E2E_FRESH_PROFILE_TASK"],
			},
			{
				type: "tool",
				name: "qna_respond",
				arguments: { response: "E2E_FRESH_PROFILE_UPDATED" },
				expectedRequestIncludes: ["E2E_FRESH_PROFILE_FEEDBACK"],
			},
		)

		await helper.signin(sidebar)
		await send(sidebar, "E2E_FRESH_PROFILE_TASK")
		await expect(sidebar.getByText("E2E_FRESH_PROFILE_READY", { exact: true })).toBeVisible({ timeout: 60_000 })
		await expandTaskHeader(sidebar)

		const profilesFile = path.join(dlineDir, "data", "settings", "api_profiles.json")
		const apiKeysFile = path.join(dlineDir, "data", "secrets", "api_keys.json")
		const profiles = JSON.parse(await readFile(profilesFile, "utf8")) as StoredProfile[]
		const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAi)
		if (!profile?.openai) throw new Error("Missing OpenAI E2E Profile")
		const updatedModel = "dline-e2e-model-v2"
		const updatedContextWindow = 262_144
		profile.modelId = updatedModel
		profile.openai.capabilities = { ...(profile.openai.capabilities ?? {}), contextWindow: updatedContextWindow }
		await writeFile(profilesFile, `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

		const apiKeys = JSON.parse(await readFile(apiKeysFile, "utf8")) as Record<string, StoredApiKey>
		apiKeys[profile.id] = { apiKey: "dline-e2e-api-key-v2", name: profile.name }
		await writeFile(apiKeysFile, `${JSON.stringify(apiKeys, null, 2)}\n`, "utf8")

		await send(sidebar, "E2E_FRESH_PROFILE_FEEDBACK")
		await expect(sidebar.getByText("E2E_FRESH_PROFILE_UPDATED", { exact: true })).toBeVisible({ timeout: 60_000 })
		await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(2)
		const updatedRequest = server.getMockConsumptions("openai-compatible-chat")[1]
		expect(updatedRequest.requestBody).toMatchObject({ model: updatedModel })
		expect(updatedRequest.authorization).toBe("Bearer dline-e2e-api-key-v2")
		await expect(sidebar.getByTestId("context-window-segmented-progress")).toHaveAttribute(
			"data-context-window",
			String(updatedContextWindow),
		)

		delete apiKeys[profile.id]
		await writeFile(apiKeysFile, `${JSON.stringify(apiKeys, null, 2)}\n`, "utf8")
		await send(sidebar, "E2E_FRESH_PROFILE_MISSING_KEY")
		await expect(
			sidebar.getByText(`Profile not valid: credentials for "${profile.name}" are unavailable.`, { exact: true }),
		).toBeVisible({ timeout: 60_000 })
		expect(server.getMockConsumptions("openai-compatible-chat")).toHaveLength(2)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)
