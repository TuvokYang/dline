import { type ErrorEventRecorder, errorEventRecorder, installLoggerTelemetryBridge } from "@/services/telemetry/events/error"
import { isSignalRecordingEnabled } from "@/services/telemetry/service/pipeline-port"
import { ClineError } from "./ClineError"
import { ErrorProviderFactory } from "./ErrorProviderFactory"
import { IErrorProvider } from "./providers/IErrorProvider"

/**
 * ErrorService handles error logging and tracking for the Cline extension
 * Uses an abstracted error provider to support multiple error tracking backends
 * Respects user privacy settings and VSCode's global telemetry configuration
 */
export class ErrorService {
    private static instance: ErrorService | null = null

    private readonly provider: IErrorProvider
    private readonly recorder: ErrorEventRecorder
    private readonly disposeLoggerBridge: () => void

    /**
     * Sets up the ErrorService singleton.
     */
    public static async initialize(): Promise<ErrorService> {
        if (ErrorService.instance) {
            throw new Error("ErrorService has already been initialized.")
        }

        const provider = await ErrorProviderFactory.createProvider(ErrorProviderFactory.getDefaultConfig())
        ErrorService.instance = new ErrorService(provider)
        return ErrorService.instance
    }

    /**
     * Gets the singleton instance
     */
    public static get(): ErrorService {
        if (!ErrorService.instance) {
            throw new Error("ErrorService not setup. Call ErrorService.initialize() first.")
        }
        return ErrorService.instance
    }

    constructor(provider: IErrorProvider, recorder: ErrorEventRecorder = errorEventRecorder) {
        this.provider = provider
        this.recorder = recorder
        this.disposeLoggerBridge = installLoggerTelemetryBridge(recorder)
    }

    captureException(error: Error | ClineError, properties?: Record<string, unknown>): Promise<void> {
        this.recorder.exception(error, properties)
        return Promise.resolve()
    }

    public logException(error: Error | ClineError, properties?: Record<string, unknown>): void {
        this.recorder.exception(error, properties)
    }

    public logMessage(
        message: string,
        level: "error" | "warning" | "log" | "debug" | "info" = "log",
        properties?: Record<string, unknown>,
    ): void {
        this.recorder.message(message, level, properties)
    }

    public toClineError(rawError: unknown, modelId?: string, providerId?: string): ClineError {
        const transformed = ClineError.transform(rawError, modelId, providerId)
        this.logException(transformed, { modelId, providerId })
        return transformed
    }

    /**
     * Check if error logging is currently enabled
     * @returns Boolean indicating whether error logging is enabled
     */
    public isEnabled(): boolean {
        return isSignalRecordingEnabled()
    }

    /**
     * Get current error logging settings
     * @returns Current error logging settings
     */
    public getSettings() {
        const enabled = this.isEnabled()
        return { enabled, hostEnabled: enabled, level: enabled ? ("all" as const) : ("off" as const) }
    }

    /**
     * Get the error provider instance
     * @returns The current error provider
     */
    public getProvider(): IErrorProvider {
        return this.provider
    }

    /**
     * Clean up resources when the service is disposed
     */
    public async dispose(): Promise<void> {
        this.disposeLoggerBridge()
        await this.provider.dispose()
        if (ErrorService.instance === this) ErrorService.instance = null
    }
}
