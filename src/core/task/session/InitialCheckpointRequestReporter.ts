import { Logger } from "@shared/services/Logger"
import type { ProviderRequestRecord, ProviderRequestReportPort } from "../executors/provider/service/ProviderRequestReport"

/** The part of the checkpoint owner that opens a task's baseline restore point. */
export interface InitialCheckpointPort {
    beginInitialCheckpoint?(): Promise<void>
}

export interface InitialCheckpointRequestReporterOptions {
    /** Absent for a surface without workspace history. */
    readonly checkpoints: InitialCheckpointPort | undefined
    /** Whether the task already sent a request; read before this request opens its own row. */
    readonly hasRequested: () => boolean
}

/**
 * Opens the task's baseline restore point as its first provider request starts.
 *
 * The baseline has to capture the workspace before anything the model asks for
 * can change it, and the first request is the last moment that still holds.
 * Its row is written before the request's own row; the shadow-repository work
 * overlaps the request, and every tool that may write waits for it before it runs.
 */
export class InitialCheckpointRequestReporter implements ProviderRequestReportPort {
    constructor(
        private readonly report: ProviderRequestReportPort,
        private readonly options: InitialCheckpointRequestReporterOptions,
    ) {}

    async begin(input: { readonly turnId: string }): Promise<ProviderRequestRecord> {
        if (!this.options.hasRequested()) await this.openBaseline()
        return this.report.begin(input)
    }

    /** A baseline that cannot be opened only costs the restore point, never the request. */
    private async openBaseline(): Promise<void> {
        try {
            await this.options.checkpoints?.beginInitialCheckpoint?.()
        } catch (error) {
            Logger.error("Failed to open the baseline checkpoint before the first request", error)
        }
    }
}
