import { readFile } from "node:fs/promises"
import * as path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { MultiInstanceLauncher, type MultiInstanceSurface } from "@e2e/utils/multi-instance"
import { expect } from "@playwright/test"

interface StoredProfile {
	id: string
	name: string
}

async function readProfiles(dlineDir: string): Promise<StoredProfile[]> {
	return JSON.parse(await readFile(path.join(dlineDir, "data", "settings", "api_profiles.json"), "utf8")) as StoredProfile[]
}

async function openApiSettings(surface: MultiInstanceSurface): Promise<void> {
	await surface.page.getByRole("button", { name: "Settings", exact: true }).click()
	await expect(surface.sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible({
		timeout: 30_000,
	})
}

function profileNameInput(surface: MultiInstanceSurface, profileName: string) {
	return surface.sidebar.locator(`input[value=${JSON.stringify(profileName)}]`)
}

async function enterManageMode(surface: MultiInstanceSurface): Promise<void> {
	const manageButton = surface.sidebar.getByRole("button", { name: "Manage profiles" })
	if (await manageButton.isVisible().catch(() => false)) await manageButton.click()
	await expect(surface.sidebar.getByRole("button", { name: "Done managing profiles" })).toBeVisible()
}

async function renameProfile(surface: MultiInstanceSurface, currentName: string, nextName: string): Promise<void> {
	const input = profileNameInput(surface, currentName)
	await expect(input).toBeVisible()
	await input.fill(nextName)
	await input.blur()
}

async function profileCardNames(surface: MultiInstanceSurface): Promise<string[]> {
	return surface.sidebar
		.getByRole("button", { name: /^Reorder / })
		.evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")?.replace(/^Reorder /, "") ?? ""))
}

async function expectProfileOrder(surface: MultiInstanceSurface, expectedNames: readonly string[]): Promise<void> {
	await expect.poll(() => profileCardNames(surface), { timeout: 15_000 }).toEqual(expectedNames)
}

async function expectResponsiveProfileLayout(surface: MultiInstanceSurface): Promise<void> {
	for (const width of [320, 480, 700]) {
		await surface.page.setViewportSize({ width, height: 800 })
		const metrics = await surface.sidebar.evaluate(() => ({
			clientWidth: document.documentElement.clientWidth,
			scrollWidth: document.documentElement.scrollWidth,
		}))
		expect(metrics.scrollWidth, `Profile settings should not overflow horizontally at ${width}px`).toBeLessThanOrEqual(
			metrics.clientWidth + 1,
		)
	}

	await surface.sidebar.evaluate(() => document.documentElement.style.setProperty("--vscode-font-size", "16px"))
	const scaledMetrics = await surface.sidebar.evaluate(() => ({
		clientWidth: document.documentElement.clientWidth,
		scrollWidth: document.documentElement.scrollWidth,
	}))
	expect(scaledMetrics.scrollWidth, "Profile settings should not overflow at 16px UI font size").toBeLessThanOrEqual(
		scaledMetrics.clientWidth + 1,
	)
}

async function selectColorTheme(surface: MultiInstanceSurface, themeName: string, themeKind: string): Promise<void> {
	await E2ETestHelper.runCommandPalette(surface.page, "Preferences: Color Theme")
	const themeInput = surface.page.locator(".quick-input-widget input").last()
	await expect(themeInput).toBeVisible()
	await themeInput.fill(themeName)
	const themeOption = surface.page
		.locator(".quick-input-widget .monaco-list-row")
		.filter({ has: surface.page.getByText(themeName, { exact: true }) })
	await expect(themeOption).toHaveCount(1)
	await themeOption.click()
	await expect
		.poll(() => surface.sidebar.locator("body").getAttribute("data-vscode-theme-kind"), { timeout: 15_000 })
		.toBe(themeKind)
}

e2e(
	"Profile Catalog - concurrent stale-list edits merge and external rename converges across VS Code instances",
	async ({ dlineDir, dlineDocsDir, extensionsDir, server, workspaceDir }, testInfo) => {
		e2e.setTimeout(240_000)
		const launcher = new MultiInstanceLauncher({
			dlineDir,
			dlineDocsDir,
			extensionsDir,
			server,
			testInfo,
			workspaceDir,
		})
		try {
			const instanceA = await launcher.launch("profile-instance-a")
			const instanceB = await launcher.launch("profile-instance-b")
			await Promise.all([openApiSettings(instanceA), openApiSettings(instanceB)])
			await Promise.all([enterManageMode(instanceA), enterManageMode(instanceB)])

			const profileAName = E2E_PROFILE_NAMES.persistence
			const profileBName = E2E_PROFILE_NAMES.mockDeepSeek
			const initialProfiles = await readProfiles(dlineDir)
			const profileAId = initialProfiles.find((profile) => profile.name === profileAName)?.id
			const profileBId = initialProfiles.find((profile) => profile.name === profileBName)?.id
			if (!profileAId || !profileBId) throw new Error("Required E2E Profiles are missing")

			const profileAConcurrentName = `${profileAName} Concurrent A`
			const profileBConcurrentName = `${profileBName} Concurrent B`
			await Promise.all([
				renameProfile(instanceA, profileAName, profileAConcurrentName),
				renameProfile(instanceB, profileBName, profileBConcurrentName),
			])

			await expect
				.poll(
					async () => {
						const profiles = await readProfiles(dlineDir)
						return {
							profileA: profiles.find((profile) => profile.id === profileAId)?.name,
							profileB: profiles.find((profile) => profile.id === profileBId)?.name,
						}
					},
					{ timeout: 15_000 },
				)
				.toEqual({
					profileA: profileAConcurrentName,
					profileB: profileBConcurrentName,
				})

			for (const surface of [instanceA, instanceB]) {
				await expect(profileNameInput(surface, profileAConcurrentName)).toBeVisible({ timeout: 15_000 })
				await expect(profileNameInput(surface, profileBConcurrentName)).toBeVisible({ timeout: 15_000 })
			}

			const externallyRenamedProfile = `${profileAName} External Commit`
			await renameProfile(instanceA, profileAConcurrentName, externallyRenamedProfile)
			await expect
				.poll(async () => (await readProfiles(dlineDir)).find((profile) => profile.id === profileAId)?.name, {
					timeout: 15_000,
				})
				.toBe(externallyRenamedProfile)

			await expect(profileNameInput(instanceB, externallyRenamedProfile)).toBeVisible({ timeout: 15_000 })
			await expect(profileNameInput(instanceB, profileAConcurrentName)).toHaveCount(0)
		} finally {
			await launcher.dispose()
		}
	},
)

e2e(
	"Profile Catalog - keyboard reorder persists, converges across instances, and remains responsive",
	async ({ dlineDir, dlineDocsDir, extensionsDir, server, workspaceDir }, testInfo) => {
		e2e.setTimeout(240_000)
		const launcher = new MultiInstanceLauncher({
			dlineDir,
			dlineDocsDir,
			extensionsDir,
			server,
			testInfo,
			workspaceDir,
		})
		try {
			const instanceA = await launcher.launch("profile-sort-instance-a")
			const instanceB = await launcher.launch("profile-sort-instance-b")
			await Promise.all([openApiSettings(instanceA), openApiSettings(instanceB)])
			await Promise.all(
				[instanceA, instanceB].map((surface) =>
					expect(surface.sidebar.getByRole("button", { name: /^Reorder / }).first()).toBeVisible({ timeout: 30_000 }),
				),
			)

			const initialProfiles = await readProfiles(dlineDir)
			const [activeProfile, overProfile] = initialProfiles
			if (!activeProfile || !overProfile) throw new Error("At least two E2E Profiles are required for sorting")
			const expectedProfiles = [overProfile, activeProfile, ...initialProfiles.slice(2)]
			const expectedIds = expectedProfiles.map((profile) => profile.id)
			const expectedNames = expectedProfiles.map((profile) => profile.name)

			const dragHandle = instanceA.sidebar.getByRole("button", { name: `Reorder ${activeProfile.name}` })
			await dragHandle.focus()
			await dragHandle.press("Space")
			await expect(dragHandle).toHaveAttribute("aria-pressed", "true")
			await dragHandle.press("ArrowDown")
			await expect(instanceA.sidebar.getByRole("status").filter({ hasText: overProfile.id })).toHaveCount(1)
			await dragHandle.press("Space")

			await expect
				.poll(async () => (await readProfiles(dlineDir)).map((profile) => profile.id), { timeout: 15_000 })
				.toEqual(expectedIds)
			await expectProfileOrder(instanceA, expectedNames)
			await expectProfileOrder(instanceB, expectedNames)
			await expectResponsiveProfileLayout(instanceB)
			await selectColorTheme(instanceB, "Light Modern", "vscode-light")
			await expectResponsiveProfileLayout(instanceB)
			await selectColorTheme(instanceB, "Dark High Contrast", "vscode-high-contrast")
			await expectResponsiveProfileLayout(instanceB)

			await launcher.close(instanceA)
			const reopened = await launcher.launch("profile-sort-reopened")
			await openApiSettings(reopened)
			await expectProfileOrder(reopened, expectedNames)
		} finally {
			await launcher.dispose()
		}
	},
)
