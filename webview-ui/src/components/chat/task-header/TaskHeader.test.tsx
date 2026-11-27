import { flatMeteredPricing } from "@shared/providers/pricing-shape"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import TaskHeader from "./TaskHeader"
import { formatTokenMetric } from "./util"

const mocks = vi.hoisted(() => ({
    expanded: false,
    setExpandTaskHeader: vi.fn(),
}))

vi.mock("@components/settings/providers/useApiProfiles", () => ({
    useApiProfiles: () => ({
        profiles: [],
        selectProfile: vi.fn(),
        selectProfiles: vi.fn(),
    }),
}))

vi.mock("@context/ExtensionStateContext", () => ({
    useExtensionState: () => ({
        apiConfiguration: {},
        checkpointManagerErrorMessage: undefined,
        currentTaskItem: { id: "task-1" },
        environment: "local",
        expandTaskHeader: mocks.expanded,
        focusChainSettings: { enabled: false },
        mode: "act",
        navigateToSettings: vi.fn(),
        promptCacheHealth: {
            status: "warming",
            sampleCount: 2,
            warmingRound: 2,
            warmingTarget: 3,
            nearContextWindow: false,
        },
        setExpandTaskHeader: mocks.setExpandTaskHeader,
        taskLockStatus: undefined,
    }),
}))

vi.mock("./rate-metrics/useTaskRateMetrics", () => ({
    useTaskRateMetrics: () => ({
        data: { points: [], degraded: false, truncated: false },
        loading: false,
        refresh: vi.fn(),
    }),
}))

const task = {
    type: "say" as const,
    say: "task" as const,
    text: "Inspect pricing display",
    ts: 1,
}

beforeEach(() => {
    mocks.expanded = false
    mocks.setExpandTaskHeader.mockReset()
})

const fullText = `First line\n${"Preserve every task detail. ".repeat(120)}\n<strong>literal text</strong>\nFinal task instruction`

function headerTree(language: "en" | "zh-CN", taskId?: string, text = fullText) {
    return (
        <UiLanguageProvider language={language}>
            <TaskHeader
                doesModelSupportPromptCache={false}
                onClose={vi.fn()}
                task={{ ...task, text }}
                taskId={taskId}
                tokensIn={0}
                tokensOut={0}
                totalCost={0}
            />
        </UiLanguageProvider>
    )
}

describe("TaskHeader task details", () => {
    it.each([false, true])("shows the exact task ID and full source text when expanded=%s", async (expanded) => {
        mocks.expanded = expanded
        render(headerTree("en", "canonical-task-123"))
        fireEvent.focus(screen.getByLabelText("Task details"))
        const details = await screen.findByRole("tooltip")
        const values = within(details).getAllByRole("definition")
        expect(values[0].textContent).toBe("canonical-task-123")
        expect(values[1].textContent).toBe(fullText)
        expect(details.querySelector("strong")).toBeNull()
        fireEvent.click(values[1])
        fireEvent.keyDown(values[1], { key: "Enter" })
        expect(mocks.setExpandTaskHeader).not.toHaveBeenCalled()
        fireEvent.click(screen.getByLabelText(expanded ? "Collapse task header" : "Expand task header"))
        expect(mocks.setExpandTaskHeader).toHaveBeenCalledWith(!expanded)
    })

    it("updates an open preview across language and task changes without replacing the surface", async () => {
        const view = render(headerTree("en", "canonical-task-123"))
        fireEvent.focus(screen.getByLabelText("Task details"))
        const details = await screen.findByRole("tooltip")
        expect(within(details).getByText("Task ID", { selector: "dt" })).toBeInTheDocument()
        expect(within(details).getByText("Full task text", { selector: "dt" })).toBeInTheDocument()

        view.rerender(headerTree("zh-CN", "canonical-task-123"))
        expect(screen.getByRole("tooltip")).toBe(details)
        expect(within(details).getByText("任务 ID", { selector: "dt" })).toBeInTheDocument()
        expect(within(details).getByText("完整任务文本", { selector: "dt" })).toBeInTheDocument()
        expect(within(details).getAllByRole("definition")[1].textContent).toBe(fullText)

        view.rerender(headerTree("en", "canonical-task-456", "The next task in full\nFinal line"))
        expect(screen.getByRole("tooltip")).toBe(details)
        const values = within(details).getAllByRole("definition")
        expect(values[0].textContent).toBe("canonical-task-456")
        expect(values[1].textContent).toBe("The next task in full\nFinal line")
        expect(mocks.setExpandTaskHeader).not.toHaveBeenCalled()
    })

    it("does not invent an ID from the message timestamp or another task's history item", async () => {
        render(headerTree("en"))
        fireEvent.focus(screen.getByLabelText("Task details"))
        const details = await screen.findByRole("tooltip")
        const values = within(details).getAllByRole("definition")
        expect(values[0].textContent).toBe("Not available")
        expect(values[1].textContent).toBe(fullText)
    })

    it("does not open details on pointer-click focus and dismisses an open preview on click", async () => {
        mocks.expanded = true
        render(headerTree("en", "canonical-task-123"))
        const trigger = screen.getByLabelText("Task details")

        fireEvent.pointerDown(trigger)
        fireEvent.focus(trigger)
        fireEvent.click(trigger)
        expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()

        fireEvent.blur(trigger)
        fireEvent.focus(trigger)
        await screen.findByRole("tooltip")

        fireEvent.pointerDown(trigger)
        expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
    })

    it("ignores passive pointerEnter without pointer movement so layout shifts do not cover header actions", () => {
        vi.useFakeTimers()
        try {
            mocks.expanded = true
            render(headerTree("en", "canonical-task-123"))
            const trigger = screen.getByLabelText("Task details")

            fireEvent.pointerEnter(trigger)
            act(() => {
                vi.advanceTimersByTime(1_500)
            })
            expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()

            fireEvent.pointerLeave(trigger)
            fireEvent.pointerEnter(trigger)
            fireEvent.pointerMove(trigger)
            act(() => {
                vi.advanceTimersByTime(1_500)
            })
            expect(screen.getByRole("tooltip")).toBeInTheDocument()
        } finally {
            vi.useRealTimers()
        }
    })
})

