import { render, screen } from "@testing-library/react"
import type { PropsWithChildren } from "react"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import McpResponseDisplay from "./McpResponseDisplay"

void React

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		mcpResponsesCollapsed: false,
		mcpDisplayMode: "plain",
	}),
}))

vi.mock("@/components/settings/ApiOptions", () => ({
	DropdownContainer: ({ children }: PropsWithChildren) => <div>{children}</div>,
}))

vi.mock("@/components/settings/utils/settingsHandlers", () => ({
	updateSetting: vi.fn(),
}))

vi.mock("./McpDisplayModeDropdown", () => ({
	default: () => <div data-testid="mcp-display-mode" />,
}))

describe("McpResponseDisplay height boundary", () => {
	it("caps the whole response at 60vh and scrolls the response content vertically", () => {
		render(<McpResponseDisplay responseText={Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n")} />)

		expect(screen.getByTestId("mcp-response-card").style.maxHeight).toBe("60vh")
		expect(screen.getByTestId("mcp-response-content").style.overflowY).toBe("auto")
	})
})
