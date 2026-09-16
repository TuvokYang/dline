import { fireEvent, render, screen } from "@testing-library/react"
import React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CommandOutputRow } from "../CommandOutputRow"

void React

vi.mock("@/services/grpc-client", () => ({
	FileServiceClient: {
		openFile: vi.fn(async () => ({})),
	},
}))

const baseProps = {
	message: { ts: 1, type: "say" as const, say: "command" as const, text: "echo hi" },
	isCommandExecuting: false,
	isOutputFullyExpanded: false,
	setIsOutputFullyExpanded: vi.fn(),
	onToggleCollapsed: vi.fn(),
	isCollapsed: false,
}

/**
 * Force the measured overflow verdict.
 *
 * jsdom performs no layout, so both heights are always 0 and the component
 * would never see an overflow. Stubbing the two properties is what lets the
 * collapse behavior be asserted at all.
 */
function stubMeasuredOverflow(overflowing: boolean): void {
	Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
		configurable: true,
		get() {
			return overflowing ? 2000 : 40
		},
	})
	Object.defineProperty(HTMLElement.prototype, "clientHeight", {
		configurable: true,
		get() {
			return overflowing ? 400 : 40
		},
	})
}

afterEach(() => {
	for (const property of ["scrollHeight", "clientHeight"] as const) {
		Object.defineProperty(HTMLElement.prototype, property, {
			configurable: true,
			get() {
				return 0
			},
		})
	}
})

describe("CommandOutputRow command text collapsing", () => {
	it("caps the command height and offers a handle when it overflows", () => {
		stubMeasuredOverflow(true)

		render(<CommandOutputRow {...baseProps} message={{ ...baseProps.message, text: "echo long" }} />)

		const scroll = screen.getByTestId("command-text-scroll")
		expect(scroll).toHaveStyle({ maxHeight: "40vh" })
		expect(screen.getByTestId("expand-handle")).toBeInTheDocument()
	})

	it("lifts the cap after the handle is used", () => {
		stubMeasuredOverflow(true)

		render(<CommandOutputRow {...baseProps} message={{ ...baseProps.message, text: "echo long" }} />)
		fireEvent.click(screen.getByTestId("expand-handle"))

		// Expanding must remove the ceiling outright rather than raise it, so the
		// whole command becomes readable.
		expect(screen.getByTestId("command-text-scroll").style.maxHeight).toBe("")
	})

	it("leaves a short command without a handle", () => {
		stubMeasuredOverflow(false)

		render(<CommandOutputRow {...baseProps} />)

		// A command that already fits must not grow a control it does not need.
		expect(screen.queryByTestId("expand-handle")).not.toBeInTheDocument()
	})

	it("keeps the handle click from toggling the surrounding row", () => {
		stubMeasuredOverflow(true)
		const onToggleCollapsed = vi.fn()

		render(
			<CommandOutputRow
				{...baseProps}
				message={{ ...baseProps.message, text: "echo long" }}
				onToggleCollapsed={onToggleCollapsed}
			/>,
		)
		fireEvent.click(screen.getByTestId("expand-handle"))

		expect(onToggleCollapsed).not.toHaveBeenCalled()
	})
})
