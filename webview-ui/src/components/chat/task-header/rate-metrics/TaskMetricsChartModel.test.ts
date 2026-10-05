import { type TaskRateMetricPoint, TaskRateRpmBasis, TaskRateUsageQuality } from "@shared/proto/dline/task"
import { describe, expect, it } from "vitest"
import {
	createDefaultEnabledTaskMetricsSeries,
	createTaskMetricsChartLayout,
	getTaskMetricsAxisTitles,
	getTaskMetricsSeries,
	getVisibleTaskMetricsSeries,
	readTaskMetricsSeriesValue,
	TASK_METRICS_SERIES,
} from "./TaskMetricsChartModel"

function point(startMs: number, overrides: Partial<TaskRateMetricPoint> = {}): TaskRateMetricPoint {
	return {
		bucketStartMs: startMs,
		bucketEndMs: startMs + 60_000,
		provisional: false,
		cacheUsageAvailable: true,
		usageAvailable: true,
		providerRoundCount: 1,
		completedRoundCount: 1,
		failedRoundCount: 0,
		cancelledRoundCount: 0,
		abortedRoundCount: 0,
		executionCount: 1,
		completedExecutionCount: 1,
		failedExecutionCount: 0,
		cancelledExecutionCount: 0,
		abortedExecutionCount: 0,
		rpmBasis: TaskRateRpmBasis.TASK_RATE_RPM_BASIS_EXECUTION_DURATION,
		usageQuality: TaskRateUsageQuality.TASK_RATE_USAGE_QUALITY_EXACT,
		inputTokens: 100,
		outputTokens: 20,
		cacheWriteTokens: 10,
		cacheReadTokens: 5,
		cacheHitRate: 5 / 115,
		thoughtsTokens: 5,
		tokenCount: 140,
		tokensPerMinute: 4_500,
		requestsPerMinute: 30,
		...overrides,
	}
}

