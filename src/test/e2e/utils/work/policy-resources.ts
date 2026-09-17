import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2ETestHelper } from "@e2e/utils/helpers"
import { expect, type Frame, type Locator } from "@playwright/test"

export interface WorkPolicyMarkers {
	globalRuleV1: string
	globalRuleV2: string
	workspaceRuleV1: string
	workspaceRuleV2: string
	conditionalRuleV1: string
	conditionalRuleV2: string
	workflowName: string
	workflowMarker: string
	skillName: string
	skillMarker: string
}

export interface WorkPolicyResources {
	globalRulePath: string
	workspaceRulePath: string
	conditionalRulePath: string
	workflowPath: string
	skillPath: string
}

function conditionalRule(marker: string): string {
	return ["---", "paths:", '  - "README.md"', "---", "", "# Conditional daily policy", "", marker, ""].join("\n")
}

export async function seedWorkPolicyResources(
	dlineDocsDir: string,
	workspaceDir: string,
	markers: WorkPolicyMarkers,
): Promise<WorkPolicyResources> {
	const globalRulesDir = path.join(dlineDocsDir, "rules")
	const workspaceRulesDir = path.join(workspaceDir, ".agents", "rules")
	const workflowDir = path.join(workspaceDir, ".agents", "workflows")
	const skillDir = path.join(workspaceDir, ".agents", "skills", markers.skillName)
	await Promise.all([
		mkdir(globalRulesDir, { recursive: true }),
		mkdir(workspaceRulesDir, { recursive: true }),
		mkdir(workflowDir, { recursive: true }),
		mkdir(skillDir, { recursive: true }),
	])

	const resources: WorkPolicyResources = {
		globalRulePath: path.join(globalRulesDir, "work-daily-global-rule.md"),
		workspaceRulePath: path.join(workspaceRulesDir, "work-daily-workspace-rule.md"),
		conditionalRulePath: path.join(workspaceRulesDir, "work-daily-conditional-rule.md"),
		workflowPath: path.join(workflowDir, `${markers.workflowName}.md`),
		skillPath: path.join(skillDir, "SKILL.md"),
	}

	await Promise.all([
		writeFile(resources.globalRulePath, `# Global daily policy\n\n${markers.globalRuleV1}\n`, "utf8"),
		writeFile(resources.workspaceRulePath, `# Workspace daily policy\n\n${markers.workspaceRuleV1}\n`, "utf8"),
		writeFile(resources.conditionalRulePath, conditionalRule(markers.conditionalRuleV1), "utf8"),
		writeFile(
			resources.workflowPath,
			[
				"---",
				`name: ${markers.workflowName}`,
				"description: Daily profiles and policies workflow marker",
				"---",
				"",
				markers.workflowMarker,
				"",
			].join("\n"),
			"utf8",
		),
		writeFile(
			resources.skillPath,
			[
				"---",
				`name: ${markers.skillName}`,
				"description: Daily profiles and policies skill marker",
				"---",
				"",
				markers.skillMarker,
				"",
			].join("\n"),
			"utf8",
		),
	])
	return resources
}

export async function writeWorkRuleVersionTwo(resources: WorkPolicyResources, markers: WorkPolicyMarkers): Promise<void> {
	await Promise.all([
		writeFile(resources.globalRulePath, `# Global daily policy\n\n${markers.globalRuleV2}\n`, "utf8"),
		writeFile(resources.workspaceRulePath, `# Workspace daily policy\n\n${markers.workspaceRuleV2}\n`, "utf8"),
		writeFile(resources.conditionalRulePath, conditionalRule(markers.conditionalRuleV2), "utf8"),
	])
}

export async function openWorkCapabilities(sidebar: Frame): Promise<Locator> {
	await sidebar.getByRole("button", { name: "Show Dline Rules & Workflows", exact: true }).first().click()
	const popup = sidebar.getByTestId("capabilities-popup")
	await expect(popup).toBeVisible()
	return popup
}

export async function selectWorkCapabilityTab(sidebar: Frame, name: "Rules" | "Workflows" | "Hooks" | "Skills"): Promise<void> {
	const tab = sidebar.getByRole("button", { name, exact: true })
	await tab.click()
	await expect(tab).toHaveAttribute("aria-pressed", "true")
}

export async function closeWorkCapabilities(sidebar: Frame): Promise<void> {
	await sidebar.getByRole("button", { name: "Hide Dline Rules & Workflows", exact: true }).first().click()
	await expect(sidebar.getByTestId("capabilities-popup")).toBeHidden()
}

function workspaceHookSection(sidebar: Frame, workspaceName: string): Locator {
	return sidebar.getByText(`${workspaceName}/.agents/hooks/`, { exact: true }).locator("xpath=..")
}

function hookRow(sidebar: Frame, workspaceName: string, hookName: string): Locator {
	return workspaceHookSection(sidebar, workspaceName)
		.getByText(hookName, { exact: true })
		.locator("xpath=ancestor::div[contains(@class, 'mb-2.5')][1]")
}

