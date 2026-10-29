import type { PromptFreshnessSnapshot } from "@shared/PromptFreshness"
import { fireEvent, render, screen } from "@testing-library/react"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import RefreshPromptButton from "./RefreshPromptButton"

const originalResizeObserver = globalThis.ResizeObserver

beforeAll(() => {
    Object.defineProperty(globalThis, "ResizeObserver", {
        configurable: true,
        value: class {
            disconnect() {}
            observe() {}
            unobserve() {}
        },
    })
})

afterAll(() => {
    if (originalResizeObserver) {
        Object.defineProperty(globalThis, "ResizeObserver", {
            configurable: true,
            value: originalResizeObserver,
        })
        return
    }
    Reflect.deleteProperty(globalThis, "ResizeObserver")
})

function freshness(overrides: Partial<PromptFreshnessSnapshot> = {}): PromptFreshnessSnapshot {
    return {
        status: "fresh",
        changes: [],
        checkedAt: 20,
        frozenAt: 10,
        ...overrides,
    }
}

describe("RefreshPromptButton", () => {
    it.each([
        undefined,
        freshness(),
        freshness({ status: "unknown" }),
    ])("keeps the standard refresh appearance when the prompt is not stale", (promptFreshness) => {
        render(<RefreshPromptButton promptFreshness={promptFreshness} taskId="task-1" />)

        expect(screen.queryByTestId("prompt-freshness-warning")).not.toBeInTheDocument()
    })

    it.each([
        ["rules", "Rules changed"],
        ["workflows", "Workflows changed"],
        ["skills", "Skills changed"],
        ["subagents", "Subagents changed"],
        ["mcp", "MCP tools changed"],
    ] as const)("shows the privacy-safe %s change summary", async (kind, summary) => {
        render(
            <RefreshPromptButton
                promptFreshness={freshness({ status: "stale", changes: [{ kind, summary }] })}
                taskId="task-1"
            />,
        )

        fireEvent.focus(screen.getByRole("button"))
        expect(await screen.findByRole("tooltip")).toHaveTextContent(summary)
    })

    it("overlays a warning SVG and explains bounded prompt changes", async () => {
        render(
            <RefreshPromptButton
                promptFreshness={freshness({
                    status: "stale",
                    changes: [
                        { kind: "rules", summary: "Rules changed" },
                        { kind: "subagents", summary: "Subagents changed" },
                        { kind: "browser", summary: "Browser settings changed" },
                        { kind: "mcp", summary: "MCP tools changed" },
                        { kind: "skills", summary: "Skills changed" },
                    ],
                })}
                taskId="task-1"
            />,
        )

        const warning = screen.getByTestId("prompt-freshness-warning")
        expect(warning.tagName.toLowerCase()).toBe("svg")
        expect(warning).toHaveAccessibleName("Prompt update available")

        fireEvent.focus(screen.getByRole("button"))
        const tooltip = await screen.findByRole("tooltip")
        expect(tooltip).toHaveTextContent("Prompt update available")
        expect(tooltip).toHaveTextContent("The current task is still using its previous prompt and tool snapshot.")
        expect(tooltip).toHaveTextContent("Rules changed")
        expect(tooltip).toHaveTextContent("Subagents changed")
        expect(tooltip).toHaveTextContent("Browser settings changed")
        expect(tooltip).toHaveTextContent("MCP tools changed")
        expect(tooltip).toHaveTextContent("+1 more change")
        expect(tooltip).not.toHaveTextContent("Skills changed")
        expect(tooltip).toHaveTextContent("Click to review and refresh.")
    })
})
