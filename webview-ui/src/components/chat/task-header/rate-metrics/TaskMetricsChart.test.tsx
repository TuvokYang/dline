import { type TaskRateMetricPoint, TaskRateRpmBasis, TaskRateUsageQuality } from "@shared/proto/dline/task"
import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { createSmoothPath, TaskMetricsChart } from "./TaskMetricsChart"
import type { TaskMetricsChartPoint } from "./TaskMetricsChartModel"

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
        tokensPerMinute: 4_500,
        requestsPerMinute: 30,
        ...overrides,
    }
}

describe("TaskMetricsChart", () => {
    it("renders accessible toggle legends and keeps Total Tokens disabled by default", async () => {
        const user = userEvent.setup()
        render(<TaskMetricsChart chartType="line" points={[point(0), point(60_000)]} view="tokenCache" />)

        const expected = ["Input", "Output", "Cache Write", "Cache Read", "Cache Hit Rate", "Total Tokens"]
        const legend = within(screen.getByRole("group", { name: "Chart series" }))
        expect(legend.getAllByRole("button").map((button) => button.textContent)).toEqual(expected)
        for (const label of expected.slice(0, -1))
            expect(legend.getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "true")
        const total = legend.getByRole("button", { name: "Total Tokens" })
        expect(total).toHaveAttribute("aria-pressed", "false")
        expect(screen.queryByTestId("task-metrics-line-totalTokens-0")).not.toBeInTheDocument()

        await user.click(total)
        expect(total).toHaveAttribute("aria-pressed", "true")
        expect(screen.getByTestId("task-metrics-line-totalTokens-0")).toBeInTheDocument()

        const input = legend.getByRole("button", { name: "Input" })
        input.focus()
        await user.keyboard("{Enter}")
        expect(input).toHaveAttribute("aria-pressed", "false")
        expect(screen.queryByTestId("task-metrics-line-input-0")).not.toBeInTheDocument()
    })

    it("omits an all-zero series without removing explicit zeros from an active series", () => {
        render(
            <TaskMetricsChart
                chartType="line"
                points={[
                    point(0, { cacheWriteTokens: 0, cacheReadTokens: 0 }),
                    point(60_000, { cacheWriteTokens: 0, cacheReadTokens: 5 }),
                ]}
                view="tokenCache"
            />,
        )
        const legend = within(screen.getByRole("group", { name: "Chart series" }))
        expect(legend.queryByRole("button", { name: "Cache Write" })).not.toBeInTheDocument()
        expect(legend.getByRole("button", { name: "Cache Read" })).toBeInTheDocument()
        expect(screen.getByTestId("task-metrics-point-cacheRead-0")).toHaveAttribute("data-value", "0")
    })

    it("renders independently toggleable TPM and execution-duration RPM legends", async () => {
        const user = userEvent.setup()
        const rendered = render(<TaskMetricsChart chartType="line" points={[point(0)]} view="rates" />)
        const legend = within(screen.getByRole("group", { name: "Chart series" }))
        const tpm = legend.getByRole("button", { name: "TPM" })
        const rpm = legend.getByRole("button", { name: "RPM" })
        expect(tpm).toHaveAttribute("aria-pressed", "true")
        expect(rpm).toHaveAttribute("aria-pressed", "true")
        expect(screen.getByTestId("task-metrics-line-tpm-0")).toBeInTheDocument()
        expect(screen.getByTestId("task-metrics-line-rpm-0")).toBeInTheDocument()

        await user.click(rpm)
        expect(rpm).toHaveAttribute("aria-pressed", "false")
        expect(screen.queryByTestId("task-metrics-line-rpm-0")).not.toBeInTheDocument()

        rendered.rerender(
            <TaskMetricsChart
                chartType="line"
                points={[point(0, { rpmBasis: TaskRateRpmBasis.TASK_RATE_RPM_BASIS_PROVIDER_DURATION })]}
                view="rates"
            />,
        )
        expect(screen.queryByTestId("task-metrics-line-rpm-0")).not.toBeInTheDocument()
        expect(screen.getByTestId("task-metrics-line-tpm-0")).toBeInTheDocument()
    })

    it("labels TPM on the left axis and RPM on the right axis with their own ticks", () => {
        const rendered = render(<TaskMetricsChart chartType="line" points={[point(0), point(60_000)]} view="rates" />)
        expect(screen.getByTestId("task-metrics-left-axis-title")).toHaveTextContent("TPM")
        expect(screen.getByTestId("task-metrics-right-axis-title")).toHaveTextContent("RPM")
        expect(screen.queryByTestId("task-metrics-percentage-tick")).not.toBeInTheDocument()
        expect(screen.getAllByTestId("task-metrics-primary-tick").at(-1)).toHaveTextContent("6.0K")
        expect(screen.getAllByTestId("task-metrics-secondary-tick").at(-1)).toHaveTextContent("30")

        rendered.rerender(<TaskMetricsChart chartType="line" points={[point(0), point(60_000)]} view="tokenCache" />)
        expect(screen.getByTestId("task-metrics-left-axis-title")).toHaveTextContent("Tokens")
        expect(screen.getByTestId("task-metrics-right-axis-title")).toHaveTextContent("Cache Hit Rate")
        expect(screen.queryByTestId("task-metrics-secondary-tick")).not.toBeInTheDocument()
    })

    it("renders one continuous monotone line with unavailable values at zero and supports Bar locally", () => {
        const points = [
            point(0, { inputTokens: 10 }),
            point(60_000, { inputTokens: undefined, usageAvailable: false }),
            point(120_000, { inputTokens: 20 }),
            point(180_000, { inputTokens: 15 }),
        ]
        const rendered = render(<TaskMetricsChart chartType="line" points={points} view="tokenCache" />)
        const paths = screen.getAllByTestId(/^task-metrics-line-input-/)
        expect(paths).toHaveLength(1)
        expect(paths[0]?.getAttribute("d")).not.toMatch(/NaN|Infinity/)
        expect(screen.getByTestId("task-metrics-point-input-1")).toHaveAttribute("data-value", "0")

        rendered.rerender(<TaskMetricsChart chartType="bar" points={points} view="tokenCache" />)
        expect(screen.getByRole("img", { name: "Task metrics history chart" })).toHaveAttribute("data-chart-type", "bar")
        expect(screen.getAllByTestId(/^task-metrics-bar-input-/)).toHaveLength(4)
    })

    it("shows a floating tooltip only when the pointer reaches a concrete line point", () => {
        render(<TaskMetricsChart chartType="line" degraded={true} points={[point(0)]} view="tokenCache" />)
        const chart = screen.getByRole("img", { name: "Task metrics history chart" })
        fireEvent.pointerEnter(chart)
        expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
        expect(screen.queryByTestId(/^task-metrics-hit-area-/)).not.toBeInTheDocument()

        const inputPoint = screen.getByTestId("task-metrics-point-input-0")
        fireEvent.pointerEnter(inputPoint)
        const tooltip = screen.getByRole("tooltip")
        expect(tooltip).toHaveAttribute("data-anchor-bucket-start-ms", "0")
        expect(tooltip).toHaveStyle({ position: "fixed" })
        expect(tooltip).not.toHaveClass("inset-x-2", "bottom-2")
        expect(tooltip).toHaveTextContent("Cache Write: 10")
        expect(tooltip).toHaveTextContent("Cache Hit Rate: 4.3%")
        expect(tooltip).toHaveTextContent("History: Degraded")
        expect(tooltip).not.toHaveTextContent(/Round|Request|API index|Provider attempt/i)

        fireEvent.pointerLeave(inputPoint)
        expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
    })

    it("anchors the tooltip to a concrete bar without restoring full-column hover", () => {
        render(<TaskMetricsChart chartType="bar" points={[point(0)]} view="tokenCache" />)
        const bar = screen.getByTestId("task-metrics-bar-input-0")

        fireEvent.pointerEnter(bar)
        expect(screen.getByRole("tooltip")).toHaveAttribute("data-anchor-bucket-start-ms", "0")
        fireEvent.pointerLeave(bar)
        expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
    })

    it("keeps one point-positioned keyboard focus anchor per time bucket", () => {
        render(<TaskMetricsChart chartType="line" points={[point(0), point(60_000)]} view="tokenCache" />)
        const focusAnchors = screen.getAllByTestId(/^task-metrics-focus-anchor-/)
        expect(focusAnchors).toHaveLength(2)
        const firstFocusAnchor = focusAnchors[0]
        expect(firstFocusAnchor).toBeDefined()
        if (!firstFocusAnchor) throw new Error("Expected a focus anchor for the first time bucket")
        expect(firstFocusAnchor).toHaveAttribute("pointer-events", "none")

        fireEvent.focus(firstFocusAnchor)
        expect(screen.getByRole("tooltip")).toHaveAttribute("data-anchor-bucket-start-ms", "0")
        fireEvent.blur(firstFocusAnchor)
        expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
    })

    it("clears an active point tooltip when its series is disabled", async () => {
        const user = userEvent.setup()
        render(<TaskMetricsChart chartType="line" points={[point(0)]} view="tokenCache" />)
        fireEvent.pointerEnter(screen.getByTestId("task-metrics-point-input-0"))
        expect(screen.getByRole("tooltip")).toBeInTheDocument()

        await user.click(within(screen.getByRole("group", { name: "Chart series" })).getByRole("button", { name: "Input" }))
        expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
    })

    it("produces a finite monotone cubic path for three or more points", () => {
        const segment = [
            { x: 0, y: 10 },
            { x: 20, y: 5 },
            { x: 40, y: 8 },
        ].map((coordinates, index) => ({
            ...coordinates,
            point: point(index * 60_000),
            value: index,
            barX: 0,
            barWidth: 1,
            barY: 0,
            barHeight: 1,
        })) satisfies TaskMetricsChartPoint[]
        const path = createSmoothPath(segment)
        expect(path).toContain("C")
        expect(path).not.toMatch(/NaN|Infinity/)
    })
})