export async function createWorkspaceTaskStartHook(sidebar: Frame, workspaceName: string): Promise<void> {
	await selectWorkCapabilityTab(sidebar, "Hooks")
	const section = workspaceHookSection(sidebar, workspaceName)
	await expect(section).toBeVisible({ timeout: 30_000 })
	await section.getByRole("combobox", { name: "Select hook type to create" }).selectOption("TaskStart")
	await expect(hookRow(sidebar, workspaceName, "TaskStart")).toBeVisible({ timeout: 30_000 })
}

export function workspaceTaskStartHookPath(workspaceDir: string): string {
	return path.join(workspaceDir, ".agents", "hooks", process.platform === "win32" ? "TaskStart.ps1" : "TaskStart")
}

export async function waitForWorkspaceTaskStartHook(hookPath: string): Promise<void> {
	await E2ETestHelper.waitForValue(async () => {
		try {
			return (await readFile(hookPath, "utf8")).length > 0 ? true : undefined
		} catch {
			return undefined
		}
	}, 30_000)
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`
}

function powershellQuote(value: string): string {
	return `'${value.replaceAll("'", "''")}'`
}

export async function writeWorkspaceTaskStartHook(hookPath: string, markerPath: string, contextMarker: string): Promise<void> {
	await mkdir(path.dirname(hookPath), { recursive: true })
	const script =
		process.platform === "win32"
			? [
					"$null = [Console]::In.ReadToEnd()",
					`Set-Content -LiteralPath ${powershellQuote(markerPath)} -Value 'WORK_POLICY_HOOK_RAN' -Encoding UTF8 -NoNewline`,
					`@{ cancel = $false; contextModification = ${powershellQuote(contextMarker)}; errorMessage = '' } | ConvertTo-Json -Compress`,
				].join("\n")
			: [
					"#!/usr/bin/env bash",
					"cat >/dev/null",
					`printf '%s' 'WORK_POLICY_HOOK_RAN' > ${shellQuote(markerPath)}`,
					`printf '%s\\n' ${shellQuote(JSON.stringify({ cancel: false, contextModification: contextMarker, errorMessage: "" }))}`,
				].join("\n")
	await writeFile(hookPath, `${script}\n`, "utf8")
	if (process.platform !== "win32") await chmod(hookPath, 0o755)
}

export async function enableWorkspaceTaskStartHook(sidebar: Frame, workspaceName: string): Promise<void> {
	const toggle = hookRow(sidebar, workspaceName, "TaskStart").getByRole("switch")
	await expect(toggle).toHaveCount(1)
	if (await toggle.isDisabled()) {
		await expect(toggle).toHaveAttribute("data-state", "checked")
		return
	}
	if ((await toggle.getAttribute("data-state")) !== "checked") await toggle.click()
	await expect(toggle).toHaveAttribute("data-state", "checked")
}

export async function selectWorkSlashCommand(
	sidebar: Frame,
	sectionName: "Workflows" | "Skills",
	resourceName: string,
	forbiddenText: readonly string[],
): Promise<Locator> {
	const input = sidebar.getByTestId("chat-input")
	await input.fill("/")
	const menu = sidebar.getByTestId("slash-commands-menu")
	await expect(menu).toBeVisible()
	await expect(menu.getByText(sectionName, { exact: true })).toBeVisible()
	for (const value of forbiddenText) await expect(menu).not.toContainText(value)
	await menu.getByText(resourceName, { exact: true }).click()
	const prefix = sectionName === "Workflows" ? `/workflow:${resourceName} ` : `/skills:${resourceName} `
	if ((await input.inputValue()) !== prefix) await input.fill(prefix)
	await expect(input).toHaveValue(prefix)
	return input
}

export async function expectWorkPromptStale(sidebar: Frame): Promise<Locator> {
	const refreshButton = sidebar.locator("button:has(svg.lucide-refresh-cw)").first()
	const warning = refreshButton.getByTestId("prompt-freshness-warning")
	await expect(warning).toBeVisible({ timeout: 30_000 })
	await refreshButton.hover()
	const tooltip = sidebar.getByRole("tooltip").filter({ hasText: "Prompt update available" })
	await expect(tooltip).toContainText("Rules changed")
	return refreshButton
}

export async function refreshWorkPrompt(sidebar: Frame, refreshButton: Locator): Promise<void> {
	await refreshButton.click()
	const dialog = sidebar.getByRole("dialog")
	await expect(dialog.getByRole("heading", { name: "Refresh Prompt Cache", exact: true })).toBeVisible()
	await dialog.getByRole("button", { name: "Confirm", exact: true }).click()
	await expect(dialog.getByRole("heading", { name: "Refresh Prompt Cache", exact: true })).toBeHidden()
	await expect(refreshButton.getByTestId("prompt-freshness-warning")).toHaveCount(0, { timeout: 30_000 })
}

export async function waitForWorkFileMarker(filePath: string, marker: string): Promise<void> {
	await E2ETestHelper.waitForValue(async () => {
		const content = await readFile(filePath, "utf8").catch(() => "")
		return content.includes(marker) ? true : undefined
	}, 30_000)
}
