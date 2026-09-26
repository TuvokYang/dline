import { expect } from "@playwright/test"
import { E2E_PROFILE_NAMES } from "../utils/api-profile"
import { E2ETestHelper } from "../utils/helpers"
import {
	COMPACT_INSTRUCTION_MARKER,
	COMPACTION_COMPLETION_TEXT as COMPLETION_TEXT,
	COMPACTION_CONTINUE_TEXT as CONTINUE_TEXT,
	configureAutoCompaction,
	enqueueAutoCompaction,
	primeContextNearLimit,
	selectProfile,
} from "./scenarios/compaction"
import { demo } from "./utils/demo-fixture"
import { dismissDemoNotifications } from "./utils/png-asset"

demo("R8", async ({ dlineDir, finishRecording, helper, pace, page, registerRecording, server, sidebar, userDataDir }) => {
	demo.setTimeout(180_000)
	await configureAutoCompaction(dlineDir)
	await helper.signin(sidebar)
	await selectProfile(sidebar, E2E_PROFILE_NAMES.mockOpenAiResponses)
	enqueueAutoCompaction(server)

	await dismissDemoNotifications(page)
	await primeContextNearLimit(sidebar)
	const contextProgress = sidebar.getByTestId("context-window-segmented-progress")

	await registerRecording("r8-compaction")
	await pace()
	const input = sidebar.getByTestId("chat-input")
	await input.fill(CONTINUE_TEXT)
	await pace(500)
	await input.press("Enter")
	await expect(input).toHaveValue("")

	const compactionPass = sidebar.getByTestId("compaction-pass").last()
	await expect(compactionPass).toBeVisible({ timeout: 60_000 })
	await expect(compactionPass).not.toHaveAttribute("data-compaction-status", "completed")
	await pace()
	await expect(compactionPass).not.toHaveAttribute("data-compaction-status", "completed")
	await expect(compactionPass).toHaveAttribute("data-compaction-status", "completed", { timeout: 60_000 })
	await compactionPass.scrollIntoViewIfNeeded()
	await pace()
	await expect(compactionPass).toHaveAttribute("data-compaction-status", "completed")

	await expect(sidebar.getByText(COMPLETION_TEXT, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
	await expect
		.poll(async () => Number((await contextProgress.getAttribute("aria-valuenow")) ?? Number.POSITIVE_INFINITY), {
			timeout: 30_000,
		})
		.toBeLessThan(40_000)
	await pace()
	await finishRecording()

	await expect(sidebar.getByTestId("compaction-failure")).toHaveCount(0)
	await expect(sidebar.locator('vscode-button[aria-label="Condense Conversation"]')).toHaveCount(0)
	await expect(sidebar.locator('vscode-button[aria-label="Regenerate Summary"]')).toHaveCount(0)
	expect(await sidebar.locator("body").innerText()).not.toContain(COMPACT_INSTRUCTION_MARKER)
	const consumptions = server.getMockConsumptions("openai-compatible-responses")
	expect(consumptions.map(({ responseType }) => responseType)).toEqual(["tool", "tool-with-completion-snapshots", "tool"])
	expect(consumptions[0].toolName).toBe("qna_respond")
	expect(consumptions[2].toolName).toBe("attempt_completion")
	expect(consumptions.every(({ contractError }) => contractError === undefined)).toBe(true)
	await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
})
