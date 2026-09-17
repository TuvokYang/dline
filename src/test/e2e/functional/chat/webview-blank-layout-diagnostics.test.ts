import { writeFile } from "node:fs/promises"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Page } from "@playwright/test"

type RectSnapshot = {
	x: number
	y: number
	width: number
	height: number
}

type FrameSnapshot = {
	label: string
	timestamp: number
	url: string
	title: string
	visibilityState: DocumentVisibilityState
	viewport: { width: number; height: number }
	html: RectSnapshot | null
	body: RectSnapshot | null
	root: RectSnapshot | null
	rootChild: RectSnapshot | null
	chatInput: RectSnapshot | null
	virtuosoScroller: RectSnapshot | null
	virtuosoItems: Array<{
		index: string | null
		rect: RectSnapshot
		text: string
		html: string
	}>
	bodyText: string
}

type ConsoleObservation = {
	timestamp: number
	type: string
	text: string
	location?: { url: string; lineNumber: number; columnNumber: number }
}

type FrameObservation = {
	timestamp: number
	event: "attached" | "detached" | "navigated"
	url: string
	name: string
}

type LayoutSample = {
	timestamp: number
	elapsedMs: number
	visibilityState: DocumentVisibilityState
	viewportWidth: number
	viewportHeight: number
	rootHeight: number | null
	scrollerHeight: number | null
	bodyTextLength: number
}

type SidebarTransition = {
	iteration: number
	startedAt: number
	recoveredAt: number
}

async function captureLayoutSample(sidebar: Frame, startedAt: number): Promise<LayoutSample> {
	return sidebar.evaluate((startedAt) => {
		const root = document.getElementById("root")
		const scroller = document.querySelector('[data-virtuoso-scroller="true"]')
		return {
			timestamp: Date.now(),
			elapsedMs: Date.now() - startedAt,
			visibilityState: document.visibilityState,
			viewportWidth: window.innerWidth,
			viewportHeight: window.innerHeight,
			rootHeight: root?.getBoundingClientRect().height ?? null,
			scrollerHeight: scroller?.getBoundingClientRect().height ?? null,
			bodyTextLength: document.body?.innerText.length ?? 0,
		}
	}, startedAt)
}

async function captureSnapshot(sidebar: Frame, label: string): Promise<FrameSnapshot> {
	return sidebar.evaluate(
		({ label }) => {
			const toRect = (element: Element | null): RectSnapshot | null => {
				if (!element) return null
				const bounds = element.getBoundingClientRect()
				return {
					x: bounds.x,
					y: bounds.y,
					width: bounds.width,
					height: bounds.height,
				}
			}
			const root = document.getElementById("root")
			const virtuosoScroller = document.querySelector('[data-virtuoso-scroller="true"]')
			const virtuosoItems = [...document.querySelectorAll<HTMLElement>("[data-index]")].slice(0, 25).map((element) => ({
				index: element.getAttribute("data-index"),
				rect: toRect(element) ?? { x: 0, y: 0, width: 0, height: 0 },
				text: (element.innerText || element.textContent || "").trim().slice(0, 300),
				html: element.outerHTML.slice(0, 1_000),
			}))

			return {
				label,
				timestamp: Date.now(),
				url: location.href,
				title: document.title,
				visibilityState: document.visibilityState,
				viewport: { width: window.innerWidth, height: window.innerHeight },
				html: toRect(document.documentElement),
				body: toRect(document.body),
				root: toRect(root),
				rootChild: toRect(root?.firstElementChild ?? null),
				chatInput: toRect(document.querySelector('[data-testid="chat-input"]')),
				virtuosoScroller: toRect(virtuosoScroller),
				virtuosoItems,
				bodyText: document.body.innerText.trim().slice(0, 2_000),
			}
		},
		{ label },
	)
}

async function captureVisibleSidebar(page: Page, helper: E2ETestHelper): Promise<Frame> {
	helper.clearCachedFrame()
	return helper.getSidebar(page)
}

async function findWebviewWrapperFrame(page: Page): Promise<Frame> {
	return E2ETestHelper.waitForValue(
		() => page.frames().find((frame) => !frame.isDetached() && frame.url().startsWith("vscode-webview://")),
		30_000,
	)
}

