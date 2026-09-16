import { Meter, type MetricAdvice, type MetricOptions } from "@opentelemetry/api"
import type { Logger as OTELLogger } from "@opentelemetry/api-logs"
import { LoggerProvider } from "@opentelemetry/sdk-logs"
import { MeterProvider } from "@opentelemetry/sdk-metrics"
import { HostProvider } from "@/hosts/host-provider"
import { getErrorLevelFromString } from "@/services/error"
import { getDistinctId, setDistinctId } from "@/services/logging/distinctId"
import { Setting } from "@/shared/proto/dline/host"
import { Logger } from "@/shared/services/Logger"
import type { ClineAccountUserInfo } from "../../../auth/AuthService"
import { logRecordFields } from "../../otel/log-record"
import { USAGE_SCOPE_NAME } from "../../otel/scopes"
import { RuntimeContentPolicy } from "../../runtime/content-policy"
import { canonicalizeTelemetryProperties } from "../../service/canonicalization"
import type { ITelemetryProvider, TelemetryProperties, TelemetrySettings } from "../ITelemetryProvider"
import type { OpenTelemetryClientProvider } from "./OpenTelemetryClientProvider"
import type { OpenTelemetryTraceProvider } from "./OpenTelemetryTraceProvider"

/**
 * Bucket bounds for runtime operation durations, in milliseconds.
 *
 * The SDK default stops at 10s, and that ceiling was reached in practice: over
 * 24h, 61,178 samples were recorded for `terminal.execute_complete` and
 * `tool.execution` but only 44,517 fell at or below 10s. With 27% of samples in
 * `+Inf`, no quantile above roughly p73 could be resolved, so a p95 read back
 * as exactly 10000 whether the real value was twelve seconds or four minutes.
 *
 * The added bounds extend to ten minutes, which covers a long-running command
 * or a tool waiting on a slow workspace. The bounds below 10s are kept as the
 * SDK had them so existing series stay comparable across this change.
 */
const OPERATION_DURATION_BUCKETS_MS = [
	0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1_000, 2_500, 5_000, 7_500, 10_000,
	// Beyond the previous ceiling.
	15_000, 30_000, 60_000, 120_000, 300_000, 600_000,
]

/** Duration histograms that need the extended ceiling, by metric name. */
const BUCKET_ADVICE: ReadonlyMap<string, MetricAdvice> = new Map([
	["dline.runtime.operation.duration", { explicitBucketBoundaries: OPERATION_DURATION_BUCKETS_MS }],
])

/**
 * Label identifying which bucket layout a sample was recorded against.
 *
 * Extension hosts update independently, so a host running the previous build
 * keeps exporting the old layout into the same metric name. Quantiles are what
 * breaks when the two are summed: `le="15000"` exists only in the new layout,
 * so it counts fewer samples than `le="10000"`, and the monotonicity repair
 * pushes the estimate toward the highest finite bound. Counts and sums are
 * unaffected, which is why the metric keeps its name and the layouts are told
 * apart by a label that only quantile queries need to pin.
 */
const BUCKET_SCHEMA_LABEL = "bucket_schema"

/** Bumped whenever a bucket layout above changes, never reused. */
const BUCKET_SCHEMA_VERSION = "v2"

/**
 * Bucket advice for one metric, or undefined to keep the SDK default.
 *
 * Advice is per metric rather than global: the bounds above are milliseconds,
 * and applying them to a metric measured in seconds, tokens or bytes would put
 * every sample in the first bucket.
 */
function bucketAdviceFor(name: string): MetricAdvice | undefined {
	return BUCKET_ADVICE.get(name)
}

/**
 * OpenTelemetry implementation of the telemetry provider interface.
 * Handles metrics and event logging using OpenTelemetry standards.
 */
export class OpenTelemetryTelemetryProvider implements ITelemetryProvider {
	private meter: Meter | null = null
	private logger: OTELLogger | null = null
	private telemetrySettings: TelemetrySettings
	private userAttributes: Record<string, string> = {}
	private readonly contentPolicy = new RuntimeContentPolicy()
	private readonly eventContentPolicy = RuntimeContentPolicy.forEvents()
	// Lazy instrument caches for metrics
	private counters = new Map<string, ReturnType<Meter["createCounter"]>>()
	private histograms = new Map<string, ReturnType<Meter["createHistogram"]>>()
	private gauges = new Map<string, ReturnType<Meter["createObservableGauge"]>>()
	private gaugeValues = new Map<string, Map<string, { value: number; attributes?: TelemetryProperties }>>()

	private meterProvider: MeterProvider | null = null
	private loggerProvider: LoggerProvider | null = null

	readonly name: string
	private readonly owner: OpenTelemetryClientProvider | undefined
	private readonly traceProvider: OpenTelemetryTraceProvider | undefined