describe("TaskMetricsChartModel", () => {
	it("defines two compact views and keeps Total Tokens disabled by default", () => {
		expect(getTaskMetricsSeries("tokenCache").map(({ label }) => label)).toEqual([
			"Input",
			"Output",
			"Cache Write",
			"Cache Read",
			"Cache Hit Rate",
			"Total Tokens",
		])
		expect(getTaskMetricsSeries("rates").map(({ label }) => label)).toEqual(["TPM", "RPM"])
		expect(TASK_METRICS_SERIES.some(({ label }) => label.includes("Creation"))).toBe(false)
		const enabled = createDefaultEnabledTaskMetricsSeries()
		expect(enabled.has("totalTokens")).toBe(false)
		expect(enabled.has("input")).toBe(true)
		expect(enabled.has("rpm")).toBe(true)
	})

	it("hides all-zero series while drawing missing values as zero in one continuous segment", () => {
		const visible = getVisibleTaskMetricsSeries(
			[point(0, { cacheWriteTokens: 0, cacheHitRate: 0 }), point(60_000, { cacheWriteTokens: 0, cacheHitRate: 0.5 })],
			"tokenCache",
		)
		expect(visible.map(({ key }) => key)).not.toContain("cacheWrite")
		expect(visible.map(({ key }) => key)).toContain("cacheHit")

		const enabled = new Set(["input", "cacheHit"] as const)
		const layout = createTaskMetricsChartLayout(
			[
				point(0, { inputTokens: 0, cacheHitRate: 0 }),
				point(60_000, { inputTokens: undefined, cacheHitRate: undefined, cacheUsageAvailable: false }),
				point(120_000, { inputTokens: 50, cacheHitRate: 0.5 }),
			],
			"tokenCache",
			enabled,
		)
		const input = layout.series.find(({ descriptor }) => descriptor.key === "input")
		const cacheHit = layout.series.find(({ descriptor }) => descriptor.key === "cacheHit")
		expect(input?.points.map(({ value }) => value)).toEqual([0, 0, 50])
		expect(input?.segments.map((segment) => segment.length)).toEqual([3])
		expect(cacheHit?.points.map(({ value }) => value)).toEqual([0, 0, 0.5])
		expect(cacheHit?.segments.map((segment) => segment.length)).toEqual([3])
		expect(input?.points[0]?.x).toBe(layout.plotLeft)
		expect(input?.points.at(-1)?.x).toBe(layout.plotRight)
		expect(layout.percentageTicks.map(({ label }) => label)).toEqual(["0%", "20%", "40%", "60%", "80%", "100%"])
	})

	it("anchors each keyboard focus target to a rendered point instead of a full-height chart column", () => {
		const layout = createTaskMetricsChartLayout([point(0), point(60_000)], "tokenCache", new Set(["input"] as const))
		const input = layout.series.find(({ descriptor }) => descriptor.key === "input")

		expect(layout.focusAnchors).toHaveLength(2)
		expect(layout.focusAnchors.map(({ x, y }) => ({ x, y }))).toEqual(input?.points.map(({ x, y }) => ({ x, y })))
		for (const anchor of layout.focusAnchors) {
			expect(Number.isFinite(anchor.x)).toBe(true)
			expect(Number.isFinite(anchor.y)).toBe(true)
			expect(anchor.y).toBeGreaterThanOrEqual(layout.plotTop)
			expect(anchor.y).toBeLessThanOrEqual(layout.plotBottom)
		}
	})

	it("shows RPM only for complete-execution basis and derives Total Tokens from visible token facts", () => {
		expect(readTaskMetricsSeriesValue(point(0), "rpm")).toBe(30)
		expect(
			readTaskMetricsSeriesValue(point(0, { rpmBasis: TaskRateRpmBasis.TASK_RATE_RPM_BASIS_PROVIDER_DURATION }), "rpm"),
		).toBeUndefined()
		// Thoughts (5) are a share of output (20), so the total is 100 + 20 + 10 + 5.
		expect(readTaskMetricsSeriesValue(point(0), "totalTokens")).toBe(135)
		expect(readTaskMetricsSeriesValue(point(0, { tokenCount: undefined }), "totalTokens")).toBe(135)
	})

	it("never reports Total Tokens below a rendered token part when the active-second estimate lags", () => {
		expect(readTaskMetricsSeriesValue(point(0, { tokenCount: 3 }), "totalTokens")).toBe(135)
		expect(readTaskMetricsSeriesValue(point(0, { tokenCount: 900 }), "totalTokens")).toBe(135)
		expect(
			readTaskMetricsSeriesValue(
				point(0, {
					tokenCount: 42,
					inputTokens: undefined,
					outputTokens: undefined,
					thoughtsTokens: undefined,
					cacheWriteTokens: undefined,
					cacheReadTokens: undefined,
				}),
				"totalTokens",
			),
		).toBe(42)
	})

	it("scales TPM on the left axis and RPM on the right axis so neither rate flattens the other", () => {
		expect(getTaskMetricsAxisTitles("rates")).toMatchObject({
			left: { label: "TPM" },
			right: { label: "RPM" },
		})
		expect(getTaskMetricsAxisTitles("tokenCache")).toMatchObject({
			left: { label: "Tokens" },
			right: { label: "Cache Hit Rate" },
		})

		const layout = createTaskMetricsChartLayout([point(0), point(60_000)], "rates", new Set(["tpm", "rpm"] as const))
		expect(layout.primaryAxisMax).toBe(6_000)
		expect(layout.secondaryAxisMax).toBe(30)
		expect(layout.primaryTicks.at(-1)?.value).toBe(layout.primaryAxisMax)
		expect(layout.secondaryTicks.at(-1)?.value).toBe(layout.secondaryAxisMax)
		expect(layout.percentageTicks).toEqual([])

		const plotHeight = layout.plotBottom - layout.plotTop
		const rpm = layout.series.find(({ descriptor }) => descriptor.key === "rpm")
		const tpm = layout.series.find(({ descriptor }) => descriptor.key === "tpm")
		// RPM uses its own axis, so 30 reaches full height instead of collapsing onto the TPM scale.
		expect(rpm?.points[0]?.y).toBeCloseTo(layout.plotTop, 6)
		expect(rpm?.points[0]?.y).toBeLessThan(layout.plotBottom - plotHeight / 2)
		expect(tpm?.points[0]?.y).toBeCloseTo(layout.plotBottom - (4_500 / 6_000) * plotHeight, 6)
	})
})
