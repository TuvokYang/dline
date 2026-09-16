import { readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { expect, type Frame } from "@playwright/test"
import { E2E_PROFILE_NAMES } from "./utils/api-profile"
import { E2ETestHelper, e2e } from "./utils/helpers"

interface StoredProfile {
	name: string
	webToolsMode?: string
	openai?: {
		capabilities?: {
			contextWindow?: number
		}
	}
	anthropic?: {
		capabilities?: {
			contextWindow?: number
		}
	}
}

interface ContextWindowVisualState {
	contextWindow: number
	durableTokens: number
	environmentRenderedWidth: number
	environmentTokens: number
	minorFactor: number
	nativeTitleCount: number
	phase?: string
	receivingRenderedWidth: number
	receivingTokens: number
	receivingWidthPercent: number
	segmentKinds: string[]
	sendingTokens: number
	tooltipTriggerCount: number
	totalTokens: number
}

interface ContextWindowTraceSegment {
	authoritativeTokens: number
	displayTokens: number
	kind: string
	renderedWidth: number
	widthPercent: number
}

interface ContextWindowTraceSample {
	ariaValueNow: number
	atMs: number
	contextWindow: number
	epoch: number
	phase?: string
	progressWidth: number
	revision: number
	segments: ContextWindowTraceSegment[]
	totalAuthoritativeTokens: number
	totalDisplayTokens: number
}

interface ContextWindowTraceController {
	capture: () => void
	frameId: number
	observer: MutationObserver
	samples: ContextWindowTraceSample[]
	stopped: boolean
}

const profilesPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "api_profiles.json")
const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")

async function configureHostedResponsesProfile(dlineDir: string): Promise<void> {
	const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
	const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAiOfficialResponses)
	if (!profile) throw new Error("Official OpenAI E2E profile is missing")
	profile.webToolsMode = "WEB_TOOLS_MODE_AUTO"
	await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

	const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
	settings.actModeProfile = E2E_PROFILE_NAMES.mockOpenAiOfficialResponses
	settings.planModeProfile = E2E_PROFILE_NAMES.mockOpenAiOfficialResponses
	settings.clineWebToolsEnabled = true
	settings.useAutoCondense = false
	await writeFile(settingsPath(dlineDir), `${JSON.stringify(settings, null, 2)}\n`, "utf8")
}

async function configureTrajectoryProfile(dlineDir: string): Promise<void> {
	const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
	const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
	if (!profile?.openai?.capabilities) throw new Error("Configurable OpenAI Responses E2E profile is missing")
	profile.openai.capabilities.contextWindow = 131_072
	profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
	await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")
	await configureTrajectorySettings(dlineDir, E2E_PROFILE_NAMES.mockOpenAiResponses)
}

async function configureAnthropicTrajectoryProfile(dlineDir: string): Promise<void> {
	const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
	const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockAnthropic)
	if (!profile) throw new Error("Configurable Anthropic E2E profile is missing")
	profile.anthropic = {
		...profile.anthropic,
		capabilities: { ...profile.anthropic?.capabilities, contextWindow: 131_072 },
	}
	profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
	await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")
	await configureTrajectorySettings(dlineDir, E2E_PROFILE_NAMES.mockAnthropic)
}

async function configureTrajectorySettings(dlineDir: string, profileName: string): Promise<void> {
	const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
	settings.actModeProfile = profileName
	settings.planModeProfile = profileName
	settings.clineWebToolsEnabled = false
	settings.useAutoCondense = false
	await writeFile(settingsPath(dlineDir), `${JSON.stringify(settings, null, 2)}\n`, "utf8")
}

async function selectProfile(sidebar: Frame, profileName: string): Promise<void> {
	const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
	if ((await modelSwitcher.innerText()).trim() === profileName) return
	await modelSwitcher.click()
	await expect(sidebar.getByText("Available Models", { exact: true })).toBeVisible()
	const profileOption = sidebar.getByRole("option").filter({ has: sidebar.getByText(profileName, { exact: true }) })
	await expect(profileOption).toHaveCount(1)
	await profileOption.click()
	await expect(modelSwitcher).toHaveText(profileName)
}

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

