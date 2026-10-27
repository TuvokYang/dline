import type { Command, CompactionFlowState, ComposeRoundCommand, FlowState, TaskEvent } from "../types"

export interface FlowReduction {
    readonly state: FlowState
    readonly commands: readonly Command[]
}

type ComposeRoundPayload = Omit<ComposeRoundCommand, "commandId" | "originRevision" | "generation" | "type" | "turnId">

/** Every compose command opens one replay-stable business turn. */
export function composeRoundCommand(
    base: Pick<ComposeRoundCommand, "commandId" | "originRevision" | "generation">,
    payload: ComposeRoundPayload,
): ComposeRoundCommand {
    return { ...base, type: "compose.round", turnId: `turn:${base.commandId}`, ...payload }
}

/**
 * Retire a compaction whose executor can no longer report back.
 *
 * A halt advances the generation and a restart replaces the process, so the
 * run's own terminal event is refused or never sent. Left `running`, the slot
 * refused every later request as a duplicate and the task could never compact
 * again. Expired, not failed: nothing went wrong with the summary, the run was
 * simply abandoned, and nothing it produced was landed.
 */
export function expireAbandonedCompaction(
    compaction: CompactionFlowState | undefined,
    message: string,
): CompactionFlowState | undefined {
    if (compaction?.status !== "scheduled" && compaction?.status !== "running") return compaction
    return { ...compaction, status: "expired", message }
}

