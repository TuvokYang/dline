import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect } from "@playwright/test"

const SKILL_NAME = "e2e-slash-skill"

e2e("Slash Skills show the skill name instead of its filesystem path", async ({ helper, sidebar, userDataDir, workspaceDir }) => {
	e2e.setTimeout(120_000)
	await helper.signin(sidebar)

	const skillDirectory = path.join(workspaceDir, ".agents", "skills", SKILL_NAME)
	await mkdir(skillDirectory, { recursive: true })
	await writeFile(
		path.join(skillDirectory, "SKILL.md"),
		[
			"---",
			`name: ${SKILL_NAME}`,
			"description: Skill shown by the focused slash menu E2E test",
			"---",
			"Use this skill only for the focused slash menu E2E test.",
		].join("\n"),
		"utf8",
	)

	const capabilitiesButton = sidebar.getByRole("button", { name: "Show Dline Rules & Workflows", exact: true }).first()
	await capabilitiesButton.click()
	const skillsTab = sidebar.getByRole("button", { name: "Skills", exact: true })
	await skillsTab.click()
	await expect(skillsTab).toHaveAttribute("aria-pressed", "true")
	await expect(sidebar.getByText(SKILL_NAME, { exact: true })).toBeVisible({ timeout: 30_000 })
	await sidebar.getByRole("button", { name: "Hide Dline Rules & Workflows", exact: true }).first().click()

	const input = sidebar.getByTestId("chat-input")
	await input.fill("/")
	const menu = sidebar.getByTestId("slash-commands-menu")
	await expect(menu).toBeVisible()
	await expect(menu.getByText("Skills", { exact: true })).toBeVisible()
	await expect(menu).not.toContainText(workspaceDir)
	await expect(menu).not.toContainText("SKILL.md")

	const skillOption = menu.getByText(SKILL_NAME, { exact: true })
	await expect(skillOption).toBeVisible()
	await skillOption.click()
	await expect(input).toHaveValue(`/skills:${SKILL_NAME} `)

	await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
})
