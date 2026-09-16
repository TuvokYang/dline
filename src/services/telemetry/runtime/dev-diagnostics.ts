import { getHeapStatistics } from "node:v8"
import type { RuntimeSnapshot } from "./performance/runtime-sampler"
import type { RuntimeEventBus } from "./runtime-event-bus"
import { RuntimeEventPriority } from "./types"

const HEALTH_LOG_INTERVAL_MS = 30_000
const MAX_ACTIVE_TASKS = 32

export interface DevDiagnosticsOptions {
	readonly enabled: () => boolean
	readonly activeTaskIds?: () => readonly string[]
	readonly memory?: () => Record<string, number>
}

/** Low-volume process evidence; no signal handlers, raw content, or independent exporter. */
export class DevRuntimeDiagnostics {
	private lastHealthAt: number | undefined

	constructor(
		private readonly bus: RuntimeEventBus,
		private readonly options: DevDiagnosticsOptions,
	) {}

	phase(stage: string, outcome: "started" | "completed" | "failed", durationMs?: number): void {
		this.record(
			"runtime.lifecycle",
			{ stage, outcome, ...(durationMs === undefined ? {} : { duration_ms: durationMs }) },
			outcome === "failed",
		)
	}

	async observe<T>(stage: string, action: () => Promise<T>): Promise<T> {
		const startedAt = performance.now()
		this.phase(stage, "started")
		try {
			const result = await action()
			this.phase(stage, "completed", performance.now() - startedAt)
			return result
		} catch (error) {
			this.phase(stage, "failed", performance.now() - startedAt)
			throw error
		}
	}

	snapshot(snapshot: RuntimeSnapshot): void {
		if (!this.options.enabled()) return
		if (this.lastHealthAt !== undefined && snapshot.monotonicMs - this.lastHealthAt < HEALTH_LOG_INTERVAL_MS) {
			return
		}
		this.lastHealthAt = snapshot.monotonicMs
		this.record("runtime.health", {
			event_loop_delay_ms: snapshot.eventLoopDelayMs,
			cpu_utilization_ratio: snapshot.cpuUtilizationRatio,
			heap_used_bytes: snapshot.heapUsedBytes,
			heap_growth_bytes: snapshot.heapGrowthBytes,
			rss_bytes: snapshot.rssBytes,
		})
	}

	reset(): void {
		this.lastHealthAt = undefined
	}

	private record(name: string, fields: Readonly<Record<string, unknown>>, failed = false): void {
		if (!this.options.enabled()) return
		try {
			const tasks = [...new Set(this.options.activeTaskIds?.() ?? [])]
			const attributes = {
				component: "runtime",
				scope: "process",
				process_pid: process.pid,
				process_uptime_seconds: process.uptime(),
				...(this.options.memory ?? processMemory)(),
				active_task_count: tasks.length,
				active_task_ids: tasks.slice(0, MAX_ACTIVE_TASKS),
				active_tasks_truncated: tasks.length > MAX_ACTIVE_TASKS,
				queue_depth: this.bus.peek().length,
				dropped_events: this.bus.drops.total,
				...fields,
			}
			// Timers created under a task must not attribute process health to that task.
			this.bus.context.restore(this.bus.context.sessionContext, () =>
				this.bus.record({
					name,
					priority: failed ? RuntimeEventPriority.Error : RuntimeEventPriority.Info,
					attributes,
					processScoped: true,
				}),
			)
		} catch {
			// Diagnostics must never disrupt startup, cleanup, or the sampler timer.
		}
	}
}

function processMemory(): Record<string, number> {
	const memory = process.memoryUsage()
	return {
		heap_used_bytes: memory.heapUsed,
		heap_total_bytes: memory.heapTotal,
		heap_size_limit_bytes: getHeapStatistics().heap_size_limit,
		external_bytes: memory.external,
		array_buffers_bytes: memory.arrayBuffers,
		rss_bytes: memory.rss,
	}
}
