import type { MockApiConsumption, MockTokenUsage } from "@e2e/fixtures/server"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import {
	captureWorkScroller,
	closeContextRecoveryTask,
	configureContextRecoveryProfiles,
	earliestVisibleWorkHistoryIndex,
	expectUniqueOrderedWorkRows,
	openContextRecoveryHistoryTask,
	openContextRecoverySidebar,
	seedLockedLongHistoryTask,
	selectContextRecoveryProfile,
	unlockAndContinueContextTask,
	waitForPersistedTaskMarkers,
	waitForPositivePromptCacheHealth,
	waitForPositiveTaskCacheHit,
	workHistoryBodyMarker,
} from "@e2e/utils/work/context-recovery"
import { sendWorkMessage } from "@e2e/utils/work/session"
import { expect } from "@playwright/test"
import type { ElectronApplication } from "playwright"

const SOURCE_TARGET = "openai-compatible-responses" as const
const TARGET_TARGET = "openai-official-responses" as const
const TASK_ID = "work-daily-context-recovery"
const TASK_TEXT = "WORK_DAILY_CONTEXT_RECOVERY_TASK"
const HISTORY_MESSAGE_COUNT = 1_200
const HISTORY_BROWSE_TARGET = 650
const STREAM_CONTINUATION = "WORK_CONTEXT_STREAM_CONTINUATION"
const STREAM_PARTIAL = "WORK_CONTEXT_STREAM_PARTIAL"
const STREAM_READY = "WORK_CONTEXT_STREAM_READY"
const AUTO_COMPACT_CONTINUE = "WORK_CONTEXT_AUTO_COMPACT_CONTINUE"
const AUTO_COMPACT_SUMMARY = "WORK_CONTEXT_AUTO_COMPACT_SUMMARY preserves the task, viewport, cache, and profile state."
const POST_COMPACTION_READY = "WORK_CONTEXT_POST_COMPACTION_READY"
const PROFILE_SWITCH_INPUT = "WORK_CONTEXT_PROFILE_SWITCH_INPUT"
const PROFILE_SWITCH_READY = "WORK_CONTEXT_PROFILE_SWITCH_READY"
const RESTART_RESUME_INPUT = "WORK_CONTEXT_RESTART_RESUME_INPUT"
const FINAL_COMPLETE = "WORK_DAILY_CONTEXT_RECOVERY_COMPLETE"
const COMPACT_INSTRUCTION_MARKER = "The current conversation is rapidly running out of context"

const COLD_USAGE: MockTokenUsage = {
	inputTokens: 7_000,
	outputTokens: 80,
	cacheReadTokens: 0,
	cacheWriteTokens: 1_000,
}
const TRIGGER_USAGE: MockTokenUsage = {
	inputTokens: 118_900,
	outputTokens: 100,
	cacheReadTokens: 6_000,
	cacheWriteTokens: 100,
}
const WARM_USAGE: MockTokenUsage = {
	inputTokens: 3_000,
	outputTokens: 80,
	cacheReadTokens: 6_000,
	cacheWriteTokens: 100,
}

function responseNames(consumptions: readonly MockApiConsumption[]): string[] {
	return consumptions.map((consumption) => consumption.toolName ?? consumption.responseType)
}

function expectStableMockPrefix(baseline: MockApiConsumption, current: MockApiConsumption, label: string): void {
	if (!baseline.cacheDiagnostic || !current.cacheDiagnostic) {
		throw new Error(`${label}: missing OpenAI cache diagnostics`)
	}
	expect(current.cacheDiagnostic.componentHashes.system, `${label}: Mock system prefix drifted`).toBe(
		baseline.cacheDiagnostic.componentHashes.system,
	)
	expect(current.cacheDiagnostic.componentHashes.tools, `${label}: Mock tools prefix drifted`).toBe(
		baseline.cacheDiagnostic.componentHashes.tools,
	)
	expect(current.cacheDiagnostic.actualPrefixHash, `${label}: Mock stable prefix hash drifted`).toBe(
		baseline.cacheDiagnostic.actualPrefixHash,
	)
	expect(current.cacheDiagnostic.stablePrefixTokens, `${label}: Mock stable prefix token count drifted`).toBe(
		baseline.cacheDiagnostic.stablePrefixTokens,
	)
	expect(
		current.cacheDiagnostic.warnings.map(({ code }) => code),
		`${label}: Mock reported prefix mismatch`,
	).not.toContain("prefix_hash_mismatch")
}

