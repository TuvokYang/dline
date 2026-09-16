import { ROOT_CONTEXT, type Span, SpanStatusCode, type Tracer, trace } from "@opentelemetry/api"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { BatchSpanProcessor, NodeTracerProvider, type SpanProcessor } from "@opentelemetry/sdk-trace-node"
import { epochMillisecondsToHrTime } from "../../otel/log-record"
import { createTelemetryResource } from "../../otel/telemetry-resource"
import { RuntimeContentPolicy } from "../../runtime/content-policy"
import { normalizeRuntimeError } from "../../runtime/error-normalizer"
import { exceptionAttributes } from "../../runtime/exception-attributes"
import { currentSignalSpan, runInSpanScope } from "../../service/trace-scope"
import type { TelemetrySpanHandle, TelemetrySpanStartOptions, TraceTelemetryCapability } from "../capabilities"
import type { TelemetryProperties } from "../ITelemetryProvider"

const TRACE_SCOPE_NAME = "dline.runtime"

/** Real OTLP trace capability using the v1 tracing island exported by sdk-trace-node. */
export class OpenTelemetryTraceProvider implements TraceTelemetryCapability {
	readonly kind = "trace" as const
	private readonly provider: NodeTracerProvider
	private readonly tracer: Tracer
	private readonly policy = RuntimeContentPolicy.forEvents()
	private readonly spans = new Set<OpenTelemetrySpanHandle>()
	private disposed = false

	constructor(endpoint: string, options: { readonly processor?: SpanProcessor } = {}) {
		const processor = options.processor ?? createBatchProcessor(endpoint)
		this.provider = new NodeTracerProvider({
			resource: createTelemetryResource(),
			spanProcessors: [processor],
		})
		this.tracer = this.provider.getTracer(TRACE_SCOPE_NAME)
	}

	startSpan(options: TelemetrySpanStartOptions): TelemetrySpanHandle {
		if (this.disposed) return INERT_SPAN
		const parent = options.root ? undefined : (options.parent ?? currentSignalSpan())
		const parentContext = parent?.spanContext ? trace.setSpanContext(ROOT_CONTEXT, parent.spanContext) : ROOT_CONTEXT
		const taskId = taskIdentity(options.attributes) ?? parent?.taskId
		const span = this.tracer.startSpan(
			options.name,
			{
				attributes: this.policy.apply({ ...(taskId ? { task_id: taskId } : {}), ...options.attributes }).attributes,
				startTime: spanTime(options.startTime),
			},
			parentContext,
		)
		const handle = new OpenTelemetrySpanHandle(span, taskId, this.policy, () => this.spans.delete(handle))
		this.spans.add(handle)
		return handle
	}

	async forceFlush(): Promise<void> {
		await this.provider.forceFlush()
	}

	async dispose(): Promise<void> {
		if (this.disposed) return
		this.disposed = true
		for (const span of this.spans) {
			span.setAttribute("interrupted", true)
			span.end("cancelled")
		}
		try {
			await this.provider.shutdown()
		} finally {
			this.policy.reset()
		}
	}
}

class OpenTelemetrySpanHandle implements TelemetrySpanHandle {
	private ended = false

	constructor(
		readonly span: Span,
		public taskId: string | undefined,
		private readonly policy: RuntimeContentPolicy,
		private readonly onEnd: () => void,
	) {}

	get active(): boolean {
		return !this.ended && this.span.isRecording()
	}
	get spanContext() {
		return this.span.spanContext()
	}
	run<T>(action: () => T): T {
		return runInSpanScope(this, action)
	}

	setAttribute(name: string, value: string | number | boolean): void {
		if (this.ended) return
		this.taskId = taskIdentity({ [name]: value }) ?? this.taskId
		this.span.setAttributes(this.policy.apply({ [name]: value }).attributes)
	}

	recordException(error: unknown): void {
		if (this.ended) return
		const normalized = normalizeRuntimeError(error)
		this.span.addEvent("exception", {
			...exceptionAttributes(normalized),
			"exception.fingerprint": normalized.fingerprint,
		})
	}

	addEvent(name: string, attributes?: Readonly<Record<string, string | number | boolean>>, timestamp?: number): void {
		if (!this.ended) this.span.addEvent(name, this.policy.apply(attributes).attributes, spanTime(timestamp))
	}

	end(outcome: "success" | "failure" | "cancelled" = "success", endTime?: number): void {
		if (this.ended) return
		this.ended = true
		this.span.setAttribute("outcome", outcome)
		this.span.setStatus({
			code: outcome === "success" ? SpanStatusCode.OK : SpanStatusCode.ERROR,
			message: outcome === "cancelled" ? "cancelled" : undefined,
		})
		try {
			this.span.end(spanTime(endTime))
		} finally {
			this.onEnd()
		}
	}
}

function createBatchProcessor(endpoint: string): SpanProcessor {
	const url = new URL(endpoint)
	const normalized = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname
	if (!normalized.endsWith("/v1/traces")) url.pathname = `${normalized}/v1/traces`
	return new BatchSpanProcessor(new OTLPTraceExporter({ url: url.toString() }))
}

function taskIdentity(properties?: TelemetryProperties): string | undefined {
	const value = properties?.task_id ?? properties?.taskId
	return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined
}

function spanTime(value?: number): [number, number] | undefined {
	if (value === undefined) return undefined
	return epochMillisecondsToHrTime(value >= 1_000_000_000_000 ? value : performance.timeOrigin + value)
}

const INERT_SPAN: TelemetrySpanHandle = Object.freeze({
	active: false,
	setAttribute(): void {},
	recordException(): void {},
	end(): void {},
})
