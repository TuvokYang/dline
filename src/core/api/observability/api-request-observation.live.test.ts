import { afterEach, describe, expect, it } from "vitest"
import { TaskTurnTelemetry } from "@/core/task/observability/task-turn-telemetry"
import { createTaskRuntimeState } from "@/core/task/runtime/TaskRuntimeState"
import { TaskPhase } from "@/core/task/TaskPhase"
import { adaptLegacyTelemetryProvider } from "@/services/telemetry/providers/LegacyTelemetryProviderAdapter"
import { OpenTelemetryClientProvider } from "@/services/telemetry/providers/opentelemetry/OpenTelemetryClientProvider"
import { OpenTelemetryTelemetryProvider } from "@/services/telemetry/providers/opentelemetry/OpenTelemetryTelemetryProvider"
import { OpenTelemetryTraceProvider } from "@/services/telemetry/providers/opentelemetry/OpenTelemetryTraceProvider"
import { forwardRuntimeEvent } from "@/services/telemetry/runtime/provider-event-bridge"
import { RuntimeEventBus } from "@/services/telemetry/runtime/runtime-event-bus"
import { RuntimeSignalPipeline } from "@/services/telemetry/runtime/signal-pipeline"
import { TelemetryChannelPolicy } from "@/services/telemetry/service/channel-policy"
import {
	configureSignalRecording,
	installObservabilityPipeline,
	installSignalPipeline,
	resetSignalRecording,
} from "@/services/telemetry/service/pipeline-port"
import { TelemetryProviderRegistry } from "@/services/telemetry/service/provider-registry"
import { createDefaultLoopbackOpenTelemetryConfig } from "@/shared/services/config/otel-config"
import type { ApiStream } from "../transform/stream"
import { ApiRequestObservation } from "./api-request-observation"

const cleanup: Array<() => void | Promise<void>> = []

afterEach(async () => {
	for (const action of cleanup.splice(0).reverse()) await action()
	installObservabilityPipeline(undefined)
	installSignalPipeline(undefined)
	resetSignalRecording()
})

describe("API error live OpenTelemetry export", () => {
	it.skipIf(process.env.DLINE_LIVE_OTEL_TEST !== "1")(
		"exports one synthetic failed API waterfall with correlated logs, state, snapshot and usage",
		async () => {
			const canaryId = `ws070-api-error-${Date.now()}`
			const config = createDefaultLoopbackOpenTelemetryConfig()
			const owner = new OpenTelemetryClientProvider(config)
			const traceProvider = new OpenTelemetryTraceProvider(config.otlpEndpoint!)
			const provider = new OpenTelemetryTelemetryProvider(owner.meterProvider, owner.loggerProvider, {
				name: "ws070-live-collector",
				owner,
				traceProvider,
			})
			const adapted = adaptLegacyTelemetryProvider(provider, {
				sink: {
					kind: "loopback",
					origin: "default",
					channels: ["runtime"],
					endpoint: config.otlpEndpoint,
				},
			})
			const registry = new TelemetryProviderRegistry(
				[{ ...adapted, capabilities: [...adapted.capabilities, traceProvider] }],
				{
					ready: true,
					policy: new TelemetryChannelPolicy({
						readConsents: () => ({ usage: "disabled", error: "enabled" }),
					}),
				},
			)
			const bus = new RuntimeEventBus({ sessionId: canaryId })
			configureSignalRecording({ enabled: () => true })
			installSignalPipeline(new RuntimeSignalPipeline(bus))
			installObservabilityPipeline({
				startSpan: (options) => registry.startSpan(options, "runtime"),
				recordHistogram: (name, value, attributes, description) =>
					registry.recordHistogram(name, value, () => attributes ?? {}, description, false, "runtime"),
				recordGauge: (name, value, attributes, description) =>
					registry.recordGauge(name, value, () => attributes ?? {}, description, false, "runtime"),
			})
			cleanup.push(
				() => registry.dispose(),
				() => bus.dispose(),
			)

			const taskId = `live-${canaryId}`
			const state = {
				...createTaskRuntimeState({
					taskId,
					phase: TaskPhase.STREAMING,
					revision: 7,
					anchor: { apiIndex: 2, turnId: "synthetic-turn" },
				}),
				turn: {
					turnId: "synthetic-turn",
					assistantApiIndex: 2,
					mode: "serial" as const,
					blocks: [],
				},
			}
			const timeline = new TaskTurnTelemetry(
				taskId,
				() => state,
				() => ({
					totalTokensIn: 1_200,
					totalTokensOut: 240,
					totalCacheReads: 300,
					totalCacheWrites: 100,
					totalCost: 0,
					providerRoundCount: 2,
					executionCount: 2,
					cacheUsageAvailable: true,
				}),
			)
			cleanup.push(() => timeline.dispose())
			timeline.committed("TURN_CREATED", state)
			timeline.snapshot("persisted", {
				taskId,
				phase: TaskPhase.STREAMING,
				apiIndex: 2,
				revision: 6,
				timestamp: Date.now(),
			})
			const failedTaskSegment = timeline.currentSpan()!
			const error = Object.assign(new Error("ws070-private-error-message"), {
				code: "upstream_unavailable",
				status: 502,
			})
			const observation = new ApiRequestObservation(
				{
					provider: "synthetic",
					model: "collector-canary",
					api_format: "synthetic",
					canary_id: canaryId,
					verification: "live-collector",
				},
				taskId,
				() => {},
			)
			const stream = observation.wrap(async function* (): ApiStream {
				yield { type: "usage", inputTokens: 11, outputTokens: 2, cacheReadTokens: 3 }
				throw error
			})

			expect((await stream.next()).value).toMatchObject({ type: "usage" })
			await expect(stream.next()).rejects.toBe(error)
			const continuation = timeline.currentSpan()!
			expect(continuation.spanContext?.traceId).toBe(failedTaskSegment.spanContext?.traceId)
			expect(continuation.spanContext?.spanId).not.toBe(failedTaskSegment.spanContext?.spanId)
			timeline.dispose()

			for (const event of bus.drain()) {
				forwardRuntimeEvent(event, {
					captureRuntimeEvent: (name, properties, severity) =>
						registry.logEvent(name, () => properties, false, "runtime", severity),
				})
			}
			await provider.forceFlush()

			console.info(
				`DLINE_LIVE_OTEL_RESULT ${JSON.stringify({
					canaryId,
					traceId: failedTaskSegment.spanContext?.traceId,
					failedTaskSegmentId: failedTaskSegment.spanContext?.spanId,
					continuationSegmentId: continuation.spanContext?.spanId,
				})}`,
			)
		},
		30_000,
	)
})
