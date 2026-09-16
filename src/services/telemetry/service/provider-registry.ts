import type { ClineAccountUserInfo } from "@/services/auth/AuthService"
import { Logger } from "@/shared/services/Logger"
import {
	isTelemetryProviderRegistration,
	type JournalTelemetrySignal,
	type TelemetryChannel,
	type TelemetryProviderCapability,
	type TelemetryProviderInput,
	type TelemetryProviderRegistration,
	type TelemetrySeverity,
	type TelemetrySpanHandle,
	type TelemetrySpanStartOptions,
} from "../providers/capabilities"
import type { ITelemetryProvider, TelemetryProperties, TelemetrySettings } from "../providers/ITelemetryProvider"
import { adaptLegacyTelemetryProvider } from "../providers/LegacyTelemetryProviderAdapter"
import { TelemetryChannelPolicy } from "./channel-policy"
import { DeferredSignalSpan } from "./pipeline-port"
import { taskTraceSource } from "./task-trace-context"
import { captureSpanLogProperties, currentSignalSpan, runInSpanScope } from "./trace-scope"

/**
 * Owns the set of providers and the fan-out to them.
 *
 * Two concerns live here because they are the same concern seen at different
 * times: *where* a signal is delivered, and *whether delivery is possible yet*.
 * Providers are built asynchronously while the service must be usable from the
 * first synchronous line of activation, so until they arrive this registry
 * holds signals rather than discarding them — otherwise the activation events,
 * which is precisely where startup failures show up, would be the ones lost.
 *
 * Providers also fail for reasons the product cannot control — a network
 * stall, a vendor SDK throwing on shutdown — so every call is isolated. Putting
 * that isolation in one place lets recorders be written as if delivery always
 * succeeds, which is the only way they stay readable.
 */

/**
 * Bound on signals held while providers are still being constructed.
 *
 * Attachment normally completes in well under a second. The bound exists for
 * the case where it never completes at all: a registry that buffered without
 * limit would turn a failed provider factory into a memory leak.
 */
const PENDING_CAPACITY = 512

/**
 * Properties resolved at delivery time rather than at call time.
 *
 * A held signal is delivered after host metadata has been resolved, so the
 * merge must happen then: capturing the merged object when the signal was
 * recorded would stamp every startup event with the placeholder host fields
 * that were current before the host bridge answered.
 */
export type PropertiesThunk = () => TelemetryProperties

/** One delivery deferred until providers exist. */
type PendingDelivery =
	| {
			kind: "event"
			channel: TelemetryChannel
			severity: TelemetrySeverity
			event: string
			properties: PropertiesThunk
			required: boolean
	  }
	| {
			kind: "identify"
			channel: "usage"
			severity: "info"
			userInfo: ClineAccountUserInfo
			properties: PropertiesThunk
	  }
	| {
			kind: "counter" | "histogram"
			channel: TelemetryChannel
			severity: TelemetrySeverity
			name: string
			value: number
			attributes: PropertiesThunk
			description?: string
			required: boolean
	  }
	| {
			kind: "gauge"
			channel: TelemetryChannel
			severity: TelemetrySeverity
			name: string
			value: number | null
			attributes: PropertiesThunk
			description?: string
			required: boolean
	  }

export class TelemetryProviderRegistry {
	private registrations: TelemetryProviderRegistration[]

	/**
	 * Whether providers are final.
	 *
	 * A registry constructed with providers is ready immediately; one that will
	 * receive them later stays pending until `markReady` is called.
	 */
	private ready: boolean
	private closed = false

	private readonly pending: PendingDelivery[] = []
	private readonly pendingSpans: Array<{ span: DeferredSignalSpan; channel: TelemetryChannel }> = []
	private pendingDropped = 0
	private readonly policy: TelemetryChannelPolicy

	constructor(
		providers: TelemetryProviderInput[] = [],
		options: { readonly ready?: boolean; readonly policy?: TelemetryChannelPolicy } = {},
	) {
		this.registrations = providers.map(normalizeRegistration)
		this.ready = options.ready ?? true
		this.policy = options.policy ?? TelemetryChannelPolicy.allowAll()
	}

	add(provider: TelemetryProviderInput): void {
		const registration = normalizeRegistration(provider)
		if (this.closed) {
			// Adding to a disposed registry would leak the provider's sockets
			// and timers, since nothing will dispose it.
			void registration.base.dispose().catch(() => {})
			return
		}

		const replaced = this.takeByName(registration.base.name)
		this.registrations.push(registration)
		void this.closeRegistrations(replaced)
	}

	async remove(name: string): Promise<void> {
		await this.closeRegistrations(this.takeByName(name))
	}

