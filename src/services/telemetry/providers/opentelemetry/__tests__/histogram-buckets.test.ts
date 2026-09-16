import { describe, expect, it, vi } from "vitest"

/**
 * Behavior guard for duration histogram bucket bounds.
 *
 * The SDK default stops at 10s, and that ceiling was reached in practice: over
 * 24h, 61,178 samples were recorded for `terminal.execute_complete` and
 * `tool.execution` while only 44,517 fell at or below 10s. With 27% of samples
 * landing in `+Inf`, a p95 read back as exactly 10000 whether the real value
 * was twelve seconds or four minutes.
 *
 * The advice is deliberately per metric. These bounds are milliseconds, so
 * applying them to a metric measured in seconds, tokens or bytes would put
 * every sample in the first bucket.
 */

vi.mock("@/hosts/host-provider", () => ({ HostProvider: {} }))
vi.mock("@/services/error", () => ({ getErrorLevelFromString: () => undefined }))
vi.mock("@/services/logging/distinctId", () => ({ getDistinctId: () => "test", setDistinctId: () => {} }))
vi.mock("@/shared/proto/dline/host", () => ({ Setting: {} }))
vi.mock("@/shared/services/Logger", () => ({
	Logger: {
		info: () => {},
		warn: () => {},
		error: () => {},
		debug: () => {},
		log: () => {},
		trace: () => {},
		isDebugEnabled: () => false,
	},
}))

const { OpenTelemetryTelemetryProvider } = await import("../OpenTelemetryTelemetryProvider")

interface CreatedHistogram {
	name: string
	options?: { advice?: { explicitBucketBoundaries?: number[] } }
}

interface RecordedSample {
	name: string
	value: number
	attributes?: Record<string, unknown>
}

/** Drive the provider with a meter that records how each instrument was created. */
function createProvider() {
	const created: CreatedHistogram[] = []
	const recorded: RecordedSample[] = []
	const provider = Object.create(OpenTelemetryTelemetryProvider.prototype) as {
		recordHistogram(name: string, value: number, attributes?: Record<string, unknown>, description?: string): void
	}
	Object.assign(provider, {
		meter: {
			createHistogram: (name: string, options?: CreatedHistogram["options"]) => {
				created.push({ name, options })
				return {
					record: (value: number, attributes?: Record<string, unknown>) => recorded.push({ name, value, attributes }),
				}
			},
		},
		histograms: new Map(),
		isEnabled: () => true,
		canonicalAttributes: (attributes?: Record<string, unknown>) => attributes ?? {},
	})
	return { provider, created, recorded }
}

describe("duration histogram buckets", () => {
	it("extends the runtime duration ceiling past the SDK default", () => {
		const { provider, created } = createProvider()

		provider.recordHistogram("dline.runtime.operation.duration", 42)

		const bounds = created[0]?.options?.advice?.explicitBucketBoundaries
		expect(bounds).toBeDefined()
		// The previous ceiling, where 27% of real samples were piling up.
		expect(bounds?.at(-1)).toBeGreaterThan(10_000)
	})

	it("keeps the sub-10s bounds the SDK already used", () => {
		// Existing series stay comparable across this change only if the lower
		// bounds are unchanged; moving them would silently reshape history.
		const { provider, created } = createProvider()

		provider.recordHistogram("dline.runtime.operation.duration", 42)

		const bounds = created[0]?.options?.advice?.explicitBucketBoundaries ?? []
		expect(bounds.filter((bound) => bound <= 10_000)).toEqual([
			0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1_000, 2_500, 5_000, 7_500, 10_000,
		])
	})

	it("reports bounds in ascending order", () => {
		// An unordered list is rejected by the SDK and would disable the
		// histogram rather than fail loudly.
		const { provider, created } = createProvider()

		provider.recordHistogram("dline.runtime.operation.duration", 42)

		const bounds = created[0]?.options?.advice?.explicitBucketBoundaries ?? []
		expect(bounds).toEqual([...bounds].sort((left, right) => left - right))
		expect(new Set(bounds).size).toBe(bounds.length)
	})

	it("leaves metrics measured in other units on the SDK default", () => {
		// These bounds are milliseconds. Applied to seconds or tokens they
		// would collapse every sample into the first bucket.
		const { provider, created } = createProvider()

		provider.recordHistogram("dline.api.duration.seconds", 1.5)

		expect(created[0]?.options?.advice).toBeUndefined()
	})

	it("still forwards the description when advice applies", () => {
		const { provider, created } = createProvider()

		provider.recordHistogram("dline.runtime.operation.duration", 42, {}, "Runtime operation duration")

		expect(created[0]?.options).toMatchObject({ description: "Runtime operation duration" })
	})
})

describe("bucket schema labelling", () => {
	it("stamps the schema version on samples whose bounds are chosen here", () => {
		// Extension hosts update independently, so an older host keeps
		// exporting the previous layout into this same metric name. Summing
		// both layouts breaks quantiles: `le="15000"` exists only in the newer
		// one, counts fewer samples than `le="10000"`, and the monotonicity
		// repair pushes the estimate toward the highest finite bound. The label
		// is what lets a quantile query pin one layout.
		const { provider, recorded } = createProvider()

		provider.recordHistogram("dline.runtime.operation.duration", 42, { operation: "checkpoint.commit" })

		expect(recorded[0]?.attributes).toMatchObject({
			operation: "checkpoint.commit",
			bucket_schema: "v2",
		})
	})

	it("leaves samples on the SDK default layout unlabelled", () => {
		// Labelling a histogram whose bounds this code never chose would claim
		// a stability guarantee it cannot make.
		const { provider, recorded } = createProvider()

		provider.recordHistogram("dline.api.duration.seconds", 1.5, { provider: "openai" })

		expect(recorded[0]?.attributes).not.toHaveProperty("bucket_schema")
	})

	it("labels every sample, not only the one that created the instrument", () => {
		// The instrument is cached after first use, so a label applied during
		// creation would be missing from every later sample.
		const { provider, recorded } = createProvider()

		provider.recordHistogram("dline.runtime.operation.duration", 42)
		provider.recordHistogram("dline.runtime.operation.duration", 4200)

		expect(recorded).toHaveLength(2)
		expect(recorded[1]?.attributes).toMatchObject({ bucket_schema: "v2" })
	})
})
