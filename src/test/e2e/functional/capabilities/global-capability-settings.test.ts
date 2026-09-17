import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

interface StoredSettings {
	__settingsMigrationVersion?: number
	globalClineRulesToggles?: Record<string, boolean>
	globalWorkflowToggles?: Record<string, boolean>
	globalSkillsToggles?: Record<string, boolean>
	globalSubagentsToggles?: Record<string, boolean>
	[key: string]: unknown
}

const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")
const globalStatePath = (dlineDir: string) => path.join(dlineDir, "data", "globalState.json")

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath)
		return true
	} catch {
		return false
	}
}

async function writeCapabilityFixtures(dlineDocsDir: string): Promise<{
	rulePath: string
	workflowPath: string
	skillPath: string
	subagentPath: string
}> {
	const rulePath = path.join(dlineDocsDir, "rules", "e2e-upgrade-rule.md")
	const workflowPath = path.join(dlineDocsDir, "workflows", "e2e-upgrade-workflow.md")
	const skillDirectory = path.join(dlineDocsDir, "skills", "e2e-upgrade-skill")
	const skillPath = path.join(skillDirectory, "SKILL.md")
	const subagentPath = path.join(dlineDocsDir, "subagents", "e2e-upgrade-subagent.yml")

	await Promise.all([
		mkdir(path.dirname(rulePath), { recursive: true }),
		mkdir(path.dirname(workflowPath), { recursive: true }),
		mkdir(skillDirectory, { recursive: true }),
		mkdir(path.dirname(subagentPath), { recursive: true }),
	])
	await Promise.all([
		writeFile(rulePath, "# E2E disabled global rule\n", "utf8"),
		writeFile(workflowPath, "# E2E disabled global workflow\n", "utf8"),
		writeFile(
			skillPath,
			"---\nname: e2e-upgrade-skill\ndescription: E2E disabled global skill\n---\n\nKeep this skill disabled.\n",
			"utf8",
		),
		writeFile(
			subagentPath,
			"---\nname: e2e-upgrade-subagent\ndescription: E2E disabled global subagent\ntools: []\n---\n\nKeep this subagent disabled.\n",
			"utf8",
		),
	])
	return { rulePath, workflowPath, skillPath, subagentPath }
}

async function seedLegacyDisabledToggles(dlineDir: string, files: Awaited<ReturnType<typeof writeCapabilityFixtures>>) {
	const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as StoredSettings
	settings.__settingsMigrationVersion = 1
	delete settings.globalClineRulesToggles
	delete settings.globalWorkflowToggles
	delete settings.globalSkillsToggles
	delete settings.globalSubagentsToggles
	await writeFile(settingsPath(dlineDir), `${JSON.stringify(settings, null, 2)}\n`, "utf8")

	const globalState = JSON.parse(await readFile(globalStatePath(dlineDir), "utf8")) as Record<string, unknown>
	await writeFile(
		globalStatePath(dlineDir),
		`${JSON.stringify(
			{
				...globalState,
				globalClineRulesToggles: { [files.rulePath]: false },
				globalWorkflowToggles: { [files.workflowPath]: false },
				globalSkillsToggles: { [files.skillPath]: false },
				globalSubagentsToggles: { [files.subagentPath]: false },
			},
			null,
			2,
		)}\n`,
		"utf8",
	)
}

async function openCapabilities(sidebar: Frame): Promise<void> {
	await sidebar.getByRole("button", { name: "Show Dline Rules & Workflows", exact: true }).first().click()
	await expect(sidebar.getByTestId("capabilities-popup")).toBeVisible()
}

function section(sidebar: Frame, heading: string) {
	return sidebar.getByText(heading, { exact: true }).locator("..")
}

function resourceSwitch(sidebar: Frame, sectionHeading: string, resourceName: string) {
	return section(sidebar, sectionHeading)
		.getByText(resourceName, { exact: true })
		.locator("xpath=ancestor::div[contains(@class, 'mb-2.5')][1]")
		.getByRole("switch")
}

e2e.use({ isolateOsHome: true })

e2e(
	"Global capability settings - legacy disabled toggles survive the Settings v2 upgrade",
	async ({ dlineDir, dlineDocsDir, helper, openVSCode, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		const files = await writeCapabilityFixtures(dlineDocsDir)
		await seedLegacyDisabledToggles(dlineDir, files)

		const app = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			await E2ETestHelper.openClineSidebar(page)
			const sidebar = await helper.getSidebar(page)
			await helper.signin(sidebar)
			await openCapabilities(sidebar)

			await expect(resourceSwitch(sidebar, "Global Rules", "e2e-upgrade-rule.md")).toHaveAttribute(
				"data-state",
				"unchecked",
			)

			await sidebar.getByRole("button", { name: "Workflows", exact: true }).click()
			await expect(resourceSwitch(sidebar, "Global Workflows", "e2e-upgrade-workflow.md")).toHaveAttribute(
				"data-state",
				"unchecked",
			)

			await sidebar.getByRole("button", { name: "Skills", exact: true }).click()
			await expect(resourceSwitch(sidebar, "Global Skills", "e2e-upgrade-skill")).toHaveAttribute("data-state", "unchecked")

			await sidebar.getByRole("button", { name: "Subagents", exact: true }).click()
			await expect(resourceSwitch(sidebar, "Global Subagents", "e2e-upgrade-subagent")).toHaveAttribute(
				"data-state",
				"unchecked",
			)

			const migrated = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as StoredSettings
			expect(migrated.__settingsMigrationVersion).toBe(2)
			expect(migrated.globalClineRulesToggles?.[files.rulePath]).toBe(false)
			expect(migrated.globalWorkflowToggles?.[files.workflowPath]).toBe(false)
			expect(migrated.globalSkillsToggles?.[files.skillPath]).toBe(false)
			expect(migrated.globalSubagentsToggles?.[files.subagentPath]).toBe(false)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Global skill creation - writes only to the Dline documents skills directory",
	async ({ dlineDocsDir, helper, openVSCode, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		const skillName = "e2e-canonical-global-skill"
		const canonicalSkillPath = path.join(dlineDocsDir, "skills", skillName, "SKILL.md")
		const legacySkillPath = path.join(userDataDir, "os-home", ".agents", "skills", skillName, "SKILL.md")

		const app = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			await E2ETestHelper.openClineSidebar(page)
			const sidebar = await helper.getSidebar(page)
			await helper.signin(sidebar)
			await openCapabilities(sidebar)
			await sidebar.getByRole("button", { name: "Skills", exact: true }).click()

			const globalSkills = section(sidebar, "Global Skills")
			await globalSkills.getByPlaceholder("New skill...").click()
			const newSkillInput = globalSkills.getByPlaceholder("skill-name (letters, numbers, dashes, underscores)")
			await newSkillInput.fill(skillName)
			await newSkillInput.press("Enter")

			await expect.poll(() => pathExists(canonicalSkillPath), { timeout: 30_000 }).toBe(true)
			expect(await pathExists(legacySkillPath)).toBe(false)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)