	/**
	 * Declare providers final and deliver everything held so far, in order.
	 *
	 * Order is preserved because a consumer reading the event stream uses it to
	 * reconstruct what happened during startup.
	 */
	markReady(): void {
		if (this.ready) {
			return
		}
		this.ready = true
		for (const { span, channel } of this.pendingSpans.splice(0)) {
			span.attach((options) => this.startSpan(options, channel))
		}

		const held = this.pending.splice(0, this.pending.length)
		const dropped = this.pendingDropped
		this.pendingDropped = 0

		for (const delivery of held) {
			this.deliver(delivery)
		}

		if (dropped > 0) {
			// A gap in the startup stream must be visible; silently shorter
			// evidence is worse than evidence that says it is incomplete.
			Logger.internalWarn(`[TelemetryService] Dropped ${dropped} telemetry signal(s) recorded before providers were ready`)
		}
	}

	/** Compatibility projection for callers still using the legacy provider API. */
	list(): ITelemetryProvider[] {
		return this.registrations.flatMap((registration) => (registration.legacy ? [registration.legacy] : []))
	}

	/** Full registration view for capability-aware callers and tests. */
	listRegistrations(): TelemetryProviderRegistration[] {
		return [...this.registrations]
	}

	get size(): number {
		return this.registrations.length
	}

	/** Signals held because providers do not exist yet. */
	get pendingCount(): number {
		return this.pending.length
	}

	isEnabled(): boolean {
		return this.registrations.some((registration) => this.policy.allows({ channel: "usage", severity: "info" }, registration))
	}

	/**
	 * Settings reported to callers.
	 *
	 * Taken from the first provider: settings describe the host's telemetry
	 * level, which is a property of the environment rather than of any one
	 * provider. With no providers the answer is "off", which is accurate — no
	 * destination exists.
	 */
	getSettings(): TelemetrySettings {
		return this.registrations.length > 0
			? this.registrations[0].base.getSettings()
			: { hostEnabled: false, level: "off" as const }
	}

	logEvent(
		event: string,
		properties: PropertiesThunk,
		required: boolean,
		channel: TelemetryChannel = "usage",
		severity: TelemetrySeverity = "info",
	): void {
		const recorded = { telemetry_timestamp_ms: Date.now(), ...captureSpanLogProperties() }
		this.dispatch({ kind: "event", channel, severity, event, properties: () => ({ ...recorded, ...properties() }), required })
	}

	identifyUser(userInfo: ClineAccountUserInfo, properties: PropertiesThunk): void {
		this.dispatch({ kind: "identify", channel: "usage", severity: "info", userInfo, properties })
	}

	recordCounter(
		name: string,
		value: number,
		attributes: PropertiesThunk,
		description?: string,
		required = false,
		channel: TelemetryChannel = "usage",
		severity: TelemetrySeverity = "info",
	): void {
		this.dispatch({ kind: "counter", channel, severity, name, value, attributes, description, required })
	}

	recordHistogram(
		name: string,
		value: number,
		attributes: PropertiesThunk,
		description?: string,
		required = false,
		channel: TelemetryChannel = "usage",
		severity: TelemetrySeverity = "info",
	): void {
		this.dispatch({ kind: "histogram", channel, severity, name, value, attributes, description, required })
	}

	recordGauge(
		name: string,
		value: number | null,
		attributes: PropertiesThunk,
		description?: string,
		required = false,
		channel: TelemetryChannel = "usage",
		severity: TelemetrySeverity = "info",
	): void {
		this.dispatch({ kind: "gauge", channel, severity, name, value, attributes, description, required })
	}

	startSpan(options: TelemetrySpanStartOptions, channel: TelemetryChannel = "runtime"): TelemetrySpanHandle {
		if (this.closed) return INERT_SPAN
		const taskId = options.attributes?.task_id ?? options.attributes?.taskId
		const taskParent = typeof taskId === "string" ? taskTraceSource(taskId)?.currentSpan() : undefined
		options = { ...options, parent: options.root ? undefined : (options.parent ?? currentSignalSpan() ?? taskParent) }
		if (!this.ready) {
			const span = new DeferredSignalSpan({ ...options, attributes: primitiveSpanAttributes(options.attributes) })
			if (this.pendingSpans.length >= PENDING_CAPACITY) this.pendingSpans.shift()?.span.discard()
			this.pendingSpans.push({ span, channel })
			return span
		}
		// Start the exporting span first so the journal can mirror its native identity.
		// Neither destination exports until end(); ending remains journal-first.
		let identity: TelemetrySpanHandle["spanContext"]
		const handles = orderedRegistrations(this.registrations)
			.reverse()
			.flatMap((registration) => {
				try {
					if (!this.policy.allows({ channel, severity: "info" }, registration)) return []
					const capability = registration.capabilities.find((entry) => entry.kind === "trace")
					if (capability?.kind !== "trace") return []
					const parent =
						options.parent instanceof CompositeTelemetrySpan
							? options.parent.forProvider(registration.base.name)
							: options.parent
					const handle = capability.startSpan({ ...options, parent, spanContext: identity })
					identity ??= handle.spanContext
					return [{ providerName: registration.base.name, handle }]
				} catch (error) {
					Logger.internalError(
						`[TelemetryService] Provider ${registration.base.name} failed to start span ${options.name}:`,
						error,
					)
					return []
				}
			})
		return handles.length === 0 ? INERT_SPAN : new CompositeTelemetrySpan(handles.reverse())
	}

