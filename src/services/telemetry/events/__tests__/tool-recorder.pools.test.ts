import { describe, expect, it } from "vitest"
import type { TelemetrySignalSink } from "../../providers/capabilities"
import { TELEMETRY_METRICS } from "../catalog"
import type { TaskAggregates } from "../task-aggregates"
import { ToolEventRecorder } from "../tool-recorder"

/**
 * The shared runtime histogram every instrumented phase reports into.
 *
 * It is named by `DurationRecorder`, not by the metric catalogue, so the name
 * is repeated here as a literal. That is deliberate: the point of the check is
 * that nothing in this file's call paths reaches that instrument, and a shared
 * constant would not make the assertion any stronger.
 */
const SHARED_RUNTIME_DURATION_METRIC = "dline.runtime.operation.duration"

interface RecordedMeasurement {
	readonly kind: "histogram" | "gauge" | "counter"
	readonly name: string
	readonly value: number | null
	readonly attributes?: Record<string, unknown>
}

interface RecordedEvent {
	readonly name: string
	readonly properties?: Record<string, unknown>
}

/**
 * A sink that keeps what was recorded rather than asserting on calls.
 *
 * The claims under test are about the emitted values — their unit, their
 * attributes, and which instrument received them — so the test has to read the
 * measurements themselves. Counting calls on a mock would pass even if the
 * queue wait were reported in milliseconds against the duration histogram.
 */
function createCapturingSink(options: { readonly categoriesEnabled?: boolean } = {}) {
	const measurements: RecordedMeasurement[] = []
	const events: RecordedEvent[] = []
	const sink: TelemetrySignalSink = {
		captureEvent: (name, properties) => {
			events.push({ name, properties })
		},
		recordCounter: (name, value, attributes) => {
			measurements.push({ kind: "counter", name, value, attributes })
		},
		recordHistogram: (name, value, attributes) => {
			measurements.push({ kind: "histogram", name, value, attributes })
		},
		recordGauge: (name, value, attributes) => {
			measurements.push({ kind: "gauge", name, value, attributes })
		},
		isCategoryEnabled: () => options.categoriesEnabled ?? true,
	}
	return { sink, measurements, events }
}

function createRecorder(options: { readonly categoriesEnabled?: boolean } = {}) {
	const captured = createCapturingSink(options)
	// The aggregates are only read by the tool-usage paths, which these tests
	// do not exercise; an empty stand-in keeps the recorder constructible
	// without pulling task state into a telemetry-shape test.
	const recorder = new ToolEventRecorder(captured.sink, {} as TaskAggregates)
	return { ...captured, recorder }
}

function findMeasurement(measurements: readonly RecordedMeasurement[], name: string, pool?: string) {
	return measurements.find((entry) => entry.name === name && (pool === undefined || entry.attributes?.pool === pool))
}

