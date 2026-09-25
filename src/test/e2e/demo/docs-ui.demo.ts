import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { expect, type Frame, type Locator } from "@playwright/test"
import { E2ETestHelper } from "../utils/helpers"
import { demo } from "./utils/demo-fixture"
import { captureDocScreenshot } from "./utils/doc-capture"

/**
 * Documentation captures for the docs site (`docs/public/assets/ui`).
 *
 * Stills are cropped from live bounding boxes and numbered in reading order.
 * GIFs are recorded full-frame and reframed afterwards by `npm run demo:media`
 * with the camera keyframes emitted by `focusCamera`.
 */

const WORKFLOW_NAME = "release-review"
const MCP_NAME = "release-tools"
const SIDEBAR_RECORDING = {
	crop: "sidebar",
	fps: 12,
	outputWidth: 560,
	camera: { aspectRatio: 4 / 3, minWidth: 560, spotlight: true },
} as const

async function seedWorkspaceCapabilities(workspaceDir: string): Promise<void> {
	const files: Record<string, string> = {
		"rules/release-policy.md": "Keep release reviews focused on actionable risks and the next decision.",
		[`workflows/${WORKFLOW_NAME}.md`]: [
			"---",
			`name: ${WORKFLOW_NAME}`,
			"description: Run a focused release-readiness review.",
			"---",
			"Inspect release readiness, summarize findings, and identify the next action.",
		].join("\n"),
		"skills/release-checklist/SKILL.md": [
			"---",
			"name: release-checklist",
			"description: Review a release checklist and summarize remaining risks.",
			"---",
			"Review the requested release checklist and report actionable risks.",
		].join("\n"),
		"subagents/code-researcher.yml": [
			"---",
			"name: code-researcher",
			"description: Read-only codebase research",
			"tools:",
			"  - read_file",
			"  - search_files",
			"---",
			"Research the codebase and report findings with file references.",
		].join("\n"),
		[`mcp/${MCP_NAME}.json`]: JSON.stringify(
			{
				name: MCP_NAME,
				description: "Demo release tooling for documentation captures.",
				type: "stdio",
				command: process.execPath,
				args: [path.join(E2ETestHelper.E2E_TESTS_DIR, "fixtures", "workspace-mcp-server.mjs")],
			},
			null,
			2,
		),
	}
	for (const [relativePath, content] of Object.entries(files)) {
		const target = path.join(workspaceDir, ".agents", relativePath)
		await mkdir(path.dirname(target), { recursive: true })
		await writeFile(target, `${content}\n`, "utf8")
	}
}

function showCapabilitiesButton(sidebar: Frame): Locator {
	return sidebar.getByRole("button", { name: "Show Dline Rules & Workflows", exact: true }).first()
}

function showMcpButton(sidebar: Frame): Locator {
	return sidebar.getByRole("button", { name: "Show MCP Servers", exact: true }).first()
}

function autoApproveToggle(sidebar: Frame, open: boolean): Locator {
	return sidebar.locator(`[aria-label="${open ? "Close" : "Open"} auto-approve settings"]`)
}

async function selectCapabilityTab(popup: Locator, tab: string): Promise<void> {
	const tabButton = popup.getByRole("button", { name: tab, exact: true })
	await tabButton.click()
	await expect(tabButton).toHaveAttribute("aria-pressed", "true")
}