export function reduceFlow(state: FlowState, event: TaskEvent): FlowReduction {
    switch (event.type) {
        case "lifecycle.open":
            return { state: state.phase === "idle" ? { ...state, phase: "initializing" } : state, commands: [] }
        case "user.submit":
            // A submission is what ends a pause. Leaving the phase at `paused` let
            // the round it opens start and then be refused at `compose.completed`,
            // so answering Resume produced no reply at all.
            // It also ends any text-only streak: the user spoke, so whatever bound
            // the previous streak no longer applies to the round they just opened.
            // Submitting also spends a recovery reply admission.
            return {
                state:
                    state.phase === "paused"
                        ? {
                              ...state,
                              phase: "initializing",
                              textOnlyTurnStreak: 0,
                              plainTextWarningCount: 0,
                              plainTextWarningMistakes: 0,
                              toolMistakeCount: 0,
                              consecutiveMistakeCount: 0,
                              replyAdmission: undefined,
                          }
                        : {
                              ...state,
                              textOnlyTurnStreak: 0,
                              plainTextWarningCount: 0,
                              plainTextWarningMistakes: 0,
                              toolMistakeCount: 0,
                              consecutiveMistakeCount: 0,
                              replyAdmission: undefined,
                          },
                commands: [],
            }
        case "provider.turn_ready": {
            const warning = event.turnPlan.plainTextWarning
            const warningCount = warning ? (state.plainTextWarningCount ?? 0) + 1 : (state.plainTextWarningCount ?? 0)
            const promoted = warningCount >= 5
            const warningMistakes = (state.plainTextWarningMistakes ?? 0) + (promoted ? 1 : 0)
            const toolMistakes = state.toolMistakeCount ?? 0
            return {
                state: {
                    ...state,
                    phase: "running",
                    error: undefined,
                    replyAdmission: undefined,
                    // Ordinary plain text consumes the weighted warning budget.
                    // Other no-tool outcomes retain the strict raw-turn guard.
                    textOnlyTurnStreak:
                        event.turnPlan.blocks.length === 0 && warning === undefined ? (state.textOnlyTurnStreak ?? 0) + 1 : 0,
                    plainTextWarningCount: warning ? (promoted ? 0 : warningCount) : state.plainTextWarningCount,
                    plainTextWarningMistakes: warningMistakes,
                    toolMistakeCount: toolMistakes,
                    consecutiveMistakeCount: toolMistakes + warningMistakes,
                    provider: state.provider && {
                        ...state.provider,
                        status: "completed",
                        turnId: event.turnId,
                        finalPayloadRef: event.finalPayloadRef,
                        journalWatermark: event.journalWatermark,
                    },
                },
                commands: [],
            }
        }
        case "tool.completion_presented":
            // A completion is terminal as soon as its result has been staged for
            // presentation. Keeping the flow `running` made history recovery and the
            // Webview treat an already-finished task as resumable/streaming while the
            // completion dialog waited for Start New Task or feedback.
            return {
                state: { ...state, phase: "completed", completionId: event.blockId },
                commands: [],
            }
        case "tool.completed":
        case "tool.failed":
        case "tool.cancelled": {
            const toolMistakes = event.mistakeCount ?? state.toolMistakeCount ?? 0
            // A persisted tool result can be terminal yet failed. The executor
            // supplies that semantic fact; absent stays success-compatible for
            // restored events written before the field existed.
            const successful = event.type === "tool.completed" && event.successful !== false
            const warningMistakes = successful ? 0 : (state.plainTextWarningMistakes ?? 0)
            return {
                state: {
                    ...state,
                    toolMistakeCount: toolMistakes,
                    plainTextWarningCount: successful ? 0 : state.plainTextWarningCount,
                    plainTextWarningMistakes: warningMistakes,
                    consecutiveMistakeCount: toolMistakes + warningMistakes,
                    ...(event.mistakeLimit === undefined ? {} : { maxConsecutiveMistakes: event.mistakeLimit }),
                },
                commands: [],
            }
        }
        case "provider.failed":
            return {
                state: {
                    ...state,
                    phase: "error",
                    error: event.message,
                    replyAdmission: undefined,
                    provider: state.provider && { ...state.provider, status: "failed" },
                },
                commands: [],
            }
        case "dialog.responded": {
            const resumed =
                state.phase === "completed" && event.actionId === "reply"
                    ? { ...state, phase: "running" as const, completionId: undefined }
                    : state
            return {
                state:
                    event.queueDeliveryId && event.queueDeliveryEntries && event.queueDeliveryMode
                        ? {
                              ...resumed,
                              pendingQueueResponse: {
                                  deliveryId: event.queueDeliveryId,
                                  entries: event.queueDeliveryEntries,
                                  mode: event.queueDeliveryMode,
                              },
                          }
                        : resumed,
                commands: [],
            }
        }
        case "compose.completed":
            return {
                state: {
                    ...state,
                    pendingQueueResponse: state.compose?.respondedQueue ? undefined : state.pendingQueueResponse,
                    compose: state.compose && {
                        ...state.compose,
                        status: "completed",
                        ...(event.queueJournalReceipt === undefined ? {} : { queueJournalReceipt: event.queueJournalReceipt }),
                    },
                },
                commands: [],
            }
        case "compose.failed":
            return {
                state: {
                    ...state,
                    phase: "error",
                    error: event.message,
                    compose: state.compose && { ...state.compose, status: "failed" },
                },
                commands: [],
            }
        case "compose.withdrawn":
            // Waiting, not error: nothing failed that a retry could fix, and the
            // user decides what the task does next, so the composer takes a reply.
            return {
                state: {
                    ...state,
                    phase: "waiting",
                    replyAdmission: "user_turn",
                    compose: state.compose && { ...state.compose, status: "cancelled" },
                },
                commands: [],
            }
        case "approval.failed":
        case "dialog.failed":
            return { state: { ...state, phase: "error", error: event.message }, commands: [] }
        case "dialog.dismissed":
            // Dismissing the failure that stopped the round hands the task back to
            // the user with one ordinary reply, as dev's `profile_recovery` input:
            // without it the composer stays closed because no dialog owns it.
            return {
                state:
                    state.phase === "error"
                        ? { ...state, phase: "waiting", error: undefined, replyAdmission: "profile_recovery" }
                        : state,
                commands: [],
            }
        case "compaction.requested":
            return {
                state: {
                    ...state,
                    compaction: {
                        compactionId: event.compactionId,
                        attempt: event.attempt,
                        contextRef: event.contextRef,
                        status: "scheduled",
                    },
                },
                commands: [],
            }
        case "compaction.started":
            return {
                state: { ...state, compaction: state.compaction && { ...state.compaction, status: "running" } },
                commands: [],
            }
        case "compaction.completed":
            return {
                state: {
                    ...state,
                    compaction: state.compaction && { ...state.compaction, status: "completed", resultRef: event.resultRef },
                },
                commands: [],
            }
        case "compaction.failed":
            return {
                state: {
                    ...state,
                    compaction: state.compaction && { ...state.compaction, status: "failed", message: event.message },
                },
                commands: [],
            }
        case "compaction.expired":
            return {
                state: {
                    ...state,
                    compaction: state.compaction && { ...state.compaction, status: "expired", message: event.message },
                },
                commands: [],
            }
        case "lifecycle.close":
            return { state: { ...state, phase: "completed", completionId: state.completionId }, commands: [] }
        case "lifecycle.consumed":
            // Terminal on purpose: every later event is refused, so the block's own
            // completion cannot open another round for a conversation the
            // successor now owns. Hydration renders this form inert.
            return {
                state: { ...state, phase: "terminated", terminalReason: "consumed", consumedRef: event.consumedRef },
                commands: [],
            }
        default:
            return { state, commands: [] }
    }
}
