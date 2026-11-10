import { envFlagEnabled } from "@/shared/env"
import { Logger } from "@/shared/services/Logger"
import { loopbackEndpointOverride } from "./transport/DlineOtelHttpClient"

type TelemetryEnvironment = Partial<Pick<NodeJS.ProcessEnv, "DLINE_OTEL_ENDPOINT" | "E2E_TEST" | "IS_TEST">>

/** A test may use its own loopback service, but must never fall back to the real service. */
export function resolveRemoteTelemetryEndpoint(
    environment: TelemetryEnvironment = process.env,
): { readonly endpoint: string | undefined } | undefined {
    const endpoint = loopbackEndpointOverride(environment.DLINE_OTEL_ENDPOINT)
    if (environment.DLINE_OTEL_ENDPOINT && !endpoint) {
        Logger.warn("[Dline] Ignoring DLINE_OTEL_ENDPOINT: only a loopback origin may replace the telemetry service")
    }
    const isTestRun = envFlagEnabled(environment.E2E_TEST) || envFlagEnabled(environment.IS_TEST)
    return isTestRun && !endpoint ? undefined : { endpoint }
}
