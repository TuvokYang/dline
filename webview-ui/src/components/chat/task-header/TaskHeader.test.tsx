import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import TaskHeader from "./TaskHeader"
import { formatTokenMetric, hasNonZeroModelPricing } from "./util"

const mocks = vi.hoisted(() => ({
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
        expandTaskHeader: false,
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
    mocks.setExpandTaskHeader.mockReset()
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
        const { container } = render(
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
        expect(container).toHaveTextContent("Prompt cache warming (2/3)")
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
        expect(rate).not.toHaveTextContent("Active:")
        expect(rate).toHaveTextContent("In:1.3K")
        expect(rate).toHaveTextContent("Out:250")
        expect(rate).toHaveTextContent("RPM:3")
        expect(rate).toHaveTextContent("TPM:4.5K")
        expect(rate).toHaveClass("ml-auto", "justify-end")
        expect(rate).toHaveClass("rounded-full", "bg-success/80", "text-background")
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

    it("hides a zero-priced model cost while retaining token metrics", () => {
        render(
            <TaskHeader
                doesModelSupportPromptCache={false}
                onClose={vi.fn()}
                pricing={{
                    cacheReadsPrice: 0,
                    cacheWritesPrice: 0,
                    inputPrice: 0,
                    outputPrice: 0,
                    thinkingOutputPrice: 0,
                }}
                task={task}
                tokensIn={1_250}
                tokensOut={250}
                totalCost={0}
            />,
        )

        const metrics = screen.getByTitle("In: 1250 / Out: 250 / Cache read: 0 / Cache write: 0")
        expect(metrics).toHaveTextContent("In:1.3K")
        expect(metrics).toHaveTextContent("Out:250")
        expect(screen.queryByText("$0.000")).not.toBeInTheDocument()
    })

    it("keeps the cost visible when the model has non-zero pricing", () => {
        render(
            <TaskHeader
                doesModelSupportPromptCache={false}
                onClose={vi.fn()}
                pricing={{ inputPrice: 0, outputPrice: 1 }}
                task={task}
                tokensIn={0}
                tokensOut={0}
                totalCost={0}
            />,
        )

        expect(screen.getByText("$0.000")).toBeInTheDocument()
    })

    it("recognizes non-zero cache, context-tier, and thinking-tier prices", () => {
        expect(hasNonZeroModelPricing({ cacheReadsPrice: 0.1 })).toBe(true)
        expect(hasNonZeroModelPricing({ tiers: [{ contextWindow: 128_000, outputPrice: 2 }] })).toBe(true)
        expect(hasNonZeroModelPricing({ thinkingOutputPriceTiers: [{ price: 3, tokenLimit: 8_000 }] })).toBe(true)
    })

    it("promotes billion-scale input and output token metrics from M to B", () => {
        expect(formatTokenMetric(1_000_000_000)).toBe("1.00B")
        expect(formatTokenMetric(1_250_000_000)).toBe("1.25B")

        render(
            <TaskHeader
                doesModelSupportPromptCache={false}
                onClose={vi.fn()}
                pricing={{ inputPrice: 0, outputPrice: 0 }}
                task={task}
                tokensIn={1_000_000_000}
                tokensOut={1_250_000_000}
                totalCost={0}
            />,
        )

        const metrics = screen.getByTitle("In: 1000000000 / Out: 1250000000 / Cache read: 0 / Cache write: 0")
        expect(metrics).toHaveTextContent("In:1.00B")
        expect(metrics).toHaveTextContent("Out:1.25B")
    })
})
