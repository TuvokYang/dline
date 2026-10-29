import type { UiMessage } from "@shared/ExtensionMessage"
import { render, screen } from "@testing-library/react"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import { ChatRowContent } from "../ChatRow"

void React

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({
        backgroundEditEnabled: false,
        mcpServers: [],
        mcpMarketplaceCatalog: [],
        onRelinquishControl: () => () => undefined,
        vscodeTerminalExecutionMode: "backgroundExec",
        clineMessages: [],
        showFeatureTips: false,
        taskViewState: undefined,
        currentTaskItem: { id: "task-1" },
    }),
}))

const SCREENSHOT = `data:image/png;base64,${"iVBORw0KGgo".repeat(40)}`

function renderRow(message: UiMessage) {
    return render(<ChatRowContent isExpanded={false} isLast message={message} onSetQuote={vi.fn()} onToggleExpand={vi.fn()} />)
}

describe("ChatRow browser rows drawn without a session card", () => {
    it("describes a browser result by its page and never draws the screenshot payload", () => {
        const { container } = renderRow({
            ts: 1,
            type: "say",
            say: "browser_action_result",
            text: JSON.stringify({ currentUrl: "https://example.com/a", screenshot: SCREENSHOT, logs: "" }),
        })

        expect(screen.getByTestId("browser-message-summary").textContent).toBe("Browser page: https://example.com/a")
        expect(container.textContent).not.toContain("base64")
    })

    it("describes a browser action instead of drawing its JSON", () => {
        const { container } = renderRow({
            ts: 2,
            type: "say",
            say: "browser_action",
            text: JSON.stringify({ action: "click", coordinate: "20,30" }),
        })

        expect(screen.getByTestId("browser-message-summary").textContent).toBe("Click (20, 30)")
        expect(container.textContent).not.toContain("coordinate")
    })
})
