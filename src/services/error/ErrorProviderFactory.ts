import { isPostHogConfigValid, PostHogClientConfig, posthogConfig } from "@/shared/services/config/posthog-config"
import { ClineError } from "./ClineError"
import { IErrorProvider } from "./providers/IErrorProvider"
import { PostHogErrorProvider } from "./providers/PostHogErrorProvider"

/**
 * Supported error provider types
 */
export type ErrorProviderType = "posthog" | "no-op"

/**
 * Configuration for error providers
 */
export interface ErrorProviderConfig {
    type: ErrorProviderType
    config: PostHogClientConfig
}

/**
 * Factory class for creating error providers
 * Allows easy switching between different error tracking providers
 */
export class ErrorProviderFactory {
    /**
     * Creates an error provider based on the provided configuration
     * @param config Configuration for the error provider
     * @returns IErrorProvider instance
     */
    public static async createProvider(config: ErrorProviderConfig): Promise<IErrorProvider> {
        switch (config.type) {
            case "posthog": {
                const { errorTrackingApiKey, host, uiHost, enableErrorAutocapture } = config.config
                // A destination is as necessary as a key: with no configured
                // host there is nowhere to report to.
                if (!isPostHogConfigValid(config.config) || !errorTrackingApiKey || !host) {
                    return new NoOpErrorProvider()
                }
                return await new PostHogErrorProvider({
                    apiKey: errorTrackingApiKey,
                    errorTrackingApiKey,
                    host,
                    uiHost,
                    enableExceptionAutocapture: !!enableErrorAutocapture,
                }).initialize()
            }
            default:
                return new NoOpErrorProvider()
        }
    }

    /**
     * Gets the default compatibility provider configuration.
     * Remote error sinks must be registered explicitly through TelemetryService.
     */
    public static getDefaultConfig(): ErrorProviderConfig {
        return {
            type: "no-op",
            config: posthogConfig,
        }
    }
}

/**
 * No-operation error provider for when error logging is disabled
 * or for testing purposes
 */
export class NoOpErrorProvider implements IErrorProvider {
    async captureException(_error: Error | ClineError, _properties?: Record<string, unknown>): Promise<void> {}

    public logException(_error: Error | ClineError, _properties?: Record<string, unknown>): void {}

    public logMessage(
        _message: string,
        _level?: "error" | "warning" | "log" | "debug" | "info",
        _properties?: Record<string, unknown>,
    ): void {}

    public isEnabled(): boolean {
        return false
    }

    public getSettings() {
        return {
            enabled: false,
            hostEnabled: false,
            level: "off" as const,
        }
    }

    public async dispose(): Promise<void> {}
}
