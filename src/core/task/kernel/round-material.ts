import { isAway, resumesAutomaticResponse } from "./away"
import type { RoundMaterialInput, RoundMaterialPlan, RoundMaterialReceipt, TaskEvent, TaskState } from "./types"

/** Content-addressed payloads may repeat; acceptance, not bytes, identifies a material. */
export function roundInputId(input: RoundMaterialInput): string {
    return input.id ?? `${input.source}:${input.revision}:${input.entryId ?? input.payloadRef}`
}

export function roundMaterialReceipt(plan: RoundMaterialPlan): RoundMaterialReceipt {
    return { planId: plan.id, noticeIds: plan.notices.map((notice) => notice.id), feedbackIds: plan.inputs.map(roundInputId) }
}

/** Called at the Runtime linearization point, after queued controls were accepted. */
export function freezeRoundMaterial(state: TaskState): RoundMaterialPlan {
    const compose = state.flow.compose!
    if (compose.materialPlan) return compose.materialPlan
    const entries = [...state.intake.queued, ...state.intake.background, ...state.intake.coTask]
    const inputs: RoundMaterialInput[] = [...(state.roundMaterial?.feedback ?? [])]
    for (const entryId of compose.admittedEntryIds) {
        const entry = entries.find((candidate) => candidate.entryId === entryId)!
        inputs.push({
            id: `intake:${entry.entryId}`,
            source: "intake",
            entryId: entry.entryId,
            payloadRef: entry.payloadRef,
            revision: entry.acceptedRevision ?? 0,
        })
    }
    return {
        id: `round-material:${compose.commandId}`,
        frozenRevision: state.revision,
        notices: [...(state.roundMaterial?.notices ?? [])],
        inputs: inputs.sort((left, right) => left.revision - right.revision),
        ...(isAway(state) ? { activeAway: state.away?.mode } : {}),
    }
}

export function reduceRoundMaterial(previous: TaskState, state: TaskState, event: TaskEvent): TaskState {
    if (event.type === "dialog.responded") {
        const feedback = [...(state.roundMaterial?.feedback ?? [])]
        if (event.queueDeliveryEntries && event.roundFeedbackRef) {
            feedback.push(
                ...event.queueDeliveryEntries.map((entry) => ({
                    id: `queue-answer:${entry.entryId}:${state.revision}`,
                    source: "intake" as const,
                    entryId: entry.entryId,
                    payloadRef: entry.payloadRef,
                    revision: state.revision,
                })),
            )
        } else {
            const ref =
                event.roundFeedbackRef ?? (resumesAutomaticResponse(state, event.interactionId) ? event.draftRef : undefined)
            if (ref)
                feedback.push({
                    id: `reply:${event.interactionId}:${state.revision}`,
                    payloadRef: ref,
                    revision: state.revision,
                    source: Object.values(previous.dialog.approvalsByBlock).some(
                        (item) => item.interactionId === event.interactionId,
                    )
                        ? "approval"
                        : "dialog",
                })
        }
        return { ...state, roundMaterial: { notices: state.roundMaterial?.notices ?? [], feedback } }
    }
    if (event.type === "compose.freeze_requested") {
        return {
            ...state,
            flow: { ...state.flow, compose: { ...state.flow.compose!, materialPlan: freezeRoundMaterial(state) } },
        }
    }
    if (event.type === "compose.prepared_retired") {
        return {
            ...state,
            flow: { ...state.flow, compose: { ...state.flow.compose!, draftRef: undefined, materialPlan: undefined } },
        }
    }
    if (event.type === "compose.prepared_restored") {
        const owner = state.flow.compose!
        const selected = new Set(owner.admittedEntryIds)
        const consume = (entries: TaskState["intake"]["queued"]) =>
            entries.map((entry) =>
                selected.has(entry.entryId)
                    ? {
                          ...entry,
                          state: "consumed" as const,
                          journalWatermark: event.journalThrough,
                          ...(entry.queue ? { queue: { editing: false } } : {}),
                      }
                    : entry,
            )
        return settleRoundMaterial(
            {
                ...state,
                flow: {
                    ...state.flow,
                    compose: {
                        ...owner,
                        status: "completed",
                        draftRef: event.draftRef,
                        materialPlan: event.plan,
                        queueJournalReceipt: event.queueJournalReceipt,
                    },
                },
                journalWatermark:
                    (state.journalWatermark?.seq ?? 0) > event.journalThrough.seq ? state.journalWatermark : event.journalThrough,
                intake: {
                    queued: consume(state.intake.queued),
                    background: consume(state.intake.background),
                    coTask: consume(state.intake.coTask),
                },
            },
            roundMaterialReceipt(event.plan),
        )
    }
    return event.type === "compose.completed" && event.materialReceipt ? settleRoundMaterial(state, event.materialReceipt) : state
}

export function retriesPreparedRound(state: TaskState, interactionId: string): boolean {
    return (
        state.dialog.primary?.interactionId === interactionId &&
        state.dialog.primary.acceptedResponse?.retryPreparedRound === true &&
        state.flow.compose?.draftRef !== undefined
    )
}

function settleRoundMaterial(state: TaskState, receipt: RoundMaterialReceipt): TaskState {
    const noticeIds = new Set(receipt.noticeIds)
    const feedbackIds = new Set(receipt.feedbackIds)
    return {
        ...state,
        roundMaterial: {
            notices: (state.roundMaterial?.notices ?? []).filter((notice) => !noticeIds.has(notice.id)),
            feedback: (state.roundMaterial?.feedback ?? []).filter((input) => !feedbackIds.has(roundInputId(input))),
        },
    }
}