	/**
	 * Dispose every provider, waiting for all of them.
	 *
	 * `allSettled` rather than `all`: one provider failing to close must not
	 * leave the others holding sockets or timers open.
	 */
	async dispose(): Promise<void> {
		this.closed = true
		this.pending.length = 0
		for (const { span } of this.pendingSpans.splice(0)) span.discard()
		this.pendingDropped = 0
		const registrations = this.registrations
		this.registrations = []
		await this.closeRegistrations(registrations)
	}

	/** Deliver now, or hold until providers exist. */
	private dispatch(delivery: PendingDelivery): void {
		if (this.closed) {
			return
		}

		if (this.ready) {
			this.deliver(delivery)
			return
		}

		if (this.pending.length >= PENDING_CAPACITY) {
			// The earliest signals describe activation and are the reason this
			// buffer exists, so the surplus that cannot fit is the newest.
			this.pendingDropped += 1
			return
		}
		this.pending.push(delivery)
	}

	private deliver(delivery: PendingDelivery): void {
		// A snapshot, so a provider that registers or removes another provider
		// while handling this signal cannot change who receives it midway.
		const registrations = [...this.registrations]
		const permitted = registrations.filter((registration) => {
			try {
				return this.policy.allows(delivery, registration)
			} catch (error) {
				Logger.internalError(`[TelemetryService] Policy failed for ${registration.base.name}:`, error)
				return false
			}
		})
		if (permitted.length === 0) {
			return
		}

		// Resolved only after consent and sink policy pass, so disabled telemetry
		// does not build metadata or attributes merely to discard them.
		let properties: TelemetryProperties
		try {
			properties = TelemetryProviderRegistry.propertiesOf(delivery)
		} catch (error) {
			Logger.internalError(`[TelemetryService] Failed to build properties for ${describe(delivery)}:`, error)
			return
		}

		for (const registration of orderedRegistrations(permitted)) {
			for (const capability of registration.capabilities) {
				try {
					TelemetryProviderRegistry.applyToCapability(capability, delivery, properties)
				} catch (error) {
					Logger.internalError(
						`[TelemetryService] Provider ${registration.base.name} failed for ${describe(delivery)}:`,
						error,
					)
				}
			}
		}
	}

	/**
	 * Resolve the deferred properties of one delivery.
	 *
	 * Deliveries carry a thunk rather than a materialised object so that a
	 * signal recorded before host metadata arrived is still delivered with the
	 * metadata that is current at delivery time.
	 */
	private static propertiesOf(delivery: PendingDelivery): TelemetryProperties {
		switch (delivery.kind) {
			case "event":
			case "identify":
				return delivery.properties()
			case "counter":
			case "histogram":
			case "gauge":
				return delivery.attributes()
			default: {
				const unhandled: never = delivery
				throw new Error(`Unhandled telemetry delivery: ${JSON.stringify(unhandled)}`)
			}
		}
	}

	/**
	 * Apply one delivery to one provider.
	 *
	 * A switch over the discriminant rather than a stored callback so that
	 * adding a delivery kind fails to compile until it is routed.
	 */
	private static applyToCapability(
		capability: TelemetryProviderCapability,
		delivery: PendingDelivery,
		properties: TelemetryProperties,
	): void {
		if (capability.kind === "journal") {
			const signal = TelemetryProviderRegistry.toJournalSignal(delivery, properties)
			if (signal) capability.append(signal)
			return
		}

		switch (delivery.kind) {
			case "event": {
				if (capability.kind !== "event") return
				const eventProperties = {
					...properties,
					telemetry_channel: delivery.channel,
					telemetry_severity: delivery.severity,
				}
				if (delivery.required) capability.logRequired(delivery.event, eventProperties)
				else capability.log(delivery.event, eventProperties)
				return
			}
			case "identify":
				if (capability.kind === "event") capability.identifyUser(delivery.userInfo, properties)
				return
			case "counter":
				if (capability.kind === "metric")
					capability.recordCounter(delivery.name, delivery.value, properties, delivery.description)
				return
			case "histogram":
				if (capability.kind === "metric")
					capability.recordHistogram(delivery.name, delivery.value, properties, delivery.description)
				return
			case "gauge":
				if (capability.kind === "metric")
					capability.recordGauge(delivery.name, delivery.value, properties, delivery.description)
				return
			default: {
				const unhandled: never = delivery
				throw new Error(`Unhandled telemetry delivery: ${JSON.stringify(unhandled)}`)
			}
		}
	}

