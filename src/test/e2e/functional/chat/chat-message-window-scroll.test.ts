import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { seedLegacyTaskHistory } from "@e2e/utils/task-history-store"
import { expect, type Frame, type TestInfo } from "@playwright/test"
import type { HistoryItem } from "@shared/HistoryItem"
import type { ElectronApplication } from "playwright"

const TASK_ID = "e2e-chat-message-window-scroll"
const TASK_TEXT = "E2E_CHAT_MESSAGE_WINDOW_SCROLL_TASK"
const BODY_MESSAGE_COUNT = 1_200
const BROWSE_TARGET_INDEX = 650
const STREAM_CONTINUATION = "E2E_CHAT_WINDOW_STREAM_CONTINUATION"
const STREAM_PARTIAL_MARKER = "E2E_CHAT_WINDOW_STREAM_PARTIAL"
const STREAM_COMPLETION_MARKER = "E2E_CHAT_WINDOW_STREAM_COMPLETE"

interface VisibleRowSnapshot {
	ts: number
	top: number
	bottom: number
	text: string
}

interface ScrollerSnapshot {
	scrollTop: number
	scrollHeight: number
	clientHeight: number
	bottomGap: number
	visibleRows: VisibleRowSnapshot[]
}

function bodyMarker(index: number): string {
	return `E2E_CHAT_WINDOW_MESSAGE_${String(index).padStart(4, "0")}`
}

function bodyText(index: number): string {
	const lineCount = (index % 4) + 1
	const details = Array.from({ length: lineCount }, (_, line) => `detail-${index}-${line + 1}`).join("\n")
	return `${bodyMarker(index)}\n${details}`
}

