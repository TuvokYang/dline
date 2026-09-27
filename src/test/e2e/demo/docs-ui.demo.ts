import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { expect, type Frame, type Locator } from "@playwright/test"
import { getE2EMockProviderBaseUrl } from "../fixtures/server/api"
import { E2E_PROFILE_NAMES } from "../utils/api-profile"
import { E2ETestHelper } from "../utils/helpers"
import { capabilityRow, toggleCapability } from "./scenarios/capabilities"
import {
	COMPACTION_COMPLETION_TEXT,
	COMPACTION_CONTINUE_TEXT,
	configureAutoCompaction,
	enqueueAutoCompaction,
	primeContextNearLimit,
	selectProfile,
} from "./scenarios/compaction"
import { fillMockOpenAiProfile, MOCK_PROFILE_NAME, waitForStoredProfileName } from "./scenarios/profile-setup"
import { enqueueSubagentReview, PARENT_RESULT, SUBAGENT_ITEMS, startSubagentReview } from "./scenarios/subagent-review"
import { demo } from "./utils/demo-fixture"
import { captureDocScreenshot } from "./utils/doc-capture"
import { dismissDemoNotifications } from "./utils/png-asset"
import { SIDEBAR_RECORDING, STEP_SETTLE_MS } from "./utils/recording-presets"

/**
 * Documentation captures for the docs site (`assets/docs/ui`).
 *
 * Stills are cropped from live bounding boxes and numbered in reading order.
 * GIFs are recorded full-frame and reframed afterwards by `npm run demo:media`
 * with the camera keyframes emitted by `focusCamera`.
 */

const WORKFLOW_NAME = "release-review"
const MCP_NAME = "release-tools"
const HEADER_TASK_TEXT = "Summarize the release checklist for this workspace."
const HEADER_TASK_RESULT = "Release checklist summarized."
// View-title actions contributed by package.json `menus.view/title`, in their display order.
const PANEL_TITLE_ACTIONS = ["New Task", "MCP Servers", "History", "Account", "Settings"] as const

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

/** The task header card is the parent of its expand/collapse row. */
async function expandedTaskHeader(sidebar: Frame): Promise<Locator> {
	const toggle = sidebar.locator('[aria-label="Expand task header"], [aria-label="Collapse task header"]')
	await expect(toggle).toHaveCount(1)
	if ((await toggle.getAttribute("aria-label")) === "Expand task header") await toggle.click()
	await expect(toggle).toHaveAttribute("aria-label", "Collapse task header")
	return toggle.locator("xpath=..")
}

function taskHeaderIconButton(header: Locator, icon: string): Locator {
	return header.locator(`button:has(svg.lucide-${icon})`).first()
}

