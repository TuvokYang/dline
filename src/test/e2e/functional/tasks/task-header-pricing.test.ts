import { readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"
import type { ElectronApplication } from "playwright"

interface StoredProfile {
	name: string
	openai?: {
		pricing?: {
			cacheReadsPrice?: number
			cacheWritesPrice?: number
			inputPrice?: number
			outputPrice?: number
			thinkingOutputPrice?: number
		}
	}
}

async function configureZeroPricing(dlineDir: string): Promise<void> {
	const profilePath = path.join(dlineDir, "data", "settings", "api_profiles.json")
	const profiles = JSON.parse(await readFile(profilePath, "utf8")) as StoredProfile[]
	const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAi)
	if (!profile?.openai?.pricing) throw new Error("Missing configurable OpenAI E2E profile")
	profile.openai.pricing = {
		cacheReadsPrice: 0,
		cacheWritesPrice: 0,
		inputPrice: 0,
		outputPrice: 0,
		thinkingOutputPrice: 0,
	}
	await writeFile(profilePath, `${JSON.stringify(profiles, null, 2)}\n`, "utf8")
}

async function openSidebar(app: ElectronApplication, helper: E2ETestHelper): Promise<Frame> {
	const page = await app.firstWindow()
	await E2ETestHelper.openClineSidebar(page)
	const sidebar = await helper.getSidebar(page)
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	await helper.signin(sidebar)
	return sidebar
}

e2e(
	"Task header - zero-priced models show token usage without a zero cost",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(150_000)
		await configureZeroPricing(dlineDir)
		server.enqueueResponses("openai-compatible-chat", {
			type: "tool",
			name: "attempt_completion",
			arguments: { result: "E2E_ZERO_PRICE_HEADER_OK" },
			usage: { inputTokens: 1_250, outputTokens: 250 },
		})

		const app = await openVSCode(workspaceDir)
		try {
			const sidebar = await openSidebar(app, helper)
			const input = sidebar.getByTestId("chat-input")
			await input.fill("Exercise zero-priced task header metrics.")
			await input.press("Enter")
			await expect(sidebar.getByText("E2E_ZERO_PRICE_HEADER_OK", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})

			const metrics = sidebar.locator("#price-tag")
			await expect(metrics).toBeVisible()
			await expect(metrics).toContainText("In:1.3K")
			await expect(metrics).toContainText("Out:250")
			await expect(metrics).not.toContainText("$0.000")
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)