e2e(
	"daily context recovery preserves viewport, cache prefix, compaction, profile transition, and restart",
	async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }, testInfo) => {
		e2e.setTimeout(600_000)
		const profiles = await configureContextRecoveryProfiles(dlineDir)
		await seedLockedLongHistoryTask(dlineDocsDir, workspaceDir, {
			taskId: TASK_ID,
			taskText: TASK_TEXT,
			messageCount: HISTORY_MESSAGE_COUNT,
		})

		server.resetOpenAiMock()
		server.enqueueResponses(
			SOURCE_TARGET,
			{
				type: "message",
				text: `${STREAM_PARTIAL}\n${"streaming detail ".repeat(40)}`,
				beforeUsageDelayMs: 8_000,
				usage: COLD_USAGE,
				expectedRequestIncludes: [STREAM_CONTINUATION],
			},
			{
				type: "tool",
				id: "call_work_context_stream_ready",
				name: "qna_respond",
				arguments: { response: STREAM_READY },
				usage: TRIGGER_USAGE,
				expectedRequestIncludes: [STREAM_PARTIAL],
			},
			{
				type: "tool",
				id: "call_work_context_summary",
				name: "summarize_task",
				arguments: { context: AUTO_COMPACT_SUMMARY },
				usage: WARM_USAGE,
				expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER],
				expectedRequestExcludes: [AUTO_COMPACT_CONTINUE],
			},
			{
				type: "tool",
				id: "call_work_context_post_compaction",
				name: "qna_respond",
				arguments: { response: POST_COMPACTION_READY },
				usage: WARM_USAGE,
				expectedRequestIncludes: [AUTO_COMPACT_SUMMARY, AUTO_COMPACT_CONTINUE],
				expectedRequestExcludes: [COMPACT_INSTRUCTION_MARKER],
			},
			{
				type: "error",
				status: 500,
				code: "unexpected_source_request",
				message: "Unexpected source request after profile transition",
			},
		)
		server.enqueueResponses(
			TARGET_TARGET,
			{
				type: "tool",
				id: "call_work_context_profile_ready",
				name: "qna_respond",
				arguments: { response: PROFILE_SWITCH_READY },
				usage: WARM_USAGE,
				expectedRequestIncludes: [PROFILE_SWITCH_INPUT],
			},
			{
				type: "tool",
				id: "call_work_context_restart_complete",
				name: "attempt_completion",
				arguments: { result: FINAL_COMPLETE },
				usage: WARM_USAGE,
				expectedRequestIncludes: [RESTART_RESUME_INPUT],
			},
			{
				type: "error",
				status: 500,
				code: "unexpected_target_request",
				message: "Unexpected target request after context recovery completion",
			},
		)

		let app: ElectronApplication | undefined
		try {
			app = await openVSCode(workspaceDir)
			let { page, sidebar } = await openContextRecoverySidebar(app, helper)
			await openContextRecoveryHistoryTask(page, sidebar, TASK_TEXT)

			const scroller = sidebar.locator('[data-virtuoso-scroller="true"]')
			await expect(scroller).toBeVisible({ timeout: 30_000 })
			await expect(sidebar.getByText(workHistoryBodyMarker(HISTORY_MESSAGE_COUNT), { exact: false })).toBeVisible({
				timeout: 30_000,
			})

			let historyBrowse = await captureWorkScroller(sidebar)
			for (
				let attempt = 0;
				attempt < 40 && (earliestVisibleWorkHistoryIndex(historyBrowse) ?? HISTORY_MESSAGE_COUNT) > HISTORY_BROWSE_TARGET;
				attempt++
			) {
				await scroller.hover()
				await page.mouse.wheel(0, -2_400)
				await page.waitForTimeout(100)
				historyBrowse = await captureWorkScroller(sidebar)
			}
			expect(earliestVisibleWorkHistoryIndex(historyBrowse)).toBeLessThanOrEqual(HISTORY_BROWSE_TARGET)
			expect(historyBrowse.bottomGap).toBeGreaterThan(100)
			expectUniqueOrderedWorkRows(historyBrowse)
			await scroller.hover()
			await page.mouse.wheel(0, 120)
			let scrollToBottom = sidebar.getByRole("button", { name: "Scroll to bottom", exact: true })
			await expect(scrollToBottom).toBeVisible({ timeout: 10_000 })
			await scrollToBottom.click()
			await expect(sidebar.getByText(workHistoryBodyMarker(HISTORY_MESSAGE_COUNT), { exact: false })).toBeVisible({
				timeout: 30_000,
			})

			await unlockAndContinueContextTask(sidebar, STREAM_CONTINUATION)
			await expect(sidebar.getByText(STREAM_PARTIAL, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect(sidebar.getByRole("contentinfo").getByText("Cancel", { exact: true })).toBeVisible({ timeout: 30_000 })
			await expect.poll(() => server.getRequestCount(SOURCE_TARGET), { timeout: 30_000 }).toBe(1)

			let streamingBrowse = await captureWorkScroller(sidebar)
			for (let attempt = 0; attempt < 12 && streamingBrowse.bottomGap <= 500; attempt++) {
				await scroller.hover()
				await page.mouse.wheel(0, -1_200)
				await page.waitForTimeout(100)
				streamingBrowse = await captureWorkScroller(sidebar)
			}
			expect(streamingBrowse.bottomGap).toBeGreaterThan(500)
			expectUniqueOrderedWorkRows(streamingBrowse)
			// The response remains open for eight seconds; hold long enough to prove live tail updates do not reclaim ownership.
			await page.waitForTimeout(1_200)
			const whileStreaming = await captureWorkScroller(sidebar)
			expect(whileStreaming.bottomGap).toBeGreaterThan(500)
			expectUniqueOrderedWorkRows(whileStreaming)

			await expect.poll(() => server.getRequestCount(SOURCE_TARGET), { timeout: 60_000 }).toBe(2)
			const afterStreaming = await captureWorkScroller(sidebar)
			expect(afterStreaming.bottomGap).toBeGreaterThan(500)
			expectUniqueOrderedWorkRows(afterStreaming)
			await scroller.hover()
			await page.mouse.wheel(0, 120)
			scrollToBottom = sidebar.getByRole("button", { name: "Scroll to bottom", exact: true })
			await expect(scrollToBottom).toBeVisible({ timeout: 10_000 })
			await scrollToBottom.click()
			await expect(sidebar.getByText(STREAM_READY, { exact: true })).toBeVisible({ timeout: 30_000 })

			const warmCacheInfo = await waitForPositiveTaskCacheHit(dlineDocsDir, TASK_ID)
			expect(warmCacheInfo.cacheReads).toBeGreaterThan(0)
			expect(warmCacheInfo.cacheHitRate).toBeGreaterThan(0)
			const warmHealth = await waitForPositivePromptCacheHealth(userDataDir, TASK_ID)
			expect(warmHealth.promptTokens).toBeGreaterThanOrEqual(4_096)

			await sendWorkMessage(sidebar, AUTO_COMPACT_CONTINUE)
			const summaryCard = sidebar.getByTestId("compaction-pass").filter({ hasText: AUTO_COMPACT_SUMMARY })
			await expect(summaryCard).toBeVisible({ timeout: 60_000 })
			await expect(summaryCard).toHaveAttribute("data-compaction-status", "completed")
			await expect(sidebar.getByText(POST_COMPACTION_READY, { exact: true })).toBeVisible({ timeout: 60_000 })
			await expect(sidebar.locator('vscode-button[aria-label="Condense Conversation"]')).toHaveCount(0)
			await expect(sidebar.locator('vscode-button[aria-label="Regenerate Summary"]')).toHaveCount(0)
			expect(await sidebar.locator("body").innerText()).not.toContain(COMPACT_INSTRUCTION_MARKER)
			await expect.poll(() => server.getRequestCount(SOURCE_TARGET), { timeout: 60_000 }).toBe(4)

			const sourceConsumptions = server.getMockConsumptions(SOURCE_TARGET)
			expect(responseNames(sourceConsumptions)).toEqual(["message", "qna_respond", "summarize_task", "qna_respond"])
			expect(sourceConsumptions.every(({ contractError }) => contractError === undefined)).toBe(true)
			const sourceBaselineConsumption = sourceConsumptions[0]
			if (!sourceBaselineConsumption) throw new Error("Missing source cache baseline")
			for (const [index, consumption] of sourceConsumptions.entries()) {
				if (index > 0) expectStableMockPrefix(sourceBaselineConsumption, consumption, `source request ${index + 1}`)
			}

			await selectContextRecoveryProfile(sidebar, profiles.targetProfileName)
			await expect.poll(() => server.getRequestCount(SOURCE_TARGET)).toBe(4)
			await expect.poll(() => server.getRequestCount(TARGET_TARGET)).toBe(0)
			await sendWorkMessage(sidebar, PROFILE_SWITCH_INPUT)
			await expect(sidebar.getByText(PROFILE_SWITCH_READY, { exact: true })).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.getRequestCount(TARGET_TARGET), { timeout: 30_000 }).toBe(1)

			const targetFirstConsumption = server.getMockConsumptions(TARGET_TARGET)[0]
			if (!targetFirstConsumption) throw new Error("Missing target profile request")
			expectStableMockPrefix(sourceBaselineConsumption, targetFirstConsumption, "equivalent target profile")
			const switchedCacheInfo = await waitForPositiveTaskCacheHit(dlineDocsDir, TASK_ID)
			expect(switchedCacheInfo.cacheReads).toBeGreaterThan(0)
			expect(switchedCacheInfo.cacheHitRate).toBeGreaterThan(0)

			await waitForPersistedTaskMarkers(dlineDocsDir, TASK_ID, [AUTO_COMPACT_SUMMARY, PROFILE_SWITCH_READY])
			await closeContextRecoveryTask(sidebar)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
			await app.close()
			app = undefined
			helper.clearCachedFrame()

			app = await openVSCode(workspaceDir)
			;({ page, sidebar } = await openContextRecoverySidebar(app, helper))
			await openContextRecoveryHistoryTask(page, sidebar, TASK_TEXT)
			await expect.poll(() => server.getRequestCount(SOURCE_TARGET)).toBe(4)
			await expect.poll(() => server.getRequestCount(TARGET_TARGET)).toBe(1)
			await expect(sidebar.getByText(AUTO_COMPACT_SUMMARY, { exact: false }).last()).toBeVisible({ timeout: 30_000 })
			await expect(sidebar.getByText(PROFILE_SWITCH_READY, { exact: true })).toBeVisible({ timeout: 30_000 })
			await expect(sidebar.getByTestId("chat-input")).toBeEnabled({ timeout: 30_000 })
			await sendWorkMessage(sidebar, RESTART_RESUME_INPUT)
			await expect(sidebar.getByText(FINAL_COMPLETE, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.getRequestCount(TARGET_TARGET), { timeout: 30_000 }).toBe(2)

			const resumedHealth = await waitForPositivePromptCacheHealth(userDataDir, TASK_ID)
			expect(resumedHealth.hitRate).toBeGreaterThan(0)
			const resumedCacheInfo = await waitForPositiveTaskCacheHit(dlineDocsDir, TASK_ID)
			expect(resumedCacheInfo.cacheReads).toBeGreaterThan(0)
			expect(resumedCacheInfo.cacheHitRate).toBeGreaterThan(0)
			await waitForPersistedTaskMarkers(dlineDocsDir, TASK_ID, [AUTO_COMPACT_SUMMARY, FINAL_COMPLETE])

			const targetConsumptions = server.getMockConsumptions(TARGET_TARGET)
			expect(responseNames(targetConsumptions)).toEqual(["qna_respond", "attempt_completion"])
			expect(targetConsumptions.every(({ contractError }) => contractError === undefined)).toBe(true)
			const resumedConsumption = targetConsumptions[1]
			if (!resumedConsumption) throw new Error("Missing restart target request")
			expectStableMockPrefix(sourceBaselineConsumption, resumedConsumption, "restart target request")
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)

			await testInfo.attach("daily-context-recovery-evidence.json", {
				body: Buffer.from(
					`${JSON.stringify(
						{
							profiles,
							warmHealth,
							resumedHealth,
							sourceRequests: sourceConsumptions.map(({ cacheDiagnostic, usage, toolName, responseType }) => ({
								cacheDiagnostic,
								usage,
								toolName,
								responseType,
							})),
							targetRequests: targetConsumptions.map(({ cacheDiagnostic, usage, toolName, responseType }) => ({
								cacheDiagnostic,
								usage,
								toolName,
								responseType,
							})),
						},
						null,
						2,
					)}\n`,
					"utf8",
				),
				contentType: "application/json",
			})
		} finally {
			await app?.close()
		}
	},
)
