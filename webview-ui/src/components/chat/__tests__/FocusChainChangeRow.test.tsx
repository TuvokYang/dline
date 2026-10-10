import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { FocusChainChangeRow } from "../FocusChainChangeRow"

const plan = "# Focus plan\n## Backend\n- [ ] Keep the API boundary\n- [ ] Add a regression test"

function renderExpandedRow(onToggleExpand = vi.fn()) {
    return render(
        <FocusChainChangeRow
            autoApproved
            isExpanded={true}
            onToggleExpand={onToggleExpand}
            plan={plan}
            reason="The task focus changed"
        />,
    )
}

describe("FocusChainChangeRow rendering", () => {
    it("caps expanded focus-chain details at 80% of the viewport with internal scrolling", () => {
        renderExpandedRow()

        const detailContainer = screen.getByTestId("focus-chain-change-details")
        expect(detailContainer).toHaveClass("max-h-[80vh]")
        expect(detailContainer).toHaveClass("overflow-y-auto")
        expect(screen.getByText("Keep the API boundary")).toBeVisible()
    })

    it("supports controlled manual collapse and reopening", () => {
        const onToggleExpand = vi.fn()
        const rendered = renderExpandedRow(onToggleExpand)

        fireEvent.click(screen.getByRole("button", { name: "Collapse focus-chain change" }))
        expect(onToggleExpand).toHaveBeenCalledOnce()

        rendered.rerender(
            <FocusChainChangeRow
                autoApproved
                isExpanded={false}
                onToggleExpand={onToggleExpand}
                plan={plan}
                reason="The task focus changed"
            />,
        )
        expect(screen.queryByText("Keep the API boundary")).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole("button", { name: "Expand focus-chain change" }))
        expect(onToggleExpand).toHaveBeenCalledTimes(2)
    })
})
