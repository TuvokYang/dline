import { type TaskRateMetricPoint, TaskRateRpmBasis } from "@shared/proto/dline/task"
import { formatTokenMetric } from "../util"

export type TaskMetricsView = "tokenCache" | "rates"
export type TaskMetricsChartType = "bar" | "line"
export type TaskMetricsSeriesKey = "input" | "output" | "cacheWrite" | "cacheRead" | "cacheHit" | "totalTokens" | "tpm" | "rpm"
export type TaskMetricsAxis = "primary" | "secondary" | "percentage"

export interface TaskMetricsAxisTitle {
	readonly label: string
	readonly color?: string
}

export interface TaskMetricsAxisTitles {
	readonly left: TaskMetricsAxisTitle
	readonly right: TaskMetricsAxisTitle
}

export interface TaskMetricsSeriesDescriptor {
	readonly key: TaskMetricsSeriesKey
	readonly view: TaskMetricsView
	readonly label: string
	readonly axis: TaskMetricsAxis
	readonly color: string
	readonly dashed: boolean
	readonly defaultEnabled: boolean
}

export interface TaskMetricsChartDimensions {
	readonly width: number
	readonly height: number
	readonly paddingLeft: number
	readonly paddingRight: number
	readonly paddingTop: number
	readonly paddingBottom: number
}

export interface TaskMetricsChartTick {
	readonly value: number
	readonly y: number
	readonly label: string
}

export interface TaskMetricsChartPoint {
	readonly point: TaskRateMetricPoint
	readonly value: number
	readonly x: number
	readonly y: number
	readonly barX: number
	readonly barWidth: number
	readonly barY: number
	readonly barHeight: number
}

export interface TaskMetricsChartSeries {
	readonly descriptor: TaskMetricsSeriesDescriptor
	readonly points: TaskMetricsChartPoint[]
	readonly segments: TaskMetricsChartPoint[][]
}

export interface TaskMetricsFocusAnchor {
	readonly point: TaskRateMetricPoint
	readonly pointIndex: number
	readonly x: number
	readonly y: number
}

export interface TaskMetricsChartLayout {
	readonly dimensions: TaskMetricsChartDimensions
	readonly plotLeft: number
	readonly plotRight: number
	readonly plotTop: number
	readonly plotBottom: number
	readonly primaryAxisMax: number
	readonly secondaryAxisMax: number
	readonly primaryTicks: TaskMetricsChartTick[]
	readonly secondaryTicks: TaskMetricsChartTick[]
	readonly percentageTicks: TaskMetricsChartTick[]
	readonly series: TaskMetricsChartSeries[]
	readonly focusAnchors: TaskMetricsFocusAnchor[]
}

export const DEFAULT_TASK_METRICS_CHART_DIMENSIONS: TaskMetricsChartDimensions = {
	width: 720,
	height: 320,
	paddingLeft: 62,
	paddingRight: 54,
	paddingTop: 28,
	paddingBottom: 38,
}

