import { afterEach, describe, it, vi } from "vitest"
import * as distinctIdModule from "@/services/logging/distinctId"
import { createDefaultLoopbackOpenTelemetryConfig } from "@/shared/services/config/otel-config"
import { TELEMETRY_METRICS } from "../../../events/catalog"
import { OpenTelemetryClientProvider } from "../OpenTelemetryClientProvider"
import { OpenTelemetryTelemetryProvider } from "../OpenTelemetryTelemetryProvider"

const providers: OpenTelemetryTelemetryProvider[] = []

afterEach(async () => {
    await Promise.all(providers.splice(0).map((provider) => provider.dispose()))
    vi.restoreAllMocks()
})

describe("OpenTelemetry live log export", () => {
    it.skipIf(process.env.DLINE_LIVE_OTEL_TEST !== "1")(
        "exports safe metadata and field-preserving masks to the loopback collector",
        async () => {
            vi.spyOn(distinctIdModule, "getDistinctId").mockReturnValue("ws065-live-distinct")

            const owner = new OpenTelemetryClientProvider(createDefaultLoopbackOpenTelemetryConfig())
            const provider = new OpenTelemetryTelemetryProvider(owner.meterProvider, owner.loggerProvider, {
                name: "ws065-live-log-provider",
                owner,
            })
            providers.push(provider)

            provider.log("ws065.live.log.masking_canary", {
                telemetry_channel: "runtime",
                telemetry_severity: "warn",
                canary_id: "ws065-mask-v2",
                verification: "live-loki",
                extension_version: "0.9.2-live",
                vscode_version: "1.134.0",
                provider: "openai-codex",
                modelId: "gpt-5.3-codex",
                apiFormat: "openai-responses",
                tokens: { input: 1200, output: 340 },
                model_list: ["gpt-5.3-codex", "gpt-5.2-codex"],
                capabilities: ["tools", "images"],
                snapshot: { phase: "flush", status: "complete", count: 3, durationMs: 42 },
                prompt: "ws065-secret-prompt-canary",
                api_key: "sk-ws065-secret-api-key",
                user_id: "ws065-secret-user",
            })
            const usageMetricAttributes = {
                provider: "openai-codex",
                model: "gpt-5.3-codex",
                apiFormat: "OPENAI_RESPONSES",
                canary_id: "ws065-usage-stats-v1",
                verification: "live-prometheus",
            }
            provider.log("task.tokens", {
                telemetry_channel: "usage",
                telemetry_severity: "info",
                canary_id: "ws065-usage-stats-v1",
                verification: "live-loki",
                provider: "openai-codex",
                model: "gpt-5.3-codex",
                modelId: "gpt-5.3-codex",
                apiFormatName: "OPENAI_RESPONSES",
                tokensIn: 1200,
                tokensOut: 800,
                cacheWriteTokens: 100,
                cacheReadTokens: 300,
                totalTokens: 2400,
                cacheUsageReported: true,
                cacheHit: true,
                cacheHitRate: 18.75,
                requestsPerMinute: 6,
                tokensPerMinute: 14_400,
                features: {
                    hooks: true,
                    focus_chain: true,
                    auto_condense: false,
                    subagents: true,
                    mcp: true,
                    web_tools: true,
                    native_tool_calls: true,
                },
            })
            provider.recordCounter(TELEMETRY_METRICS.API.REQUESTS_TOTAL, 1, usageMetricAttributes)
            provider.recordCounter(TELEMETRY_METRICS.TASK.TOKENS_TOTAL, 2400, usageMetricAttributes)
            provider.recordCounter(TELEMETRY_METRICS.CACHE.INPUT_TOTAL, 1600, usageMetricAttributes)
            provider.recordCounter(TELEMETRY_METRICS.CACHE.READ_TOTAL, 300, usageMetricAttributes)
            provider.recordHistogram(TELEMETRY_METRICS.CACHE.HIT_RATE_PERCENT, 18.75, usageMetricAttributes)
            await provider.forceFlush()
        },
    )
})
