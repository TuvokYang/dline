import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"
import type { ElectronApplication } from "playwright"

interface StoredProfile {
	name: string
	modelId?: string
}

interface OpenAiChatRequestBody {
	model?: string
	messages?: unknown[]
	prompt_cache_key?: string
}

async function configureGpt56ChatProfile(dlineDir: string): Promise<void> {
	const profilesPath = path.join(dlineDir, "data", "settings", "api_profiles.json")
	const profiles = JSON.parse(await readFile(profilesPath, "utf8")) as StoredProfile[]
	const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAi)
	if (!profile) throw new Error("Missing configurable OpenAI Chat E2E profile")
	profile.modelId = "gpt-5.6-sol"
	await writeFile(profilesPath, `${JSON.stringify(profiles, null, 2)}\n`, "utf8")
}

async function openSidebar(app: ElectronApplication, helper: E2ETestHelper): Promise<Frame> {
	const page = await app.firstWindow()
	await E2ETestHelper.openClineSidebar(page)
	const sidebar = await helper.getSidebar(page)
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	await helper.signin(sidebar)
	return sidebar
}

async function submit(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled()
	await input.fill(text)
	await input.press("Enter")
	await expect(input).toHaveValue("")
	await expect(sidebar.getByText(text, { exact: true }).last()).toBeVisible()
}

e2e(
	"OpenAI Chat cache - an appended third user turn preserves the complete prior request prefix",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		await configureGpt56ChatProfile(dlineDir)
		server.enqueueResponses(
			"openai-compatible-chat",
			{
				type: "tool",
				id: "call_cache_prefix_round_one",
				name: "qna_respond",
				arguments: { response: "E2E_CACHE_PREFIX_ROUND_ONE" },
			},
			{
				type: "tool",
				id: "call_cache_prefix_round_two",
				name: "qna_respond",
				arguments: { response: "E2E_CACHE_PREFIX_ROUND_TWO" },
			},
			{
				type: "tool",
				id: "call_cache_prefix_complete",
				name: "attempt_completion",
				arguments: { result: "E2E_CACHE_PREFIX_DONE" },
			},
		)

		const app = await openVSCode(workspaceDir)
		try {
			const sidebar = await openSidebar(app, helper)
			await submit(sidebar, "E2E_CACHE_PREFIX_TASK")
			await expect(sidebar.getByText("E2E_CACHE_PREFIX_ROUND_ONE", { exact: true })).toBeVisible({ timeout: 60_000 })
			await submit(sidebar, "E2E_CACHE_PREFIX_FEEDBACK_ONE")
			await expect(sidebar.getByText("E2E_CACHE_PREFIX_ROUND_TWO", { exact: true })).toBeVisible({ timeout: 60_000 })
			await submit(sidebar, "E2E_CACHE_PREFIX_FEEDBACK_TWO")
			await expect(sidebar.getByText("E2E_CACHE_PREFIX_DONE", { exact: false }).last()).toBeVisible({ timeout: 60_000 })

			await expect.poll(() => server.getRequestCount("openai-compatible-chat"), { timeout: 60_000 }).toBe(3)
			const requests = server.getMockConsumptions("openai-compatible-chat")
			const previousBody = requests[1].requestBody as OpenAiChatRequestBody
			const appendedBody = requests[2].requestBody as OpenAiChatRequestBody
			expect(previousBody.model).toBe("gpt-5.6-sol")
			expect(appendedBody.prompt_cache_key).toBe(previousBody.prompt_cache_key)
			expect(appendedBody.messages?.slice(0, previousBody.messages?.length)).toEqual(previousBody.messages)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)
