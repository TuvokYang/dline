import path from "node:path"
import { OtlpBatchOutboxRepository } from "@/core/storage/telemetry-remote/OtlpBatchOutboxRepository"
import type { JournalTelemetrySignal, TelemetrySpanHandle, TelemetrySpanStartOptions } from "../providers/capabilities"
import type { SignalSpanContext } from "../service/pipeline-port"
import { encodeOtlpMetrics, encodeOtlpTraces, OTLP_ADMISSION, OTLP_LIMITS, type OtlpSpanInput } from "./contracts/otlpProduction"
import {
    DiagnosticDeliveryWorker,
    type DiagnosticTokenSource,
    type ProductionOtlpOutbox,
} from "./diagnostics/DiagnosticDeliveryWorker"
import { type DiagnosticResource, diagnosticOtlpResource } from "./diagnostics/diagnosticRecord"
import { type DroppedSignal, isMetricsWindow, type MetricsWindow, ProductionMetricsWindow } from "./metrics/productionMetrics"
import { isOtlpSpanInput, ProductionSpanRecorder } from "./traces/productionSpans"
import type { OtlpTransport } from "./transport/DlineOtelHttpClient"

/** Delta windows kept while the service cannot be reached; each is one request, so an hour at the default cadence. */
const MAX_PENDING_WINDOWS = 60
/** Finished spans held in memory between flushes; more are dropped and counted. */
const MAX_BUFFERED_SPANS = 500

export interface ProductionSignalChannelsOptions {
    /** `<remoteDir>`: the outboxes live in its `metrics/` and `traces/` folders. */
    readonly remoteDir: string
    readonly resource: DiagnosticResource
    readonly tokens: DiagnosticTokenSource
    readonly transport: OtlpTransport
    /** This window's identity in the shared outbox claims. */
    readonly owner: string
    readonly allowed: () => boolean
    readonly clock?: () => number
    readonly log?: (message: string) => void
}

/**
 * The production Metrics and Traces channels of this extension host (TADR
 * §2.4, §5.3, §7.2). Each has its own machine-wide outbox, pacing and worker,
 * so a wait or a stop on one never holds the other or the Logs channel.
 *
 * Metrics aggregate in memory as one delta window and freeze only when the
 * outbox holds no earlier window, so a server gate longer than the export
 * interval widens the window instead of queueing deltas without bound.
 */
export class ProductionSignalChannels {
    private readonly clock: () => number
    private readonly metricsOutbox: OtlpBatchOutboxRepository<MetricsWindow>
    private readonly tracesOutbox: OtlpBatchOutboxRepository<OtlpSpanInput>
    private readonly metricsWorker: DiagnosticDeliveryWorker
    private readonly tracesWorker: DiagnosticDeliveryWorker
    private readonly spans: ProductionSpanRecorder
    private window: ProductionMetricsWindow
    private spanBuffer: OtlpSpanInput[] = []
    private spanBufferDropped = 0

    constructor(private readonly options: ProductionSignalChannelsOptions) {
        this.clock = options.clock ?? Date.now
        const resourceOf = (dropped: number) => diagnosticOtlpResource(options.resource, dropped)
        this.metricsOutbox = new OtlpBatchOutboxRepository(path.join(options.remoteDir, "metrics", "outbox.json"), {
            channel: "metrics",
            // One request covers one export window (TADR §7.2).
            encode: ([window], dropped) => JSON.stringify(encodeOtlpMetrics(resourceOf(dropped), window, window.points)),
            isItem: isMetricsWindow,
            maxItemsPerRequest: 1,
            maxPendingItems: MAX_PENDING_WINDOWS,
        })
        this.tracesOutbox = new OtlpBatchOutboxRepository(path.join(options.remoteDir, "traces", "outbox.json"), {
            channel: "traces",
            encode: (spans, dropped) => JSON.stringify(encodeOtlpTraces(resourceOf(dropped), spans)),
            isItem: isOtlpSpanInput,
            maxItemsPerRequest: OTLP_LIMITS.maxSpans,
            maxPendingItems: OTLP_ADMISSION.spansPerDay,
            admission: { perHour: OTLP_ADMISSION.spansPerHour, perDay: OTLP_ADMISSION.spansPerDay },
        })
        const worker = (stream: "metrics" | "traces", outbox: ProductionOtlpOutbox) =>
            new DiagnosticDeliveryWorker({
                outbox,
                tokens: options.tokens,
                send: (delivery, signal) => options.transport.sendOtlp(stream, delivery, signal),
                owner: options.owner,
                label: stream,
                clock: this.clock,
                log: options.log,
            })
        this.metricsWorker = worker("metrics", this.metricsOutbox)
        this.tracesWorker = worker("traces", this.tracesOutbox)
        this.window = new ProductionMetricsWindow(this.clock())
        this.spans = new ProductionSpanRecorder({
            enabled: options.allowed,
            clock: this.clock,
            publish: (span) => this.publish(span),
        })
    }

    /** One extension-host session began; counted once in the current window. */
    sessionStarted(): void {
        this.window.recordSessionStarted()
    }

    /** Runtime gauges from the canonical pipeline. */
    observe(signal: JournalTelemetrySignal): void {
        if (this.options.allowed()) this.window.observe(signal)
    }

    /** Records the records of one signal dropped before they reached its outbox. */
    recordDropped(signal: DroppedSignal, count: number): void {
        this.window.recordDropped(signal, count)
    }

    startSpan(
        options: TelemetrySpanStartOptions,
        companion?: (identity: SignalSpanContext) => TelemetrySpanHandle,
    ): TelemetrySpanHandle {
        return this.spans.start(options, companion)
    }

    /** Move the finished spans into the traces outbox. */
    async flush(): Promise<void> {
        if (this.spanBuffer.length === 0 && this.spanBufferDropped === 0) return
        const spans = this.spanBuffer
        const dropped = this.spanBufferDropped
        this.spanBuffer = []
        this.spanBufferDropped = 0
        if (!this.options.allowed()) return
        await this.tracesOutbox.append(spans, this.clock(), dropped)
    }

    /**
     * Close the current delta window into the metrics outbox, unless an earlier
     * window still waits there; then the current one keeps growing.
     */
    async exportMetrics(): Promise<void> {
        if (!this.options.allowed()) {
            this.window.freeze(this.clock())
            return
        }
        if ((await this.metricsOutbox.backlog()) > 0) return
        const window = this.window.freeze(this.clock())
        if (window) await this.metricsOutbox.append([window], window.endMs)
    }

    async deliver(signal: AbortSignal): Promise<void> {
        await this.metricsWorker.deliverOnce(signal)
        await this.tracesWorker.deliverOnce(signal)
    }

    /** Forget everything gathered and queued, for withdrawn consent; channel gates stay. */
    async clear(): Promise<void> {
        this.spanBuffer = []
        this.spanBufferDropped = 0
        this.window = new ProductionMetricsWindow(this.clock())
        await Promise.all([this.metricsOutbox.clear(), this.tracesOutbox.clear()])
    }

    private publish(span: OtlpSpanInput): void {
        this.window.recordOperation(span)
        if (this.spanBuffer.length >= MAX_BUFFERED_SPANS) {
            this.spanBufferDropped++
            this.window.recordDropped("traces", 1)
            return
        }
        this.spanBuffer.push(span)
    }
}