describe("TaskHeader pricing", () => {
    it("keeps the compact action out of the collapsed task-title row", () => {
        render(
            <TaskHeader
                doesModelSupportPromptCache={false}
                onClose={vi.fn()}
                onCompactTask={vi.fn(async () => true)}
                task={task}
                tokensIn={0}
                tokensOut={0}
                totalCost={0}
            />,
        )

        expect(screen.queryByRole("button", { name: "Compact task" })).not.toBeInTheDocument()
        expect(screen.getByLabelText("Expand task header")).toBeInTheDocument()
    })

    it("renders prompt cache health before the task header card", () => {
        render(
            <TaskHeader
                doesModelSupportPromptCache={true}
                onClose={vi.fn()}
                task={task}
                tokensIn={0}
                tokensOut={0}
                totalCost={0}
            />,
        )

        const warming = screen.getByRole("status")
        const taskHeader = screen.getByLabelText("Expand task header").closest("div.relative")
        expect(taskHeader).not.toBeNull()
        expect(warming.compareDocumentPosition(taskHeader as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it("renders RPM and TPM before usage metrics in an always-visible right-aligned region", () => {
        render(
            <TaskHeader
                doesModelSupportPromptCache={false}
                onClose={vi.fn()}
                requestsPerMinute={3}
                task={task}
                tokensIn={1_250}
                tokensOut={250}
                tokensPerMinute={4_500}
                totalCost={0}
            />,
        )

        const rate = screen.getByTestId("task-rate-metrics")
        expect(rate).toHaveAttribute("id", "price-tag")
        expect(rate).toHaveAttribute("title", "In: 1250 / Out: 250 / Cache read: 0 / Cache write: 0")
        expect(rate).toHaveAttribute("type", "button")
        expect(rate.querySelectorAll("button")).toHaveLength(0)
    })

    it("does not toggle the Task header for interactions rendered through the rate-history portal", () => {
        render(
            <TaskHeader
                doesModelSupportPromptCache={false}
                onClose={vi.fn()}
                requestsPerMinute={3}
                task={task}
                tokensIn={1_250}
                tokensOut={250}
                tokensPerMinute={4_500}
                totalCost={0}
            />,
        )

        fireEvent.click(screen.getByTestId("task-rate-metrics"))
        expect(screen.getByRole("dialog", { name: "API Rate History" })).toBeInTheDocument()
        expect(mocks.setExpandTaskHeader).not.toHaveBeenCalled()

        fireEvent.click(screen.getByRole("radio", { name: "TPM/RPM" }))
        fireEvent.keyDown(screen.getByRole("radio", { name: "Line" }), { key: "Enter" })
        fireEvent.click(screen.getByRole("button", { name: "Close" }))
        expect(mocks.setExpandTaskHeader).not.toHaveBeenCalled()
    })

    it("shows a reported zero amount independently of zero model prices while retaining token metrics", () => {
        render(
            <TaskHeader
                currency="CNY"
                doesModelSupportPromptCache={false}
                onClose={vi.fn()}
                pricing={flatMeteredPricing(0, 0, 0, 0)}
                task={task}
                tokensIn={1_250}
                tokensOut={250}
                totalCost={0}
            />,
        )

        expect(screen.getByTitle("In: 1250 / Out: 250 / Cache read: 0 / Cache write: 0")).toBeInTheDocument()
        expect(screen.getByText("¥0.000")).toBeInTheDocument()
    })

    it("shows an unlabelled reported amount without current model pricing", () => {
        render(
            <TaskHeader
                doesModelSupportPromptCache={false}
                onClose={vi.fn()}
                task={task}
                tokensIn={0}
                tokensOut={0}
                totalCost={0}
            />,
        )

        expect(screen.getByText("0.000")).toBeInTheDocument()
    })

    it("promotes billion-scale input and output token metrics from M to B", () => {
        expect(formatTokenMetric(1_000_000_000)).toBe("1.00B")
        expect(formatTokenMetric(1_250_000_000)).toBe("1.25B")

        render(
            <TaskHeader
                doesModelSupportPromptCache={false}
                onClose={vi.fn()}
                pricing={flatMeteredPricing(0, 0)}
                task={task}
                tokensIn={1_000_000_000}
                tokensOut={1_250_000_000}
                totalCost={0}
            />,
        )

        const metrics = screen.getByTitle("In: 1000000000 / Out: 1250000000 / Cache read: 0 / Cache write: 0")
    })
})
