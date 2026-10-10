import { TaskRateTokenQuality } from "@shared/proto/dline/task"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TaskRateMetricsDialog } from "./TaskRateMetricsDialog"

const mocks = vi.hoisted(() => ({
    refresh: vi.fn(),
    useTaskRateMetrics: vi.fn(),
}))

vi.mock("./useTaskRateMetrics", () => ({
    useTaskRateMetrics: mocks.useTaskRateMetrics,
}))

function renderDialog() {
    return render(<TaskRateMetricsDialog onOpenChange={vi.fn()} open={true} taskId="task-1" />)
}

beforeEach(() => {
    mocks.refresh.mockReset()
    mocks.useTaskRateMetrics.mockReset().mockReturnValue({
        data: { points: [], degraded: false, truncated: false },
        loading: false,
        refresh: mocks.refresh,
    })
})

describe("TaskRateMetricsDialog", () => {
    it("defaults to Hour and exposes only the two compact views", () => {
        renderDialog()
        expect(screen.getByRole("dialog", { name: "API Rate History" })).toBeInTheDocument()
        expect(mocks.useTaskRateMetrics).toHaveBeenLastCalledWith({ enabled: true, resolution: "hour", taskId: "task-1" })
        const resolution = screen.getByRole("combobox", { name: "History resolution" })
        expect(resolution).toHaveValue("hour")
        expect(screen.queryByRole("option", { name: "Round" })).not.toBeInTheDocument()
        expect(screen.getByRole("radio", { name: "Token/Cache" })).toHaveAttribute("aria-checked", "true")
        expect(screen.getByRole("radio", { name: "TPM/RPM" })).toHaveAttribute("aria-checked", "false")
        expect(screen.queryByRole("radio", { name: "Usage & Cache" })).not.toBeInTheDocument()
        expect(screen.queryByRole("radio", { name: "Total Tokens" })).not.toBeInTheDocument()
        expect(screen.getByRole("radiogroup", { name: "Chart type" })).toBeInTheDocument()
        expect(screen.getByRole("radio", { name: "Line" })).toHaveAttribute("aria-checked", "true")

        fireEvent.change(resolution, { target: { value: "minute" } })
        expect(mocks.useTaskRateMetrics).toHaveBeenLastCalledWith({ enabled: true, resolution: "minute", taskId: "task-1" })

        fireEvent.change(resolution, { target: { value: "day" } })
        expect(mocks.useTaskRateMetrics).toHaveBeenLastCalledWith({ enabled: true, resolution: "day", taskId: "task-1" })
    })

    it("keeps compact controls aligned while allowing a narrow toolbar to wrap", () => {
        renderDialog()
        const toolbar = screen.getByRole("toolbar", { name: "Task metrics controls" })
        expect(toolbar).toHaveClass("flex-wrap", "gap-x-2", "gap-y-1", "overflow-visible", "whitespace-nowrap")
        const controls = within(toolbar)
        const resolution = controls.getByRole("combobox", { name: "History resolution" })
        expect(resolution).toHaveValue("hour")
        expect(resolution).toHaveClass("h-5", "px-1", "text-center", "text-[11px]", "leading-normal", "[text-align-last:center]")
        expect(controls.getByRole("radiogroup", { name: "History view" })).toHaveClass("gap-1")
        expect(controls.getByRole("radiogroup", { name: "Chart type" })).toHaveClass("gap-1")
        expect(controls.getByRole("radio", { name: "Token/Cache" })).toHaveClass("px-1")
        expect(controls.getAllByRole("option").map((option) => option.textContent)).toEqual(["Minute", "Hour", "Day"])
        expect(controls.getAllByRole("radio")).toHaveLength(4)
        for (const name of ["Token/Cache", "TPM/RPM", "Bar", "Line"] as const) {
            expect(controls.getByRole("radio", { name })).toBeInTheDocument()
        }
        fireEvent.click(controls.getByRole("button", { name: "Refresh" }))
        expect(mocks.refresh).toHaveBeenCalledOnce()
    })

    it("renders loading, empty and retryable error states", () => {
        mocks.useTaskRateMetrics.mockReturnValue({ loading: true, refresh: mocks.refresh })
        const rendered = renderDialog()
        expect(screen.getByRole("status")).toHaveTextContent("Loading API rate history")

        mocks.useTaskRateMetrics.mockReturnValue({
            data: { points: [], degraded: false, truncated: false },
            loading: false,
            refresh: mocks.refresh,
        })
        rendered.rerender(<TaskRateMetricsDialog onOpenChange={vi.fn()} open={true} taskId="task-1" />)
        expect(screen.getByText("No API activity in this range.")).toBeInTheDocument()

        mocks.useTaskRateMetrics.mockReturnValue({ error: "history unavailable", loading: false, refresh: mocks.refresh })
        rendered.rerender(<TaskRateMetricsDialog onOpenChange={vi.fn()} open={true} taskId="task-1" />)
        expect(screen.getByRole("alert")).toHaveTextContent("history unavailable")
        fireEvent.click(screen.getByRole("button", { name: "Retry" }))
        expect(mocks.refresh).toHaveBeenCalledOnce()
    })

    it("shows only actionable degraded and active-point truncation notices alongside the chart", () => {
        mocks.useTaskRateMetrics.mockReturnValue({
            data: {
                points: [
                    {
                        bucketStartMs: Date.parse("2026-08-10T12:00:00.000Z"),
                        bucketEndMs: Date.parse("2026-08-10T12:01:00.000Z"),
                        activeSeconds: 2,
                        requestCount: 1,
                        tokenCount: 200,
                        requestsPerMinute: 30,
                        tokensPerMinute: 6_000,
                        tokenQuality: TaskRateTokenQuality.TASK_RATE_TOKEN_QUALITY_MIXED,
                        provisional: false,
                    },
                ],
                degraded: true,
                truncated: true,
                retentionStartMs: Date.parse("2026-08-01T00:00:00.000Z"),
            },
            loading: false,
            refresh: mocks.refresh,
        })
        renderDialog()

        expect(screen.getByText("History may be incomplete.")).toBeInTheDocument()
        expect(screen.getByText("Showing the most recent points.")).toBeInTheDocument()
        expect(screen.queryByText(/History retained from/)).not.toBeInTheDocument()
        expect(screen.getByTestId("task-metrics-chart")).toBeInTheDocument()
        const chart = screen.getByRole("img", { name: "Task metrics history chart" })
        expect(chart).toHaveAttribute("data-view", "tokenCache")
        expect(chart).toHaveAttribute("data-chart-type", "line")
        expect(screen.getByRole("radiogroup", { name: "Chart type" })).toBeInTheDocument()

        fireEvent.click(screen.getByRole("radio", { name: "TPM/RPM" }))
        expect(screen.getByRole("radio", { name: "TPM/RPM" })).toHaveAttribute("aria-checked", "true")
        expect(chart).toHaveAttribute("data-view", "rates")
        expect(chart).toHaveAttribute("data-chart-type", "line")

        fireEvent.click(screen.getByRole("radio", { name: "Bar" }))
        expect(screen.getByRole("radio", { name: "Bar" })).toHaveAttribute("aria-checked", "true")
        expect(chart).toHaveAttribute("data-chart-type", "bar")

        fireEvent.click(screen.getByRole("radio", { name: "Token/Cache" }))
        expect(screen.getByRole("radio", { name: "Token/Cache" })).toHaveAttribute("aria-checked", "true")
        expect(chart).toHaveAttribute("data-view", "tokenCache")
    })
})
