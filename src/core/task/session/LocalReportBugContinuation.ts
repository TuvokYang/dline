import { executeReportBugOutcome } from "@core/reporting/ReportBugWorkflow"
import { Logger } from "@shared/services/Logger"
import type { TaskState } from "../kernel"
import type { TaskPayloadStore } from "../stores"
import { decodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { DialogPresentationEnvelope, DialogSelectionEnvelope } from "../stores/payload/TaskPayloadEnvelopes"
import type { UnownedDialogContinuationPort, UnownedDialogOutcome, UnownedDialogResolution } from "./UnownedDialogContinuation"

export interface LocalReportBugContinuationPorts {
    readonly state: () => Readonly<TaskState>
    readonly writable: () => boolean
    readonly payloads: Pick<TaskPayloadStore, "read">
}

/** A local preview has no tool block and must never turn its answer into Provider input. */
export class LocalReportBugContinuation implements UnownedDialogContinuationPort {
    /** Coalesce deliveries of the same accepted response, including a retirement retry. Not a crash receipt. */
    private readonly effects = new WeakMap<object, Promise<UnownedDialogOutcome>>()

    constructor(
        private readonly ports: LocalReportBugContinuationPorts,
        private readonly fallback: UnownedDialogContinuationPort,
    ) {}

    private owns(resolution: UnownedDialogResolution): boolean {
        // Reserve the namespace even after retirement erased its kind. A stale
        // delivery must be refused here, never downgraded to generic input.
        return resolution.interactionId.startsWith("report-bug-local:")
    }

    accepts(resolution: UnownedDialogResolution): boolean {
        return this.owns(resolution) || this.fallback.accepts(resolution)
    }

    async prepare(resolution: UnownedDialogResolution): Promise<boolean> {
        return this.owns(resolution) ? true : ((await this.fallback.prepare?.(resolution)) ?? true)
    }

    continue(resolution: UnownedDialogResolution): Promise<UnownedDialogOutcome> {
        if (!this.owns(resolution)) return this.fallback.continue(resolution)
        if (resolution.kind !== "report_bug") return Promise.resolve("declined")
        const state = this.ports.state()
        const interaction = [state.dialog.primary, state.dialog.interrupted].find(
            (candidate) => candidate?.interactionId === resolution.interactionId && candidate.kind === "report_bug",
        )
        const response = interaction?.acceptedResponse
        if (
            !interaction ||
            interaction.status !== "resolving" ||
            !response ||
            response.actionId !== resolution.outcome.actionId
        ) {
            return Promise.resolve("declined")
        }
        const isCurrent = () => {
            const current = this.ports.state()
            return (
                this.ports.writable() &&
                current.generation === state.generation &&
                current.halt.status === "idle" &&
                (resolution.isCurrent?.() ?? true) &&
                [current.dialog.primary, current.dialog.interrupted].some(
                    (candidate) =>
                        candidate?.interactionId === interaction.interactionId &&
                        candidate.status === "resolving" &&
                        candidate.acceptedResponse === response,
                )
            )
        }
        if (!isCurrent()) return Promise.resolve("declined")
        const existing = this.effects.get(response)
        if (existing) return existing
        const effect = (async (): Promise<UnownedDialogOutcome> => {
            try {
                const presentation = decodeTaskPayload<DialogPresentationEnvelope>(
                    await this.ports.payloads.read(interaction.presentationRef),
                )
                if (presentation.kind !== "dialog_presentation" || presentation.presentationKind !== "report_bug") return "failed"
                // Confirm reads exactly the accepted selection, never the unedited preview as a fallback.
                const selection = response.selectionRef
                    ? decodeTaskPayload<DialogSelectionEnvelope>(await this.ports.payloads.read(response.selectionRef))
                    : undefined
                if (selection && selection.kind !== "dialog_selection") return "failed"
                if (!isCurrent()) return "declined"
                const result = await executeReportBugOutcome(
                    {
                        ...resolution.outcome,
                        selection: selection ? { values: [...selection.values] } : undefined,
                    },
                    presentation.body,
                    isCurrent,
                )
                return result === "invalid" ? "failed" : "continued"
            } catch (error) {
                Logger.error(`Failed to execute local ReportBug interaction ${resolution.interactionId}`, error)
                return "failed"
            }
        })()
        this.effects.set(response, effect)
        void effect.then((outcome) => {
            if (outcome !== "continued") this.effects.delete(response)
        })
        return effect
    }
}
