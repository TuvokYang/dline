import type { ClineAccountUserInfo } from "@/services/auth/AuthService"
import type { SignalSpanContext, SignalSpanHandle } from "../service/pipeline-port"
import type { ITelemetryProvider, TelemetryProperties, TelemetrySettings } from "./ITelemetryProvider"

/** Consent channel carried by every canonical telemetry signal. */
export type TelemetryChannel = "usage" | "error" | "runtime" | "raw-artifact"

/** Severity used for host-level filtering without inspecting event names. */
export type TelemetrySeverity = "debug" | "info" | "warn" | "error" | "fatal"

/** Where a provider sends data. Consent policy is applied before this sink. */
export type TelemetrySinkKind = "journal" | "loopback" | "remote" | "test"

export type TelemetrySinkOrigin = "default" | "user" | "organization" | "test"

export interface TelemetrySinkDescriptor {
	readonly kind: TelemetrySinkKind
	readonly origin: TelemetrySinkOrigin
	readonly channels: readonly TelemetryChannel[]
	readonly endpoint?: string
	readonly enhancement?: "standard" | "debug"
}

/** Lifecycle and technical availability shared by every provider capability. */
export interface TelemetryProviderBase {
	readonly name: string
	isEnabled(): boolean
	getSettings(): TelemetrySettings
	forceFlush(): Promise<void>
	dispose(): Promise<void>
}

export interface EventTelemetryCapability {
	readonly kind: "event"
	log(event: string, properties?: TelemetryProperties): void
	logRequired(event: string, properties?: TelemetryProperties): void
	identifyUser(userInfo: ClineAccountUserInfo, properties?: TelemetryProperties): void
}

export interface MetricTelemetryCapability {
	readonly kind: "metric"
	recordCounter(name: string, value: number, attributes?: TelemetryProperties, description?: string): void
	recordHistogram(name: string, value: number, attributes?: TelemetryProperties, description?: string): void
	recordGauge(name: string, value: number | null, attributes?: TelemetryProperties, description?: string): void
}

export interface TelemetrySpanStartOptions {
	readonly name: string
	readonly attributes?: TelemetryProperties
	readonly parent?: TelemetrySpanHandle
	readonly startTime?: number
	readonly root?: boolean
	/** Journal mirrors may reuse the exporting provider's exact trace identity. */
	readonly spanContext?: SignalSpanContext
}

export interface TelemetrySpanHandle extends SignalSpanHandle {}

export interface TraceTelemetryCapability {
	readonly kind: "trace"
	startSpan(options: TelemetrySpanStartOptions): TelemetrySpanHandle
}

export type JournalTelemetrySignal =
	| {
			readonly kind: "event"
			readonly channel: TelemetryChannel
			readonly severity: TelemetrySeverity
			readonly name: string
			readonly properties?: TelemetryProperties
			readonly required: boolean
	  }
	| {
			readonly kind: "metric"
			readonly channel: TelemetryChannel
			readonly severity: TelemetrySeverity
			readonly instrument: "counter" | "histogram" | "gauge"
			readonly name: string
			readonly value: number | null
			readonly attributes?: TelemetryProperties
			readonly description?: string
	  }

export interface JournalTelemetryCapability {
	readonly kind: "journal"
	append(signal: JournalTelemetrySignal): void
}

export type TelemetryProviderCapability =
	| EventTelemetryCapability
	| MetricTelemetryCapability
	| TraceTelemetryCapability
	| JournalTelemetryCapability

/** Explicit provider registration; capability support is never inferred by duck typing. */
export interface TelemetryProviderRegistration {
	readonly kind: "registration"
	readonly base: TelemetryProviderBase
	/** Compatibility projection for callers that still need the legacy API. */
	readonly legacy?: ITelemetryProvider
	readonly sink: TelemetrySinkDescriptor
	readonly capabilities: readonly TelemetryProviderCapability[]
}

/** Existing callers may still supply the legacy all-capabilities interface. */
export type TelemetryProviderInput = ITelemetryProvider | TelemetryProviderRegistration

export function isTelemetryProviderRegistration(input: TelemetryProviderInput): input is TelemetryProviderRegistration {
	return "kind" in input && input.kind === "registration"
}
