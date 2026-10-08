import { describe, expect, it } from "vitest"
import { formatTaskPanelTitle, normalizeTaskPanelTitle, resolveTaskPanelTitle } from "../TaskPanelTitle"

const checklist = (...items: Array<"completed" | "pending">): string =>
	items.map((item, index) => `- [${item === "completed" ? "x" : " "}] Task ${index + 1}`).join("\n")

describe("formatTaskPanelTitle", () => {
	it("truncates a Chinese task title to ten Unicode characters before appending progress", () => {
		expect(
			formatTaskPanelTitle({
				taskTitle: "改进编辑面板任务标题显示逻辑",
				checklist: checklist("pending", "pending", "pending", "pending", "pending"),
			}),
		).toBe("改进编辑面板任务标题 (0/5)")
	})

	it("keeps the existing sixteen-character limit for non-Chinese titles", () => {
		expect(formatTaskPanelTitle({ taskTitle: "This is a very long task title" })).toBe("This is a very l")
	})

	it("shows completed items rather than the first unfinished item position", () => {
		expect(
			formatTaskPanelTitle({
				taskTitle: "任务标题",
				checklist: checklist("completed", "completed", "pending", "pending"),
			}),
		).toBe("任务标题 (2/4)")
	})

	it("matches the TODO completion indicator when five of seven items are complete", () => {
		expect(
			formatTaskPanelTitle({
				taskTitle: "任务标题",
				checklist: checklist("completed", "completed", "completed", "completed", "completed", "pending", "pending"),
			}),
		).toBe("任务标题 (5/7)")
	})

	it("shows the total completed count when every item is complete", () => {
		expect(
			formatTaskPanelTitle({
				taskTitle: "任务标题",
				checklist: checklist("completed", "completed", "completed"),
			}),
		).toBe("任务标题 (3/3)")
	})

	it("omits progress when the checklist has no task items", () => {
		expect(formatTaskPanelTitle({ taskTitle: "任务标题", checklist: "# Empty" })).toBe("任务标题")
	})

	it("preserves the progress suffix when a panel entry point normalizes the title", () => {
		expect(normalizeTaskPanelTitle("改进编辑面板任务标题显示逻辑 (3/5)")).toBe("改进编辑面板任务标题 (3/5)")
	})

	it("removes an empty progress suffix from a panel entry point", () => {
		expect(normalizeTaskPanelTitle("任务标题 (0/0)")).toBe("任务标题")
	})

	// Regression: a panel entry point must not drop the progress suffix by
	// re-normalizing an already formatted title (previously the raw task text
	// was re-sent after init and overwrote "修一下api con (1/5)").
	it("keeps the progress suffix stable when re-normalizing a formatted title", () => {
		const formatted = formatTaskPanelTitle({
			taskTitle: "修一下api config中的 profile 列表",
			checklist: checklist("completed", "pending", "pending", "pending", "pending"),
		})

		expect(formatted).toBe("修一下api con (1/5)")
		expect(normalizeTaskPanelTitle(formatted)).toBe(formatted)
	})
})

describe("resolveTaskPanelTitle", () => {
	// Regression: a background-started task synced its title before the task
	// row existed and kept the "Dline" fallback tab title.
	it("uses the initial task text before the task row exists", () => {
		expect(resolveTaskPanelTitle({ taskRow: undefined, initialTask: "E2E_PANEL_ONE_GROUP task" })).toBe("E2E_PANEL_ONE_GR")
	})

	it("prefers the persisted task row over the initial and history text", () => {
		expect(resolveTaskPanelTitle({ taskRow: "Row title", initialTask: "Initial", historyTask: "History" })).toBe("Row title")
	})

	it("skips blank sources and falls back to the history task text", () => {
		expect(resolveTaskPanelTitle({ taskRow: "  ", initialTask: "", historyTask: "History title" })).toBe("History title")
	})

	it("appends checklist progress and keeps the fallback title without any text", () => {
		expect(resolveTaskPanelTitle({ checklist: checklist("completed", "pending") })).toBe("Dline (1/2)")
	})
})