async function expandTaskHeader(sidebar: Frame): Promise<void> {
	const expand = sidebar.getByLabel("Expand task header")
	if (await expand.isVisible()) await expand.click()
	await expect(sidebar.getByTestId("context-window-indicator")).toBeVisible({ timeout: 60_000 })
}

async function readContextWindowVisual(sidebar: Frame): Promise<ContextWindowVisualState> {
	return sidebar.getByTestId("context-window-segmented-progress").evaluate((progress) => {
		const element = progress as HTMLElement
		const segments = Array.from(element.querySelectorAll<HTMLElement>("[data-segment]"))
		const phase = element.dataset.phase
		const durable = segments.find((segment) => segment.dataset.segment === "durable")
		const active = segments.find((segment) => segment.dataset.segment === "active")
		const environment = segments.find((segment) => segment.dataset.segment === "environment")
		return {
			contextWindow: Number(element.dataset.contextWindow ?? 0),
			durableTokens: Number(durable?.dataset.authoritativeTokens ?? 0),
			environmentRenderedWidth: environment?.getBoundingClientRect().width ?? 0,
			environmentTokens: Number(environment?.dataset.authoritativeTokens ?? 0),
			minorFactor: Number(element.dataset.minorFactor ?? 1),
			nativeTitleCount: element.querySelectorAll("[title]").length + (element.hasAttribute("title") ? 1 : 0),
			phase,
			receivingRenderedWidth: phase === "receiving" ? (active?.getBoundingClientRect().width ?? 0) : 0,
			receivingTokens: phase === "receiving" ? Number(active?.dataset.authoritativeTokens ?? 0) : 0,
			receivingWidthPercent: phase === "receiving" ? Number.parseFloat(active?.style.width ?? "0") : 0,
			segmentKinds: segments.map((segment) => segment.dataset.segment ?? ""),
			sendingTokens: phase === "sending" ? Number(active?.dataset.authoritativeTokens ?? 0) : 0,
			tooltipTriggerCount: document.querySelectorAll('[data-testid="context-window-tooltip-trigger"]').length,
			totalTokens: segments.reduce((total, segment) => total + Number(segment.dataset.authoritativeTokens ?? 0), 0),
		}
	})
}

async function startContextWindowTrace(sidebar: Frame): Promise<void> {
	await sidebar.evaluate(() => {
		const traceWindow = window as Window & { __dlineContextWindowTrace?: ContextWindowTraceController }
		traceWindow.__dlineContextWindowTrace?.observer.disconnect()
		if (traceWindow.__dlineContextWindowTrace?.frameId) {
			cancelAnimationFrame(traceWindow.__dlineContextWindowTrace.frameId)
		}

		const samples: ContextWindowTraceSample[] = []
		const controller = {} as ContextWindowTraceController
		const capture = () => {
			if (controller.stopped) return
			const progress = document.querySelector<HTMLElement>('[data-testid="context-window-segmented-progress"]')
			if (progress) {
				const progressWidth = progress.getBoundingClientRect().width
				const segments = Array.from(progress.querySelectorAll<HTMLElement>("[data-segment]")).map((segment) => ({
					authoritativeTokens: Number(segment.dataset.authoritativeTokens ?? 0),
					displayTokens: Number(segment.dataset.tokens ?? 0),
					kind: segment.dataset.segment ?? "",
					renderedWidth: segment.getBoundingClientRect().width,
					widthPercent: Number.parseFloat(segment.style.width || "0"),
				}))
				samples.push({
					ariaValueNow: Number(progress.getAttribute("aria-valuenow") ?? 0),
					atMs: performance.now(),
					contextWindow: Number(progress.dataset.contextWindow ?? 0),
					epoch: Number(progress.dataset.epoch ?? 0),
					phase: progress.dataset.phase,
					progressWidth,
					revision: Number(progress.dataset.revision ?? 0),
					segments,
					totalAuthoritativeTokens: segments.reduce((total, segment) => total + segment.authoritativeTokens, 0),
					totalDisplayTokens: segments.reduce((total, segment) => total + segment.displayTokens, 0),
				})
			}
			controller.frameId = requestAnimationFrame(capture)
		}
		const observer = new MutationObserver(() => capture())
		Object.assign(controller, { capture, frameId: 0, observer, samples, stopped: false })
		traceWindow.__dlineContextWindowTrace = controller
		observer.observe(document.body, { attributes: true, childList: true, subtree: true })
		capture()
	})
}

