import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { expect, type Frame, type Locator, type Page, type TestInfo } from "@playwright/test"
import type { ClineApiServerMock, MockApiTarget } from "./fixtures/server"
import { E2E_PROFILE_NAMES } from "./utils/api-profile"
import { E2ETestHelper, e2e } from "./utils/helpers"

interface StoredProfile {
	id: string
	name: string
	provider: string
	modelInfo?: {
		capabilities?: {
			supportsReasoning?: boolean
			supportsTools?: boolean
			thinking?: {
				supported?: boolean
				mode?: string
				effortLevels?: string[]
				maxBudget?: number
			}
		}
	}
	[key: string]: unknown
}

interface StoredTaskSettings {
	actModeReasoningOverrideKind?: string
	actModeReasoningOverrideEffort?: string
	actModeThinkingBudgetTokens?: number
	actModeServiceTierOverrideKind?: string
	actModeServiceTierOverrideTier?: string
}

const profilesPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "api_profiles.json")
const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")

const SERVICE_TIER_TOOLTIPS = {
	Auto: "Let OpenAI choose the request service tier.",
	Default: "Use the standard OpenAI service tier.",
	Flex: "Use the lower-cost flexible service tier.",
	Scale: "Use the Scale service tier.",
	Priority: "Use the priority service tier.",
	Ultrafast: "Use the ultra-fast service tier.",
} as const

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

async function configureDefaultProfile(
	dlineDir: string,
	profileName: string,
	mutate?: (profile: StoredProfile) => void,
): Promise<StoredProfile> {
	const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
	const profile = profiles.find((candidate) => candidate.name === profileName)
	if (!profile) throw new Error(`Missing E2E Profile: ${profileName}`)
	profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
	mutate?.(profile)

	const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
	await Promise.all([
		writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8"),
		writeFile(
			settingsPath(dlineDir),
			`${JSON.stringify(
				{
					...settings,
					actModeProfile: profile.name,
					actModeProfileId: profile.id,
					planModeProfile: profile.name,
					planModeProfileId: profile.id,
				},
				null,
				2,
			)}\n`,
			"utf8",
		),
	])
	return profile
}

async function onlyTaskId(dlineDocsDir: string): Promise<string> {
	return E2ETestHelper.waitForValue(async () => {
		const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true }).catch(() => [])
		const ids = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
		return ids.length === 1 ? ids[0] : undefined
	}, 30_000)
}

async function readTaskSettings(dlineDocsDir: string, taskId: string): Promise<StoredTaskSettings> {
	return JSON.parse(await readFile(path.join(dlineDocsDir, "tasks", taskId, "settings.json"), "utf8")) as StoredTaskSettings
}

async function waitForProfile(
	dlineDir: string,
	profileName: string,
	predicate: (profile: StoredProfile) => boolean,
): Promise<StoredProfile> {
	return E2ETestHelper.waitForValue(async () => {
		const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
		const profile = profiles.find((candidate) => candidate.name === profileName)
		return profile && predicate(profile) ? profile : undefined
	}, 15_000)
}

async function readProfileReasoning(dlineDir: string, profileName: string): Promise<Record<string, unknown>> {
	const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
	const profile = profiles.find((candidate) => candidate.name === profileName)
	if (!profile) throw new Error(`Missing E2E Profile: ${profileName}`)
	return asRecord(asRecord(profile[profile.provider]).reasoning)
}

function enableOpenAiServiceTier(profile: StoredProfile): void {
	const provider = asRecord(profile.openai)
	profile.openai = {
		...provider,
		serviceTierEnabled: true,
	}
}

function disableDeepSeekThinking(profile: StoredProfile): void {
	const provider = asRecord(profile.deepseek)
	profile.deepseek = {
		...provider,
		reasoning: { enableThinking: false, effort: "", thinkingBudget: 0 },
	}
}

async function openApiSettings(page: Page, sidebar: Frame): Promise<void> {
	await page.getByRole("button", { name: "Settings", exact: true }).click()
	await expect(sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible()
}

function getProfileCard(sidebar: Frame, profileName: string): Locator {
	const toggle = sidebar
		.getByRole("button", { name: `Expand ${profileName}`, exact: true })
		.or(sidebar.getByRole("button", { name: `Collapse ${profileName}`, exact: true }))
	return sidebar.getByTestId("api-profile-card").filter({ has: toggle })
}

async function openProfileEditor(sidebar: Frame, profileName: string): Promise<Locator> {
	const card = getProfileCard(sidebar, profileName)
	await expect(card).toHaveCount(1)
	const providerSelector = card.getByRole("combobox", { name: "Provider" })
	if (!(await providerSelector.isVisible())) {
		await card.getByRole("button", { name: `Expand ${profileName}`, exact: true }).click()
	}
	await expect(providerSelector).toBeVisible()
	return card
}

async function setCapability(card: Locator, label: string, value: boolean): Promise<void> {
	const checkbox = card.locator("vscode-checkbox").filter({ hasText: label })
	await expect(checkbox).toHaveCount(1)
	await expect(checkbox).toBeVisible()
	const current = await checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))
	if (current !== value) await checkbox.click()
	await expect.poll(() => checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))).toBe(value)
}

async function setButtonGroupWidth(sidebar: Frame, width: number): Promise<void> {
	const buttonGroup = sidebar.locator("[data-chat-input-runtime-controls]").locator("..")
	await buttonGroup.evaluate((element, targetWidth) => {
		const htmlElement = element as HTMLElement
		htmlElement.style.width = `${targetWidth}px`
		htmlElement.style.maxWidth = `${targetWidth}px`
		htmlElement.style.flex = `0 0 ${targetWidth}px`
		htmlElement.style.minWidth = "0px"
	}, width)
}

