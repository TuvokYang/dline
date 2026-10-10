import { afterEach, describe, expect, it, vi } from "vitest"
import { ErrorEventRecorder } from "@/services/telemetry/events/error"
import {
    configureSignalRecording,
    discardBootstrapSignals,
    installSignalPipeline,
    resetSignalRecording,
} from "@/services/telemetry/service/pipeline-port"
import { ErrorService } from "../ErrorService"
import type { IErrorProvider } from "../providers/IErrorProvider"

function provider(): IErrorProvider {
    return {
        captureException: vi.fn(async () => undefined),
        logException: vi.fn(),
        logMessage: vi.fn(),
        isEnabled: vi.fn(() => false),
        getSettings: vi.fn(() => ({ enabled: false, hostEnabled: false, level: "off" as const })),
        dispose: vi.fn(async () => undefined),
    }
}

describe("ErrorService", () => {
    afterEach(() => {
        installSignalPipeline(undefined)
        discardBootstrapSignals()
        resetSignalRecording()
        vi.restoreAllMocks()
    })

    it("uses the standard error recorder instead of the compatibility provider", async () => {
        configureSignalRecording({ enabled: () => true })
        const accept = vi.fn()
        installSignalPipeline({ accept })
        const errorProvider = provider()
        const service = new ErrorService(errorProvider, new ErrorEventRecorder())
        const error = new Error("Invalid task phase transition")

        service.logException(error, { modelId: "gpt-test" })
        service.logMessage("provider failed", "warning", { status: 503 })

        expect(accept).toHaveBeenCalledTimes(2)
        expect(errorProvider.logException).not.toHaveBeenCalled()
        expect(errorProvider.logMessage).not.toHaveBeenCalled()
        expect(service.isEnabled()).toBe(true)
        await service.dispose()
        expect(errorProvider.dispose).toHaveBeenCalledOnce()
    })
})