async function captureWrapperSnapshot(frame: Frame): Promise<Record<string, unknown>> {
	return frame.evaluate(() => {
		const nestedFrames = [...document.querySelectorAll("iframe")].map((element) => {
			const bounds = element.getBoundingClientRect()
			return {
				src: element.src,
				name: element.name,
				className: element.className,
				width: bounds.width,
				height: bounds.height,
				contentDocumentReadyState: element.contentDocument?.readyState ?? null,
				contentDocumentBodyPresent: Boolean(element.contentDocument?.body),
			}
		})
		return {
			url: location.href,
			title: document.title,
			readyState: document.readyState,
			visibilityState: document.visibilityState,
			viewport: { width: window.innerWidth, height: window.innerHeight },
			bodyPresent: Boolean(document.body),
			bodyHtml: document.body?.innerHTML.slice(0, 20_000) ?? null,
			rootCount: document.querySelectorAll("#root").length,
			nestedFrames,
		}
	})
}

e2e.use({ devWebview: true, installVsix: false })

e2e("records Webview layout across sidebar lifecycle", async ({ helper, page, server, userDataDir }) => {
	e2e.setTimeout(180_000)
	const consoleObservations: ConsoleObservation[] = []
	const pageErrors: Array<{ timestamp: number; message: string }> = []
	const frameObservations: FrameObservation[] = []
	const failedRequests: Array<{ timestamp: number; url: string; error: string | null }> = []
	const errorResponses: Array<{ timestamp: number; url: string; status: number }> = []
	const layoutSamples: LayoutSample[] = []
	const sidebarTransitions: SidebarTransition[] = []
	const snapshots: FrameSnapshot[] = []

	page.on("console", (message) => {
		consoleObservations.push({
			timestamp: Date.now(),
			type: message.type(),
			text: message.text(),
			location: message.location(),
		})
	})
	page.on("pageerror", (error) => {
		pageErrors.push({ timestamp: Date.now(), message: error.stack ?? error.message })
	})
	page.on("frameattached", (frame) => {
		frameObservations.push({ timestamp: Date.now(), event: "attached", url: frame.url(), name: frame.name() })
	})
	page.on("framedetached", (frame) => {
		frameObservations.push({ timestamp: Date.now(), event: "detached", url: frame.url(), name: frame.name() })
	})
	page.on("framenavigated", (frame) => {
		if (frame === page.mainFrame() || frame.url().startsWith("vscode-webview://")) {
			frameObservations.push({ timestamp: Date.now(), event: "navigated", url: frame.url(), name: frame.name() })
		}
	})
	page.on("requestfailed", (request) => {
		failedRequests.push({ timestamp: Date.now(), url: request.url(), error: request.failure()?.errorText ?? null })
	})
	page.on("response", (response) => {
		if (response.status() >= 400) {
			errorResponses.push({ timestamp: Date.now(), url: response.url(), status: response.status() })
		}
	})

	const conversationTurns = [
		{ assistant: "E2E_WEBVIEW_LONG_TURN_1", user: "E2E_WEBVIEW_LONG_REPLY_1" },
		{ assistant: "E2E_WEBVIEW_LONG_TURN_2", user: "E2E_WEBVIEW_LONG_REPLY_2" },
		{ assistant: "E2E_WEBVIEW_LONG_TURN_3", user: "E2E_WEBVIEW_LONG_REPLY_3" },
		{ assistant: "E2E_WEBVIEW_LONG_TURN_4", user: "E2E_WEBVIEW_LONG_REPLY_4" },
	] as const
	server.resetOpenAiMock()
	server.enqueueOpenAiResponses(
		...conversationTurns.map(({ assistant }, index) => ({
			type: "tool" as const,
			id: `call_webview_long_turn_${index + 1}`,
			name: "qna_respond",
			arguments: { response: assistant },
			delayMs: 7_000,
		})),
		{
			type: "message",
			text: "E2E_WEBVIEW_STREAMING_AFTER_30S",
			delayMs: 2_000,
			afterChatContentDelayMs: 20_000,
		},
	)
	await expect
		.poll(() => E2ETestHelper.readDlineOutputIfPresent(userDataDir)?.includes("[Dline] extension activated") ?? false, {
			timeout: 30_000,
		})
		.toBe(true)
	const dlineTabBeforeOpen = page.getByRole("tab", { name: /Dline/ })
	if ((await dlineTabBeforeOpen.getAttribute("aria-expanded")) === "true") {
		await E2ETestHelper.runCommandPalette(page, "View: Toggle Primary Side Bar Visibility")
		await expect(dlineTabBeforeOpen).toHaveAttribute("aria-expanded", "false")
	}
	await E2ETestHelper.openClineSidebar(page)
	const wrapperFrame = await findWebviewWrapperFrame(page)
	let sidebar: Frame
	try {
		sidebar = await captureVisibleSidebar(page, helper)
	} catch (error) {
		const earlyReport = {
			capturedAt: new Date().toISOString(),
			phase: "before-root",
			wrapper: await captureWrapperSnapshot(wrapperFrame),
			frames: page.frames().map((frame) => ({ url: frame.url(), name: frame.name(), detached: frame.isDetached() })),
			frameObservations,
			consoleObservations,
			pageErrors,
			failedRequests,
			errorResponses,
		}
		const earlyReportPath = e2e.info().outputPath("webview-before-root-diagnostics.json")
		await writeFile(earlyReportPath, `${JSON.stringify(earlyReport, null, 2)}\n`, "utf8")
		await e2e.info().attach("webview-before-root-diagnostics", {
			path: earlyReportPath,
			contentType: "application/json",
		})
		throw error
	}
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	await helper.signin(sidebar)
	const input = sidebar.getByTestId("chat-input")
	const conversationStartedAt = Date.now()
	let stopLayoutSampling = false
	page.once("close", () => {
		stopLayoutSampling = true
	})
	const layoutSampling = (async () => {
		while (!stopLayoutSampling) {
			try {
				layoutSamples.push(await captureLayoutSample(sidebar, conversationStartedAt))
			} catch {
				// Frame transitions are recorded separately; sampling resumes on the next interval.
			}
			await new Promise((resolve) => setTimeout(resolve, 250))
		}
	})()
	await input.fill("Exercise a real long Webview conversation for layout diagnostics.")
	await sidebar.getByTestId("send-button").click()
	for (const [index, turn] of conversationTurns.entries()) {
		await expect(sidebar.getByText(turn.assistant, { exact: true }).last()).toBeVisible({ timeout: 60_000 })
		snapshots.push(await captureSnapshot(sidebar, `conversation-turn-${index + 1}`))
		await expect(input).toBeEnabled()
		await input.fill(turn.user)
		await sidebar.getByTestId("send-button").click()
		await expect(sidebar.getByText(turn.user, { exact: true }).last()).toBeVisible()
	}
	await expect(sidebar.getByText("E2E_WEBVIEW_STREAMING_AFTER_30S", { exact: true }).last()).toBeVisible({ timeout: 60_000 })
	const longConversationElapsedMs = Date.now() - conversationStartedAt
	if (longConversationElapsedMs < 30_000) {
		await page.waitForTimeout(30_000 - longConversationElapsedMs)
	}
	const collectionStartedAt = Date.now()
	await expect(sidebar.getByText("E2E_WEBVIEW_STREAMING_AFTER_30S", { exact: true }).last()).toBeVisible()

	snapshots.push(await captureSnapshot(sidebar, "streaming-after-30s-conversation"))
	await page.screenshot({ path: e2e.info().outputPath("task-visible.png"), fullPage: true })

	const dlineTab = page.getByRole("tab", { name: /Dline/ })
	let revealedSidebar = sidebar
	for (let iteration = 1; iteration <= 5; iteration++) {
		const startedAt = Date.now()
		await E2ETestHelper.runCommandPalette(page, "View: Toggle Primary Side Bar Visibility")
		await expect(dlineTab).toHaveAttribute("aria-expanded", "false")
		await E2ETestHelper.runCommandPalette(page, "View: Toggle Primary Side Bar Visibility")
		await E2ETestHelper.openClineSidebar(page)
		revealedSidebar = await captureVisibleSidebar(page, helper)
		await expect(revealedSidebar.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 })
		await expect(revealedSidebar.locator('[data-virtuoso-scroller="true"]')).toBeVisible({ timeout: 30_000 })
		const recoveredAt = Date.now()
		sidebarTransitions.push({ iteration, startedAt, recoveredAt })
		snapshots.push(await captureSnapshot(revealedSidebar, `after-sidebar-reveal-${iteration}`))
	}
	await page.screenshot({ path: e2e.info().outputPath("after-sidebar-reveal.png"), fullPage: true })

	await page.setViewportSize({ width: 900, height: 600 })
	await expect(revealedSidebar.getByTestId("chat-input")).toBeVisible()
	snapshots.push(await captureSnapshot(revealedSidebar, "after-window-resize"))
	await page.screenshot({ path: e2e.info().outputPath("after-window-resize.png"), fullPage: true })
	stopLayoutSampling = true
	await layoutSampling

	const report = {
		capturedAt: new Date().toISOString(),
		conversationStartedAt,
		collectionStartedAt,
		conversationElapsedBeforeCollectionMs: collectionStartedAt - conversationStartedAt,
		requestCount: server.getRequestCount("openai-compatible-chat"),
		frames: page.frames().map((frame) => ({ url: frame.url(), name: frame.name(), detached: frame.isDetached() })),
		frameObservations,
		consoleObservations,
		pageErrors,
		failedRequests,
		errorResponses,
		layoutSamples,
		sidebarTransitions,
		snapshots,
	}
	const reportPath = e2e.info().outputPath("webview-layout-diagnostics.json")
	await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
	await e2e.info().attach("webview-layout-diagnostics", { path: reportPath, contentType: "application/json" })

	expect(collectionStartedAt - conversationStartedAt).toBeGreaterThanOrEqual(30_000)
	expect(server.getRequestCount("openai-compatible-chat")).toBe(5)
	expect(
		failedRequests.filter((request) => request.url.startsWith("http://localhost:8097")),
		"React DevTools should not be requested unless explicitly enabled",
	).toEqual([])
	expect(
		errorResponses.filter((response) => response.url.includes("codicon.ttf")),
		"Codicon font should not receive an HTTP error",
	).toEqual([])
	expect(
		failedRequests.filter((request) => request.url.includes("codicon.ttf")),
		"Codicon font should load from the Vite origin without a CSP or network failure",
	).toEqual([])
	const recoveredAt = layoutSamples.find((sample) => sample.viewportHeight > 150 && (sample.scrollerHeight ?? 0) > 0)?.elapsedMs
	expect(recoveredAt, "Webview layout should recover from its default 300x150 startup viewport").toBeDefined()
	for (const transition of sidebarTransitions) {
		expect(
			transition.recoveredAt - transition.startedAt,
			`sidebar transition ${transition.iteration} recovery time`,
		).toBeLessThan(5_000)
	}
	const stableLayoutSamples = layoutSamples.filter(
		(sample) =>
			!sidebarTransitions.some(
				(transition) => sample.timestamp >= transition.startedAt && sample.timestamp <= transition.recoveredAt,
			),
	)
	const zeroAfterRecovery = stableLayoutSamples.filter(
		(sample) =>
			recoveredAt !== undefined &&
			sample.elapsedMs >= recoveredAt &&
			sample.visibilityState === "visible" &&
			(sample.rootHeight ?? 0) > 0 &&
			sample.scrollerHeight === 0,
	)
	expect(zeroAfterRecovery, "Virtuoso should not collapse again after the Webview reaches its real size").toEqual([])
	const zeroAfterThirtySeconds = stableLayoutSamples.filter(
		(sample) =>
			sample.elapsedMs >= 30_000 &&
			sample.visibilityState === "visible" &&
			(sample.rootHeight ?? 0) > 0 &&
			sample.scrollerHeight === 0,
	)
	expect(zeroAfterThirtySeconds, "Virtuoso should remain measurable after 30 seconds of real conversation").toEqual([])
	for (const snapshot of snapshots.filter((snapshot) => !snapshot.label.startsWith("conversation-turn-"))) {
		expect(snapshot.viewport.height, `${snapshot.label}: viewport height`).toBeGreaterThan(0)
		expect(snapshot.root?.height ?? 0, `${snapshot.label}: root height`).toBeGreaterThan(0)
		expect(snapshot.virtuosoScroller?.height ?? 0, `${snapshot.label}: Virtuoso scroller height`).toBeGreaterThan(0)
		expect(
			snapshot.virtuosoItems.filter((item) => item.rect.height === 0),
			`${snapshot.label}: zero-height Virtuoso items`,
		).toEqual([])
	}

	await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
})