async function runtimeControlMetrics(sidebar: Frame) {
	const runtimeControls = sidebar.locator("[data-chat-input-runtime-controls]")
	const buttonGroup = runtimeControls.locator("..")
	const profileSlot = sidebar.locator('[data-chat-input-slot="profile"]')
	const thinkingSlot = sidebar.locator('[data-chat-input-slot="thinking"]')
	const serviceTierSlot = sidebar.locator('[data-chat-input-slot="service-tier"]')
	const profileTextElement = sidebar.locator("[data-chat-input-profile-text]")
	const thinking = sidebar.getByRole("combobox", { name: "Task thinking override" })
	const thinkingTextElement = thinking.locator('[data-slot="select-value"]')
	const serviceTierIcon = sidebar.getByTestId("task-service-tier-icon")
	const [
		buttonGroupBox,
		runtimeBox,
		profileBox,
		thinkingBox,
		serviceTierBox,
		profileContentBox,
		thinkingContentBox,
		serviceTierContentBox,
	] = await Promise.all([
		buttonGroup.boundingBox(),
		runtimeControls.boundingBox(),
		profileSlot.boundingBox(),
		thinkingSlot.boundingBox(),
		serviceTierSlot.boundingBox(),
		profileTextElement.boundingBox(),
		thinkingTextElement.boundingBox(),
		serviceTierIcon.boundingBox(),
	])
	if (
		!buttonGroupBox ||
		!runtimeBox ||
		!profileBox ||
		!thinkingBox ||
		!serviceTierBox ||
		!profileContentBox ||
		!thinkingContentBox ||
		!serviceTierContentBox
	) {
		throw new Error("Runtime control geometry is unavailable")
	}
	const [profileText, thinkingText, thinkingTrigger, runtimeOverflow, buttonGroupOverflow] = await Promise.all([
		profileTextElement.evaluate((element) => {
			const style = getComputedStyle(element)
			return { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, textAlign: style.textAlign }
		}),
		thinkingTextElement.evaluate((element) => {
			const style = getComputedStyle(element)
			return { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, textAlign: style.textAlign }
		}),
		thinking.evaluate((element) => {
			const style = getComputedStyle(element)
			return {
				clientWidth: element.clientWidth,
				scrollWidth: element.scrollWidth,
				overflowX: style.overflowX,
				minWidth: style.minWidth,
				width: style.width,
			}
		}),
		runtimeControls.evaluate((element) => {
			const style = getComputedStyle(element)
			return {
				clientWidth: element.clientWidth,
				scrollWidth: element.scrollWidth,
				overflowX: style.overflowX,
			}
		}),
		buttonGroup.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth })),
	])
	const prefixWidth = runtimeBox.x - buttonGroupBox.x
	const availableRuntimeWidth = buttonGroupBox.x + buttonGroupBox.width - runtimeBox.x
	const profileChromeWidth = profileBox.width - profileText.clientWidth
	const thinkingChromeWidth = thinkingBox.width - thinkingText.clientWidth
	const intrinsicRuntimeWidth =
		profileText.scrollWidth + profileChromeWidth + thinkingText.scrollWidth + thinkingChromeWidth + serviceTierBox.width + 8
	return {
		buttonGroupBox,
		runtimeBox,
		profileBox,
		thinkingBox,
		serviceTierBox,
		profileContentBox,
		thinkingContentBox,
		serviceTierContentBox,
		profileText,
		thinkingText,
		thinkingTrigger,
		runtimeOverflow,
		buttonGroupOverflow,
		prefixWidth,
		availableRuntimeWidth,
		intrinsicRuntimeWidth,
		requiredButtonGroupWidth: prefixWidth + intrinsicRuntimeWidth,
	}
}

function expectRuntimeControlsOnOneLine(metrics: Awaited<ReturnType<typeof runtimeControlMetrics>>): void {
	const centerY = (box: { y: number; height: number }) => box.y + box.height / 2
	const profileToThinking = metrics.thinkingBox.x - (metrics.profileBox.x + metrics.profileBox.width)
	const thinkingToTier = metrics.serviceTierBox.x - (metrics.thinkingBox.x + metrics.thinkingBox.width)

	expect(metrics.profileText.textAlign).toBe("center")
	expect(metrics.thinkingText.textAlign).toBe("center")
	expect(Math.abs(centerY(metrics.profileBox) - centerY(metrics.thinkingBox))).toBeLessThanOrEqual(1)
	expect(Math.abs(centerY(metrics.thinkingBox) - centerY(metrics.serviceTierBox))).toBeLessThanOrEqual(1)
	expect(profileToThinking).toBeGreaterThanOrEqual(3)
	expect(thinkingToTier).toBeGreaterThanOrEqual(3)
	expect(Math.abs(profileToThinking - thinkingToTier)).toBeLessThanOrEqual(0.5)
}

function expectRuntimeControlsFillAvailableWidth(metrics: Awaited<ReturnType<typeof runtimeControlMetrics>>): void {
	const runtimeRight = metrics.runtimeBox.x + metrics.runtimeBox.width
	const buttonGroupRight = metrics.buttonGroupBox.x + metrics.buttonGroupBox.width
	const contentBoxes = [metrics.profileBox, metrics.thinkingBox, metrics.serviceTierBox]
	const expectedRuntimeWidth = Math.min(metrics.intrinsicRuntimeWidth, metrics.availableRuntimeWidth)

	expect(Math.abs(metrics.runtimeBox.width - expectedRuntimeWidth)).toBeLessThanOrEqual(1)
	expect(metrics.runtimeOverflow.overflowX).toBe("hidden")
	expect(runtimeRight).toBeLessThanOrEqual(buttonGroupRight + 1)
	expect(metrics.buttonGroupOverflow.scrollWidth).toBeLessThanOrEqual(metrics.buttonGroupOverflow.clientWidth)
	for (const box of contentBoxes) {
		expect(box.x + box.width).toBeLessThanOrEqual(runtimeRight + 1)
	}
}

async function startTaskAndWaitForRuntimeControls(
	sidebar: Frame,
	target: MockApiTarget,
	server: ClineApiServerMock,
	markers: { task: string; prompt: string; completion: string },
	options: { onStreaming?: () => Promise<void>; streamingDelayMs?: number; supportsThinking?: boolean } = {},
): Promise<void> {
	server.enqueueResponses(
		target,
		{
			type: "tool",
			name: "qna_respond",
			arguments: { response: markers.prompt },
			delayMs: options.streamingDelayMs ?? 5_000,
		},
		{
			type: "tool",
			name: "attempt_completion",
			arguments: { result: markers.completion },
		},
	)

	const input = sidebar.getByTestId("chat-input")
	await input.fill(markers.task)
	await sidebar.getByTestId("send-button").click()
	await expect.poll(() => server.getRequestCount(target), { timeout: 30_000 }).toBe(1)
	await expect(sidebar.getByRole("contentinfo").getByText("Cancel", { exact: true })).toBeVisible({ timeout: 30_000 })
	const thinkingControl = sidebar.getByRole("combobox", { name: "Task thinking override" })
	if (options.supportsThinking === false) {
		await expect(thinkingControl).toHaveCount(0)
	} else {
		await expect(thinkingControl).toBeVisible()
		await expect(thinkingControl).toBeEnabled()
	}
	const serviceTierControl = sidebar.getByRole("button", { name: "Task service tier" })
	if (target === "openai-compatible-chat" || target === "openai-compatible-responses") {
		await expect(serviceTierControl).toBeVisible()
		await expect(serviceTierControl).toBeEnabled()
	} else {
		await expect(serviceTierControl).toHaveCount(0)
	}
	await options.onStreaming?.()
	await expect(sidebar.getByText(markers.prompt, { exact: true })).toBeVisible({ timeout: 60_000 })
}