async function stopContextWindowTrace(sidebar: Frame): Promise<ContextWindowTraceSample[]> {
	return sidebar.evaluate(() => {
		const traceWindow = window as Window & { __dlineContextWindowTrace?: ContextWindowTraceController }
		const controller = traceWindow.__dlineContextWindowTrace
		if (!controller) throw new Error("Context-window trace was not started")
		controller.stopped = true
		controller.observer.disconnect()
		cancelAnimationFrame(controller.frameId)
		delete traceWindow.__dlineContextWindowTrace
		return controller.samples
	})
}

function distinctContextWindowStates(trace: ContextWindowTraceSample[]): ContextWindowTraceSample[] {
	return trace.filter(
		(sample, index) =>
			index === 0 ||
			sample.revision !== trace[index - 1]?.revision ||
			sample.phase !== trace[index - 1]?.phase ||
			sample.totalAuthoritativeTokens !== trace[index - 1]?.totalAuthoritativeTokens,
	)
}

function authoritativeSegmentTokens(sample: ContextWindowTraceSample, kind: string): number {
	return sample.segments.find((segment) => segment.kind === kind)?.authoritativeTokens ?? 0
}

e2e(
	"Context indicator - hosted tool results never inflate Receiving and exact usage calibrates the request",
	async ({ dlineDir, helper, server, sidebar, userDataDir }, testInfo) => {
		e2e.setTimeout(180_000)
		await configureHostedResponsesProfile(dlineDir)
		server.resetOpenAiMock()

		const query = "E2E_CONTEXT_RECEIVING_HOSTED_QUERY"
		server.enqueueResponses("openai-official-responses", {
			type: "hosted-web-search",
			id: "ws_context_receiving_large_result",
			query,
			results: [
				{
					title: "Large provider-hosted result",
					url: "https://example.test/context-receiving-large-result",
					snippet: "R".repeat(48_000),
				},
			],
			usage: { inputTokens: 1_200, outputTokens: 800 },
			beforeUsageDelayMs: 5_000,
			afterUsageHoldMs: 20_000,
		})

		await helper.signin(sidebar)
		await selectProfile(sidebar, E2E_PROFILE_NAMES.mockOpenAiOfficialResponses)
		await sendTask(sidebar, "Use hosted search, then present the requested plan.")
		await expect(sidebar.getByText("Dline wants to search the web for:", { exact: false })).toBeVisible({ timeout: 60_000 })
		await sidebar.getByRole("contentinfo").getByText("Approve", { exact: true }).click()
		await expect(sidebar.getByTestId("web-search-card").filter({ hasText: query })).toBeVisible({ timeout: 60_000 })
		await expandTaskHeader(sidebar)

		const progress = sidebar.getByTestId("context-window-segmented-progress")
		await expect(progress).toHaveAttribute("data-phase", "sending")
		const beforeExactUsage = await readContextWindowVisual(sidebar)
		expect(beforeExactUsage.segmentKinds).toEqual(["durable", "active", "staged", "environment"])
		expect(beforeExactUsage.minorFactor).toBeGreaterThanOrEqual(1)
		expect(beforeExactUsage.minorFactor).toBeLessThanOrEqual(3)
		expect(beforeExactUsage.sendingTokens).toBeGreaterThan(0)
		expect(beforeExactUsage.receivingTokens).toBe(0)

		await expect(sidebar.getByTestId("context-window-segment-active")).toHaveAttribute("data-authoritative-tokens", "800", {
			timeout: 45_000,
		})
		await expect(progress).toHaveAttribute("data-phase", "receiving")
		await expect(progress).toHaveAttribute("aria-valuenow", "2000")
		const calibrated = await readContextWindowVisual(sidebar)
		expect(calibrated).toMatchObject({
			phase: "receiving",
			receivingTokens: 800,
			sendingTokens: 0,
			segmentKinds: ["durable", "active", "staged", "environment"],
			totalTokens: 2_000,
		})
		expect(calibrated.minorFactor).toBeGreaterThanOrEqual(1)
		expect(calibrated.minorFactor).toBeLessThanOrEqual(3)
		expect(calibrated.receivingRenderedWidth).toBeGreaterThanOrEqual(3)
		expect(calibrated.environmentTokens).toBeGreaterThan(0)
		expect(calibrated.environmentRenderedWidth).toBeGreaterThanOrEqual(3)
		expect(calibrated.tooltipTriggerCount).toBe(1)
		expect(calibrated.nativeTitleCount).toBe(0)
		expect(calibrated.receivingWidthPercent).toBeCloseTo(
			(calibrated.receivingTokens * calibrated.minorFactor * 100) / calibrated.contextWindow,
			4,
		)

		const narrowLayout = await sidebar.evaluate(() => {
			document.documentElement.style.width = "180px"
			document.body.style.width = "180px"
			const indicator = document.querySelector<HTMLElement>('[data-testid="context-window-indicator"]')
			const progress = document.querySelector<HTMLElement>('[data-testid="context-window-segmented-progress"]')
			if (!indicator || !progress) throw new Error("Context indicator layout is unavailable")
			return {
				indicatorWidth: indicator.getBoundingClientRect().width,
				progressHeight: progress.getBoundingClientRect().height,
				progressWidth: progress.getBoundingClientRect().width,
				segmentKinds: Array.from(progress.querySelectorAll<HTMLElement>("[data-segment]")).map(
					(segment) => segment.dataset.segment,
				),
				viewportWidth: document.documentElement.getBoundingClientRect().width,
			}
		})
		expect(narrowLayout.viewportWidth).toBe(180)
		expect(narrowLayout.indicatorWidth).toBeGreaterThan(0)
		expect(narrowLayout.progressWidth).toBeGreaterThan(0)
		expect(narrowLayout.progressHeight).toBeGreaterThan(0)
		expect(narrowLayout.segmentKinds).toEqual(["durable", "active", "staged", "environment"])

		await sidebar.getByTestId("context-window-progress-track").hover()
		const hoverCardContent = sidebar.locator('[data-slot="hover-card-content"]')
		await expect(hoverCardContent).toHaveCount(1)
		await expect(hoverCardContent).toBeVisible()
		const segmentDetails = hoverCardContent.getByTestId("context-window-segment-details")
		await expect(segmentDetails).toBeVisible()
		for (const kind of ["durable", "active", "staged", "environment"] as const) {
			const detail = segmentDetails.locator(`[data-segment-detail="${kind}"]`)
			await expect(detail).toBeVisible()
			await expect(detail).toHaveCSS("background-color", /rgb/)
		}
		const metricGeometry = await hoverCardContent.evaluate((content) => {
			const metrics = ["used", "remaining", "total"].map((metric) => {
				const cell = content.querySelector<HTMLElement>(`[data-context-summary-metric="${metric}"]`)
				if (!cell) throw new Error(`Missing context summary metric: ${metric}`)
				const cellBox = cell.getBoundingClientRect()
				const children = Array.from(cell.children).map((child) => (child as HTMLElement).getBoundingClientRect())
				return {
					cellCenter: cellBox.left + cellBox.width / 2,
					childCenters: children.map((box) => box.left + box.width / 2),
					width: cellBox.width,
				}
			})
			return metrics
		})
		expect(
			Math.max(...metricGeometry.map((metric) => metric.width)) - Math.min(...metricGeometry.map((metric) => metric.width)),
		).toBeLessThan(1)
		for (const metric of metricGeometry) {
			for (const childCenter of metric.childCenters) expect(Math.abs(childCenter - metric.cellCenter)).toBeLessThan(1)
		}
		await sidebar.getByTestId("chat-input").hover()
		await expect(hoverCardContent).toHaveCount(0)
		const screenshotPath = testInfo.outputPath("context-indicator-narrow.png")
		await sidebar.getByTestId("context-window-indicator").screenshot({ path: screenshotPath })
		await testInfo.attach("context-indicator-narrow", { path: screenshotPath, contentType: "image/png" })

		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Context indicator - a continuation request never re-estimates the full history before exact usage",
	async ({ dlineDir, helper, server, sidebar, userDataDir }, testInfo) => {
		e2e.setTimeout(180_000)
		await configureTrajectoryProfile(dlineDir)
		server.resetOpenAiMock()
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_context_trajectory_qna",
				name: "qna_respond",
				arguments: { response: "E2E_CONTEXT_TRAJECTORY_QNA" },
				usage: { inputTokens: 6_000, outputTokens: 100 },
			},
			{
				type: "tool",
				id: "call_context_trajectory_complete",
				name: "attempt_completion",
				arguments: { result: "E2E_CONTEXT_TRAJECTORY_COMPLETE" },
				usage: { inputTokens: 6_500, outputTokens: 100 },
				beforeUsageDelayMs: 5_000,
				afterUsageHoldMs: 3_000,
				expectedRequestIncludes: ["E2E_CONTEXT_TRAJECTORY_FEEDBACK"],
			},
		)

		await helper.signin(sidebar)
		await selectProfile(sidebar, E2E_PROFILE_NAMES.mockOpenAiResponses)
		await sendTask(sidebar, "E2E_CONTEXT_TRAJECTORY_TASK")
		await expect(sidebar.getByText("E2E_CONTEXT_TRAJECTORY_QNA", { exact: false })).toBeVisible({ timeout: 60_000 })
		await expandTaskHeader(sidebar)

		const progress = sidebar.getByTestId("context-window-segmented-progress")
		await expect(progress).toHaveAttribute("data-phase", "receiving", { timeout: 30_000 })
		await expect(progress).toHaveAttribute("aria-valuenow", "6100")
		await startContextWindowTrace(sidebar)

		await sendTask(sidebar, "E2E_CONTEXT_TRAJECTORY_FEEDBACK")
		await expect.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 30_000 }).toBe(2)
		await expect(progress).toHaveAttribute("aria-valuenow", "6600", { timeout: 30_000 })
		await expect(progress).toHaveAttribute("data-phase", "receiving")

		const trace = await stopContextWindowTrace(sidebar)
		await testInfo.attach("context-window-trajectory", {
			body: Buffer.from(JSON.stringify(trace, null, 2)),
			contentType: "application/json",
		})

		const stateSamples = distinctContextWindowStates(trace)
		expect(stateSamples.length).toBeGreaterThan(2)
		expect(stateSamples.some((sample) => sample.phase === "sending")).toBe(true)
		expect(stateSamples.some((sample) => sample.phase === "receiving" && sample.totalAuthoritativeTokens === 6_600)).toBe(
			true,
		)
		expect(stateSamples.every((sample) => sample.contextWindow === 131_072)).toBe(true)
		expect(stateSamples.every((sample) => sample.ariaValueNow === sample.totalAuthoritativeTokens)).toBe(true)
		for (let index = 1; index < stateSamples.length; index++) {
			expect(stateSamples[index]?.revision).toBeGreaterThanOrEqual(stateSamples[index - 1]?.revision ?? 0)
		}

		const peakTotal = Math.max(...stateSamples.map((sample) => sample.totalAuthoritativeTokens))
		const exactTotal = 6_600
		const maxFixtureRoundDelta = 2_000
		expect(peakTotal - exactTotal).toBeLessThanOrEqual(maxFixtureRoundDelta)

		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Context indicator - Anthropic split usage and tool arguments preserve one authoritative trajectory",
	async ({ dlineDir, helper, server, sidebar, userDataDir }, testInfo) => {
		e2e.setTimeout(180_000)
		await configureAnthropicTrajectoryProfile(dlineDir)
		server.resetOpenAiMock()
		const firstCallId = "call_context_anthropic_qna"
		const largeCompletion = `E2E_CONTEXT_ANTHROPIC_COMPLETE_${"T".repeat(12_000)}`
		server.enqueueResponses(
			"anthropic-messages",
			{
				type: "tool",
				id: firstCallId,
				name: "qna_respond",
				arguments: { response: "E2E_CONTEXT_ANTHROPIC_QNA" },
				usage: { inputTokens: 6_000, outputTokens: 100 },
			},
			{
				type: "tool",
				id: "call_context_anthropic_complete",
				name: "attempt_completion",
				arguments: { result: largeCompletion },
				usage: {
					inputTokens: 5_500,
					outputTokens: 800,
					cacheReadTokens: 1_000,
					cacheWriteTokens: 500,
				},
				beforeUsageDelayMs: 5_000,
				afterUsageHoldMs: 5_000,
				expectedToolResults: [{ callId: firstCallId, contentIncludes: "E2E_CONTEXT_ANTHROPIC_FEEDBACK" }],
			},
		)

		await helper.signin(sidebar)
		await selectProfile(sidebar, E2E_PROFILE_NAMES.mockAnthropic)
		await sendTask(sidebar, "E2E_CONTEXT_ANTHROPIC_TASK")
		await expect(sidebar.getByText("E2E_CONTEXT_ANTHROPIC_QNA", { exact: false })).toBeVisible({ timeout: 60_000 })
		await expandTaskHeader(sidebar)

		const progress = sidebar.getByTestId("context-window-segmented-progress")
		await expect(progress).toHaveAttribute("aria-valuenow", "6100", { timeout: 30_000 })
		await startContextWindowTrace(sidebar)

		await sendTask(sidebar, "E2E_CONTEXT_ANTHROPIC_FEEDBACK")
		await expect.poll(() => server.getRequestCount("anthropic-messages"), { timeout: 30_000 }).toBe(2)
		await expect
			.poll(
				async () => {
					const current = await readContextWindowVisual(sidebar)
					return current.totalTokens === 7_000 && current.receivingTokens > 800
				},
				{ timeout: 30_000 },
			)
			.toBe(true)
		await expect(progress).toHaveAttribute("aria-valuenow", "7800", { timeout: 30_000 })
		await expect(sidebar.getByTestId("context-window-segment-active")).toHaveAttribute("data-authoritative-tokens", "800")

		const trace = await stopContextWindowTrace(sidebar)
		await testInfo.attach("context-window-anthropic-split-trajectory", {
			body: Buffer.from(JSON.stringify(trace, null, 2)),
			contentType: "application/json",
		})
		const stateSamples = distinctContextWindowStates(trace)
		expect(stateSamples.length).toBeGreaterThan(3)
		expect(
			stateSamples.some(
				(sample) =>
					sample.phase === "receiving" &&
					sample.totalAuthoritativeTokens === 7_000 &&
					authoritativeSegmentTokens(sample, "active") > 800,
			),
		).toBe(true)
		expect(
			stateSamples.some(
				(sample) =>
					sample.phase === "receiving" &&
					sample.totalAuthoritativeTokens === 7_800 &&
					authoritativeSegmentTokens(sample, "active") === 800,
			),
		).toBe(true)
		expect(stateSamples.every((sample) => sample.contextWindow === 131_072)).toBe(true)
		expect(stateSamples.every((sample) => sample.ariaValueNow === sample.totalAuthoritativeTokens)).toBe(true)
		for (let index = 1; index < stateSamples.length; index++) {
			expect(stateSamples[index]?.revision).toBeGreaterThanOrEqual(stateSamples[index - 1]?.revision ?? 0)
		}
		const peakTotal = Math.max(...stateSamples.map((sample) => sample.totalAuthoritativeTokens))
		expect(peakTotal - 7_800).toBeLessThanOrEqual(2_000)

		const consumptions = server.getMockConsumptions("anthropic-messages")
		expect(consumptions).toHaveLength(2)
		expect(consumptions[1]?.contractError).toBeUndefined()
		expect(consumptions[1]?.usage).toEqual({
			inputTokens: 5_500,
			outputTokens: 800,
			cacheReadTokens: 1_000,
			cacheWriteTokens: 500,
		})
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)
