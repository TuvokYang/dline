import type { ContextWindowIndicatorSnapshot } from "@shared/context-window-indicator"
import { act, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import ContextWindowSegmentedProgress from "./ContextWindowSegmentedProgress"

function snapshot(overrides: Partial<ContextWindowIndicatorSnapshot> = {}): ContextWindowIndicatorSnapshot {
	return {
		taskId: "task-1",
		revision: 1,
		epoch: 1,
		phase: "receiving",
		durableContextTokens: 40_000,
		pendingSendTokens: 0,
		receivingTokens: 10_000,
		environmentTokens: 5_000,
		contextWindow: 100_000,
		mode: "act",
		updatedAt: 1,
		lineage: { kind: "baseline" },
		...overrides,
	}
}

describe("ContextWindowSegmentedProgress", () => {
	it("renders durable, phase-active, staged, and ENV as exactly four layout segments", () => {
		const stagedSnapshot = {
			...snapshot({ phase: "receiving", pendingSendTokens: 0, receivingTokens: 10_000 }),
			stagedTokens: 8_000,
		} as ContextWindowIndicatorSnapshot

		render(<ContextWindowSegmentedProgress snapshot={stagedSnapshot} />)

		const progress = screen.getByRole("progressbar", { name: "Context window usage progress" })
		expect(
			Array.from(progress.querySelectorAll("[data-segment]")).map((element) => element.getAttribute("data-segment")),
		).toEqual(["durable", "active", "staged", "environment"])
		expect(screen.queryByTestId("context-window-segment-sending")).not.toBeInTheDocument()
		expect(screen.queryByTestId("context-window-segment-receiving")).not.toBeInTheDocument()
		expect(screen.getByTestId("context-window-segment-active")).toHaveAttribute("aria-label", "Receiving: 10000 tokens")
		expect(screen.getByTestId("context-window-segment-active")).toHaveAttribute("data-active", "true")
		expect(screen.getByTestId("context-window-segment-staged")).toHaveAttribute("aria-label", "Staged: 8000 tokens")
	})

	it("renders four colored segments in durable, active, staged, ENV order", () => {
		render(
			<ContextWindowSegmentedProgress
				snapshot={snapshot({ phase: "sending", pendingSendTokens: 20_000, receivingTokens: 0, stagedTokens: 10_000 })}
			/>,
		)

		const progress = screen.getByRole("progressbar", { name: "Context window usage progress" })
		const segments = [
			screen.getByTestId("context-window-segment-durable"),
			screen.getByTestId("context-window-segment-active"),
			screen.getByTestId("context-window-segment-staged"),
			screen.getByTestId("context-window-segment-environment"),
		]

		expect(progress).toHaveAttribute("data-phase", "sending")
		expect(
			Array.from(progress.querySelectorAll("[data-segment]")).map((element) => element.getAttribute("data-segment")),
		).toEqual(["durable", "active", "staged", "environment"])
		expect(segments.map((segment) => segment.getAttribute("data-tokens"))).toEqual(["40000", "20000", "10000", "5000"])
		// Segment widths follow the actual token ratios without visual amplification.
		expect(segments.map((segment) => segment.style.width)).toEqual(["40%", "20%", "10%", "5%"])
		expect(segments.map((segment) => segment.style.backgroundColor)).toEqual([
			"var(--vscode-charts-green, #3fb950)",
			"var(--vscode-charts-blue, #58a6ff)",
			"var(--vscode-charts-orange, #d18616)",
			"var(--vscode-charts-purple, #bc8cff)",
		])
		expect(segments[1]).toHaveAttribute("data-active", "true")
		expect(segments[1]).toHaveClass("animate-pulse")
		expect(progress).not.toHaveAttribute("title")
		expect(segments.every((segment) => !segment.hasAttribute("title"))).toBe(true)
		expect(segments.map((segment) => segment.getAttribute("tabindex"))).toEqual([null, null, null, null])
		expect(segments.map((segment) => segment.getAttribute("aria-label"))).toEqual([
			"Durable: 40000 tokens",
			"Sending: 20000 tokens",
			"Staged: 10000 tokens",
			"ENV: 5000 tokens",
		])
	})

	it("retains the previous temporary segments while an authoritative commit clears them", () => {
		const { rerender } = render(<ContextWindowSegmentedProgress snapshot={snapshot()} />)

		rerender(
			<ContextWindowSegmentedProgress
				snapshot={snapshot({
					revision: 2,
					phase: "committing",
					durableContextTokens: 68_000,
					pendingSendTokens: 0,
					receivingTokens: 0,
					lineage: {
						kind: "compaction_pass",
						operationId: "operation-1",
						passIndex: 0,
						attemptIndex: 0,
						attemptId: "attempt-0",
					},
				})}
			/>,
		)

		expect(screen.getByTestId("context-window-segmented-progress")).toHaveAttribute("data-motion", "commit")
		expect(screen.getByTestId("context-window-segment-durable").style.filter).toBe("brightness(1.16)")
		const active = screen.getByTestId("context-window-segment-active")
		expect(active).toHaveAttribute("data-authoritative-tokens", "0")
		expect(active).toHaveAttribute("data-tokens", "10000")
		expect(active).toHaveAttribute("data-transition-source", "previous")
		expect(active.style.width).toBe("0%")
		expect(active.style.opacity).toBe("0")
		expect(active.style.transform).toBe("translateX(-8px)")

		rerender(
			<ContextWindowSegmentedProgress
				snapshot={snapshot({
					revision: 3,
					phase: "stable",
					durableContextTokens: 68_000,
					pendingSendTokens: 0,
					receivingTokens: 0,
					lineage: {
						kind: "compaction_pass",
						operationId: "operation-1",
						passIndex: 0,
						attemptIndex: 0,
						attemptId: "attempt-0",
					},
				})}
			/>,
		)
		expect(screen.getByTestId("context-window-segmented-progress")).toHaveAttribute("data-motion", "commit")
		expect(screen.getByTestId("context-window-segment-active")).toHaveAttribute("data-tokens", "10000")
	})

	it("infers coalesced commit from the epoch even when the durable total is unchanged", () => {
		const { rerender } = render(<ContextWindowSegmentedProgress snapshot={snapshot()} />)

		rerender(
			<ContextWindowSegmentedProgress
				snapshot={snapshot({
					revision: 2,
					epoch: 1,
					phase: "stable",
					durableContextTokens: 40_000,
					pendingSendTokens: 0,
					receivingTokens: 0,
					lineage: {
						kind: "compaction_pass",
						operationId: "operation-1",
						passIndex: 0,
						attemptIndex: 0,
						attemptId: "attempt-0",
					},
				})}
			/>,
		)

		expect(screen.getByTestId("context-window-segmented-progress")).toHaveAttribute("data-motion", "commit")
	})

	it("infers a coalesced rollback only when the epoch advances", () => {
		const { rerender } = render(<ContextWindowSegmentedProgress snapshot={snapshot()} />)

		rerender(
			<ContextWindowSegmentedProgress
				snapshot={snapshot({
					revision: 2,
					epoch: 2,
					phase: "stable",
					durableContextTokens: 40_000,
					pendingSendTokens: 0,
					receivingTokens: 0,
				})}
			/>,
		)

		expect(screen.getByTestId("context-window-segmented-progress")).toHaveAttribute("data-motion", "rollback")
	})

	it("clears retained commit motion after the animation settle window", () => {
		vi.useFakeTimers()
		try {
			const { rerender } = render(<ContextWindowSegmentedProgress snapshot={snapshot()} />)
			rerender(
				<ContextWindowSegmentedProgress
					snapshot={snapshot({
						revision: 2,
						phase: "committing",
						durableContextTokens: 68_000,
						pendingSendTokens: 0,
						receivingTokens: 0,
					})}
				/>,
			)
			rerender(
				<ContextWindowSegmentedProgress
					snapshot={snapshot({
						revision: 3,
						phase: "stable",
						durableContextTokens: 68_000,
						pendingSendTokens: 0,
						receivingTokens: 0,
					})}
				/>,
			)
			expect(screen.getByTestId("context-window-segmented-progress")).toHaveAttribute("data-motion", "commit")

			act(() => vi.advanceTimersByTime(720))

			expect(screen.getByTestId("context-window-segmented-progress")).toHaveAttribute("data-motion", "none")
			expect(screen.getByTestId("context-window-segment-active")).toHaveAttribute("data-tokens", "0")
		} finally {
			vi.useRealTimers()
		}
	})

	it("reveals the settled round as Staged once the settle animation ends", () => {
		vi.useFakeTimers()
		try {
			const { rerender } = render(<ContextWindowSegmentedProgress snapshot={snapshot()} />)
			rerender(
				<ContextWindowSegmentedProgress
					snapshot={snapshot({ revision: 2, phase: "stable", receivingTokens: 0, stagedTokens: 12_000 })}
				/>,
			)

			act(() => vi.advanceTimersByTime(720))

			expect(screen.getByTestId("context-window-segmented-progress")).toHaveAttribute("data-motion", "none")
			const staged = screen.getByTestId("context-window-segment-staged")
			expect(staged).toHaveAttribute("data-tokens", "12000")
			expect(staged.style.width).toBe("12%")
			expect(staged.style.opacity).toBe("1")
		} finally {
			vi.useRealTimers()
		}
	})

	it("keeps Staged visible when a stable snapshot only refreshes the pending estimate", () => {
		const { rerender } = render(
			<ContextWindowSegmentedProgress
				snapshot={snapshot({ revision: 2, phase: "stable", receivingTokens: 0, stagedTokens: 12_000 })}
			/>,
		)
		rerender(
			<ContextWindowSegmentedProgress
				snapshot={snapshot({ revision: 3, phase: "stable", receivingTokens: 0, stagedTokens: 13_000 })}
			/>,
		)

		expect(screen.getByTestId("context-window-segmented-progress")).toHaveAttribute("data-motion", "none")
		const staged = screen.getByTestId("context-window-segment-staged")
		expect(staged).toHaveAttribute("data-tokens", "13000")
		expect(staged.style.width).toBe("13%")
	})

	it("animates temporary segments outward during rollback", () => {
		const { rerender } = render(<ContextWindowSegmentedProgress snapshot={snapshot()} />)

		rerender(
			<ContextWindowSegmentedProgress
				snapshot={snapshot({
					revision: 2,
					phase: "rolling_back",
					durableContextTokens: 40_000,
					pendingSendTokens: 0,
					receivingTokens: 0,
				})}
			/>,
		)
		expect(screen.getByTestId("context-window-segmented-progress")).toHaveAttribute("data-motion", "rollback")
		expect(screen.getByTestId("context-window-segment-active")).toHaveAttribute("data-tokens", "10000")
		expect(screen.getByTestId("context-window-segment-active").style.transform).toBe("translateX(8px)")
	})

	it("provides reduced-motion fallbacks for every animated segment", () => {
		render(<ContextWindowSegmentedProgress snapshot={snapshot()} />)

		for (const kind of ["durable", "active", "staged", "environment"] as const) {
			expect(screen.getByTestId(`context-window-segment-${kind}`)).toHaveClass(
				"motion-reduce:transition-none",
				"motion-reduce:transform-none",
			)
		}
		expect(screen.getByTestId("context-window-segment-active")).toHaveClass("motion-reduce:animate-none")
	})

	it("gives every non-zero segment a real pixel minimum while zero-token segments remain absent", () => {
		render(
			<ContextWindowSegmentedProgress
				snapshot={snapshot({
					contextWindow: 1_000_000,
					durableContextTokens: 10_000,
					pendingSendTokens: 0,
					receivingTokens: 1,
					stagedTokens: 2_000,
					environmentTokens: 1_000,
				})}
			/>,
		)

		for (const kind of ["durable", "active", "staged", "environment"] as const) {
			expect(screen.getByTestId(`context-window-segment-${kind}`).style.minWidth).toBe("min(3px, 24.674975%)")
		}
	})

	it("keeps raw widths when the staged segment starts with one token", () => {
		render(
			<ContextWindowSegmentedProgress
				snapshot={snapshot({
					contextWindow: 1_000_000,
					phase: "sending",
					durableContextTokens: 10_000,
					pendingSendTokens: 2_000,
					receivingTokens: 0,
					stagedTokens: 1,
					environmentTokens: 1_000,
				})}
			/>,
		)

		const progress = screen.getByTestId("context-window-segmented-progress")
		expect(screen.getByTestId("context-window-segment-active").style.width).toBe("0.2%")
		expect(Number.parseFloat(screen.getByTestId("context-window-segment-staged").style.width)).toBeCloseTo(0.0001, 8)
		expect(screen.getByTestId("context-window-segment-environment").style.width).toBe("0.1%")
		expect(progress).toHaveAttribute("data-minimum-width-percent", "24.674975")
		expect(screen.getByTestId("context-window-segment-active").style.minWidth).toBe("min(3px, 24.674975%)")
	})

	it("preserves raw token ratios for sub-pixel segments", () => {
		render(
			<ContextWindowSegmentedProgress
				snapshot={snapshot({
					contextWindow: 1_000_000,
					phase: "sending",
					durableContextTokens: 10_000,
					pendingSendTokens: 2_000,
					receivingTokens: 0,
					stagedTokens: 1_000,
					environmentTokens: 1_000,
				})}
			/>,
		)

		expect(screen.getByTestId("context-window-segment-durable").style.width).toBe("1%")
		expect(screen.getByTestId("context-window-segment-active").style.width).toBe("0.2%")
		expect(screen.getByTestId("context-window-segment-staged").style.width).toBe("0.1%")
		expect(screen.getByTestId("context-window-segment-environment").style.width).toBe("0.1%")

		const active = screen.getByTestId("context-window-segment-active")
		expect(active).toHaveAttribute("data-authoritative-tokens", "2000")
		expect(active).toHaveAttribute("data-tokens", "2000")
		expect(screen.getByTestId("context-window-segment-environment")).toHaveAttribute("data-tokens", "1000")
		expect(Number.parseFloat(active.style.width)).toBeCloseTo(
			Number.parseFloat(screen.getByTestId("context-window-segment-staged").style.width) * 2,
			8,
		)
	})

	it("keeps zero-token segments at zero width without a minimum-width placeholder", () => {
		render(
			<ContextWindowSegmentedProgress
				snapshot={snapshot({
					phase: "stable",
					durableContextTokens: 40_000,
					pendingSendTokens: 0,
					receivingTokens: 0,
					environmentTokens: 0,
				})}
			/>,
		)

		for (const kind of ["active", "staged", "environment"] as const) {
			const segment = screen.getByTestId(`context-window-segment-${kind}`)
			expect(segment.style.width).toBe("0%")
			expect(segment.style.minWidth).toBe("0px")
			expect(segment.style.opacity).toBe("0")
		}
	})

	it("updates the ENV segment when the backend publishes a freshly recomputed environment", () => {
		const { rerender } = render(
			<ContextWindowSegmentedProgress
				snapshot={snapshot({ phase: "stable", pendingSendTokens: 0, receivingTokens: 0, environmentTokens: 5_000 })}
			/>,
		)

		const envBefore = screen.getByTestId("context-window-segment-environment")
		expect(envBefore).toHaveAttribute("data-tokens", "5000")

		rerender(
			<ContextWindowSegmentedProgress
				snapshot={snapshot({
					revision: 2,
					phase: "stable",
					pendingSendTokens: 0,
					receivingTokens: 0,
					environmentTokens: 9_000,
				})}
			/>,
		)

		const envAfter = screen.getByTestId("context-window-segment-environment")
		expect(envAfter).toHaveAttribute("data-tokens", "9000")
		expect(envAfter).toHaveAttribute("data-authoritative-tokens", "9000")
		expect(envAfter.style.width).toBe("9%")
		expect(envAfter.style.minWidth).toBe("min(3px, 25.5%)")
	})

	it("keeps ENV separate and uses its raw token width after a round completes", () => {
		render(
			<ContextWindowSegmentedProgress
				snapshot={snapshot({
					phase: "stable",
					durableContextTokens: 500,
					pendingSendTokens: 0,
					receivingTokens: 0,
					environmentTokens: 50,
				})}
			/>,
		)

		const durable = screen.getByTestId("context-window-segment-durable")
		const env = screen.getByTestId("context-window-segment-environment")
		expect(durable).toHaveAttribute("data-authoritative-tokens", "500")
		expect(env).toHaveAttribute("data-authoritative-tokens", "50")
		expect(env.style.width).toBe("0.05%")
	})

	it("quantizes repeating segment widths without overflowing the track", () => {
		render(
			<ContextWindowSegmentedProgress
				snapshot={snapshot({
					phase: "sending",
					durableContextTokens: 1,
					pendingSendTokens: 1,
					receivingTokens: 0,
					stagedTokens: 0,
					environmentTokens: 1,
					contextWindow: 3,
				})}
			/>,
		)

		const widths = [
			screen.getByTestId("context-window-segment-durable"),
			screen.getByTestId("context-window-segment-active"),
			screen.getByTestId("context-window-segment-staged"),
			screen.getByTestId("context-window-segment-environment"),
		].map((segment) => segment.style.width)
		expect(widths).toEqual(["33.333333%", "33.333333%", "0%", "33.333284%"])
		expect(widths.reduce((total, width) => total + Number.parseFloat(width), 0)).toBeLessThanOrEqual(100)
	})

	it("keeps raw widths within the track near the context limit", () => {
		render(
			<ContextWindowSegmentedProgress
				snapshot={snapshot({
					durableContextTokens: 99_500,
					pendingSendTokens: 0,
					receivingTokens: 0,
					environmentTokens: 500,
				})}
			/>,
		)

		expect(screen.getByTestId("context-window-segmented-progress")).toHaveAttribute("data-minimum-width-percent", "0")
		expect(screen.getByTestId("context-window-segment-durable").style.width).toBe("99.5%")
		expect(screen.getByTestId("context-window-segment-environment").style.width).toBe("0.5%")
		expect(screen.getByTestId("context-window-segment-durable").style.minWidth).toBe("min(3px, 0%)")
		expect(screen.getByTestId("context-window-segment-environment").style.minWidth).toBe("min(3px, 0%)")
		const totalWidth =
			Number.parseFloat(screen.getByTestId("context-window-segment-durable").style.width) +
			Number.parseFloat(screen.getByTestId("context-window-segment-environment").style.width)
		expect(totalWidth).toBeLessThanOrEqual(100)
	})
})