	constructor(
		meterProvider: MeterProvider | null,
		loggerProvider: LoggerProvider | null,
		{
			name,
			owner,
			traceProvider,
		}: {
			name?: string
			owner?: OpenTelemetryClientProvider
			traceProvider?: OpenTelemetryTraceProvider
		} = {},
	) {
		this.name = name || "OpenTelemetryProvider"
		this.owner = owner
		this.traceProvider = traceProvider

		// Initialize telemetry settings
		this.telemetrySettings = {
			hostEnabled: true,
			level: "all",
		}

		if (meterProvider) {
			this.meter = meterProvider.getMeter(USAGE_SCOPE_NAME)
			this.meterProvider = meterProvider
		}

		if (loggerProvider) {
			this.logger = loggerProvider.getLogger(USAGE_SCOPE_NAME)
			this.loggerProvider = loggerProvider
		}

		// Log initialization status
		const loggerReady = !!this.logger
		const meterReady = !!this.meter
		if (loggerReady || meterReady) {
			Logger.debug(`[OTEL] Provider initialized - Logger: ${loggerReady}, Meter: ${meterReady}`)
		}
	}

	public async initialize(): Promise<OpenTelemetryTelemetryProvider> {
		// Listen for host telemetry changes
		HostProvider.env.subscribeToTelemetrySettings(
			{},
			{
				onResponse: (event: { isEnabled: Setting }) => {
					const hostEnabled = event.isEnabled === Setting.ENABLED || event.isEnabled === Setting.UNSUPPORTED
					this.telemetrySettings.hostEnabled = hostEnabled
				},
			},
		)

		// Check host-specific telemetry setting (e.g. VS Code setting)
		const hostSettings = await HostProvider.env.getTelemetrySettings({})
		if (hostSettings.isEnabled === Setting.DISABLED) {
			this.telemetrySettings.hostEnabled = false
		}

		this.telemetrySettings.level = await this.getTelemetryLevel()
		return this
	}

	async forceFlush() {
		await Promise.all([
			this.owner?.forceFlush() ?? Promise.all([this.meterProvider?.forceFlush(), this.loggerProvider?.forceFlush()]),
			this.traceProvider?.forceFlush(),
		])
	}

	public log(event: string, properties?: TelemetryProperties): void {
		if (!this.isEnabled() || this.telemetrySettings.level === "off") {
			return
		}

		// Host-level severity filtering is applied centrally by channel policy.
		// Record log event (primary path)
		if (this.logger) {
			this.logger.emit({
				...logRecordFields(properties),
				body: event,
				attributes: this.eventAttributes(properties),
			})
		}
	}

	public logRequired(event: string, properties?: TelemetryProperties): void {
		// "Required" preserves ordering during a consent transition; it never
		// bypasses the central consent or host gate.
		if (this.isEnabled() && this.logger) {
			this.logger.emit({
				...logRecordFields(properties),
				body: event,
				attributes: this.eventAttributes(properties, true),
			})
		}
	}

	public identifyUser(userInfo: ClineAccountUserInfo, properties: TelemetryProperties = {}): void {
		if (!this.isEnabled() || !userInfo) {
			return
		}

		// Always refresh cached user/org attributes so subsequent logs
		// include up-to-date organization context (e.g. after org switch
		// or extension restart with the same user ID).
		this.userAttributes = this.buildUserAttributes(userInfo, properties)

		const distinctId = getDistinctId()

		// Only emit identification event and update distinct ID when the
		// user ID actually changes (first login or user switch).
		if (userInfo.id !== distinctId) {
			if (this.logger) {
				this.logger.emit({
					severityText: "INFO",
					body: "user_identified",
					attributes: this.canonicalAttributes({
						...this.userAttributes,
						alias: distinctId,
					}),
				})
			}

			// Ensure distinct ID is updated so that we will not identify the user again
			setDistinctId(userInfo.id)
		}
	}

	/**
	 * Build a flat record of user and organization attributes for use as
	 * OpenTelemetry log/event attributes.
	 */
	private buildUserAttributes(userInfo: ClineAccountUserInfo, properties: TelemetryProperties = {}): Record<string, string> {
		const activeOrg = userInfo.organizations?.find((org) => org.active)

		return {
			user_id: userInfo.id,
			user_name: userInfo.displayName || "",

			...(activeOrg && {
				organization_id: activeOrg.organizationId,
				organization_name: activeOrg.name,
				member_id: activeOrg.memberId,
				member_role: activeOrg.roles[0] || "member",
			}),
			...properties,
		}
	}

	private canonicalAttributes(properties?: TelemetryProperties): Record<string, string | number | boolean> {
		return { ...canonicalizeTelemetryProperties(properties, this.contentPolicy).attributes }
	}

	private eventAttributes(properties?: TelemetryProperties, required = false): Record<string, string | number | boolean> {
		const channel = properties?.telemetry_channel
		const attributes = {
			...canonicalizeTelemetryProperties(
				{
					...(required ? { _required: true } : {}),
					...this.userAttributes,
					...properties,
				},
				this.eventContentPolicy,
			).attributes,
		}
		// The persistent installation identifier correlates usage and failures for
		// one Dline installation. Channel consent is enforced by the registry before
		// this provider is invoked, so independently disabled channels emit nothing.
		if (channel === "usage" || channel === "error" || channel === "runtime") {
			attributes.distinct_id = getDistinctId()
		}
		return attributes
	}

