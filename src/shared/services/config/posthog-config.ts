import { envFlagEnabled } from "@shared/env"
import { BUILD_CONSTANTS } from "../../constants"

export interface PostHogClientConfig {
    /**
     * The main API key for PostHog telemetry service.
     */
    apiKey?: string | undefined
    /**
     * The API key for PostHog used only for error tracking service.
     */
    errorTrackingApiKey?: string | undefined
    enableErrorAutocapture?: boolean
    host?: string | undefined
    uiHost?: string | undefined
}

/**
 * Helper type for a valid PostHog client configuration.
 * Must contain api keys for both telemetry and error tracking, and a host to
 * send them to.
 */
export interface PostHogClientValidConfig extends PostHogClientConfig {
    apiKey: string
    errorTrackingApiKey: string
    host: string
}

/**
 * NOTE: Ensure that dev environment is not used in production.
 * process.env.CI will always be true in the CI environment, during both testing and publishing step,
 * so it is not a reliable indicator of the environment.
 */
const useDevEnv = envFlagEnabled(process.env.IS_DEV) || process.env.DLINE_ENVIRONMENT === "local"

/**
 * Where product analytics and error reports are sent.
 *
 * There is deliberately no default. The transport is kept so a Dline-operated
 * endpoint can be attached later, but an unconfigured build must not reach any
 * external service. Relying on an empty API key for that is not sufficient:
 * injecting a key in CI would silently restore reporting to whatever host was
 * compiled in.
 */
function readEndpoint(rawValue: string | undefined): string | undefined {
    const trimmed = rawValue?.trim()
    return trimmed ? trimmed : undefined
}

export const posthogConfig: PostHogClientConfig = {
    apiKey: BUILD_CONSTANTS.TELEMETRY_SERVICE_API_KEY,
    errorTrackingApiKey: BUILD_CONSTANTS.ERROR_SERVICE_API_KEY,
    host: readEndpoint(process.env.DLINE_TELEMETRY_HOST),
    uiHost: readEndpoint(process.env.DLINE_TELEMETRY_UI_HOST),
    enableErrorAutocapture: BUILD_CONSTANTS.ENABLE_ERROR_AUTOCAPTURE === "true",
}

const isTestEnv = envFlagEnabled(process.env.E2E_TEST) || envFlagEnabled(process.env.IS_TEST)

export function isPostHogConfigValid(config: PostHogClientConfig): config is PostHogClientValidConfig {
    // Allow invalid config in test environment to enable mocking and stubbing
    if (isTestEnv) {
        return true
    }
    return (
        typeof config.apiKey === "string" &&
        config.apiKey.length > 0 &&
        typeof config.errorTrackingApiKey === "string" &&
        config.errorTrackingApiKey.length > 0 &&
        typeof config.host === "string" &&
        config.host.length > 0
    )
}

/** Only meaningful once a host is configured; unused otherwise. */
export function isDevEnvironment(): boolean {
    return useDevEnv
}