demo("docs UI stills", async ({ helper, page, sidebar, workspaceDir }) => {
	demo.setTimeout(240_000)
	await seedWorkspaceCapabilities(workspaceDir)
	await helper.signin(sidebar)

	const modeSwitch = sidebar.getByTestId("mode-switch")
	await captureDocScreenshot(page, sidebar, "chat-input-toolbar", {
		regions: [autoApproveToggle(sidebar, false), sidebar.getByTestId("chat-input"), modeSwitch],
		markers: [
			{ label: "1", target: sidebar.getByTestId("context-button") },
			{ label: "2", target: sidebar.getByTestId("files-button") },
			{ label: "3", target: showMcpButton(sidebar) },
			{ label: "4", target: showCapabilitiesButton(sidebar) },
			{ label: "5", target: sidebar.getByRole("button", { name: "Select model", exact: true }) },
			{ label: "6", target: modeSwitch },
			{ label: "7", target: sidebar.getByTestId("send-button") },
		],
	})

	await showCapabilitiesButton(sidebar).click()
	const popup = sidebar.getByTestId("capabilities-popup")
	await expect(popup).toBeVisible()
	const capabilityTabs = [
		{ tab: "Rules", id: "capabilities-rules", item: popup.getByText("release-policy.md", { exact: true }) },
		{ tab: "Workflows", id: "capabilities-workflows", item: popup.getByText(`${WORKFLOW_NAME}.md`, { exact: true }) },
		{ tab: "Skills", id: "capabilities-skills", item: popup.getByText("release-checklist", { exact: true }) },
		{ tab: "Subagents", id: "capabilities-subagents", item: popup.getByText("code-researcher", { exact: false }).first() },
		{ tab: "Environments", id: "capabilities-environments", item: sidebar.getByTestId("shell-environment-panel") },
	]
	for (const { tab, id, item } of capabilityTabs) {
		await selectCapabilityTab(popup, tab)
		await expect(item).toBeVisible({ timeout: 30_000 })
		await captureDocScreenshot(page, sidebar, id, { regions: [popup], padding: 4 })
	}
	await sidebar.getByRole("button", { name: "Hide Dline Rules & Workflows", exact: true }).first().click()
	await expect(popup).toBeHidden()

	await autoApproveToggle(sidebar, false).click()
	const autoApproveIntro = sidebar.getByText("Let Dline take these actions without asking for approval.", { exact: false })
	await expect(autoApproveIntro).toBeVisible()
	await captureDocScreenshot(page, sidebar, "auto-approve-menu", {
		regions: [
			autoApproveIntro,
			sidebar.getByText("Notifications may show abbreviated tool details", { exact: false }),
			autoApproveToggle(sidebar, true),
		],
		padding: 16,
	})
	await autoApproveToggle(sidebar, true).click()

	await showMcpButton(sidebar).click()
	const serverName = sidebar.getByText(MCP_NAME, { exact: true })
	await expect(serverName).toBeVisible({ timeout: 30_000 })
	await captureDocScreenshot(page, sidebar, "mcp-servers-popup", {
		regions: [
			sidebar.getByText("MCP Servers", { exact: true }),
			sidebar.getByRole("button", { name: "Go to MCP server settings" }),
			serverName,
		],
		padding: 16,
	})
})

demo("docs mode switch", async ({ finishRecording, focusCamera, helper, pace, registerRecording, sidebar }) => {
	await helper.signin(sidebar)
	const modeSwitch = sidebar.getByTestId("mode-switch")
	await expect(sidebar.getByRole("switch", { name: "Act" })).toHaveAttribute("aria-checked", "true")

	await registerRecording("docs-mode-switch", SIDEBAR_RECORDING)
	await focusCamera(modeSwitch)
	await modeSwitch.getByText("Plan", { exact: true }).hover()
	await pace(1_400)
	await modeSwitch.click()
	await expect(sidebar.getByRole("switch", { name: "Plan" })).toHaveAttribute("aria-checked", "true")
	await pace(1_400)
	await modeSwitch.click()
	await expect(sidebar.getByRole("switch", { name: "Act" })).toHaveAttribute("aria-checked", "true")
	await pace(1_200)
	await finishRecording()
})

demo("docs slash workflow", async ({ finishRecording, focusCamera, helper, pace, registerRecording, sidebar, workspaceDir }) => {
	await seedWorkspaceCapabilities(workspaceDir)
	await helper.signin(sidebar)
	const input = sidebar.getByTestId("chat-input")

	await registerRecording("docs-slash-workflow", SIDEBAR_RECORDING)
	await focusCamera(input)
	await input.click()
	await input.pressSequentially("/rel", { delay: 140 })
	const menu = sidebar.getByLabel("Slash commands")
	await expect(menu).toBeVisible()
	await focusCamera([menu, input])
	await pace(1_200)
	await menu.getByText(WORKFLOW_NAME, { exact: false }).first().click()
	// Return to the input as soon as the menu closes so the spotlight never outlines empty space.
	await expect(menu).toBeHidden()
	await focusCamera(input, 0)
	await expect(input).toHaveValue(new RegExp(`^/workflow:${WORKFLOW_NAME}\\s*$`))
	await pace(1_600)
	await finishRecording()
})

