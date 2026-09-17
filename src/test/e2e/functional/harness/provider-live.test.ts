import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

const requestedProfileMode = process.env.DLINE_E2E_PROFILE?.trim()
const liveProfilesEnabled = Boolean(requestedProfileMode && requestedProfileMode !== "mock-openai")

e2e.use({ profileMode: liveProfilesEnabled ? "live" : "mock" })
e2e.skip(!liveProfilesEnabled, "Live profile E2E requires an explicit non-mock DLINE_E2E_PROFILE")

async function selectProfile(sidebar: Frame, profileName: string): Promise<void> {
	const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
	const profileListTitle = sidebar.getByText("Available Models", { exact: true })
	const profileOverlay = sidebar.locator(".fixed.inset-0.z-40")

	if ((await modelSwitcher.innerText()).trim() === profileName) {
		await expect(profileListTitle).not.toBeVisible()
		await expect(profileOverlay).not.toBeVisible()
		return
	}

	await modelSwitcher.click()
	await expect(profileListTitle).toBeVisible()
	const profileOption = sidebar.getByRole("option").filter({ has: sidebar.getByText(profileName, { exact: true }) })
	await expect(profileOption).toHaveCount(1)
	await profileOption.click()
	await expect(modelSwitcher).toHaveText(profileName)
	await expect(profileListTitle).not.toBeVisible()
	await expect(profileOverlay).not.toBeVisible()
}

e2e.describe("Live provider profile", () => {
	e2e(
		"completes a minimal turn with every preprocessed credential profile",
		async ({ helper, preparedE2EState, sidebar, userDataDir }) => {
			const liveProfiles = preparedE2EState.liveProfiles
			e2e.skip(liveProfiles.length === 0, "No local or API_KEY_<PROVIDER>_<MODEL> credentials were preprocessed")
			e2e.setTimeout(Math.max(180_000, liveProfiles.length * 180_000))
			await helper.signin(sidebar)
			const failures: string[] = []

			for (const profile of liveProfiles) {
				const input = sidebar.getByTestId("chat-input")
				try {
					await e2e.step(`${profile.credentialSource}: ${profile.provider}:${profile.modelId}`, async () => {
						await selectProfile(sidebar, profile.profileName)

						await input.fill(
							"Calculate 271828 + 314159. Return only the numeric result, without separators or explanation.",
						)
						await sidebar.getByTestId("send-button").click()
						const answer = sidebar.getByText("585987", { exact: false }).last()
						const hardApiFailure = sidebar.getByText(/"status":(?:401|402|403)/).last()
						await expect
							.poll(async () => (await answer.isVisible()) || (await hardApiFailure.isVisible()), {
								timeout: 120_000,
							})
							.toBe(true)
						if (await hardApiFailure.isVisible()) {
							throw new Error((await hardApiFailure.textContent())?.trim() || "Provider authentication failed")
						}
					})
				} catch (error) {
					failures.push(
						`${profile.credentialSource} ${profile.provider}:${profile.modelId}: ${error instanceof Error ? error.message : String(error)}`,
					)
				} finally {
					const profileOverlay = sidebar.locator(".fixed.inset-0.z-40")
					if (await profileOverlay.isVisible()) {
						await profileOverlay.click({ position: { x: 1, y: 1 } })
						await expect(profileOverlay).not.toBeVisible()
					}
					const closeTask = sidebar.getByRole("button", { name: "Close Task" })
					if (await closeTask.isVisible()) {
						await closeTask.click()
						await expect(input).toBeVisible()
					}
				}
			}

			if (failures.length === 0) await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
			expect(failures, `Live provider failures:\n${failures.join("\n")}`).toEqual([])
		},
	)
})
