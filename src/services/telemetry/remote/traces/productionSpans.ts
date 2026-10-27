import { randomBytes } from "node:crypto"
import type { TelemetrySpanHandle, TelemetrySpanStartOptions } from "../../providers/capabilities"
import type { SignalSpanContext } from "../../service/pipeline-port"
import { isUsageModelId } from "../contracts/modelIdentity"
import {
    isSpanId,
    isTraceId,
    type OtlpAttributes,
    type OtlpAttributeValue,
    type OtlpSpanInput,
    type OtlpSpanName,
    type OtlpSpanOutcome,
} from "../contracts/otlpProduction"
import { diagnosticProviderId, diagnosticValue } from "../diagnostics/diagnosticRecord"

/**
 * Internal span names that leave as the production span catalog (TADR §5.3).
 * Every other span stays local; a cataloged span names its nearest cataloged
 * ancestor as parent, so the exported tree has no dangling links.
 */
const PRODUCTION_SPAN_NAMES: Readonly<Record<string, OtlpSpanName>> = {
    "task.turn": "dline.task",
    "subagent.run": "dline.task",
    "tool.execution": "dline.tool.execute",
    "gen_ai.client.operation": "gen_ai.client.operation",
}

export interface ProductionSpanRecorderOptions {
    /** Whether diagnostics may leave the machine now; a span ending while they may not is not kept. */
    readonly enabled: () => boolean
    readonly publish: (span: OtlpSpanInput) => void
    readonly clock?: () => number
}

/**
 * The production trace capability (TADR §5.3): every span gets an identity, so
 * logs captured inside it correlate, but only cataloged spans are kept, with
 * their attributes reduced to the catalog's allowlist and value rules.
 */
export class ProductionSpanRecorder {
    private readonly clock: () => number
    /** Each handle's nearest cataloged span, itself included; a parent handle outlives its own end. */
    private readonly exportedAncestor = new WeakMap<object, string | undefined>()

    constructor(private readonly options: ProductionSpanRecorderOptions) {
        this.clock = options.clock ?? Date.now
    }

    /**
     * Start a span. `companion` starts another destination's span under the same
     * identity (the issue overlay); the returned handle drives both.
     */
    start(
        options: TelemetrySpanStartOptions,
        companion?: (identity: SignalSpanContext) => TelemetrySpanHandle,
    ): TelemetrySpanHandle {
        const identity = identityOf(options)
        const name = PRODUCTION_SPAN_NAMES[options.name]
        const parentSpanId = options.parent ? this.exportedAncestor.get(options.parent) : undefined
        const other = companion?.(identity)
        const attributes: Record<string, OtlpAttributeValue> = { ...primitive(options.attributes) }
        const startMs = options.startTime ?? this.clock()
        const { enabled, publish } = this.options
        const clock = this.clock
        let ended = false
        const handle: TelemetrySpanHandle = {
            get active() {
                return !ended
            },
            spanContext: identity,
            setAttribute(key, value) {
                if (!ended) attributes[key] = value
                other?.setAttribute(key, value)
            },
            recordException(error) {
                if (!ended && error instanceof Error && attributes["error.type"] === undefined)
                    attributes["error.type"] = error.name
                other?.recordException(error)
            },
            addEvent(eventName, values, timestamp) {
                other?.addEvent?.(eventName, values, timestamp)
            },
            end(outcome = "success", endTime) {
                other?.end(outcome, endTime)
                if (ended) return
                ended = true
                if (!name || !enabled()) return
                publish({
                    name,
                    traceId: identity.traceId,
                    spanId: identity.spanId,
                    ...(parentSpanId ? { parentSpanId } : {}),
                    startMs,
                    endMs: Math.max(startMs, endTime ?? clock()),
                    outcome,
                    attributes: catalogAttributes(name, options.name, attributes, outcome),
                })
            },
        }
        this.exportedAncestor.set(handle, name ? identity.spanId : parentSpanId)
        return handle
    }
}