demo("docs UI stills", async ({ helper, page, server, sidebar, workspaceDir }) => {
	demo.setTimeout(240_000)
	await seedWorkspaceCapabilities(workspaceDir)
	await helper.signin(sidebar)

	const panelTitle = page.locator('[id="workbench.parts.sidebar"] .composite.title').first()
	await captureDocScreenshot(page, sidebar, "panel-title-bar", {
		regions: [panelTitle],
		padding: 4,
		markers: PANEL_TITLE_ACTIONS.map((name, index) => ({
			label: String(index + 1),
			target: panelTitle.getByRole("button", { name, exact: true }),
		})),
	})

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
	await sidebar.getByRole("button", { name: "Hide MCP Servers", exact: true }).first().click()
	await expect(serverName).toBeHidden()

	// The task header only exists while a task is open; run one short task with usage so
	// the metrics capsule and context bar have real values to show.
	server.resetOpenAiMock()
	server.enqueueOpenAiResponses({
		type: "tool",
		id: "call_docs_header_complete",
		name: "attempt_completion",
		arguments: { result: HEADER_TASK_RESULT },
		usage: { inputTokens: 18_400, outputTokens: 320, cacheReadTokens: 12_800 },
		expectedRequestIncludes: [HEADER_TASK_TEXT],
	})
	const input = sidebar.getByTestId("chat-input")
	await input.fill(HEADER_TASK_TEXT)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(HEADER_TASK_RESULT, { exact: false }).last()).toBeVisible({ timeout: 60_000 })

	const header = await expandedTaskHeader(sidebar)
	const metrics = sidebar.getByTestId("task-rate-metrics")
	await expect(metrics).toBeVisible({ timeout: 30_000 })
	await expect(sidebar.getByTestId("context-window-indicator")).toBeVisible({ timeout: 30_000 })
	await captureDocScreenshot(page, sidebar, "task-header", {
		regions: [header],
		padding: 8,
		markers: [
			{ label: "1", target: metrics },
			{ label: "2", target: sidebar.getByTestId("context-window-progress-track") },
			{ label: "3", target: header.locator('[aria-label="Compact task"]') },
			{ label: "4", target: taskHeaderIconButton(header, "copy") },
			{ label: "5", target: taskHeaderIconButton(header, "refresh-cw") },
			{ label: "6", target: taskHeaderIconButton(header, "trash") },
			{ label: "7", target: header.locator('[aria-label="Close Task"]') },
		],
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

demo(
	"docs capability toggles",
	async ({ finishRecording, focusCamera, helper, pace, registerRecording, sidebar, workspaceDir }) => {
		await seedWorkspaceCapabilities(workspaceDir)
		await helper.signin(sidebar)

		await registerRecording("docs-capability-toggles", SIDEBAR_RECORDING)
		const showCapabilities = showCapabilitiesButton(sidebar)
		await focusCamera(showCapabilities)
		await showCapabilities.click()
		const popup = sidebar.getByTestId("capabilities-popup")
		await expect(popup).toBeVisible()

		const steps = [
			{ tab: "Rules", name: "release-policy.md" },
			{ tab: "Skills", name: "release-checklist" },
			{ tab: "Workflows", name: `${WORKFLOW_NAME}.md` },
		]
		for (const { tab, name } of steps) {
			await focusCamera(popup.getByRole("button", { name: tab, exact: true }), STEP_SETTLE_MS)
			await selectCapabilityTab(popup, tab)
			const row = capabilityRow(sidebar, name)
			await expect(row).toBeVisible({ timeout: 30_000 })
			await focusCamera(row, STEP_SETTLE_MS)
			await toggleCapability(sidebar, name, false)
			await pace(700)
		}
		await finishRecording()
	},
)

demo(
	"docs profile setup",
	async ({ dlineDir, finishRecording, focusCamera, helper, page, pace, registerRecording, server, sidebar }) => {
		await helper.signin(sidebar)
		const focusStep = (target: Locator | Locator[]) => focusCamera(target, STEP_SETTLE_MS)

		await registerRecording("docs-profile-setup", SIDEBAR_RECORDING)
		const settingsButton = page.getByRole("button", { name: "Settings", exact: true })
		await focusStep(settingsButton)
		await settingsButton.click()
		const addProfile = sidebar.getByRole("button", { name: "Add profile", exact: true })
		await expect(addProfile).toBeVisible()
		await focusStep(addProfile)
		await addProfile.click()
		const profileCard = sidebar.getByTestId("api-profile-card").last()
		await expect(profileCard).toBeVisible()

		await fillMockOpenAiProfile(profileCard, getE2EMockProviderBaseUrl(server.baseUrl, "openai-compatible-chat"), focusStep)
		await waitForStoredProfileName(dlineDir, MOCK_PROFILE_NAME)

		const done = sidebar.getByRole("button", { name: "Done", exact: true })
		await focusStep(done)
		await done.click()
		const modelSwitcher = sidebar.getByRole("button", { name: "Select model", exact: true })
		await expect(modelSwitcher).toBeVisible()
		await focusStep(modelSwitcher)
		await modelSwitcher.click()
		const profileOption = sidebar.getByRole("option").filter({ has: sidebar.getByText(MOCK_PROFILE_NAME, { exact: true }) })
		await expect(profileOption).toHaveCount(1)
		await focusStep([profileOption, modelSwitcher])
		await profileOption.click()
		await expect(modelSwitcher).toHaveText(MOCK_PROFILE_NAME)
		await focusCamera(modelSwitcher, 0)
		await pace(1_200)
		await finishRecording()
	},
)

demo("docs subagents", async ({ finishRecording, focusCamera, helper, pace, page, registerRecording, server, sidebar }) => {
	demo.setTimeout(180_000)
	await helper.signin(sidebar)
	enqueueSubagentReview(server)
	// Clear startup toasts before the run: the command palette used to dismiss them
	// later loses focus to the live subagent updates and cannot be driven reliably.
	await dismissDemoNotifications(page)
	await startSubagentReview(sidebar, server)
	// Children finish 13-16 s after their last request; start a little later so the GIF stays under 20 s
	// while every child is still running when the Activities list first comes into view.
	await pace(2_000)

	await registerRecording("docs-subagents", SIDEBAR_RECORDING)
	const activitiesTab = sidebar.getByRole("tab", { name: /^Activities(?: \d+)?$/ })
	await focusCamera(activitiesTab, STEP_SETTLE_MS)
	await activitiesTab.click()
	await sidebar.getByTestId("activity-status-filter-all").click()
	await sidebar.getByTestId("activity-kind-filter-subagent").click()

	const cards = sidebar.getByTestId("activity-item")
	await expect(cards).toHaveCount(SUBAGENT_ITEMS.length)
	await focusCamera(sidebar.getByTestId("activity-list"), STEP_SETTLE_MS)
	// Collapsed cards show only the agent name; expand them so each child's task identifies its card.
	for (let index = 0; index < SUBAGENT_ITEMS.length; index += 1) {
		await cards.nth(index).getByTestId("activity-toggle").click()
	}
	const activities = SUBAGENT_ITEMS.map((item) => cards.filter({ hasText: item.task }))
	await Promise.all(activities.map((activity) => expect(activity).toHaveCount(1)))
	await pace(800)

	// Follow each child as it finishes so the status change is the focus of the frame.
	for (const activity of activities) {
		await focusCamera(activity, 0)
		await expect(activity).toHaveAttribute("data-activity-status", "completed", { timeout: 30_000 })
		await pace(600)
	}

	const workTab = sidebar.getByRole("tab", { name: "Work", exact: true })
	await focusCamera(workTab, STEP_SETTLE_MS)
	await workTab.click()
	const parentResult = sidebar.getByText(PARENT_RESULT, { exact: false }).last()
	await expect(parentResult).toBeVisible({ timeout: 30_000 })
	await focusCamera(parentResult, 0)
	await pace(1_400)
	await finishRecording()
})

demo(
	"docs auto compact",
	async ({ dlineDir, finishRecording, focusCamera, helper, pace, registerRecording, server, sidebar }) => {
		demo.setTimeout(180_000)
		await configureAutoCompaction(dlineDir)
		await helper.signin(sidebar)
		await selectProfile(sidebar, E2E_PROFILE_NAMES.mockOpenAiResponses)
		enqueueAutoCompaction(server)
		await primeContextNearLimit(sidebar)
		const contextIndicator = sidebar.getByTestId("context-window-indicator")
		const contextProgress = sidebar.getByTestId("context-window-segmented-progress")

		await registerRecording("docs-auto-compact", SIDEBAR_RECORDING)
		await focusCamera(contextIndicator)
		await pace(600)
		const input = sidebar.getByTestId("chat-input")
		await focusCamera(input, STEP_SETTLE_MS)
		await input.fill(COMPACTION_CONTINUE_TEXT)
		await input.press("Enter")
		await expect(input).toHaveValue("")

		const compactionPass = sidebar.getByTestId("compaction-pass").last()
		await expect(compactionPass).toBeVisible({ timeout: 60_000 })
		await focusCamera(compactionPass, 0)
		await expect(compactionPass).toHaveAttribute("data-compaction-status", "completed", { timeout: 60_000 })
		await pace(800)

		const completion = sidebar.getByText(COMPACTION_COMPLETION_TEXT, { exact: false }).last()
		await expect(completion).toBeVisible({ timeout: 60_000 })
		await focusCamera(completion, STEP_SETTLE_MS)
		await expect
			.poll(async () => Number((await contextProgress.getAttribute("aria-valuenow")) ?? Number.POSITIVE_INFINITY), {
				timeout: 30_000,
			})
			.toBeLessThan(40_000)
		await focusCamera(contextIndicator, 0)
		await pace(1_400)
		await finishRecording()
	},
)
