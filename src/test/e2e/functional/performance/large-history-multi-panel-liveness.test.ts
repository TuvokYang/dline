import * as path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { seedTaskCorpus } from "@e2e/utils/seed-task-corpus"
import { readExtensionHostRuntimeHealth } from "@e2e/utils/task-history-control-client"
import { expect, type Frame, type Page } from "@playwright/test"
import type { RuntimeHealthSample } from "@/test/e2e-control/task-history-control"

const TASK_COUNT = 4
const UI_MESSAGES_PER_TASK = 900
const API_MESSAGES_PER_TASK = 900
const PAYLOAD_BYTES = 8 * 1024
const MAX_CONTROL_ROUND_TRIP_MS = 1_000
const MAX_EVENT_LOOP_DELAY_MS = 250
const MAX_HEAP_BYTES_PER_PERSISTED_BYTE = 1.5
const MAX_RSS_BYTES_PER_PERSISTED_BYTE = 3

interface TimedHealthSample extends RuntimeHealthSample {
	roundTripMs: number
}

async function findAdditionalDlineFrame(page: Page, existingFrames: Set<Frame>): Promise<Frame> {
	let resolved: Frame | undefined
	await expect
		.poll(
			async () => {
				for (const frame of page.frames()) {
					if (existingFrames.has(frame) || frame.isDetached() || !frame.url().startsWith("vscode-webview://")) continue
					if ((await frame.locator("#root").count()) > 0) {
						resolved = frame
						return true
					}
				}
				return false
			},
			{ timeout: 30_000 },
		)
		.toBe(true)
	if (!resolved) throw new Error("Dline editor panel frame was not created")
	return resolved
}

async function openHistoryInPanel(page: Page, sidebar: Frame, title: string): Promise<Frame> {
	const historyItem = sidebar.locator(".history-item").filter({ hasText: title })
	await expect(historyItem).toHaveCount(1, { timeout: 60_000 })
	await historyItem.hover()
	const existingFrames = new Set(page.frames())
	await historyItem.getByRole("button", { name: "Open in New Window", exact: true }).click()
	const panel = await findAdditionalDlineFrame(page, existingFrames)
	await E2ETestHelper.dismissWhatsNewModal(panel)
	await expect(panel.getByText(title, { exact: true }).first()).toBeVisible({ timeout: 60_000 })
	await expect(panel.getByRole("contentinfo").getByText("Resume", { exact: true })).toBeVisible({ timeout: 60_000 })
	return panel
}

function startHealthSampler(controlDirectory: string): {
	samples: TimedHealthSample[]
	stop(): Promise<void>
} {
	let stopped = false
	const samples: TimedHealthSample[] = []
	const sampling = (async () => {
		while (!stopped) {
			const startedAt = performance.now()
			const health = await readExtensionHostRuntimeHealth(controlDirectory)
			samples.push({ ...health, roundTripMs: performance.now() - startedAt })
			await new Promise((resolve) => setTimeout(resolve, 50))
		}
	})()
	return {
		samples,
		async stop(): Promise<void> {
			stopped = true
			await sampling
		},
	}
}

e2e(
	"Large historical tasks remain responsive and bounded across editor panels",
	async ({ dlineDocsDir, helper, openVSCode, userDataDir, workspaceDir }, testInfo) => {
		e2e.setTimeout(300_000)
		const corpus = await seedTaskCorpus(dlineDocsDir, {
			taskCount: TASK_COUNT,
			uiMessagesPerTask: UI_MESSAGES_PER_TASK,
			apiMessagesPerTask: API_MESSAGES_PER_TASK,
			payloadBytes: PAYLOAD_BYTES,
		})
		const controlDirectory = path.join(userDataDir, "task-history-control")
		const app = await openVSCode(workspaceDir, { DLINE_E2E_TASK_HISTORY_CONTROL_DIR: controlDirectory })
		const panels: Frame[] = []
		try {
			const page = await app.firstWindow()
			await E2ETestHelper.openClineSidebar(page)
			const sidebar = await helper.getSidebar(page)
			await E2ETestHelper.dismissWhatsNewModal(sidebar)
			await helper.signin(sidebar)
			await page.getByRole("button", { name: "History", exact: true }).click()
			await expect(sidebar.getByText(corpus.entries[0].title, { exact: true })).toBeVisible({ timeout: 120_000 })

			const baseline = await readExtensionHostRuntimeHealth(controlDirectory)
			const sampler = startHealthSampler(controlDirectory)
			try {
				for (const entry of corpus.entries) panels.push(await openHistoryInPanel(page, sidebar, entry.title))
			} finally {
				await sampler.stop()
			}
			const final = await readExtensionHostRuntimeHealth(controlDirectory)
			const samples = [baseline, ...sampler.samples, final]
			const maxHeapUsedBytes = Math.max(...samples.map((sample) => sample.heapUsedBytes))
			const maxRssBytes = Math.max(...samples.map((sample) => sample.rssBytes))
			const maxRoundTripMs = Math.max(...sampler.samples.map((sample) => sample.roundTripMs))
			const maxEventLoopDelayMs = Math.max(...sampler.samples.map((sample) => sample.eventLoopDelayMs))
			const report = {
				persistedBytes: corpus.totalPersistedBytes,
				baseline,
				final,
				maxHeapUsedBytes,
				maxRssBytes,
				maxRoundTripMs,
				maxEventLoopDelayMs,
				sampleCount: sampler.samples.length,
			}
			console.log(`[large-history-multi-panel] ${JSON.stringify(report)}`)
			await testInfo.attach("large-history-multi-panel.json", {
				body: Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8"),
				contentType: "application/json",
			})

			expect(sampler.samples.length).toBeGreaterThanOrEqual(TASK_COUNT)
			expect(maxRoundTripMs, "Extension-host control round trip must remain responsive").toBeLessThan(
				MAX_CONTROL_ROUND_TRIP_MS,
			)
			expect(maxEventLoopDelayMs, "Extension-host event-loop delay must stay below the warning budget").toBeLessThan(
				MAX_EVENT_LOOP_DELAY_MS,
			)
			expect(
				maxHeapUsedBytes - baseline.heapUsedBytes,
				"Historical panels must not retain every full message body",
			).toBeLessThan(corpus.totalPersistedBytes * MAX_HEAP_BYTES_PER_PERSISTED_BYTE)
			expect(maxRssBytes - baseline.rssBytes, "Historical panels must keep RSS growth bounded").toBeLessThan(
				corpus.totalPersistedBytes * MAX_RSS_BYTES_PER_PERSISTED_BYTE,
			)

			for (const panel of panels) {
				expect(panel.isDetached()).toBe(false)
				await expect(panel.getByRole("contentinfo").getByText("Resume", { exact: true })).toBeVisible()
			}
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)