export const TASK_METRICS_SERIES: readonly TaskMetricsSeriesDescriptor[] = [
	{
		key: "input",
		view: "tokenCache",
		label: "Input",
		axis: "primary",
		color: "var(--vscode-charts-blue, #58a6ff)",
		dashed: false,
		defaultEnabled: true,
	},
	{
		key: "output",
		view: "tokenCache",
		label: "Output",
		axis: "primary",
		color: "var(--vscode-charts-green, #3fb950)",
		dashed: false,
		defaultEnabled: true,
	},
	{
		key: "cacheWrite",
		view: "tokenCache",
		label: "Cache Write",
		axis: "primary",
		color: "var(--vscode-charts-orange, #d18616)",
		dashed: false,
		defaultEnabled: true,
	},
	{
		key: "cacheRead",
		view: "tokenCache",
		label: "Cache Read",
		axis: "primary",
		color: "var(--vscode-charts-cyan, #39c5cf)",
		dashed: false,
		defaultEnabled: true,
	},
	{
		key: "cacheHit",
		view: "tokenCache",
		label: "Cache Hit Rate",
		axis: "percentage",
		color: "var(--vscode-charts-purple, #bc8cff)",
		dashed: true,
		defaultEnabled: true,
	},
	{
		key: "totalTokens",
		view: "tokenCache",
		label: "Total Tokens",
		axis: "primary",
		color: "var(--vscode-charts-yellow, #e3b341)",
		dashed: true,
		defaultEnabled: false,
	},
	{
		key: "tpm",
		view: "rates",
		label: "TPM",
		axis: "primary",
		color: "var(--vscode-charts-blue, #58a6ff)",
		dashed: false,
		defaultEnabled: true,
	},
	{
		key: "rpm",
		view: "rates",
		label: "RPM",
		axis: "secondary",
		color: "var(--vscode-charts-orange, #d18616)",
		dashed: false,
		defaultEnabled: true,
	},
] as const

const PERCENTAGE_TICK_VALUES = [0, 0.2, 0.4, 0.6, 0.8, 1] as const
const MIN_BAR_WIDTH = 2
const MAX_BAR_GROUP_WIDTH = 48

export function getTaskMetricsSeries(view: TaskMetricsView): readonly TaskMetricsSeriesDescriptor[] {
	return TASK_METRICS_SERIES.filter((descriptor) => descriptor.view === view)
}

/** Describe the left and right axis of a view so each rate keeps its own readable scale. */
export function getTaskMetricsAxisTitles(view: TaskMetricsView): TaskMetricsAxisTitles {
	if (view === "rates") {
		return {
			left: { label: "TPM", color: getSeriesColor("tpm") },
			right: { label: "RPM", color: getSeriesColor("rpm") },
		}
	}
	return {
		left: { label: "Tokens" },
		right: { label: "Cache Hit Rate", color: getSeriesColor("cacheHit") },
	}
}

export function getVisibleTaskMetricsSeries(
	points: readonly TaskRateMetricPoint[],
	view: TaskMetricsView,
): readonly TaskMetricsSeriesDescriptor[] {
	return getTaskMetricsSeries(view).filter(({ key }) =>
		points.some((point) => {
			const value = readTaskMetricsSeriesValue(point, key)
			return value !== undefined && Number.isFinite(value) && value !== 0
		}),
	)
}

export function createDefaultEnabledTaskMetricsSeries(): Set<TaskMetricsSeriesKey> {
	return new Set(TASK_METRICS_SERIES.filter(({ defaultEnabled }) => defaultEnabled).map(({ key }) => key))
}