async function selectThinkingOverride(sidebar: Frame, optionName: string): Promise<void> {
	const control = sidebar.getByRole("combobox", { name: "Task thinking override" })
	await expect(control).toBeVisible()
	await expect(control).toBeEnabled()
	await control.click()
	await expect(sidebar.getByRole("option", { name: "Profile", exact: true })).toHaveCount(0)
	await sidebar.getByRole("option", { name: optionName, exact: true }).click()
	await expect(control).toContainText(optionName)
}

async function selectServiceTier(sidebar: Frame, optionName: string): Promise<void> {
	const control = sidebar.getByRole("button", { name: "Task service tier" })
	await expect(control).toBeVisible()
	await expect(control).toBeEnabled()
	await control.click()
	await expect(sidebar.getByRole("listbox", { name: "Task service tier options" })).toBeVisible()
	await expect(sidebar.getByRole("option", { name: "Profile", exact: true })).toHaveCount(0)
	await sidebar.getByRole("option", { name: optionName, exact: true }).click()
	await expect(control).toHaveAttribute("data-service-tier-label", optionName)
}

async function expectRuntimeControlTooltip(sidebar: Frame, control: Locator, text: string): Promise<void> {
	await control.hover()
	await expect(sidebar.locator('[data-slot="tooltip-content"]').filter({ hasText: text })).toBeVisible()
}

