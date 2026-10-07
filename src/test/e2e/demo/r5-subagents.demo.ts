import { expect } from "@playwright/test"
import { E2ETestHelper } from "../utils/helpers"
import { enqueueSubagentReview, SUBAGENT_ITEMS as ITEMS, PARENT_RESULT, startSubagentReview } from "./scenarios/subagent-review"
import { demo } from "./utils/demo-fixture"
import { dismissDemoNotifications } from "./utils/png-asset"
import { WINDOW_RECORDING } from "./utils/recording-presets"

/**
 * The children finish 13 s, 14.5 s and 16 s after their last request. Starting the
 * recording this far into that wait trims idle running frames, and the lower frame rate
 * keeps the full-window GIF inside the 3 MB README budget: the running indicators on
 * three cards change every frame, so size tracks the frame count. The steps before the
 * "still running" check below take about 5 s, which leaves roughly 2 s of margin.
 */
const RECORDING_LEAD_IN_MS = 5_500
const R5_RECORDING = { ...WINDOW_RECORDING, fps: 6 } as const

demo("R5", async ({ finishRecording, focusCamera, helper, pace, page, registerRecording, server, sidebar, userDataDir }) => {
	demo.setTimeout(180_000)
	await helper.signin(sidebar)
	enqueueSubagentReview(server)

	await dismissDemoNotifications(page)
	await startSubagentReview(sidebar, server)

	// Children finish on a fixed schedule after their last request, so camera moves here use
	// no extra settle time; the "running" assertions below depend on that budget.
	await pace(RECORDING_LEAD_IN_MS)
	await registerRecording("r5-subagents", R5_RECORDING)
	const activitiesTab = sidebar.getByRole("tab", { name: /^Activities(?: \d+)?$/ })
	await focusCamera(activitiesTab, 0)
	await activitiesTab.click()
	await sidebar.getByTestId("activity-status-filter-all").click()
	await sidebar.getByTestId("activity-kind-filter-subagent").click()

	const cards = sidebar.getByTestId("activity-item")
	await expect(cards).toHaveCount(3)
	await focusCamera(sidebar.getByTestId("activity-list"), 0)
	for (let index = 0; index < ITEMS.length; index += 1) {
		await cards.nth(index).getByTestId("activity-toggle").click()
	}

	const activities = ITEMS.map((item) => cards.filter({ hasText: item.task }))
	for (const [index, activity] of activities.entries()) {
		await expect(activity).toHaveCount(1)
		await expect(activity).toHaveAttribute("data-activity-status", "running")
		await expect(activity.getByTestId("subagent-activity-task")).toContainText(ITEMS[index].task)
		await expect(activity.getByTestId("subagent-activity-context")).toContainText(ITEMS[index].context)
		await expect(activity.getByTestId("subagent-tool-step-name")).toHaveText(ITEMS[index].tool)
		await expect(activity.getByTestId("subagent-tool-step-status")).toHaveText(/Done$/)
	}
	await pace(1_500)
	await Promise.all(activities.map((activity) => expect(activity).toHaveAttribute("data-activity-status", "running")))

	await focusCamera(activities[0], 0)
	await expect(activities[0]).toHaveAttribute("data-activity-status", "completed", { timeout: 30_000 })
	await expect(activities[1]).toHaveAttribute("data-activity-status", "running")
	await focusCamera(activities[1], 0)
	await pace(500)
	await expect(activities[1]).toHaveAttribute("data-activity-status", "completed", { timeout: 30_000 })
	await expect(activities[2]).toHaveAttribute("data-activity-status", "running")
	await focusCamera(activities[2], 0)
	await pace(500)
	await expect(activities[2]).toHaveAttribute("data-activity-status", "completed", { timeout: 30_000 })
	await focusCamera(sidebar.getByTestId("activity-list"), 0)

	for (const [index, activity] of activities.entries()) {
		await expect(activity.getByTestId("subagent-tool-step-name")).toHaveText([ITEMS[index].tool, "attempt_completion"])
		await expect(activity.getByTestId("subagent-tool-step-status")).toHaveText([/Done$/, /Done$/])
	}
	await pace(1_000)

	const workTab = sidebar.getByRole("tab", { name: "Work", exact: true })
	await focusCamera(workTab, 0)
	await workTab.click()
	const parentResult = sidebar.getByText(PARENT_RESULT, { exact: false }).last()
	await expect(parentResult).toBeVisible({ timeout: 30_000 })
	await focusCamera(parentResult, 0)
	await pace(1_200)
	await finishRecording()

	const consumptions = server.getMockConsumptions("openai-compatible-chat")
	expect(consumptions).toHaveLength(8)
	expect(consumptions[0]).toMatchObject({ toolName: "use_subagents", toolCallId: "call_r5_use_subagents" })
	expect(consumptions.at(-1)).toMatchObject({ toolName: "attempt_completion", toolCallId: "call_r5_parent_complete" })
	expect(consumptions.every(({ contractError }) => contractError === undefined)).toBe(true)
	const childFinals = consumptions.filter(({ toolCallId }) => toolCallId?.startsWith("call_r5_child_complete_"))
	expect(childFinals).toHaveLength(3)
	const receivedAtMs = childFinals.map((entry) => entry.receivedAtMs)
	expect(Math.max(...receivedAtMs) - Math.min(...receivedAtMs)).toBeLessThan(2_000)
	await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
})