/** Build dual-axis geometry for the selected compact metrics view. */
export function createTaskMetricsChartLayout(
	points: readonly TaskRateMetricPoint[],
	view: TaskMetricsView,
	enabledSeries: ReadonlySet<TaskMetricsSeriesKey>,
	dimensions: TaskMetricsChartDimensions = DEFAULT_TASK_METRICS_CHART_DIMENSIONS,
): TaskMetricsChartLayout {
	const sortedPoints = [...points].sort((left, right) => left.bucketStartMs - right.bucketStartMs)
	const descriptors = getVisibleTaskMetricsSeries(points, view).filter(({ key }) => enabledSeries.has(key))
	const plotLeft = dimensions.paddingLeft
	const plotRight = dimensions.width - dimensions.paddingRight
	const plotTop = dimensions.paddingTop
	const plotBottom = dimensions.height - dimensions.paddingBottom
	const plotWidth = Math.max(1, plotRight - plotLeft)
	const plotHeight = Math.max(1, plotBottom - plotTop)
	const firstPoint = sortedPoints[0]
	const lastPoint = sortedPoints.at(-1)
	const firstMidpointMs = firstPoint ? getBucketMidpointMs(firstPoint) : 0
	const lastMidpointMs = lastPoint ? getBucketMidpointMs(lastPoint) : firstMidpointMs
	const durationMs = Math.max(1, lastMidpointMs - firstMidpointMs)
	const primaryAxisMax = getAxisMaxForAxis(sortedPoints, descriptors, "primary")
	const secondaryAxisMax = getAxisMaxForAxis(sortedPoints, descriptors, "secondary")
	const primaryTicks = descriptors.some(({ axis }) => axis === "primary")
		? createChartTicks(primaryAxisMax).map((value) => ({
				value,
				y: plotBottom - (value / primaryAxisMax) * plotHeight,
				label: formatTokenMetric(value),
			}))
		: []
	const secondaryTicks = descriptors.some(({ axis }) => axis === "secondary")
		? createChartTicks(secondaryAxisMax).map((value) => ({
				value,
				y: plotBottom - (value / secondaryAxisMax) * plotHeight,
				label: formatTokenMetric(value),
			}))
		: []
	const percentageTicks = descriptors.some(({ axis }) => axis === "percentage")
		? PERCENTAGE_TICK_VALUES.map((value) => ({
				value,
				y: plotBottom - value * plotHeight,
				label: `${Math.round(value * 100)}%`,
			}))
		: []
	const xForPoint = (point: TaskRateMetricPoint): number => {
		if (sortedPoints.length <= 1) return plotLeft + plotWidth / 2
		return plotLeft + ((getBucketMidpointMs(point) - firstMidpointMs) / durationMs) * plotWidth
	}

	const series = descriptors.map((descriptor, index) =>
		createSeries(
			sortedPoints,
			descriptor,
			xForPoint,
			plotLeft,
			plotRight,
			plotTop,
			plotBottom,
			descriptor.axis === "secondary" ? secondaryAxisMax : primaryAxisMax,
			index,
			descriptors.length,
			durationMs,
			plotWidth,
		),
	)
	const focusAnchors = sortedPoints.map((point, pointIndex) => ({
		point,
		pointIndex,
		x: xForPoint(point),
		y: series[0]?.points[pointIndex]?.y ?? plotBottom,
	}))

	return {
		dimensions,
		plotLeft,
		plotRight,
		plotTop,
		plotBottom,
		primaryAxisMax,
		secondaryAxisMax,
		primaryTicks,
		secondaryTicks,
		percentageTicks,
		series,
		focusAnchors,
	}
}

export function readTaskMetricsSeriesValue(point: TaskRateMetricPoint, key: TaskMetricsSeriesKey): number | undefined {
	switch (key) {
		case "input":
			return point.inputTokens
		case "output":
			return point.outputTokens
		case "cacheWrite":
			return point.cacheWriteTokens
		case "cacheRead":
			return point.cacheReadTokens
		case "cacheHit":
			return point.cacheUsageAvailable ? point.cacheHitRate : undefined
		case "totalTokens":
			return readTotalTokens(point)
		case "tpm":
			return point.tokensPerMinute
		case "rpm":
			return point.rpmBasis === TaskRateRpmBasis.TASK_RATE_RPM_BASIS_EXECUTION_DURATION
				? point.requestsPerMinute
				: undefined
	}
}

export function formatTaskMetricsSeriesValue(descriptor: TaskMetricsSeriesDescriptor, value: number): string {
	return descriptor.axis === "percentage" ? `${(value * 100).toFixed(1)}%` : value.toLocaleString()
}

/**
 * Sum the same token facts the chart renders so Total Tokens can never fall below one of its parts.
 * `tokenCount` is a provider-active-second estimate that may lag the canonical per-round usage.
 * Thoughts are a share of output, so they are not a separate term.
 */
function readTotalTokens(point: TaskRateMetricPoint): number | undefined {
	const values = [point.inputTokens, point.outputTokens, point.cacheWriteTokens, point.cacheReadTokens]
	if (values.every((value) => value === undefined)) return point.tokenCount
	return values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
}

