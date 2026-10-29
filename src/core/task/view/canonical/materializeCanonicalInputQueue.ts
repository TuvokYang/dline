import type { TaskState } from "../../kernel"

export interface CanonicalInputQueuePayload<TSemanticInput> {
    readonly text?: string
    readonly images?: readonly string[]
    readonly files?: readonly string[]
    readonly activeQuote?: string
    readonly semanticInput?: TSemanticInput
}

export interface CanonicalInputQueueEntry<TSemanticInput> {
    readonly id: string
    readonly text: string
    readonly images: readonly string[]
    readonly files: readonly string[]
    readonly activeQuote?: string
    readonly semanticInput?: TSemanticInput
    readonly mode: "queued" | "steering"
    readonly editing: boolean
    readonly sequence: number
}

function visibleEntries(state: Readonly<TaskState>) {
    return state.intake.queued
        .filter(
            (entry) =>
                entry.source === "user" &&
                entry.queue !== undefined &&
                (entry.state === "accepted" || entry.state === "released"),
        )
        .sort((left, right) => left.sequence - right.sequence)
}

export function canonicalInputQueuePayloadRefs(state: Readonly<TaskState>): readonly string[] {
    return visibleEntries(state).map((entry) => entry.payloadRef)
}

/** Pure canonical projection from kernel facts and caller-materialized payload data. */
export function projectCanonicalInputQueue<TSemanticInput>(
    state: Readonly<TaskState>,
    payloads: ReadonlyMap<string, CanonicalInputQueuePayload<TSemanticInput>>,
): readonly CanonicalInputQueueEntry<TSemanticInput>[] {
    return visibleEntries(state).map((entry) => {
        const payload = payloads.get(entry.payloadRef)
        if (!payload) throw new Error(`CanonicalInputQueuePayloadMissing:${entry.payloadRef}`)
        return {
            id: entry.entryId,
            text: payload.text ?? "",
            images: payload.images ?? [],
            files: payload.files ?? [],
            ...(payload.activeQuote ? { activeQuote: payload.activeQuote } : {}),
            ...(payload.semanticInput ? { semanticInput: payload.semanticInput } : {}),
            mode: entry.mode,
            editing: entry.queue?.editing ?? false,
            sequence: entry.sequence,
        }
    })
}