async function seedLongCompletedTask(dlineDocsDir: string, workspaceDir: string): Promise<void> {
	const tasksDir = path.join(dlineDocsDir, "tasks")
	const taskDir = path.join(tasksDir, TASK_ID)
	await mkdir(taskDir, { recursive: true })

	const baseTimestamp = Date.now() - 120_000
	const historyItem: HistoryItem = {
		id: TASK_ID,
		ts: baseTimestamp,
		task: TASK_TEXT,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		cwdOnTaskInitialization: workspaceDir,
	}
	const messages = [
		{ ts: baseTimestamp, type: "say", say: "task", text: TASK_TEXT },
		...Array.from({ length: BODY_MESSAGE_COUNT }, (_, offset) => {
			const index = offset + 1
			return {
				ts: baseTimestamp + index,
				type: "say",
				say: "text",
				text: bodyText(index),
			}
		}),
	]

	await Promise.all([
		seedLegacyTaskHistory(dlineDocsDir, [historyItem]),
		writeFile(
			path.join(taskDir, "ui_messages.jsonl"),
			`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
			"utf8",
		),
		writeFile(path.join(taskDir, "api_conversation_history.jsonl"), "", "utf8"),
		writeFile(
			path.join(taskDir, ".lock"),
			JSON.stringify({ held_by: "e2e-chat-window-other-instance", locked_at: Date.now(), pid: 4242 }),
			"utf8",
		),
	])
}

function grpcLogPath(testInfo: TestInfo): string {
	const fileName = E2ETestHelper.generateTestFileName(testInfo.title, testInfo.project.name)
	return path.join(E2ETestHelper.CODEBASE_ROOT_DIR, "tests", "specs", `grpc_recorded_session_${fileName}.json`)
}

async function observeFetchedWindows(sidebar: Frame): Promise<void> {
	await sidebar.evaluate(() => {
		const completedRequests = new Set<string>()
		const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
		document.documentElement.dataset.fetchedWindows = "0"
		// Observe the real FetchMessageResponse contract in this isolated webview.
		// The shared recorder overwrites JSON concurrently and is not a reliable live counter.
		window.addEventListener("message", (event: MessageEvent<unknown>) => {
			const envelope = event.data
			if (!isRecord(envelope) || envelope.type !== "grpc_response" || !isRecord(envelope.grpc_response)) return
			const response = envelope.grpc_response
			if (response.error || typeof response.request_id !== "string" || !isRecord(response.message)) return
			const payload = response.message
			if (
				!Array.isArray(payload.messages) ||
				typeof payload.startIndex !== "number" ||
				typeof payload.totalCount !== "number"
			)
				return
			completedRequests.add(response.request_id)
			document.documentElement.dataset.fetchedWindows = String(completedRequests.size)
		})
	})
}

async function readFetchMessageRpcCount(sidebar: Frame): Promise<number> {
	return sidebar.evaluate(() => Number(document.documentElement.dataset.fetchedWindows ?? 0))
}

async function captureScroller(sidebar: Frame): Promise<ScrollerSnapshot> {
	return sidebar.locator('[data-virtuoso-scroller="true"]').evaluate((scroller) => {
		const scrollerRect = scroller.getBoundingClientRect()
		const visibleRows = [...document.querySelectorAll<HTMLElement>("[data-message-ts]")]
			.map((element) => {
				const rect = element.getBoundingClientRect()
				return {
					ts: Number(element.dataset.messageTs),
					top: rect.top - scrollerRect.top,
					bottom: rect.bottom - scrollerRect.top,
					text: (element.innerText || element.textContent || "").trim().slice(0, 160),
				}
			})
			.filter((row) => Number.isFinite(row.ts) && row.bottom > 0 && row.top < scroller.clientHeight)
		return {
			scrollTop: scroller.scrollTop,
			scrollHeight: scroller.scrollHeight,
			clientHeight: scroller.clientHeight,
			bottomGap: Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop),
			visibleRows,
		}
	})
}

function expectUniqueOrderedRows(snapshot: ScrollerSnapshot): void {
	const timestamps = snapshot.visibleRows.map((row) => row.ts)
	expect(new Set(timestamps).size, "visible Chat rows must have unique message identities").toBe(timestamps.length)
	for (let index = 1; index < timestamps.length; index++) {
		const previousTimestamp = timestamps[index - 1]
		if (previousTimestamp === undefined) throw new Error("visible Chat row predecessor is missing")
		expect(timestamps[index], "visible Chat rows must remain ordered by message identity").toBeGreaterThan(previousTimestamp)
	}
}

async function unlockAndContinueTask(sidebar: Frame, text: string): Promise<void> {
	const unlockButton = sidebar.getByRole("button", { name: "Unlock", exact: true })
	await expect(unlockButton).toBeVisible({ timeout: 30_000 })
	await unlockButton.click()
	await expect(sidebar.getByText("Unlock Task", { exact: true })).toBeVisible({ timeout: 10_000 })
	await sidebar.getByRole("button", { name: "Confirm", exact: true }).click()
	await expect(unlockButton).toBeHidden({ timeout: 15_000 })

	const input = sidebar.getByTestId("chat-input")
	const sendButton = sidebar.getByTestId("send-button")
	const resumeButton = sidebar.getByRole("contentinfo").getByText("Resume", { exact: true })
	await expect(input).toBeEnabled({ timeout: 30_000 })
	await expect
		.poll(
			async () => (await resumeButton.isVisible().catch(() => false)) || (await sendButton.isEnabled().catch(() => false)),
			{
				timeout: 30_000,
			},
		)
		.toBe(true)
	await input.fill(text)
	if (await resumeButton.isVisible().catch(() => false)) {
		await resumeButton.click()
	} else {
		await sendButton.click()
	}
	await expect(sidebar.getByText(text, { exact: true }).last()).toBeVisible({ timeout: 30_000 })
}

async function openSeededHistoryTask(
	app: ElectronApplication,
	helper: E2ETestHelper,
): Promise<{ page: Awaited<ReturnType<ElectronApplication["firstWindow"]>>; sidebar: Frame }> {
	const page = await app.firstWindow()
	await E2ETestHelper.openClineSidebar(page)
	const sidebar = await helper.getSidebar(page)
	await helper.signin(sidebar)
	await observeFetchedWindows(sidebar)
	await page.getByRole("button", { name: "History", exact: true }).click()
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	const historyTask = sidebar.locator(".history-item").filter({ hasText: TASK_TEXT })
	await expect(historyTask).toHaveCount(1)
	await historyTask.click()
	await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({ timeout: 30_000 })
	await expect(sidebar.getByText(TASK_TEXT, { exact: true }).first()).toBeVisible({ timeout: 30_000 })
	return { page, sidebar }
}

e2e.describe("Chat message window scroll", () => {
	e2e.use({ grpcRecorderEnabled: true })

	e2e(
		"long history window does not refetch forever while browsing upward",
		async ({ dlineDocsDir, helper, openVSCode, userDataDir, workspaceDir }, testInfo) => {
			e2e.setTimeout(240_000)
			const recorderPath = grpcLogPath(testInfo)
			await rm(recorderPath, { force: true })
			await seedLongCompletedTask(dlineDocsDir, workspaceDir)

			let app: ElectronApplication | undefined
			let completed = false
			try {
				app = await openVSCode(workspaceDir)
				const { page, sidebar } = await openSeededHistoryTask(app, helper)
				const scroller = sidebar.locator('[data-virtuoso-scroller="true"]')
				await expect(scroller).toBeVisible({ timeout: 30_000 })
				await expect(sidebar.getByText(bodyMarker(BODY_MESSAGE_COUNT), { exact: false })).toBeVisible({ timeout: 30_000 })

				await expect
					.poll(
						async () => {
							const snapshot = await captureScroller(sidebar)
							const latestRow = snapshot.visibleRows.find((row) =>
								row.text.includes(bodyMarker(BODY_MESSAGE_COUNT)),
							)
							return latestRow !== undefined && latestRow.bottom <= snapshot.clientHeight + 1
						},
						{ message: "a reopened long Task must fully render the latest row", timeout: 30_000 },
					)
					.toBe(true)
				await expect(sidebar.getByRole("button", { name: "Scroll to bottom", exact: true })).toHaveCount(0)
				const initial = await captureScroller(sidebar)
				expectUniqueOrderedRows(initial)
				await expect.poll(() => readFetchMessageRpcCount(sidebar), { timeout: 30_000 }).toBeGreaterThanOrEqual(1)
				const initialFetchCount = await readFetchMessageRpcCount(sidebar)

				let browsing = await captureScroller(sidebar)
				for (let attempt = 0; attempt < 40; attempt++) {
					const visibleIndexes = browsing.visibleRows.flatMap((row) => {
						const match = /E2E_CHAT_WINDOW_MESSAGE_(\d{4})/u.exec(row.text)
						return match ? [Number(match[1])] : []
					})
					if (visibleIndexes.some((index) => index <= BROWSE_TARGET_INDEX)) break
					await scroller.hover()
					await page.mouse.wheel(0, -2_400)
					// Pace real wheel input so Virtuoso can publish ranges and request the next leading page.
					await page.waitForTimeout(100)
					browsing = await captureScroller(sidebar)
				}
				const oldestVisibleIndex = Math.min(
					...browsing.visibleRows.flatMap((row) => {
						const match = /E2E_CHAT_WINDOW_MESSAGE_(\d{4})/u.exec(row.text)
						return match ? [Number(match[1])] : []
					}),
				)
				expect(oldestVisibleIndex, "wheel browsing must reach the requested older history range").toBeLessThanOrEqual(
					BROWSE_TARGET_INDEX,
				)
				expect(browsing.bottomGap, "browsing old messages must move away from the live tail").toBeGreaterThan(100)
				expectUniqueOrderedRows(browsing)
				const anchor = browsing.visibleRows.find((row) => row.top >= -1)
				expect(anchor, "the browser must expose a stable visible row anchor").toBeDefined()

				await expect.poll(() => readFetchMessageRpcCount(sidebar), { timeout: 30_000 }).toBeGreaterThan(initialFetchCount)
				// This interval is the behavior under test: after required edge loading settles,
				// a correct window controller must become quiescent instead of refetching the latest page forever.
				await page.waitForTimeout(1_500)
				const settledFetchCount = await readFetchMessageRpcCount(sidebar)
				await page.waitForTimeout(1_500)
				const laterFetchCount = await readFetchMessageRpcCount(sidebar)

				const afterIdle = await captureScroller(sidebar)
				await testInfo.attach("chat-idle-anchor-diagnostics.json", {
					body: JSON.stringify({ anchor, browsing, afterIdle, settledFetchCount, laterFetchCount }, null, 2),
					contentType: "application/json",
				})
				expectUniqueOrderedRows(afterIdle)
				const sameAnchor = afterIdle.visibleRows.find((row) => row.ts === anchor.ts)
				if (!sameAnchor) throw new Error("idle window maintenance must preserve the user's visible anchor")
				expect(Math.abs(sameAnchor.top - anchor.top), "idle maintenance must not yank the viewport").toBeLessThanOrEqual(
					20,
				)
				expect(
					laterFetchCount,
					`fetchMessage must settle after the necessary leading loads (settled=${settledFetchCount}, later=${laterFetchCount})`,
				).toBeLessThanOrEqual(settledFetchCount + 1)

				await scroller.hover()
				await page.mouse.wheel(0, 120)
				const scrollToBottom = sidebar.getByRole("button", { name: "Scroll to bottom", exact: true })
				await expect(scrollToBottom).toBeVisible({ timeout: 10_000 })
				await scrollToBottom.click()
				await expect(sidebar.getByText(bodyMarker(BODY_MESSAGE_COUNT), { exact: false })).toBeVisible({ timeout: 30_000 })
				await expect
					.poll(
						async () => {
							const snapshot = await captureScroller(sidebar)
							const latestRow = snapshot.visibleRows.find((row) =>
								row.text.includes(bodyMarker(BODY_MESSAGE_COUNT)),
							)
							return latestRow !== undefined && latestRow.bottom <= snapshot.clientHeight + 1
						},
						{ message: "returning to bottom must fully render the latest row", timeout: 30_000 },
					)
					.toBe(true)
				await expect(sidebar.getByRole("button", { name: "Scroll to bottom", exact: true })).toHaveCount(0)
				const returnedToBottom = await captureScroller(sidebar)
				expectUniqueOrderedRows(returnedToBottom)

				await testInfo.attach("chat-message-window-scroll-evidence.json", {
					body: Buffer.from(
						JSON.stringify(
							{
								initialFetchCount,
								settledFetchCount,
								laterFetchCount,
								initial,
								browsing,
								afterIdle,
								returnedToBottom,
							},
							null,
							2,
						),
						"utf8",
					),
					contentType: "application/json",
				})
				await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
				completed = true
			} finally {
				await app?.close()
				const recorderEvidence = await readFile(recorderPath).catch(() => undefined)
				if (recorderEvidence) {
					await testInfo.attach("chat-message-window-grpc-recording.json", {
						body: recorderEvidence,
						contentType: "application/json",
					})
				}
				if (completed) {
					await rm(recorderPath, { force: true })
				}
			}
		},
	)

	e2e(
		"active streaming tail does not reclaim the viewport while the user browses upward",
		async ({ dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }, testInfo) => {
			e2e.setTimeout(240_000)
			const recorderPath = grpcLogPath(testInfo)
			await rm(recorderPath, { force: true })
			await seedLongCompletedTask(dlineDocsDir, workspaceDir)
			server.resetOpenAiMock()
			server.enqueueOpenAiResponses(
				{
					type: "message",
					text: `${STREAM_PARTIAL_MARKER}\n${"streaming detail ".repeat(40)}`,
					afterChatContentDelayMs: 10_000,
				},
				{
					type: "tool",
					id: "call_chat_window_stream_complete",
					name: "attempt_completion",
					arguments: { result: STREAM_COMPLETION_MARKER },
					expectedRequestIncludes: [STREAM_PARTIAL_MARKER],
				},
			)

			let app: ElectronApplication | undefined
			let completed = false
			try {
				app = await openVSCode(workspaceDir)
				const { page, sidebar } = await openSeededHistoryTask(app, helper)
				const scroller = sidebar.locator('[data-virtuoso-scroller="true"]')
				await expect(scroller).toBeVisible({ timeout: 30_000 })
				await expect(sidebar.getByText(bodyMarker(BODY_MESSAGE_COUNT), { exact: false })).toBeVisible({ timeout: 30_000 })

				await unlockAndContinueTask(sidebar, STREAM_CONTINUATION)
				await expect(sidebar.getByText(STREAM_PARTIAL_MARKER, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
				await expect(sidebar.getByRole("contentinfo").getByText("Cancel", { exact: true })).toBeVisible({
					timeout: 30_000,
				})
				await expect.poll(() => server.getRequestCount("openai-compatible-chat"), { timeout: 30_000 }).toBe(1)

				let browsing = await captureScroller(sidebar)
				for (let attempt = 0; attempt < 12 && browsing.bottomGap <= 500; attempt++) {
					await scroller.hover()
					await page.mouse.wheel(0, -1_200)
					await page.waitForTimeout(100)
					browsing = await captureScroller(sidebar)
				}
				expect(browsing.bottomGap, "wheel input must move away from the streaming tail").toBeGreaterThan(500)
				expectUniqueOrderedRows(browsing)
				const anchor = browsing.visibleRows.find((row) => row.top >= -1)
				if (!anchor) throw new Error("stream browsing must expose a stable visible anchor")

				await page.waitForTimeout(1_500)
				const whileStreaming = await captureScroller(sidebar)
				const streamingDiagnosticsPath = testInfo.outputPath("chat-message-window-active-stream-diagnostics.json")
				await writeFile(
					streamingDiagnosticsPath,
					`${JSON.stringify({ anchor, browsing, whileStreaming }, null, 2)}\n`,
					"utf8",
				)
				await testInfo.attach("chat-message-window-active-stream-diagnostics.json", {
					path: streamingDiagnosticsPath,
					contentType: "application/json",
				})
				const sameStreamingAnchor = whileStreaming.visibleRows.find((row) => row.ts === anchor.ts)
				if (!sameStreamingAnchor) throw new Error("active streaming must not replace the browsing window")
				expect(
					Math.abs(sameStreamingAnchor.top - anchor.top),
					"active streaming must not pull the user's anchor toward the tail",
				).toBeLessThanOrEqual(20)
				await expect(sidebar.getByRole("contentinfo").getByText("Cancel", { exact: true })).toBeVisible()

				await expect.poll(() => server.getRequestCount("openai-compatible-chat"), { timeout: 30_000 }).toBe(2)
				await expect(sidebar.getByRole("contentinfo").getByText("Start New Task", { exact: true })).toBeVisible({
					timeout: 60_000,
				})
				const afterCompletion = await captureScroller(sidebar)
				const anchorDiagnosticsPath = testInfo.outputPath("chat-message-window-streaming-anchor-diagnostics.json")
				await writeFile(
					anchorDiagnosticsPath,
					`${JSON.stringify({ anchor, browsing, whileStreaming, afterCompletion }, null, 2)}\n`,
					"utf8",
				)
				await testInfo.attach("chat-message-window-streaming-anchor-diagnostics.json", {
					path: anchorDiagnosticsPath,
					contentType: "application/json",
				})
				const sameCompletedAnchor = afterCompletion.visibleRows.find((row) => row.ts === anchor.ts)
				if (!sameCompletedAnchor) throw new Error("completion appended during browsing must preserve the anchor")
				expect(
					Math.abs(sameCompletedAnchor.top - anchor.top),
					"completion must not auto-follow until the user explicitly returns to bottom",
				).toBeLessThanOrEqual(20)
				expectUniqueOrderedRows(afterCompletion)

				await scroller.hover()
				await page.mouse.wheel(0, 120)
				const scrollToBottom = sidebar.getByRole("button", { name: "Scroll to bottom", exact: true })
				await expect(scrollToBottom).toBeVisible({ timeout: 10_000 })
				await expect(scrollToBottom.locator("..")).toHaveClass(/pointer-events-auto/)
				await scrollToBottom.click()
				await expect(sidebar.getByText(STREAM_COMPLETION_MARKER, { exact: false }).last()).toBeVisible({
					timeout: 30_000,
				})
				await expect(scrollToBottom).toHaveCount(0)
				const returnedToBottom = await captureScroller(sidebar)
				expectUniqueOrderedRows(returnedToBottom)

				await testInfo.attach("chat-message-window-streaming-evidence.json", {
					body: Buffer.from(
						`${JSON.stringify({ browsing, whileStreaming, afterCompletion, returnedToBottom }, null, 2)}\n`,
						"utf8",
					),
					contentType: "application/json",
				})
				await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
				completed = true
			} finally {
				await app?.close()
				const recorderEvidence = await readFile(recorderPath).catch(() => undefined)
				if (recorderEvidence) {
					await testInfo.attach("chat-message-window-streaming-grpc-recording.json", {
						body: recorderEvidence,
						contentType: "application/json",
					})
				}
				if (completed) {
					await rm(recorderPath, { force: true })
				}
			}
		},
	)
})