describe("VER-TASK-007-POOL: pool admission reports a wait and the occupancy that caused it", () => {
	it("reports the queue wait in seconds and the occupancy at the same sampling point", () => {
		const { recorder, measurements } = createRecorder()

		recorder.capturePoolAdmission({ pool: "tool", queueWaitMs: 2500, running: 4, queued: 3, limit: 4 })

		const wait = findMeasurement(measurements, TELEMETRY_METRICS.POOLS.QUEUE_WAIT_SECONDS)
		// Milliseconds in, seconds out: the metric name ends in `.seconds`, and
		// an alert threshold written against it would be off by 1000x if the
		// raw millisecond figure were passed through.
		expect(wait?.value).toBe(2.5)
		expect(wait?.kind).toBe("histogram")
		expect(findMeasurement(measurements, TELEMETRY_METRICS.POOLS.RUNNING)?.value).toBe(4)
		expect(findMeasurement(measurements, TELEMETRY_METRICS.POOLS.QUEUED)?.value).toBe(3)
		expect(findMeasurement(measurements, TELEMETRY_METRICS.POOLS.LIMIT)?.value).toBe(4)
	})

	it("distinguishes a saturated pool from an idle one", () => {
		const saturated = createRecorder()
		saturated.recorder.capturePoolAdmission({ pool: "tool", queueWaitMs: 9000, running: 4, queued: 6, limit: 4 })

		const idle = createRecorder()
		idle.recorder.capturePoolAdmission({ pool: "tool", queueWaitMs: 0, running: 1, queued: 0, limit: 4 })

		// Saturation is the pair (running at the limit, work still queued). One
		// number alone cannot express it: a long wait with an empty queue is a
		// slow admission, and a full queue with running below the limit is
		// withheld capacity rather than an undersized limit.
		const saturatedRunning = findMeasurement(saturated.measurements, TELEMETRY_METRICS.POOLS.RUNNING)?.value
		const saturatedLimit = findMeasurement(saturated.measurements, TELEMETRY_METRICS.POOLS.LIMIT)?.value
		const saturatedQueued = findMeasurement(saturated.measurements, TELEMETRY_METRICS.POOLS.QUEUED)?.value
		expect(saturatedRunning).toBe(saturatedLimit)
		expect(saturatedQueued).toBeGreaterThan(0)

		const idleRunning = findMeasurement(idle.measurements, TELEMETRY_METRICS.POOLS.RUNNING)?.value as number
		const idleLimit = findMeasurement(idle.measurements, TELEMETRY_METRICS.POOLS.LIMIT)?.value as number
		expect(idleRunning).toBeLessThan(idleLimit)
		expect(findMeasurement(idle.measurements, TELEMETRY_METRICS.POOLS.QUEUED)?.value).toBe(0)
	})

	it("re-samples occupancy on release without recording another wait", () => {
		const { recorder, measurements } = createRecorder()

		recorder.recordPoolOccupancy({ pool: "tool", running: 0, queued: 0, limit: 4 })

		// Without a release-side sample the gauges would keep their last
		// admission values and read as permanently saturated.
		expect(findMeasurement(measurements, TELEMETRY_METRICS.POOLS.RUNNING)?.value).toBe(0)
		expect(findMeasurement(measurements, TELEMETRY_METRICS.POOLS.QUEUE_WAIT_SECONDS)).toBeUndefined()
	})
})

describe("VER-TASK-007-POOL-ATTRIBUTION: each pool reports its own limit under a bounded label", () => {
	it("separates the two pools by label and keeps their limits independent", () => {
		const { recorder, measurements } = createRecorder()

		recorder.capturePoolAdmission({ pool: "tool", queueWaitMs: 100, running: 8, queued: 0, limit: 8 })
		recorder.capturePoolAdmission({ pool: "subagent", queueWaitMs: 4000, running: 2, queued: 5, limit: 2 })

		// A saturation incident has to name the limit to lower. Reading back
		// per pool is what proves the two are not collapsed into one series.
		expect(findMeasurement(measurements, TELEMETRY_METRICS.POOLS.LIMIT, "tool")?.value).toBe(8)
		expect(findMeasurement(measurements, TELEMETRY_METRICS.POOLS.LIMIT, "subagent")?.value).toBe(2)
		expect(findMeasurement(measurements, TELEMETRY_METRICS.POOLS.QUEUED, "tool")?.value).toBe(0)
		expect(findMeasurement(measurements, TELEMETRY_METRICS.POOLS.QUEUED, "subagent")?.value).toBe(5)
	})

	it("uses only the two known pool values as labels", () => {
		const { recorder, measurements } = createRecorder()

		recorder.capturePoolAdmission({ pool: "tool", queueWaitMs: 1, running: 1, queued: 0, limit: 4 })
		recorder.capturePoolAdmission({ pool: "subagent", queueWaitMs: 1, running: 1, queued: 0, limit: 4 })

		const pools = new Set(measurements.map((entry) => entry.attributes?.pool))
		// The label set is closed by the ExecutionPool type. Asserting the
		// observed set stays inside it is what keeps the cardinality bounded
		// as further pools are considered.
		expect([...pools].sort()).toEqual(["subagent", "tool"])
	})
})