	public isEnabled(): boolean {
		return this.telemetrySettings.hostEnabled && this.telemetrySettings.level !== "off"
	}

	public getSettings(): TelemetrySettings {
		return { ...this.telemetrySettings }
	}

	/**
	 * Record a counter metric (cumulative value that only increases)
	 * Lazy creation - only creates the counter on first use if meter is available.
	 */
	public recordCounter(
		name: string,
		value: number,
		attributes?: TelemetryProperties,
		description?: string,
		_required = false,
	): void {
		if (!this.meter || !this.isEnabled()) {
			return
		}

		let counter = this.counters.get(name)
		if (!counter) {
			const options = description ? { description } : undefined
			counter = this.meter.createCounter(name, options)
			this.counters.set(name, counter)
			Logger.debug(`[OTEL] Created counter: ${name}`)
		}

		counter.add(value, this.canonicalAttributes(attributes))
	}

	/**
	 * Record a histogram metric (distribution of values for percentile analysis)
	 * Lazy creation - only creates the histogram on first use if meter is available.
	 */
	public recordHistogram(
		name: string,
		value: number,
		attributes?: TelemetryProperties,
		description?: string,
		_required = false,
	): void {
		if (!this.meter || !this.isEnabled()) {
			return
		}

		const advice = bucketAdviceFor(name)

		let histogram = this.histograms.get(name)
		if (!histogram) {
			const options: MetricOptions | undefined =
				description || advice ? { ...(description ? { description } : {}), ...(advice ? { advice } : {}) } : undefined
			histogram = this.meter.createHistogram(name, options)
			this.histograms.set(name, histogram)
			Logger.debug(`[OTEL] Created histogram: ${name}`)
		}

		const canonical = this.canonicalAttributes(attributes)
		// Stamped only where bounds were chosen here. A histogram left on the
		// SDK default has no layout of ours to version, and labelling it would
		// claim a guarantee this code does not make.
		histogram.record(value, advice ? { ...canonical, [BUCKET_SCHEMA_LABEL]: BUCKET_SCHEMA_VERSION } : canonical)
	}

	/**
	 * Record a gauge metric (point-in-time value that can go up or down)
	 * Lazy creation - creates an observable gauge that reads from stored values
	 */
	public recordGauge(
		name: string,
		value: number | null,
		attributes?: TelemetryProperties,
		description?: string,
		_required = false,
	): void {
		if (!this.meter || !this.isEnabled()) {
			return
		}

		const canonicalAttributes = this.canonicalAttributes(attributes)
		const attrKey = JSON.stringify(canonicalAttributes)

		const existingSeries = this.gaugeValues.get(name)

		if (value === null) {
			if (existingSeries) {
				existingSeries.delete(attrKey)
				if (existingSeries.size === 0) {
					this.gaugeValues.delete(name)
					this.gauges.delete(name)
				}
			}
			return
		}

		let series = existingSeries
		if (!series) {
			series = new Map()
			this.gaugeValues.set(name, series)
		}

		if (!this.gauges.has(name)) {
			const options = description ? { description } : undefined
			const gauge = this.meter.createObservableGauge(name, options)

			gauge.addCallback((observableResult) => {
				const snapshot = this.snapshotGaugeSeries(name)
				if (snapshot.length === 0) {
					return
				}
				for (const data of snapshot) {
					observableResult.observe(data.value, this.canonicalAttributes(data.attributes))
				}
			})

			this.gauges.set(name, gauge)
			Logger.debug(`[OTEL] Created gauge: ${name}`)
		}

		series.set(attrKey, { value, attributes: canonicalAttributes })
	}

	private snapshotGaugeSeries(name: string): Array<{ value: number; attributes?: TelemetryProperties }> {
		const series = this.gaugeValues.get(name)
		if (!series) {
			return []
		}
		const snapshot: Array<{ value: number; attributes?: TelemetryProperties }> = []
		for (const data of series.values()) {
			snapshot.push({
				value: data.value,
				attributes: data.attributes ? { ...data.attributes } : undefined,
			})
		}
		return snapshot
	}

	public async dispose(): Promise<void> {
		await Promise.all([this.owner?.dispose(), this.traceProvider?.dispose()])
		this.contentPolicy.reset()
		this.eventContentPolicy.reset()
	}

	/**
	 * Get the current telemetry level from VS Code settings
	 */
	private async getTelemetryLevel(): Promise<TelemetrySettings["level"]> {
		const hostSettings = await HostProvider.env.getTelemetrySettings({})
		if (hostSettings.isEnabled === Setting.DISABLED) {
			return "off"
		}
		return getErrorLevelFromString(hostSettings.errorLevel)
	}
}