async function submitFeedback(sidebar: Frame, feedback: string, completion: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled()
	await input.fill(feedback)
	await input.press("Enter")
	await expect(sidebar.getByText(completion, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
}

async function captureRuntimeControls(page: Page, sidebar: Frame, testInfo: TestInfo, name: string): Promise<void> {
	const pagePath = testInfo.outputPath(`${name}-vscode.png`)
	await page.screenshot({ path: pagePath })
	await testInfo.attach(`${name}-vscode`, { path: pagePath, contentType: "image/png" })

	const controlsPath = testInfo.outputPath(`${name}-controls.png`)
	await sidebar.locator("[data-chat-input-runtime-controls]").screenshot({ path: controlsPath })
	await testInfo.attach(`${name}-controls`, { path: controlsPath, contentType: "image/png" })
}

async function captureRuntimeLayoutEvidence(
	page: Page,
	sidebar: Frame,
	testInfo: TestInfo,
	name: string,
): Promise<Awaited<ReturnType<typeof runtimeControlMetrics>>> {
	const metrics = await runtimeControlMetrics(sidebar)
	await captureRuntimeControls(page, sidebar, testInfo, name)
	const metricsPath = testInfo.outputPath(`${name}-layout.json`)
	await writeFile(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf8")
	await testInfo.attach(`${name}-layout`, { path: metricsPath, contentType: "application/json" })
	return metrics
}

async function svgPaintMetrics(icon: Locator): Promise<{ height: number; maxPartHeight: number; width: number }> {
	return icon.evaluate((element) => {
		const parts = [...element.querySelectorAll<SVGGraphicsElement>("path, circle, rect, line, polyline, polygon")]
		const rects = parts.map((part) => part.getBoundingClientRect()).filter((rect) => rect.width > 0 || rect.height > 0)
		if (rects.length === 0) throw new Error("SVG icon has no measurable painted geometry")
		const left = Math.min(...rects.map((rect) => rect.left))
		const right = Math.max(...rects.map((rect) => rect.right))
		const top = Math.min(...rects.map((rect) => rect.top))
		const bottom = Math.max(...rects.map((rect) => rect.bottom))
		return {
			height: bottom - top,
			maxPartHeight: Math.max(...rects.map((rect) => rect.height)),
			width: right - left,
		}
	})
}

async function runtimeControlAppearance(sidebar: Frame) {
	const profile = sidebar.getByRole("button", { name: "Select model" })
	const thinking = sidebar.getByRole("combobox", { name: "Task thinking override" })
	const serviceTier = sidebar.getByRole("button", { name: "Task service tier" })
	const serviceTierIcon = sidebar.getByTestId("task-service-tier-icon")
	const contextIcon = sidebar.getByTestId("context-button").locator("svg")
	const filesIcon = sidebar.getByTestId("files-button").locator("svg")
	const [
		profileAppearance,
		thinkingAppearance,
		serviceTierAppearance,
		iconAppearance,
		serviceTierPaint,
		contextPaint,
		filesPaint,
	] = await Promise.all([
		profile.evaluate((element) => {
			const style = getComputedStyle(element)
			const rect = element.getBoundingClientRect()
			return {
				centerY: rect.top + rect.height / 2,
				color: style.color,
				fontSize: Number.parseFloat(style.fontSize),
				height: rect.height,
				lineHeight: style.lineHeight,
			}
		}),
		thinking.evaluate((element) => {
			const style = getComputedStyle(element)
			const rect = element.getBoundingClientRect()
			return {
				centerY: rect.top + rect.height / 2,
				color: style.color,
				disabled: (element as HTMLButtonElement).disabled,
				fontSize: Number.parseFloat(style.fontSize),
				height: rect.height,
				lineHeight: style.lineHeight,
			}
		}),
		serviceTier.evaluate((element) => {
			const rect = element.getBoundingClientRect()
			return {
				centerY: rect.top + rect.height / 2,
				disabled: (element as HTMLButtonElement).disabled,
				height: rect.height,
				width: rect.width,
			}
		}),
		serviceTierIcon.evaluate((element) => {
			const style = getComputedStyle(element)
			const rect = element.getBoundingClientRect()
			return {
				centerY: rect.top + rect.height / 2,
				cssHeight: Number.parseFloat(style.height),
				cssWidth: Number.parseFloat(style.width),
				display: style.display,
				height: rect.height,
				width: rect.width,
			}
		}),
		svgPaintMetrics(serviceTierIcon),
		svgPaintMetrics(contextIcon),
		svgPaintMetrics(filesIcon),
	])
	return {
		profile: profileAppearance,
		thinking: thinkingAppearance,
		serviceTier: serviceTierAppearance,
		serviceTierIcon: iconAppearance,
		serviceTierPaint,
		contextPaint,
		filesPaint,
	}
}

function expectRuntimeControlAppearance(metrics: Awaited<ReturnType<typeof runtimeControlAppearance>>): void {
	expect(metrics.thinking.fontSize).toBe(metrics.profile.fontSize)
	expect(metrics.thinking.lineHeight).toBe(metrics.profile.lineHeight)
	expect(metrics.thinking.color).toBe(metrics.profile.color)
	expect(metrics.serviceTierIcon.display).toBe("block")
	expect(metrics.serviceTierIcon.cssHeight).toBe(15)
	expect(metrics.serviceTierIcon.cssWidth).toBe(15)
	expect(metrics.serviceTierPaint.maxPartHeight).toBeGreaterThanOrEqual(metrics.contextPaint.maxPartHeight - 0.5)
	expect(metrics.serviceTierPaint.height).toBeGreaterThanOrEqual(metrics.filesPaint.height)
	expect(metrics.serviceTier.height - metrics.serviceTierIcon.height).toBeGreaterThanOrEqual(3)
	expect(metrics.serviceTier.width - metrics.serviceTierIcon.width).toBeGreaterThanOrEqual(3)
	expect(Math.abs(metrics.profile.centerY - metrics.thinking.centerY)).toBeLessThanOrEqual(1)
	expect(Math.abs(metrics.thinking.centerY - metrics.serviceTier.centerY)).toBeLessThanOrEqual(1)
	expect(Math.abs(metrics.serviceTier.centerY - metrics.serviceTierIcon.centerY)).toBeLessThanOrEqual(1)
}

async function captureRuntimeControlEvidence(
	page: Page,
	sidebar: Frame,
	testInfo: TestInfo,
	name: string,
): Promise<Awaited<ReturnType<typeof runtimeControlAppearance>>> {
	const metrics = await runtimeControlAppearance(sidebar)
	await captureRuntimeControls(page, sidebar, testInfo, name)
	const metricsPath = testInfo.outputPath(`${name}-metrics.json`)
	await writeFile(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf8")
	await testInfo.attach(`${name}-metrics`, { path: metricsPath, contentType: "application/json" })
	expectRuntimeControlAppearance(metrics)
	return metrics
}

async function expectRuntimeControlsFit(sidebar: Frame): Promise<void> {
	const contextButton = sidebar.getByTestId("context-button")
	const filesButton = sidebar.getByTestId("files-button")
	const mcpButton = sidebar.getByRole("button", { name: /MCP Servers/ })
	const rulesButton = sidebar.getByRole("button", { name: /Dline Rules & Workflows/ })
	const profile = sidebar.getByRole("button", { name: "Select model" })
	const thinking = sidebar.getByRole("combobox", { name: "Task thinking override" })
	const tier = sidebar.getByRole("button", { name: "Task service tier" })
	const profileSlot = sidebar.locator('[data-chat-input-slot="profile"]')
	const runtimeControls = sidebar.locator("[data-chat-input-runtime-controls]")
	const boxes = await Promise.all([
		contextButton.boundingBox(),
		filesButton.boundingBox(),
		mcpButton.boundingBox(),
		rulesButton.boundingBox(),
		profile.boundingBox(),
		thinking.boundingBox(),
		tier.boundingBox(),
		runtimeControls.boundingBox(),
	])
	if (boxes.some((box) => box === null)) throw new Error("Runtime control geometry is unavailable")
	const [contextBox, filesBox, mcpBox, rulesBox, profileBox, thinkingBox, tierBox, runtimeBox] = boxes as NonNullable<
		Awaited<ReturnType<Locator["boundingBox"]>>
	>[]
	const gaps = [
		filesBox.x - (contextBox.x + contextBox.width),
		mcpBox.x - (filesBox.x + filesBox.width),
		rulesBox.x - (mcpBox.x + mcpBox.width),
		profileBox.x - (rulesBox.x + rulesBox.width),
		thinkingBox.x - (profileBox.x + profileBox.width),
		tierBox.x - (thinkingBox.x + thinkingBox.width),
	]
	const standardGap = gaps[0]
	const profileLayout = await profileSlot.evaluate((element) => {
		const style = getComputedStyle(element)
		return {
			flexShrink: style.flexShrink,
			maxWidth: Number.parseFloat(style.maxWidth),
			overflowX: style.overflowX,
			width: element.getBoundingClientRect().width,
		}
	})
	const centerY = (box: NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>>) => box.y + box.height / 2

	expect(standardGap).toBeGreaterThanOrEqual(3)
	for (const gap of gaps.slice(1)) expect(Math.abs(gap - standardGap)).toBeLessThanOrEqual(0.5)
	expect(Math.abs(profileBox.height - mcpBox.height)).toBeLessThanOrEqual(0.5)
	expect(Math.abs(thinkingBox.height - rulesBox.height)).toBeLessThanOrEqual(0.5)
	expect(Math.abs(tierBox.height - mcpBox.height)).toBeLessThanOrEqual(0.5)
	expect(Math.abs(tierBox.width - rulesBox.width)).toBeLessThanOrEqual(0.5)
	expect(Math.abs(centerY(profileBox) - centerY(thinkingBox))).toBeLessThanOrEqual(1)
	expect(Math.abs(centerY(thinkingBox) - centerY(tierBox))).toBeLessThanOrEqual(1)
	expect(profileLayout.flexShrink).toBe("1")
	expect(profileLayout.overflowX).toBe("hidden")
	expect(profileLayout.maxWidth).toBeGreaterThan(0)
	expect(profileLayout.width).toBeLessThanOrEqual(profileLayout.maxWidth + 1)
	expect(profileBox.x).toBeGreaterThanOrEqual(runtimeBox.x)
	expect(tierBox.x + tierBox.width).toBeLessThanOrEqual(runtimeBox.x + runtimeBox.width + 1)
}

async function openSidebar(page: Page, helper: E2ETestHelper): Promise<Frame> {
	await E2ETestHelper.openClineSidebar(page)
	const sidebar = await helper.getSidebar(page)
	await helper.signin(sidebar)
	return sidebar
}

e2e(
	"DeepSeek Provider settings - Enable Thinking persists the canonical reasoning contract",
	async ({ dlineDir, helper, openVSCode, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		await configureDefaultProfile(dlineDir, E2E_PROFILE_NAMES.mockDeepSeek, disableDeepSeekThinking)
		const app = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			const sidebar = await openSidebar(page, helper)
			await openApiSettings(page, sidebar)
			const card = await openProfileEditor(sidebar, E2E_PROFILE_NAMES.mockDeepSeek)
			await setCapability(card, "Enable Thinking", true)

			await expect
				.poll(() => readProfileReasoning(dlineDir, E2E_PROFILE_NAMES.mockDeepSeek), { timeout: 15_000 })
				.toMatchObject({ enableThinking: true, effort: "high" })
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Task runtime controls - DeepSeek settings update exposes and operates Thinking in the same Task",
	async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(240_000)
		await configureDefaultProfile(dlineDir, E2E_PROFILE_NAMES.mockDeepSeek, disableDeepSeekThinking)
		const app = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			const sidebar = await openSidebar(page, helper)
			const markers = {
				task: "E2E_DEEPSEEK_PROVIDER_ENABLE_THINKING_TASK",
				prompt: "E2E_DEEPSEEK_PROVIDER_ENABLE_THINKING_READY",
				completion: "E2E_DEEPSEEK_PROVIDER_ENABLE_THINKING_DONE",
			}
			await startTaskAndWaitForRuntimeControls(sidebar, "deepseek-chat", server, markers, { supportsThinking: false })
			await expect(sidebar.getByRole("combobox", { name: "Task thinking override" })).toHaveCount(0)

			await openApiSettings(page, sidebar)
			const card = await openProfileEditor(sidebar, E2E_PROFILE_NAMES.mockDeepSeek)
			await setCapability(card, "Enable Thinking", true)
			await waitForProfile(dlineDir, E2E_PROFILE_NAMES.mockDeepSeek, (profile) => {
				const reasoning = asRecord(asRecord(profile.deepseek).reasoning)
				return reasoning.effort === "high"
			})
			await sidebar.getByRole("button", { name: "Done" }).click()

			const control = sidebar.getByRole("combobox", { name: "Task thinking override" })
			await expect(control).toBeVisible({ timeout: 30_000 })
			await expect(control).toBeEnabled()
			await expect(control).toContainText("High")
			await control.click()
			await sidebar.getByRole("option", { name: "Low", exact: true }).click()
			const taskId = await onlyTaskId(dlineDocsDir)
			await expect
				.poll(async () => readTaskSettings(dlineDocsDir, taskId), { timeout: 30_000 })
				.toMatchObject({ actModeReasoningOverrideKind: "effort", actModeReasoningOverrideEffort: "low" })
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Profile layout - sufficient parent space shows the full name and fills the real remainder",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }, testInfo) => {
		e2e.setTimeout(240_000)
		await configureDefaultProfile(dlineDir, E2E_PROFILE_NAMES.mockOpenAi, enableOpenAiServiceTier)
		const app = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			const sidebar = await openSidebar(page, helper)
			const markers = {
				task: "E2E_PROFILE_LAYOUT_SUFFICIENT_TASK",
				prompt: "E2E_PROFILE_LAYOUT_SUFFICIENT_READY",
				completion: "E2E_PROFILE_LAYOUT_SUFFICIENT_DONE",
			}
			await startTaskAndWaitForRuntimeControls(sidebar, "openai-compatible-chat", server, markers)
			const baseline = await runtimeControlMetrics(sidebar)
			await setButtonGroupWidth(sidebar, Math.ceil(baseline.requiredButtonGroupWidth + 80))
			const metrics = await captureRuntimeLayoutEvidence(page, sidebar, testInfo, "profile-layout-wide")

			await expect(sidebar.getByRole("button", { name: "Select model" })).toHaveText(E2E_PROFILE_NAMES.mockOpenAi)
			expect(metrics.availableRuntimeWidth).toBeGreaterThanOrEqual(metrics.intrinsicRuntimeWidth)
			expect(metrics.profileText.scrollWidth).toBeLessThanOrEqual(metrics.profileText.clientWidth)
			expect(metrics.profileBox.width + 1).toBeGreaterThanOrEqual(metrics.profileText.scrollWidth)
			expectRuntimeControlsFillAvailableWidth(metrics)
			expectRuntimeControlsOnOneLine(metrics)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Profile layout - truncation starts only below the measured content threshold",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }, testInfo) => {
		e2e.setTimeout(240_000)
		await configureDefaultProfile(dlineDir, E2E_PROFILE_NAMES.mockOpenAi, enableOpenAiServiceTier)
		const app = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			const sidebar = await openSidebar(page, helper)
			const markers = {
				task: "E2E_PROFILE_LAYOUT_THRESHOLD_TASK",
				prompt: "E2E_PROFILE_LAYOUT_THRESHOLD_READY",
				completion: "E2E_PROFILE_LAYOUT_THRESHOLD_DONE",
			}
			await startTaskAndWaitForRuntimeControls(sidebar, "openai-compatible-chat", server, markers)
			const baseline = await runtimeControlMetrics(sidebar)

			await setButtonGroupWidth(sidebar, Math.ceil(baseline.requiredButtonGroupWidth + 80))
			const fitting = await runtimeControlMetrics(sidebar)
			expect(fitting.profileText.scrollWidth).toBeLessThanOrEqual(fitting.profileText.clientWidth)
			expectRuntimeControlsFillAvailableWidth(fitting)

			await setButtonGroupWidth(sidebar, Math.floor(baseline.requiredButtonGroupWidth - 40))
			const constrained = await captureRuntimeLayoutEvidence(page, sidebar, testInfo, "profile-layout-narrow")
			expect(constrained.availableRuntimeWidth).toBeLessThan(constrained.intrinsicRuntimeWidth)
			expect(constrained.profileText.scrollWidth).toBeGreaterThan(constrained.profileText.clientWidth)
			expectRuntimeControlsFillAvailableWidth(constrained)
			expectRuntimeControlsOnOneLine(constrained)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Profile layout - shrinkable controls change monotonically and preserve intrinsic proportions",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(240_000)
		await configureDefaultProfile(dlineDir, E2E_PROFILE_NAMES.mockOpenAi, enableOpenAiServiceTier)
		const app = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			const sidebar = await openSidebar(page, helper)
			const markers = {
				task: "E2E_PROFILE_LAYOUT_PROPORTIONAL_TASK",
				prompt: "E2E_PROFILE_LAYOUT_PROPORTIONAL_READY",
				completion: "E2E_PROFILE_LAYOUT_PROPORTIONAL_DONE",
			}
			await startTaskAndWaitForRuntimeControls(sidebar, "openai-compatible-chat", server, markers)
			const baseline = await runtimeControlMetrics(sidebar)
			const widths = [
				Math.ceil(baseline.requiredButtonGroupWidth + 60),
				Math.floor(baseline.requiredButtonGroupWidth - 30),
				Math.floor(baseline.requiredButtonGroupWidth - 70),
			]
			const samples = []
			for (const width of widths) {
				await setButtonGroupWidth(sidebar, width)
				const metrics = await runtimeControlMetrics(sidebar)
				expectRuntimeControlsFillAvailableWidth(metrics)
				expectRuntimeControlsOnOneLine(metrics)
				samples.push(metrics)
			}
			const [wide, medium, narrow] = samples
			expect(wide.profileBox.width).toBeGreaterThan(medium.profileBox.width)
			expect(medium.profileBox.width).toBeGreaterThan(narrow.profileBox.width)
			expect(wide.thinkingBox.width).toBeGreaterThanOrEqual(medium.thinkingBox.width)
			expect(medium.thinkingBox.width).toBeGreaterThanOrEqual(narrow.thinkingBox.width)
			const intrinsicProfileShare =
				baseline.profileText.scrollWidth / (baseline.profileText.scrollWidth + baseline.thinkingText.scrollWidth)
			const mediumProfileShare = medium.profileBox.width / (medium.profileBox.width + medium.thinkingBox.width)
			expect(Math.abs(mediumProfileShare - intrinsicProfileShare)).toBeLessThanOrEqual(0.08)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Profile layout - extreme width shrinks flexible controls and preserves the fixed Service Tier",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(240_000)
		await configureDefaultProfile(dlineDir, E2E_PROFILE_NAMES.mockOpenAi, enableOpenAiServiceTier)
		const app = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			const sidebar = await openSidebar(page, helper)
			const markers = {
				task: "E2E_PROFILE_LAYOUT_EXTREME_TASK",
				prompt: "E2E_PROFILE_LAYOUT_EXTREME_READY",
				completion: "E2E_PROFILE_LAYOUT_EXTREME_DONE",
			}
			await startTaskAndWaitForRuntimeControls(sidebar, "openai-compatible-chat", server, markers)
			const baseline = await runtimeControlMetrics(sidebar)
			const iconWidth = baseline.serviceTierBox.width
			await setButtonGroupWidth(sidebar, Math.ceil(baseline.prefixWidth + iconWidth * 3 + 6))
			const metrics = await runtimeControlMetrics(sidebar)

			expect(metrics.profileBox.width).toBeGreaterThan(0)
			expect(metrics.thinkingBox.width).toBeGreaterThan(0)
			expect(metrics.profileBox.width).toBeLessThan(baseline.profileBox.width)
			expect(metrics.thinkingBox.width).toBeLessThan(baseline.thinkingBox.width)
			expect(Math.abs(metrics.serviceTierBox.width - iconWidth)).toBeLessThanOrEqual(1)
			expect(metrics.serviceTierBox.x + metrics.serviceTierBox.width).toBeLessThanOrEqual(
				metrics.runtimeBox.x + metrics.runtimeBox.width + 1,
			)
			expectRuntimeControlsFillAvailableWidth(metrics)
			expectRuntimeControlsOnOneLine(metrics)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Task runtime controls - OpenAI effort and Service Tier are actionable, equidistant, persisted, and used by the next request",
	async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }, testInfo) => {
		e2e.setTimeout(240_000)
		await configureDefaultProfile(dlineDir, E2E_PROFILE_NAMES.mockOpenAi, enableOpenAiServiceTier)
		const app = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			const sidebar = await openSidebar(page, helper)
			const markers = {
				task: "E2E_OPENAI_RUNTIME_CONTROLS_TASK",
				prompt: "E2E_OPENAI_RUNTIME_CONTROLS_READY",
				completion: "E2E_OPENAI_RUNTIME_CONTROLS_DONE",
			}
			await startTaskAndWaitForRuntimeControls(sidebar, "openai-compatible-chat", server, markers, {
				onStreaming: async () => {
					await expectRuntimeControlsFit(sidebar)
					const streamingMetrics = await captureRuntimeControlEvidence(
						page,
						sidebar,
						testInfo,
						"openai-runtime-controls-streaming",
					)
					expect(streamingMetrics.thinking.disabled).toBe(false)
					expect(streamingMetrics.serviceTier.disabled).toBe(false)

					const firstRequest = server.getMockConsumptions("openai-compatible-chat")[0]
					expect(firstRequest.thinking).toEqual({ mode: "effort", effort: "high" })
					expect(asRecord(firstRequest.requestBody)).not.toHaveProperty("service_tier")

					await selectThinkingOverride(sidebar, "Low")
					await selectServiceTier(sidebar, "Ultrafast")
					const streamingTaskId = await onlyTaskId(dlineDocsDir)
					await expect
						.poll(async () => readTaskSettings(dlineDocsDir, streamingTaskId), { timeout: 30_000 })
						.toMatchObject({
							actModeReasoningOverrideKind: "effort",
							actModeReasoningOverrideEffort: "low",
							actModeServiceTierOverrideKind: "tier",
							actModeServiceTierOverrideTier: "ultrafast",
						})
				},
				streamingDelayMs: 15_000,
			})
			const thinkingControl = sidebar.getByRole("combobox", { name: "Task thinking override" })
			const serviceTierControl = sidebar.getByRole("button", { name: "Task service tier" })
			await expect(thinkingControl).toBeEnabled()
			await expect(serviceTierControl).toBeEnabled()
			await expectRuntimeControlsFit(sidebar)
			const stoppedMetrics = await captureRuntimeControlEvidence(
				page,
				sidebar,
				testInfo,
				"openai-runtime-controls-between-turns",
			)
			expect(stoppedMetrics.thinking.disabled).toBe(false)
			expect(stoppedMetrics.serviceTier.disabled).toBe(false)
			await expect(thinkingControl).toContainText("Low")
			await expect(serviceTierControl).toHaveAttribute("data-service-tier-label", "Ultrafast")
			await expectRuntimeControlTooltip(
				sidebar,
				sidebar.getByRole("button", { name: "Select model" }),
				E2E_PROFILE_NAMES.mockOpenAi,
			)
			await expectRuntimeControlTooltip(sidebar, thinkingControl, "Thinking: Low")
			await expectRuntimeControlTooltip(sidebar, serviceTierControl, "Service Tier: Ultrafast")

			await serviceTierControl.click()
			const serviceTierMenu = sidebar.getByRole("listbox", { name: "Task service tier options" })
			await expect(serviceTierMenu).toBeVisible()
			for (const tier of Object.keys(SERVICE_TIER_TOOLTIPS) as (keyof typeof SERVICE_TIER_TOOLTIPS)[]) {
				const optionValue = tier.toLowerCase()
				const option = sidebar.getByRole("option", { name: tier, exact: true })
				await expect(option).toBeVisible()
				await expect(option).toHaveAttribute("title", SERVICE_TIER_TOOLTIPS[tier])
				await expect(option.locator(`[data-service-tier-option-icon="${optionValue}"] svg`)).toHaveCount(1)
				await expect(option.locator(`[data-service-tier-option-label="${optionValue}"]`)).toHaveText(tier)
			}
			const menuPath = testInfo.outputPath("openai-service-tier-menu.png")
			await serviceTierMenu.screenshot({ path: menuPath })
			await testInfo.attach("openai-service-tier-menu", { path: menuPath, contentType: "image/png" })
			await page.keyboard.press("Escape")
			await expect(serviceTierControl).toHaveAttribute("data-service-tier-label", "Ultrafast")
			await captureRuntimeControls(page, sidebar, testInfo, "openai-runtime-controls")

			const taskId = await onlyTaskId(dlineDocsDir)
			await expect
				.poll(async () => readTaskSettings(dlineDocsDir, taskId), { timeout: 30_000 })
				.toMatchObject({
					actModeReasoningOverrideKind: "effort",
					actModeReasoningOverrideEffort: "low",
					actModeServiceTierOverrideKind: "tier",
					actModeServiceTierOverrideTier: "ultrafast",
				})

			await submitFeedback(sidebar, "E2E_OPENAI_RUNTIME_CONTROLS_FEEDBACK", markers.completion)
			await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(2)
			const nextRequest = server.getMockConsumptions("openai-compatible-chat")[1]
			expect(nextRequest.thinking).toEqual({ mode: "effort", effort: "low" })
			expect(nextRequest.requestBody).toMatchObject({ service_tier: "ultrafast" })
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Task runtime controls - an explicit subagent Profile keeps its own Thinking effort",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(240_000)
		await configureDefaultProfile(dlineDir, E2E_PROFILE_NAMES.mockOpenAiResponses, enableOpenAiServiceTier)
		await configureDefaultProfile(dlineDir, E2E_PROFILE_NAMES.mockOpenAi, enableOpenAiServiceTier)
		const subagentName = "e2e-profile-thinking"
		const subagentTask = "E2E_SUBAGENT_PROFILE_THINKING_TASK"
		const childResult = "E2E_SUBAGENT_PROFILE_THINKING_CHILD_DONE"
		const parentCompletion = "E2E_SUBAGENT_PROFILE_THINKING_PARENT_DONE"
		const systemPromptMarker = "E2E_SUBAGENT_PROFILE_THINKING_SYSTEM_PROMPT"
		const subagentDirectory = path.join(workspaceDir, ".agents", "subagents")
		await mkdir(subagentDirectory, { recursive: true })
		await writeFile(
			path.join(subagentDirectory, `${subagentName}.yml`),
			`---
name: ${subagentName}
description: Verifies that explicit subagent Profile reasoning is isolated from parent Task overrides.
profile: ${E2E_PROFILE_NAMES.mockOpenAiResponses}
tools:
  - attempt_completion
---

${systemPromptMarker}
Return the requested result.`,
			"utf8",
		)

		const app = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			const sidebar = await openSidebar(page, helper)
			server.resetOpenAiMock()
			server.enqueueResponses(
				"openai-compatible-chat",
				{
					type: "tool",
					name: "qna_respond",
					arguments: { response: "E2E_SUBAGENT_PROFILE_THINKING_READY" },
				},
				{
					type: "tool",
					id: "call_subagent_profile_thinking",
					name: "use_subagent",
					arguments: {
						agent_name: subagentName,
						task: subagentTask,
						context: "Return the configured child Profile result.",
						timeout: 60,
					},
				},
				{
					type: "tool",
					id: "call_subagent_profile_thinking_parent_complete",
					name: "attempt_completion",
					arguments: { result: parentCompletion },
					expectedToolResults: [
						{
							callId: "call_subagent_profile_thinking",
							contentIncludes: childResult,
						},
					],
				},
			)
			server.enqueueResponses("openai-compatible-responses", {
				type: "tool",
				id: "call_subagent_profile_thinking_child_complete",
				name: "attempt_completion",
				arguments: { result: childResult },
				expectedRequestIncludes: [systemPromptMarker],
			})

			const input = sidebar.getByTestId("chat-input")
			await input.fill("Start the Task and wait for a follow-up before running the configured subagent.")
			await sidebar.getByTestId("send-button").click()
			await expect.poll(() => server.getRequestCount("openai-compatible-chat"), { timeout: 30_000 }).toBe(1)
			await expect(sidebar.getByText("E2E_SUBAGENT_PROFILE_THINKING_READY", { exact: true })).toBeVisible({
				timeout: 60_000,
			})

			await selectThinkingOverride(sidebar, "Low")
			await selectServiceTier(sidebar, "Ultrafast")

			await input.fill("Run the explicit Profile subagent now.")
			await input.press("Enter")
			const approveButton = sidebar.getByText("Approve", { exact: true })
			const subagentTaskRow = sidebar.getByText(subagentTask, { exact: true }).last()
			await expect(approveButton.or(subagentTaskRow)).toBeVisible({ timeout: 60_000 })
			if (await approveButton.isVisible()) await approveButton.click()
			await expect(sidebar.getByText(parentCompletion, { exact: false }).last()).toBeVisible({ timeout: 60_000 })

			await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(3)
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(1)
			const parentSubagentRequest = server.getMockConsumptions("openai-compatible-chat")[1]
			expect(parentSubagentRequest.thinking).toEqual({ mode: "effort", effort: "low" })
			expect(parentSubagentRequest.requestBody).toMatchObject({ service_tier: "ultrafast" })
			const childRequest = server.getMockConsumptions("openai-compatible-responses")[0]
			expect(childRequest.contractError).toBeUndefined()
			expect(childRequest.thinking).toEqual({ mode: "effort", effort: "high" })
			expect(childRequest.requestBody).toMatchObject({ service_tier: "ultrafast" })

			await expect(subagentTaskRow).toBeVisible()
			const subagentCard = subagentTaskRow.locator("xpath=ancestor::*[@data-testid='subagent-item'][1]")
			const runtimeConfig = subagentCard.getByTestId("subagent-runtime-config")
			await expect(runtimeConfig.getByTitle(`Profile: ${E2E_PROFILE_NAMES.mockOpenAiResponses}`)).toBeVisible()
			await expect(runtimeConfig.getByTitle("Thinking: high")).toBeVisible()
			await expect
				.poll(() => readProfileReasoning(dlineDir, E2E_PROFILE_NAMES.mockOpenAiResponses), { timeout: 15_000 })
				.toMatchObject({ enableThinking: true, effort: "high" })
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Task runtime controls - a cancelled OpenAI Task keeps controls visible and restores editing",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }, testInfo) => {
		e2e.setTimeout(180_000)
		await configureDefaultProfile(dlineDir, E2E_PROFILE_NAMES.mockOpenAi, enableOpenAiServiceTier)
		server.resetOpenAiMock()
		server.enqueueResponses("openai-compatible-chat", {
			type: "tool",
			name: "attempt_completion",
			arguments: { result: "E2E_CANCELLED_RUNTIME_CONTROLS_MUST_NOT_RENDER" },
			delayMs: 30_000,
		})
		const app = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			const sidebar = await openSidebar(page, helper)
			const input = sidebar.getByTestId("chat-input")
			await input.fill("E2E_CANCELLED_RUNTIME_CONTROLS_TASK")
			await sidebar.getByTestId("send-button").click()
			await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(1)

			const taskFooter = sidebar.getByRole("contentinfo")
			const cancelButton = taskFooter.getByText("Cancel", { exact: true })
			await expect(cancelButton).toBeVisible({ timeout: 30_000 })
			const thinkingControl = sidebar.getByRole("combobox", { name: "Task thinking override" })
			const serviceTierControl = sidebar.getByRole("button", { name: "Task service tier" })
			await expect(thinkingControl).toBeVisible()
			await expect(thinkingControl).toBeEnabled()
			await expect(serviceTierControl).toBeVisible()
			await expect(serviceTierControl).toBeEnabled()
			await cancelButton.click()
			await expect
				.poll(() => server.getMockConsumptions("openai-compatible-chat")[0]?.abortedAtMs, { timeout: 30_000 })
				.not.toBeUndefined()

			await expect(taskFooter.getByText("Resume", { exact: true })).toBeVisible({ timeout: 30_000 })
			await expect(thinkingControl).toBeVisible()
			await expect(thinkingControl).toBeEnabled()
			await expect(serviceTierControl).toBeVisible()
			await expect(serviceTierControl).toBeEnabled()
			await expectRuntimeControlsFit(sidebar)
			const cancelledMetrics = await captureRuntimeControlEvidence(
				page,
				sidebar,
				testInfo,
				"openai-runtime-controls-cancelled",
			)
			expect(cancelledMetrics.thinking.disabled).toBe(false)
			expect(cancelledMetrics.serviceTier.disabled).toBe(false)
			await expect(sidebar.getByText("E2E_CANCELLED_RUNTIME_CONTROLS_MUST_NOT_RENDER", { exact: false })).toHaveCount(0)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Task runtime controls - DeepSeek exposes Low, High and Max, persists Max, and uses it in the next request",
	async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }, testInfo) => {
		e2e.setTimeout(240_000)
		const profileBefore = await configureDefaultProfile(dlineDir, E2E_PROFILE_NAMES.mockDeepSeek)
		const app = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			const sidebar = await openSidebar(page, helper)
			const markers = {
				task: "E2E_DEEPSEEK_RUNTIME_CONTROLS_TASK",
				prompt: "E2E_DEEPSEEK_RUNTIME_CONTROLS_READY",
				completion: "E2E_DEEPSEEK_RUNTIME_CONTROLS_DONE",
			}
			await startTaskAndWaitForRuntimeControls(sidebar, "deepseek-chat", server, markers)
			const thinking = sidebar.getByRole("combobox", { name: "Task thinking override" })
			await expect(thinking).toBeEnabled()
			await thinking.click()
			await expect(sidebar.getByRole("option", { name: "Low", exact: true })).toBeVisible()
			await expect(sidebar.getByRole("option", { name: "High", exact: true })).toBeVisible()
			await expect(sidebar.getByRole("option", { name: "Max", exact: true })).toBeVisible()
			await expect(sidebar.getByRole("option", { name: "Xhigh", exact: true })).toHaveCount(0)
			await sidebar.getByRole("option", { name: "Max", exact: true }).click()
			await expect(sidebar.getByRole("button", { name: "Task service tier" })).toHaveCount(0)
			await captureRuntimeControls(page, sidebar, testInfo, "deepseek-runtime-controls")

			const taskId = await onlyTaskId(dlineDocsDir)
			await expect
				.poll(async () => readTaskSettings(dlineDocsDir, taskId), { timeout: 30_000 })
				.toMatchObject({
					actModeReasoningOverrideKind: "effort",
					actModeReasoningOverrideEffort: "max",
				})

			await submitFeedback(sidebar, "E2E_DEEPSEEK_RUNTIME_CONTROLS_FEEDBACK", markers.completion)
			await expect.poll(() => server.getRequestCount("deepseek-chat")).toBe(2)
			expect(server.getMockConsumptions("deepseek-chat")[1].thinking).toEqual({ mode: "effort", effort: "max" })

			const persistedProfiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
			const persisted = persistedProfiles.find((profile) => profile.id === profileBefore.id)
			expect(asRecord(asRecord(persisted?.deepseek).reasoning).effort).toBe("high")
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Task runtime controls - a budget Provider edits tokens without Service Tier, persists them, and uses them in the next request",
	async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }, testInfo) => {
		e2e.setTimeout(240_000)
		const profileBefore = await configureDefaultProfile(dlineDir, E2E_PROFILE_NAMES.mockAnthropic, (profile) => {
			profile.modelId = "dline-e2e-budget-anthropic"
			profile.modelInfo = {
				capabilities: {
					supportsReasoning: true,
					supportsTools: true,
					thinking: { supported: true, mode: "budget", maxBudget: 32_000 },
				},
			}
			profile.anthropic = {
				...asRecord(profile.anthropic),
				reasoning: { enableThinking: true, effort: "", thinkingBudget: 2_048 },
			}
		})
		const app = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			const sidebar = await openSidebar(page, helper)
			const markers = {
				task: "E2E_BUDGET_RUNTIME_CONTROLS_TASK",
				prompt: "E2E_BUDGET_RUNTIME_CONTROLS_READY",
				completion: "E2E_BUDGET_RUNTIME_CONTROLS_DONE",
			}
			await startTaskAndWaitForRuntimeControls(sidebar, "anthropic-messages", server, markers)
			await expect(sidebar.getByRole("combobox", { name: "Task thinking override" })).toContainText("Budget")
			await expect(sidebar.getByRole("button", { name: "Task service tier" })).toHaveCount(0)
			const budget = sidebar.getByRole("spinbutton", { name: "Task thinking budget" })
			await expect(budget).toBeEnabled()
			await budget.fill("4096")
			await budget.press("Enter")
			await captureRuntimeControls(page, sidebar, testInfo, "budget-runtime-controls")

			const taskId = await onlyTaskId(dlineDocsDir)
			await expect
				.poll(async () => readTaskSettings(dlineDocsDir, taskId), { timeout: 30_000 })
				.toMatchObject({
					actModeReasoningOverrideKind: "budget",
					actModeThinkingBudgetTokens: 4_096,
				})

			await submitFeedback(sidebar, "E2E_BUDGET_RUNTIME_CONTROLS_FEEDBACK", markers.completion)
			await expect.poll(() => server.getRequestCount("anthropic-messages")).toBe(2)
			expect(server.getMockConsumptions("anthropic-messages")[1].thinking).toEqual({ mode: "budget", budget: 4_096 })

			const persistedProfiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
			const persisted = persistedProfiles.find((profile) => profile.id === profileBefore.id)
			expect(asRecord(asRecord(persisted?.anthropic).reasoning).thinkingBudget).toBe(2_048)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)