describe("VER-TASK-007-FANOUT: a batch reports its width and how many items chose a Profile", () => {
	it("records the item count and the explicitly bound subset separately", () => {
		const { recorder, measurements } = createRecorder()

		recorder.captureSubagentFanout(5, 2)

		expect(findMeasurement(measurements, TELEMETRY_METRICS.SUBAGENT_FANOUT.BATCH_ITEMS)?.value).toBe(5)
		// Items that inherited a Profile from YAML or the parent are excluded
		// by construction: the caller counts only the tool parameter, so this
		// figure answers whether the new per-item parameter is used at all.
		expect(findMeasurement(measurements, TELEMETRY_METRICS.SUBAGENT_FANOUT.EXPLICIT_PROFILE_ITEMS)?.value).toBe(2)
	})

	it("stays silent when subagent telemetry is disabled", () => {
		const { recorder, measurements } = createRecorder({ categoriesEnabled: false })

		recorder.captureSubagentFanout(5, 2)

		expect(measurements).toHaveLength(0)
	})
})

describe("VER-TASK-007-CARDINALITY: counts are values, never labels", () => {
	it("attaches no attributes at all to the fan-out measurements", () => {
		const { recorder, measurements } = createRecorder()

		recorder.captureSubagentFanout(32, 32)

		// A batch may carry up to the per-batch maximum, so a width label would
		// add one series per distinct batch size.
		for (const measurement of measurements) {
			expect(measurement.attributes).toBeUndefined()
		}
	})

	it("keeps agent names, profile names, and ids out of pool attributes", () => {
		const { recorder, measurements } = createRecorder()

		recorder.capturePoolAdmission({ pool: "subagent", queueWaitMs: 1200, running: 3, queued: 9, limit: 3 })

		for (const measurement of measurements) {
			// `pool` is the only permitted key: anything else here would be an
			// unbounded value promoted to a label.
			expect(Object.keys(measurement.attributes ?? {})).toEqual(["pool"])
		}
	})
})

describe("VER-TASK-007-HISTOGRAM: the new measurements keep to their own instruments", () => {
	it("does not write into the shared runtime duration histogram", () => {
		const { recorder, measurements } = createRecorder()

		recorder.capturePoolAdmission({ pool: "tool", queueWaitMs: 2500, running: 2, queued: 1, limit: 2 })
		recorder.captureSubagentFanout(4, 1)

		// The shared histogram's buckets are millisecond durations. A count of
		// items or a figure in seconds landing there would be placed against
		// bounds that do not describe it, corrupting every quantile read from
		// that metric, not just the new one.
		const names = measurements.map((entry) => entry.name)
		expect(names).not.toContain(SHARED_RUNTIME_DURATION_METRIC)
		expect(names.every((name) => name.startsWith("dline.pool.") || name.startsWith("dline.subagent.fanout."))).toBe(true)
	})

	it("records occupancy as gauges rather than histogram samples", () => {
		const { recorder, measurements } = createRecorder()

		recorder.capturePoolAdmission({ pool: "tool", queueWaitMs: 10, running: 2, queued: 1, limit: 2 })

		// Occupancy is a level, not a distribution: recording it as a histogram
		// would make `rate()` over the bucket counts look like throughput.
		expect(findMeasurement(measurements, TELEMETRY_METRICS.POOLS.RUNNING)?.kind).toBe("gauge")
		expect(findMeasurement(measurements, TELEMETRY_METRICS.POOLS.QUEUED)?.kind).toBe("gauge")
		expect(findMeasurement(measurements, TELEMETRY_METRICS.POOLS.LIMIT)?.kind).toBe("gauge")
		expect(findMeasurement(measurements, TELEMETRY_METRICS.POOLS.QUEUE_WAIT_SECONDS)?.kind).toBe("histogram")
	})
})