function getSeriesColor(key: TaskMetricsSeriesKey): string | undefined {
	return TASK_METRICS_SERIES.find((descriptor) => descriptor.key === key)?.color
}

function getAxisMaxForAxis(
	points: readonly TaskRateMetricPoint[],
	descriptors: readonly TaskMetricsSeriesDescriptor[],
	axis: TaskMetricsAxis,
): number {
	const axisDescriptors = descriptors.filter((descriptor) => descriptor.axis === axis)
	const values = points.flatMap((point) =>
		axisDescriptors
			.map(({ key }) => readTaskMetricsSeriesValue(point, key))
			.filter((value): value is number => value !== undefined),
	)
	return getAxisMax(Math.max(0, ...values))
}

function createSeries(
	points: readonly TaskRateMetricPoint[],
	descriptor: TaskMetricsSeriesDescriptor,
	xForPoint: (point: TaskRateMetricPoint) => number,
	plotLeft: number,
	plotRight: number,
	plotTop: number,
	plotBottom: number,
	axisMax: number,
	seriesIndex: number,
	seriesCount: number,
	durationMs: number,
	plotWidth: number,
): TaskMetricsChartSeries {
	const plotHeight = Math.max(1, plotBottom - plotTop)
	const chartPoints: TaskMetricsChartPoint[] = []
	const segments: TaskMetricsChartPoint[][] = []
	let currentSegment: TaskMetricsChartPoint[] | undefined

	for (const point of points) {
		const value = readTaskMetricsSeriesValue(point, descriptor.key) ?? 0
		const normalized = descriptor.axis === "percentage" ? clamp(value, 0, 1) : value / axisMax
		const x = xForPoint(point)
		const bucketWidth = ((point.bucketEndMs - point.bucketStartMs) / durationMs) * plotWidth
		const groupWidth = clamp(bucketWidth * 0.72, MIN_BAR_WIDTH * seriesCount, MAX_BAR_GROUP_WIDTH)
		const slotWidth = groupWidth / Math.max(1, seriesCount)
		const barWidth = Math.max(MIN_BAR_WIDTH, slotWidth - 1)
		const groupX = clamp(x - groupWidth / 2, plotLeft, Math.max(plotLeft, plotRight - groupWidth))
		const y = plotBottom - normalized * plotHeight
		const chartPoint: TaskMetricsChartPoint = {
			point,
			value,
			x,
			y,
			barX: groupX + seriesIndex * slotWidth + (slotWidth - barWidth) / 2,
			barWidth,
			barY: y,
			barHeight: Math.max(0, plotBottom - y),
		}
		chartPoints.push(chartPoint)

		const previousPoint = currentSegment?.at(-1)
		if (!currentSegment || !previousPoint || point.bucketStartMs > previousPoint.point.bucketEndMs) {
			currentSegment = [chartPoint]
			segments.push(currentSegment)
		} else {
			currentSegment.push(chartPoint)
		}
	}

	return { descriptor, points: chartPoints, segments }
}

function getBucketMidpointMs(point: TaskRateMetricPoint): number {
	return point.bucketStartMs + (point.bucketEndMs - point.bucketStartMs) / 2
}

function createChartTicks(maxValue: number, targetCount = 5): number[] {
	const safeMax = Math.max(0, maxValue)
	if (safeMax === 0) return [0]
	const rawStep = safeMax / Math.max(1, targetCount - 1)
	const magnitude = 10 ** Math.floor(Math.log10(rawStep))
	const normalized = rawStep / magnitude
	const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
	const step = factor * magnitude
	const tickMax = Math.ceil(safeMax / step) * step
	const ticks: number[] = []
	for (let value = 0; value <= tickMax + step * 0.000001; value += step) ticks.push(Number(value.toFixed(12)))
	return ticks
}

function getAxisMax(maxValue: number): number {
	if (maxValue <= 0) return 1
	return createChartTicks(maxValue).at(-1) ?? 1
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value))
}
