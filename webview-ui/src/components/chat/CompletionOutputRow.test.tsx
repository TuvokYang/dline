import { render, screen } from "@testing-library/react"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import { CompletionOutputRow } from "./CompletionOutputRow"

void React

describe("CompletionOutputRow height boundary", () => {
    it("caps long completion content at 60vh while leaving the action row outside the scroll surface", () => {
        render(
            <CompletionOutputRow
                explainChangesDisabled={false}
                handleQuoteClick={vi.fn()}
                messageTs={1}
                quoteButtonState={{ visible: false, top: 0, left: 0, selectedText: "" }}
                seeNewChangesDisabled={false}
                setExplainChangesDisabled={vi.fn()}
                setSeeNewChangesDisabled={vi.fn()}
                showActionRow={false}
                text={Array.from({ length: 200 }, (_, index) => `completion line ${index}`).join("\n")}
            />,
        )

        expect(screen.getByTestId("completion-output-scroll")).toHaveClass(
            "max-h-[60vh]",
            "overflow-y-auto",
            "overscroll-x-contain",
        )
    })
})
