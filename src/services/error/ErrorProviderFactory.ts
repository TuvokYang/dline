import { ClineError } from "./ClineError"
import { IErrorProvider } from "./providers/IErrorProvider"

/**
 * Supported error provider types. Remote error sinks are registered through
 * TelemetryService; this factory only supplies the local compatibility provider.
 */
export type ErrorProviderType = "no-op"

/**
 * Configuration for error providers
 */
export interface ErrorProviderConfig {
    type: ErrorProviderType
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
    public static async createProvider(_config: ErrorProviderConfig): Promise<IErrorProvider> {
        return new NoOpErrorProvider()
    }

    /**
     * Gets the default compatibility provider configuration.
     * Remote error sinks must be registered explicitly through TelemetryService.
     */
    public static getDefaultConfig(): ErrorProviderConfig {
        return { type: "no-op" }
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