demo("docs context mention", async ({ finishRecording, focusCamera, helper, pace, registerRecording, sidebar }) => {
	await helper.signin(sidebar)
	const input = sidebar.getByTestId("chat-input")

	await registerRecording("docs-context-mention", SIDEBAR_RECORDING)
	await focusCamera(input)
	await input.click()
	await input.pressSequentially("Review @", { delay: 120 })
	const menu = sidebar.getByLabel("Context mentions")
	await expect(menu).toBeVisible()
	await focusCamera([menu, input])
	await pace(1_000)
	for (let step = 0; step < 2; step += 1) {
		await input.press("ArrowDown")
		await pace(700)
	}
	await pace(800)
	await input.press("Escape")
	await expect(menu).toBeHidden()
	await focusCamera(input, 0)
	await pace(1_200)
	await finishRecording()
})

demo("docs environment variable", async ({ finishRecording, focusCamera, helper, page, pace, registerRecording, sidebar }) => {
	await helper.signin(sidebar)

	await registerRecording("docs-environment-variable", SIDEBAR_RECORDING)
	const showCapabilities = showCapabilitiesButton(sidebar)
	await focusCamera(showCapabilities)
	await showCapabilities.click()
	const popup = sidebar.getByTestId("capabilities-popup")
	await expect(popup).toBeVisible()
	const environmentsTab = popup.getByRole("button", { name: "Environments", exact: true })
	await focusCamera(environmentsTab)
	await selectCapabilityTab(popup, "Environments")

	const panel = sidebar.getByTestId("shell-environment-panel")
	const addVariable = panel.getByRole("button", { name: "Add variable" })
	await expect(addVariable).toBeVisible({ timeout: 30_000 })
	await focusCamera(addVariable)
	await addVariable.click()
	// The editor autosaves 350 ms after the last change. Action annotations pause ~500 ms
	// before each action, which would save the blank new row and flash a validation error,
	// so start typing without an annotation pause and restore the pointer afterwards.
	const variableName = panel.getByLabel("Environment name 1")
	const variableValue = panel.getByLabel("Environment value 1")
	await page.screencast.hideActions()
	await variableName.pressSequentially("API_BASE_URL", { delay: 60 })
	await page.screencast.showActions({ cursor: "pointer", duration: 500, fontSize: 1 })
	// The first save inserts the status line above the tabs and shifts the rows down;
	// wait for it so the camera keyframe matches where the inputs finally rest.
	const saved = panel.getByText("Saved", { exact: true })
	await expect(saved).toBeVisible({ timeout: 20_000 })
	await focusCamera([variableName, variableValue], 0)
	await variableValue.pressSequentially("http://localhost:8080", { delay: 40 })
	await expect(saved).toBeVisible({ timeout: 20_000 })
	await expect(panel.getByText(/must be non-empty/)).toHaveCount(0)
	await pace(1_600)
	await finishRecording()
})

demo("docs auto approve", async ({ finishRecording, focusCamera, helper, pace, registerRecording, sidebar }) => {
	await helper.signin(sidebar)
	const editItem = sidebar.locator("vscode-checkbox").filter({ hasText: "Edit project files" })

	// Start from a disabled action so the recording shows the option turning on.
	await autoApproveToggle(sidebar, false).click()
	await expect(editItem).toBeVisible()
	if (await editItem.evaluate((element) => (element as HTMLInputElement).checked === true)) await editItem.click()
	await autoApproveToggle(sidebar, true).click()
	await expect(editItem).toBeHidden()

	await registerRecording("docs-auto-approve", SIDEBAR_RECORDING)
	const openToggle = autoApproveToggle(sidebar, false)
	await focusCamera(openToggle)
	await openToggle.click()
	await expect(editItem).toBeVisible()
	await focusCamera(editItem)
	await editItem.click()
	const editAllItem = sidebar.locator("vscode-checkbox").filter({ hasText: "Edit all files" })
	await expect(editAllItem).toBeVisible()
	await pace(900)
	await focusCamera(editAllItem)
	await pace(900)
	const closeToggle = autoApproveToggle(sidebar, true)
	await focusCamera(closeToggle)
	await closeToggle.click()
	await pace(1_200)
	await finishRecording()
})
