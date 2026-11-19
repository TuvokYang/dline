// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import ThinkingControl from "./ThinkingControl"

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
    VSCodeCheckbox: ({
        checked,
        children,
        disabled,
        onChange,
        "aria-label": ariaLabel,
    }: {
        "aria-label"?: string
        checked?: boolean
        children: ReactNode
        disabled?: boolean
        onChange?: React.ChangeEventHandler<HTMLInputElement>
    }) => (
        <label>
            <input aria-label={ariaLabel} checked={checked} disabled={disabled} onChange={onChange} type="checkbox" />
            {children}
        </label>
    ),
}))

const DISPLAY_OPTIONS = [
    { value: "none", label: "None" },
    { value: "summarized", label: "Summarized" },
    { value: "omitted", label: "Omitted" },
]

const displaySelector = () => screen.getAllByRole("combobox")[1]

describe("ThinkingControl", () => {
    it("leaves a controlled unknown mode unselected despite stored preferences", () => {
        const onUpdate = vi.fn()
        render(
            <ThinkingControl
                effortOptions={["low", "high"]}
                mode="both"
                onReasoningConfigUpdate={onUpdate}
                reasoningConfig={{ enableThinking: true, effort: "high", thinkingBudget: 2048 }}
                selectedMode=""
            />,
        )
        expect(screen.getByRole("combobox", { name: "Thinking Mode" })).toHaveTextContent("Choose a thinking mode")
        expect(screen.queryByRole("combobox", { name: "Reasoning Effort" })).not.toBeInTheDocument()
        expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument()
        expect(onUpdate).not.toHaveBeenCalled()
    })

    it("publishes a controlled mode and cleared preferences as one update without inventing a budget", () => {
        const onUpdate = vi.fn()
        const onModeChange = vi.fn()
        const tree = (selectedMode: "" | "budget") => (
            <ThinkingControl
                effortOptions={["low", "high"]}
                mode="both"
                onModeChange={onModeChange}
                onReasoningConfigUpdate={onUpdate}
                reasoningConfig={{ enableThinking: true, display: "omitted" }}
                selectedMode={selectedMode}
            />
        )
        const view = render(tree(""))
        fireEvent.click(screen.getByRole("combobox", { name: "Thinking Mode" }))
        fireEvent.click(screen.getByRole("option", { name: "Budget", exact: true }))
        expect(onModeChange).toHaveBeenCalledExactlyOnceWith("budget", {
            enableThinking: true,
            effort: undefined,
            thinkingBudget: undefined,
            display: "omitted",
        })
        expect(onUpdate).not.toHaveBeenCalled()
        view.rerender(tree("budget"))
        expect(screen.getByRole("combobox", { name: "Thinking Mode" })).toHaveTextContent("Budget")
        expect(screen.getByRole("spinbutton")).toHaveValue(null)
        expect(screen.getByRole("spinbutton")).not.toHaveAttribute("max")
    })

    it("does not fabricate a medium preference when thinking is enabled", () => {
        const onUpdate = vi.fn()
        render(<ThinkingControl effortOptions={["low"]} mode="effort-only" onReasoningConfigUpdate={onUpdate} />)
        fireEvent.click(screen.getByRole("checkbox", { name: "Enable Thinking" }))
        expect(onUpdate).toHaveBeenCalledWith({
            enableThinking: true,
            effort: undefined,
            thinkingBudget: undefined,
            display: undefined,
        })
    })

    it("keeps effort labels and raw updates while the interface language changes", () => {
        const onUpdate = vi.fn()
        const tree = (language: "en" | "zh-CN") => (
            <UiLanguageProvider language={language}>
                <ThinkingControl
                    effortOptions={["low", "high", "max"]}
                    mode="effort-only"
                    onReasoningConfigUpdate={onUpdate}
                    reasoningConfig={{ enableThinking: true, effort: "high", display: "omitted" }}
                />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        const selector = screen.getByRole("combobox", { name: "Reasoning Effort" })
        const checkbox = screen.getByRole("checkbox", { name: "Enable Thinking" })
        for (const language of ["zh-CN", "en"] as const) {
            view.rerender(tree(language))
            const effortLabel = language === "zh-CN" ? "推理强度" : "Reasoning Effort"
            const thinkingLabel = language === "zh-CN" ? "启用思考" : "Enable Thinking"
            expect(screen.getByRole("combobox", { name: effortLabel })).toBe(selector)
            expect(screen.getByRole("checkbox", { name: thinkingLabel })).toBe(checkbox)
            expect(checkbox).toBeChecked()
            expect(selector).toHaveTextContent("High")
            fireEvent.click(selector)
            expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Low", "High", "Max"])
            fireEvent.click(screen.getByRole("option", { name: "Max", exact: true }))
            expect(onUpdate).toHaveBeenLastCalledWith({
                enableThinking: true,
                effort: "max",
                thinkingBudget: undefined,
                display: "omitted",
            })
        }
    })

    it.each([undefined, true])("keeps explicit None off even with enableThinking=%s and an enabled default", (enableThinking) => {
        render(
            <ThinkingControl
                defaultEnabled={true}
                effortOptions={["none", "low"]}
                mode="effort-only"
                onReasoningConfigUpdate={vi.fn()}
                reasoningConfig={{ enableThinking, effort: "none" }}
            />,
        )
        expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).not.toBeChecked()
        expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
    })

    it.each([
        { mode: "effort-only", reasoningConfig: { thinkingBudget: 1500 } },
        { mode: "budget-only", reasoningConfig: { effort: "low" } },
    ] as const)("does not enable $mode from a preference for the other mode", ({ mode, reasoningConfig }) => {
        const onUpdate = vi.fn()
        render(
            <ThinkingControl
                effortOptions={["low"]}
                maxBudget={2000}
                mode={mode}
                onReasoningConfigUpdate={onUpdate}
                reasoningConfig={reasoningConfig}
            />,
        )
        expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).not.toBeChecked()
        expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
        expect(screen.queryByRole("slider")).not.toBeInTheDocument()
        expect(onUpdate).not.toHaveBeenCalled()
    })

    it("does not enable thinking from an effort outside the model declaration", () => {
        render(
            <ThinkingControl
                effortOptions={["low"]}
                mode="effort-only"
                onReasoningConfigUpdate={vi.fn()}
                reasoningConfig={{ effort: "stale-level" }}
            />,
        )
        expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).not.toBeChecked()
    })

    it.each([undefined, true])("keeps a zero budget off despite an enabled default and enableThinking=%s", (enableThinking) => {
        render(
            <ThinkingControl
                defaultEnabled={true}
                maxBudget={2000}
                mode="budget-only"
                onReasoningConfigUpdate={vi.fn()}
                reasoningConfig={{ enableThinking, thinkingBudget: 0 }}
            />,
        )
        expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).not.toBeChecked()
        expect(screen.queryByRole("slider")).not.toBeInTheDocument()
    })

    it.each(["effort-only", "both"] as const)("does not disable a legal effort with a stale zero budget in %s", (mode) => {
        render(
            <ThinkingControl
                effortOptions={["low"]}
                mode={mode}
                onReasoningConfigUpdate={vi.fn()}
                reasoningConfig={{ effort: "low", thinkingBudget: 0 }}
            />,
        )
        expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).toBeChecked()
        expect(screen.getAllByRole("combobox").some((selector) => selector.textContent === "Low")).toBe(true)
    })

    it("does not render an empty-string effort as a Radix option", () => {
        render(
            <ThinkingControl
                defaultEnabled={true}
                effortOptions={["", "low"]}
                mode="effort-only"
                onReasoningConfigUpdate={vi.fn()}
            />,
        )
        fireEvent.click(screen.getByRole("combobox"))
        expect(screen.getByRole("option", { name: "Low" })).toBeInTheDocument()
    })

    it("does not offer a selector for an explicitly empty effort declaration", () => {
        render(<ThinkingControl defaultEnabled={true} effortOptions={[]} mode="effort-only" onReasoningConfigUpdate={vi.fn()} />)
        expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
    })

    it.each([
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        3000,
    ])("does not turn an invalid minimum %s into a usable budget editor", (minBudget) => {
        render(
            <ThinkingControl
                maxBudget={2000}
                minBudget={minBudget}
                mode="budget-only"
                onReasoningConfigUpdate={vi.fn()}
                reasoningConfig={{ enableThinking: true, thinkingBudget: 100 }}
            />,
        )
        expect(screen.queryByRole("slider")).not.toBeInTheDocument()
        expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument()
    })

    it("does not invent a budget maximum when the declaration omits it", () => {
        const onUpdate = vi.fn()
        render(
            <ThinkingControl
                effortOptions={[]}
                mode="budget-only"
                onReasoningConfigUpdate={onUpdate}
                reasoningConfig={{ enableThinking: true, thinkingBudget: 3000, display: "omitted" }}
            />,
        )
        const input = screen.getByRole("spinbutton")
        expect(input).not.toHaveAttribute("max")
        fireEvent.change(input, { target: { value: "9000" } })
        fireEvent.blur(input)
        expect(onUpdate).toHaveBeenCalledWith({
            enableThinking: true,
            effort: undefined,
            thinkingBudget: 9000,
            display: "omitted",
        })
    })

    it("does not fabricate a budget preference when thinking is enabled", () => {
        const onUpdate = vi.fn()
        render(<ThinkingControl effortOptions={[]} maxBudget={2000} mode="budget-only" onReasoningConfigUpdate={onUpdate} />)
        fireEvent.click(screen.getByRole("checkbox", { name: "Enable Thinking" }))
        expect(onUpdate).toHaveBeenCalledWith({
            enableThinking: true,
            effort: undefined,
            thinkingBudget: undefined,
            display: undefined,
        })
    })

    it.each([
        { value: "1", expected: 1024 },
        { value: "9000", expected: 2000 },
    ])("bounds an explicit budget edit $value by the supplied protocol and model limits", ({ value, expected }) => {
        const onUpdate = vi.fn()
        render(
            <ThinkingControl
                effortOptions={[]}
                maxBudget={2000}
                minBudget={1024}
                mode="budget-only"
                onReasoningConfigUpdate={onUpdate}
                reasoningConfig={{ enableThinking: true, thinkingBudget: 1500, display: "omitted" }}
            />,
        )
        const slider = screen.getByRole("slider")
        fireEvent.change(slider, { target: { value } })
        fireEvent.mouseUp(slider)
        expect(onUpdate).toHaveBeenCalledWith({
            enableThinking: true,
            effort: undefined,
            thinkingBudget: expected,
            display: "omitted",
        })
    })

    it("shows a default-enabled model at its configured default effort", () => {
        render(
            <ThinkingControl
                defaultEffort="high"
                defaultEnabled={true}
                effortOptions={["none", "low", "medium", "high", "max"]}
                mode="effort-only"
                onReasoningConfigUpdate={vi.fn()}
            />,
        )

        expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).toBeChecked()
    })

    it("persists an explicit disabled request when None is selected", () => {
        const onReasoningConfigUpdate = vi.fn()
        render(
            <ThinkingControl
                defaultEffort="high"
                defaultEnabled={true}
                effortLabel="Adaptive Thinking"
                effortOptions={["none", "low", "medium", "high", "max"]}
                mode="effort-only"
                onReasoningConfigUpdate={onReasoningConfigUpdate}
            />,
        )

        fireEvent.click(screen.getByRole("combobox"))
        fireEvent.click(screen.getByRole("option", { name: "None" }))

        expect(onReasoningConfigUpdate).toHaveBeenCalledWith({
            enableThinking: false,
            effort: "none",
            thinkingBudget: undefined,
        })
    })

    it("stores the selected reasoning display", () => {
        const onReasoningConfigUpdate = vi.fn()
        render(
            <ThinkingControl
                defaultEffort="high"
                defaultEnabled={true}
                displayOptions={DISPLAY_OPTIONS}
                effortOptions={["none", "low", "medium", "high", "max"]}
                mode="effort-only"
                onReasoningConfigUpdate={onReasoningConfigUpdate}
                reasoningConfig={{ enableThinking: true, effort: "high" }}
            />,
        )

        fireEvent.click(displaySelector())
        fireEvent.click(screen.getByRole("option", { name: "Omitted" }))

        expect(onReasoningConfigUpdate).toHaveBeenCalledWith({
            enableThinking: true,
            effort: "high",
            display: "omitted",
        })
    })

    it("clears the stored display when None is selected", () => {
        const onReasoningConfigUpdate = vi.fn()
        render(
            <ThinkingControl
                defaultEffort="high"
                defaultEnabled={true}
                displayOptions={DISPLAY_OPTIONS}
                effortOptions={["none", "low", "medium", "high", "max"]}
                mode="effort-only"
                onReasoningConfigUpdate={onReasoningConfigUpdate}
                reasoningConfig={{ enableThinking: true, effort: "high", display: "omitted" }}
            />,
        )

        fireEvent.click(displaySelector())
        fireEvent.click(screen.getByRole("option", { name: "None" }))

        expect(onReasoningConfigUpdate).toHaveBeenCalledWith({
            enableThinking: true,
            effort: "high",
            display: undefined,
        })
    })

    it("preserves the stored display when the effort changes", () => {
        const onReasoningConfigUpdate = vi.fn()
        render(
            <ThinkingControl
                defaultEffort="high"
                defaultEnabled={true}
                displayOptions={DISPLAY_OPTIONS}
                effortLabel="Adaptive Thinking"
                effortOptions={["none", "low", "medium", "high", "max"]}
                mode="effort-only"
                onReasoningConfigUpdate={onReasoningConfigUpdate}
                reasoningConfig={{ enableThinking: true, effort: "high", display: "omitted" }}
            />,
        )

        fireEvent.click(screen.getByRole("combobox", { name: "Adaptive Thinking" }))
        fireEvent.click(screen.getByRole("option", { name: "Low" }))

        expect(onReasoningConfigUpdate).toHaveBeenCalledWith({
            enableThinking: true,
            effort: "low",
            thinkingBudget: undefined,
            display: "omitted",
        })
    })

    it("omits the display selector when a provider exposes no options", () => {
        render(
            <ThinkingControl
                defaultEffort="high"
                defaultEnabled={true}
                effortOptions={["none", "low", "medium", "high", "max"]}
                mode="effort-only"
                onReasoningConfigUpdate={vi.fn()}
            />,
        )

        expect(screen.queryByText("Thinking Display")).not.toBeInTheDocument()
    })

    it("keeps required thinking enabled when a stale profile requests disabled", () => {
        const onReasoningConfigUpdate = vi.fn()
        render(
            <ThinkingControl
                defaultEffort="high"
                defaultEnabled={true}
                disableSupported={false}
                effortLabel="Adaptive Thinking"
                effortOptions={["low", "medium", "high", "max"]}
                mode="effort-only"
                onReasoningConfigUpdate={onReasoningConfigUpdate}
                reasoningConfig={{ enableThinking: false, effort: "none" }}
            />,
        )

        const enableThinking = screen.getByRole("checkbox", { name: "Enable Thinking" })
        expect(enableThinking).toBeChecked()
        expect(enableThinking).toBeDisabled()
        expect(screen.queryByRole("option", { name: "None" })).not.toBeInTheDocument()
        expect(onReasoningConfigUpdate).not.toHaveBeenCalled()
    })
})
