import fs from "node:fs/promises"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DevRuntimeDiagnostics } from "../dev-diagnostics"
import { RuntimeTelemetryLifecycle } from "../lifecycle"
import type { RuntimeSnapshot } from "../performance/runtime-sampler"
import { RuntimeEventBus } from "../runtime-event-bus"
import type { RuntimeTelemetryEvent } from "../types"

const disposals: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const dispose of disposals.splice(0).reverse()) await dispose()
	vi.unstubAllEnvs()
})

const snapshot: RuntimeSnapshot = {
	monotonicMs: 1_000,
	eventLoopDelayMs: 23,
	cpuUtilizationRatio: 0.8,
	heapUsedBytes: 2_000,
	rssBytes: 5_000,
	heapGrowthBytes: 500,
}

describe("development process diagnostics", () => {
	it("bounds health frequency, retains task IDs, and never fabricates a task owner", () => {
		vi.stubEnv("IS_DEV", "true")
		const bus = new RuntimeEventBus({ sessionId: "session-a" })
		const diagnostics = new DevRuntimeDiagnostics(bus, {
			enabled: () => true,
			activeTaskIds: () => ["task-a", "task-b", "task-a"],
			memory: () => ({ heap_size_limit_bytes: 20_000 }),
		})
		bus.context.run({ taskId: "wrong-owner" }, () => {
			diagnostics.snapshot(snapshot)
			diagnostics.snapshot({ ...snapshot, monotonicMs: 2_000 })
			diagnostics.snapshot({ ...snapshot, monotonicMs: 31_000 })
		})
		const events = bus.drain()
		expect(events).toHaveLength(2)
		expect(events[0].context.taskId).toBeUndefined()
		expect(events[0].traceContext).toBeUndefined()
		expect(events[0].attributes).toMatchObject({
			"active_task_ids.0": "task-a",
			"active_task_ids.1": "task-b",
			active_task_count: 2,
			process_pid: process.pid,
			heap_used_bytes: 2_000,
			heap_size_limit_bytes: 20_000,
			event_loop_delay_ms: 23,
		})
		bus.dispose()
	})

	it("does not inspect process/task details when disabled and propagates business errors unchanged", async () => {
		const bus = new RuntimeEventBus()
		const memory = vi.fn(() => ({}))
		const tasks = vi.fn(() => [])
		const diagnostics = new DevRuntimeDiagnostics(bus, { enabled: () => false, activeTaskIds: tasks, memory })
		diagnostics.snapshot(snapshot)
		const failure = new Error("original business failure")
		await expect(
			diagnostics.observe("cleanup", async () => {
				throw failure
			}),
		).rejects.toBe(failure)
		expect(bus.drain()).toHaveLength(0)
		expect(memory).not.toHaveBeenCalled()
		expect(tasks).not.toHaveBeenCalled()
		bus.dispose()
	})

	it.each([
		["true", "enabled", true],
		["false", "enabled", false],
		["true", "disabled", false],
		["true", "unset", false],
	] as const)("respects IS_DEV=%s and consent=%s through lifecycle shutdown", async (isDev, setting, expected) => {
		vi.stubEnv("IS_DEV", isDev)
		const root = path.join(process.cwd(), "tmp")
		await fs.mkdir(root, { recursive: true })
		const dataDir = await fs.mkdtemp(path.join(root, "dev-otel-"))
		disposals.push(() => fs.rm(dataDir, { recursive: true, force: true }))
		const events: RuntimeTelemetryEvent[] = []
		const lifecycle = new RuntimeTelemetryLifecycle({
			dataDir,
			sessionId: "dev-session",
			samplerIntervalMs: 0,
			drainIntervalMs: 0,
			onEvent: (event) => events.push(event),
			activeTaskIds: () => ["task-a"],
		})
		disposals.push(() => lifecycle.dispose())
		await lifecycle.applyConsent(setting)
		await lifecycle.diagnostics.observe("shutdown.controllers", async () => {})
		await lifecycle.dispose()
		if (!expected) {
			expect(events).toHaveLength(0)
			return
		}
		expect(events.map((event) => event.attributes.stage)).toEqual([
			"telemetry.started",
			"shutdown.controllers",
			"shutdown.controllers",
			"telemetry.stopping",
			"telemetry.final_flush",
		])
		expect(events.every((event) => event.context.taskId === undefined)).toBe(true)
		expect(events[2].attributes.outcome).toBe("completed")
	})
})
