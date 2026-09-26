import { expect } from "@playwright/test"
import { E2ETestHelper } from "../utils/helpers"
import { enqueueSubagentReview, SUBAGENT_ITEMS as ITEMS, PARENT_RESULT, startSubagentReview } from "./scenarios/subagent-review"
import { demo } from "./utils/demo-fixture"
import { dismissDemoNotifications } from "./utils/png-asset"

demo("R5", async ({ finishRecording, helper, pace, page, registerRecording, server, sidebar, userDataDir }) => {
	demo.setTimeout(180_000)
	await helper.signin(sidebar)
	enqueueSubagentReview(server)

	await dismissDemoNotifications(page)
	await startSubagentReview(sidebar, server)

	await registerRecording("r5-subagents")
	await sidebar.getByRole("tab", { name: /^Activities(?: \d+)?$/ }).click()
	await sidebar.getByTestId("activity-status-filter-all").click()
	await sidebar.getByTestId("activity-kind-filter-subagent").click()

	const cards = sidebar.getByTestId("activity-item")
	await expect(cards).toHaveCount(3)
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
	await pace()
	await Promise.all(activities.map((activity) => expect(activity).toHaveAttribute("data-activity-status", "running")))

	await expect(activities[0]).toHaveAttribute("data-activity-status", "completed", { timeout: 30_000 })
	await expect(activities[1]).toHaveAttribute("data-activity-status", "running")
	await pace(500)
	await expect(activities[1]).toHaveAttribute("data-activity-status", "completed", { timeout: 30_000 })
	await expect(activities[2]).toHaveAttribute("data-activity-status", "running")
	await pace(500)
	await expect(activities[2]).toHaveAttribute("data-activity-status", "completed", { timeout: 30_000 })

	for (const [index, activity] of activities.entries()) {
		await expect(activity.getByTestId("subagent-tool-step-name")).toHaveText([ITEMS[index].tool, "attempt_completion"])
		await expect(activity.getByTestId("subagent-tool-step-status")).toHaveText([/Done$/, /Done$/])
	}
	await pace()

	await sidebar.getByRole("tab", { name: "Work", exact: true }).click()
	await expect(sidebar.getByText(PARENT_RESULT, { exact: false }).last()).toBeVisible({ timeout: 30_000 })
	await pace(1_000)
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
