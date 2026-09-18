import {
	DEFAULT_MAX_PARALLEL_SUBAGENTS,
	DEFAULT_MAX_PARALLEL_TOOL_CALLS,
	MAX_PARALLEL_SUBAGENTS,
	MAX_PARALLEL_TOOL_CALLS,
	resolveMaxParallelSubagents,
	resolveMaxParallelToolCalls,
} from "@shared/concurrency-limits"
import { describe, expect, it } from "vitest"

describe("tool call concurrency limit", () => {
	it("defaults to 32 when nothing was configured", () => {
		expect(resolveMaxParallelToolCalls(undefined, true)).toBe(32)
		expect(DEFAULT_MAX_PARALLEL_TOOL_CALLS).toBe(32)
	})

	it("refuses to exceed the maximum the user is offered", () => {
		expect(resolveMaxParallelToolCalls(100, true)).toBe(MAX_PARALLEL_TOOL_CALLS)
	})

	it("never resolves to zero, which would stall every turn", () => {
		expect(resolveMaxParallelToolCalls(0, true)).toBe(1)
		expect(resolveMaxParallelToolCalls(-5, true)).toBe(1)
	})

	it("falls back rather than trusting a corrupt persisted value", () => {
		expect(resolveMaxParallelToolCalls(Number.NaN, true)).toBe(DEFAULT_MAX_PARALLEL_TOOL_CALLS)
		expect(resolveMaxParallelToolCalls(Number.POSITIVE_INFINITY, true)).toBe(DEFAULT_MAX_PARALLEL_TOOL_CALLS)
	})

	it("truncates a fractional value instead of rounding past the ceiling", () => {
		expect(resolveMaxParallelToolCalls(4.9, true)).toBe(4)
	})

	it("serializes execution when parallel tool calling is switched off", () => {
		// The toggle outranks the stored ceiling, so turning the feature off
		// must produce serial execution no matter what number was saved.
		expect(resolveMaxParallelToolCalls(32, false)).toBe(1)
		expect(resolveMaxParallelToolCalls(undefined, false)).toBe(1)
	})

	it("restores the configured ceiling when the toggle comes back on", () => {
		// Disabling must not overwrite the saved preference, or the user would
		// have to re-enter it every time they flip the switch.
		expect(resolveMaxParallelToolCalls(8, false)).toBe(1)
		expect(resolveMaxParallelToolCalls(8, true)).toBe(8)
	})
})

describe("subagent concurrency limit", () => {
	it("defaults to 64 when nothing was configured", () => {
		expect(resolveMaxParallelSubagents(undefined)).toBe(64)
		expect(DEFAULT_MAX_PARALLEL_SUBAGENTS).toBe(64)
	})

	it("clamps to its own maximum rather than the tool-call one", () => {
		expect(resolveMaxParallelSubagents(1000)).toBe(MAX_PARALLEL_SUBAGENTS)
		expect(MAX_PARALLEL_SUBAGENTS).toBeGreaterThan(MAX_PARALLEL_TOOL_CALLS)
	})

	it("never resolves to zero", () => {
		expect(resolveMaxParallelSubagents(0)).toBe(1)
	})

	it("stays independent of the tool-call toggle", () => {
		// Subagents are throttled to protect provider capacity, so switching
		// off local parallel tool calling must not also serialize them.
		const withToolCallsOff = resolveMaxParallelSubagents(16)
		expect(withToolCallsOff).toBe(16)
		expect(resolveMaxParallelToolCalls(16, false)).toBe(1)
	})

	it("does not move when the tool-call limit changes", () => {
		const before = resolveMaxParallelSubagents(20)
		expect(resolveMaxParallelToolCalls(2, true)).toBe(2)
		expect(resolveMaxParallelSubagents(20)).toBe(before)
	})
})