/**
 * The exporting provider's identity when the registry passed one, so every
 * destination names the span alike; otherwise the parent's trace and a new span.
 */
function identityOf(options: TelemetrySpanStartOptions): SignalSpanContext {
    const requested = options.spanContext
    const traceId = [requested?.traceId, options.parent?.spanContext?.traceId].find(isTraceId) ?? randomHex(16)
    const spanId = isSpanId(requested?.spanId) ? requested.spanId : randomHex(8)
    return { traceId, spanId, traceFlags: requested?.traceFlags ?? 1 }
}

function randomHex(bytes: number): string {
    return randomBytes(bytes).toString("hex")
}

/** The catalog attributes of one span, each kept only with a value its rule accepts. */
function catalogAttributes(
    name: OtlpSpanName,
    internalName: string,
    raw: Readonly<Record<string, OtlpAttributeValue>>,
    outcome: OtlpSpanOutcome,
): OtlpAttributes {
    const failed = outcome === "failure"
    const errorType = failed ? firstOf(raw, ["error.type", "error_type"], diagnosticValue.token) : undefined
    switch (name) {
        case "dline.task":
            return { "dline.role": internalName === "subagent.run" ? "subagent" : "task" }
        case "dline.tool.execute":
            return compact({
                "tool.name": firstOf(raw, ["tool.name", "tool_name"], diagnosticValue.builtInTool),
                "failure.stage": failed
                    ? firstOf(raw, ["failure.stage", "failure_stage"], diagnosticValue.failureStage)
                    : undefined,
                "error.type": errorType,
            })
        case "gen_ai.client.operation": {
            const provider = raw["gen_ai.provider.name"]
            const attempt = raw["retry.attempt"]
            return compact({
                "gen_ai.provider.name": typeof provider === "string" ? diagnosticProviderId(provider) : undefined,
                "gen_ai.request.model": firstOf(raw, ["gen_ai.request.model"], isUsageModelId),
                "dline.role": firstOf(raw, ["dline.role"], diagnosticValue.role),
                "error.type": errorType,
                "retry.attempt": Number.isSafeInteger(attempt) && (attempt as number) >= 0 ? attempt : undefined,
                "dline.attempt_observation_id": firstOf(raw, ["dline.attempt_observation_id"], diagnosticValue.correlationId),
                "dline.logical_request_id": firstOf(raw, ["dline.logical_request_id"], diagnosticValue.correlationId),
            })
        }
    }
}

function firstOf(
    raw: Readonly<Record<string, OtlpAttributeValue>>,
    keys: readonly string[],
    accepts: (value: unknown) => value is string,
): string | undefined {
    return keys.map((key) => raw[key]).find(accepts)
}

function compact(attributes: Readonly<Record<string, OtlpAttributeValue | undefined>>): OtlpAttributes {
    return Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined)) as OtlpAttributes
}

function primitive(attributes: Readonly<Record<string, unknown>> | undefined): Record<string, OtlpAttributeValue> {
    const result: Record<string, OtlpAttributeValue> = {}
    for (const [key, value] of Object.entries(attributes ?? {})) {
        if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
            result[key] = value
    }
    return result
}

/** Validates a stored span, so a damaged outbox document is read as unusable rather than sent. */
export function isOtlpSpanInput(value: unknown): value is OtlpSpanInput {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false
    const span = value as Record<string, unknown>
    return (
        typeof span.name === "string" &&
        Object.values(PRODUCTION_SPAN_NAMES).includes(span.name as OtlpSpanName) &&
        isTraceId(span.traceId) &&
        isSpanId(span.spanId) &&
        (span.parentSpanId === undefined || isSpanId(span.parentSpanId)) &&
        typeof span.startMs === "number" &&
        typeof span.endMs === "number" &&
        (span.outcome === "success" || span.outcome === "failure" || span.outcome === "cancelled") &&
        typeof span.attributes === "object" &&
        span.attributes !== null
    )
}
