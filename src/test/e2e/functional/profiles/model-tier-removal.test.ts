import { readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Locator, type Page } from "@playwright/test"
import type { ElectronApplication } from "playwright"

interface StoredProfile {
	name: string
	anthropic?: {
		customModelEnabled?: boolean
		capabilities?: { contextWindowTiers?: unknown[] }
		pricing?: { tiers?: unknown[] }
		pricingTiersEnabled?: boolean
	}
}

const profilesPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "api_profiles.json")

async function openModelConfiguration(page: Page, sidebar: Frame): Promise<Locator> {
	await page.getByRole("button", { name: "Settings", exact: true }).click()
	await expect(sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible()
	const card = sidebar.getByTestId("api-profile-card").filter({
		has: sidebar.getByRole("button", { name: new RegExp(`^(Expand|Collapse) ${E2E_PROFILE_NAMES.mockAnthropic}$`) }),
	})
	await expect(card).toHaveCount(1)
	const expandToggle = card.getByRole("button", { name: /^Expand / })
	if (await expandToggle.isVisible()) await expandToggle.click()
	await expect(card.getByRole("button", { name: /^Collapse / })).toBeVisible()
	const modelConfiguration = card.getByRole("button", { name: "Model Configuration" })
	await expect(modelConfiguration).toBeVisible()
	if (!(await card.getByRole("textbox", { name: "Context Window Size" }).isVisible())) await modelConfiguration.click()
	await expect(card.getByRole("textbox", { name: "Context Window Size" })).toBeVisible()
	return card
}

async function removeAll(card: Locator, name: "Remove Context Tier" | "Remove Pricing Tier"): Promise<void> {
	const buttons = card.getByRole("button", { name })
	while ((await buttons.count()) > 0) {
		const previous = await buttons.count()
		await buttons.first().click()
		await expect.poll(() => buttons.count()).toBeLessThan(previous)
	}
}

async function readProfile(dlineDir: string): Promise<StoredProfile> {
	const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
	const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockAnthropic)
	if (!profile) throw new Error("Missing Anthropic E2E Profile")
	return profile
}

async function seedExplicitTiers(dlineDir: string): Promise<void> {
	const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
	const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockAnthropic)
	if (!profile) throw new Error("Missing Anthropic E2E Profile")
	profile.anthropic = {
		...(profile.anthropic ?? {}),
		customModelEnabled: true,
		capabilities: {
			contextWindowTiers: [
				{ id: "standard", contextWindow: 200_000, label: "200K" },
				{ id: "long", contextWindow: 1_000_000, label: "1M" },
			],
		},
		pricing: {
			tiers: [{ contextWindow: 200_000, inputPrice: 3, outputPrice: 15 }],
		},
		pricingTiersEnabled: true,
	}
	await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")
}

e2e(
	"Model configuration keeps explicitly removed context and pricing tiers empty after restart",
	async ({ dlineDir, helper, openVSCode, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		let firstApp: ElectronApplication | undefined
		let reopenedApp: ElectronApplication | undefined
		await seedExplicitTiers(dlineDir)
		try {
			firstApp = await openVSCode(workspaceDir)
			const firstPage = await firstApp.firstWindow()
			await E2ETestHelper.openClineSidebar(firstPage)
			const firstSidebar = await helper.getSidebar(firstPage)
			await helper.signin(firstSidebar)
			const card = await openModelConfiguration(firstPage, firstSidebar)
			expect(await card.getByRole("button", { name: "Remove Context Tier" }).count()).toBeGreaterThan(0)
			expect(await card.getByRole("button", { name: "Remove Pricing Tier" }).count()).toBeGreaterThan(0)
			await removeAll(card, "Remove Context Tier")
			await removeAll(card, "Remove Pricing Tier")
			await expect
				.poll(async () => {
					const profile = await readProfile(dlineDir)
					return {
						context: profile.anthropic?.capabilities?.contextWindowTiers,
						pricing: profile.anthropic?.pricing?.tiers,
						pricingTiersEnabled: profile.anthropic?.pricingTiersEnabled,
					}
				})
				.toEqual({ context: [], pricing: [], pricingTiersEnabled: true })

			await firstApp.close()
			firstApp = undefined
			helper.clearCachedFrame()
			reopenedApp = await openVSCode(workspaceDir)
			const reopenedPage = await reopenedApp.firstWindow()
			await E2ETestHelper.openClineSidebar(reopenedPage)
			const reopenedSidebar = await helper.getSidebar(reopenedPage)
			await helper.signin(reopenedSidebar)
			const reopenedCard = await openModelConfiguration(reopenedPage, reopenedSidebar)
			await expect(reopenedCard.getByRole("button", { name: "Remove Context Tier" })).toHaveCount(0)
			await expect(reopenedCard.getByRole("button", { name: "Remove Pricing Tier" })).toHaveCount(0)
			await expect(reopenedCard.getByRole("button", { name: "Add Context Tier" })).toBeVisible()
			await expect(reopenedCard.getByRole("button", { name: "Add Pricing Tier" })).toBeVisible()
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await reopenedApp?.close()
			await firstApp?.close()
		}
	},
)
