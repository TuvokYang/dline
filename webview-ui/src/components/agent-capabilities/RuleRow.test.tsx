import { act, fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import RuleRow from "./RuleRow"

describe("RuleRow", () => {
    it("does not let an older failed toggle clear a newer pending intent", async () => {
        let rejectFirst: ((error: Error) => void) | undefined
        const toggleRule = vi
            .fn()
            .mockImplementationOnce(
                () =>
                    new Promise<void>((_resolve, reject) => {
                        rejectFirst = reject
                    }),
            )
            .mockImplementation(() => new Promise<void>(() => {}))
        render(
            <RuleRow
                enabled={true}
                isGlobal={true}
                rulePath="C:\\workspace\\rules\\review.md"
                ruleType="rule"
                toggleRule={toggleRule}
            />,
        )
        const toggle = screen.getByRole("switch")

        fireEvent.click(toggle)
        fireEvent.click(toggle)
        fireEvent.click(toggle)
        expect(toggle).toHaveAttribute("data-state", "unchecked")
        expect(toggleRule).toHaveBeenCalledTimes(3)

        await act(async () => {
            rejectFirst?.(new Error("first write failed"))
            await Promise.resolve()
        })
        expect(toggle).toHaveAttribute("data-state", "unchecked")
    })
})