	private static toJournalSignal(
		delivery: PendingDelivery,
		properties: TelemetryProperties,
	): JournalTelemetrySignal | undefined {
		switch (delivery.kind) {
			case "event":
				return {
					kind: "event",
					channel: delivery.channel,
					severity: delivery.severity,
					name: delivery.event,
					properties,
					required: delivery.required,
				}
			case "identify":
				// Identity payloads are deliberately never journalled.
				return undefined
			case "counter":
			case "histogram":
			case "gauge":
				return {
					kind: "metric",
					channel: delivery.channel,
					severity: delivery.severity,
					instrument: delivery.kind,
					name: delivery.name,
					value: delivery.value,
					attributes: properties,
					description: delivery.description,
				}
			default: {
				const unhandled: never = delivery
				throw new Error(`Unhandled telemetry delivery: ${JSON.stringify(unhandled)}`)
			}
		}
	}

	private takeByName(name: string): TelemetryProviderRegistration[] {
		const removed = this.registrations.filter((registration) => registration.base.name === name)
		this.registrations = this.registrations.filter((registration) => registration.base.name !== name)
		return removed
	}

	private async closeRegistrations(registrations: readonly TelemetryProviderRegistration[]): Promise<void> {
		await Promise.allSettled(
			registrations.map(async (registration) => {
				try {
					await registration.base.forceFlush()
				} finally {
					await registration.base.dispose()
				}
			}),
		)
	}
}

const INERT_SPAN: TelemetrySpanHandle = Object.freeze({
	active: false,
	setAttribute(): void {},
	recordException(): void {},
	end(): void {},
})

interface ProviderSpanHandle {
	readonly providerName: string
	readonly handle: TelemetrySpanHandle
}

class CompositeTelemetrySpan implements TelemetrySpanHandle {
	private ended = false
	constructor(private readonly handles: readonly ProviderSpanHandle[]) {}
	get active(): boolean {
		return !this.ended && this.handles.some(({ handle }) => handle.active)
	}
	get spanContext() {
		return this.handles.find(({ handle }) => handle.spanContext)?.handle.spanContext
	}
	get taskId() {
		return this.handles.find(({ handle }) => handle.taskId)?.handle.taskId
	}
	run<T>(action: () => T): T {
		return runInSpanScope(this, action)
	}
	addEvent(name: string, attributes?: Readonly<Record<string, string | number | boolean>>, timestamp?: number): void {
		if (!this.ended) this.apply((handle) => handle.addEvent?.(name, attributes, timestamp))
	}
	forProvider(providerName: string): TelemetrySpanHandle | undefined {
		return this.handles.find((entry) => entry.providerName === providerName)?.handle
	}
	setAttribute(name: string, value: string | number | boolean): void {
		if (!this.ended) this.apply((handle) => handle.setAttribute(name, value))
	}
	recordException(error: unknown): void {
		if (!this.ended) this.apply((handle) => handle.recordException(error))
	}
	end(outcome?: "success" | "failure" | "cancelled", endTime?: number): void {
		if (this.ended) return
		this.ended = true
		this.apply((handle) => handle.end(outcome, endTime))
	}
	private apply(action: (handle: TelemetrySpanHandle) => void): void {
		for (const { handle } of this.handles) {
			try {
				action(handle)
			} catch {
				// A broken sink cannot change the tool outcome or strand another sink's span.
			}
		}
	}
}

function orderedRegistrations(registrations: readonly TelemetryProviderRegistration[]): TelemetryProviderRegistration[] {
	return [...registrations].sort((left, right) =>
		left.sink.kind === right.sink.kind ? 0 : left.sink.kind === "journal" ? -1 : right.sink.kind === "journal" ? 1 : 0,
	)
}

function normalizeRegistration(provider: TelemetryProviderInput): TelemetryProviderRegistration {
	return isTelemetryProviderRegistration(provider) ? provider : adaptLegacyTelemetryProvider(provider)
}

function primitiveSpanAttributes(properties?: TelemetryProperties): Record<string, string | number | boolean> | undefined {
	if (!properties) return undefined
	const attributes: Record<string, string | number | boolean> = {}
	for (const [key, value] of Object.entries(properties)) {
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") attributes[key] = value
	}
	return attributes
}

/** Short identifier used only in failure logs. */
function describe(delivery: PendingDelivery): string {
	switch (delivery.kind) {
		case "event":
			return `event ${delivery.event}`
		case "identify":
			return "user identification"
		default:
			return `${delivery.kind} ${delivery.name}`
	}
}
