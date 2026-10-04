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
			return {
				state:
					state.phase === "paused"
						? { ...state, phase: "initializing", textOnlyTurnStreak: 0, consecutiveMistakeCount: 0 }
						: { ...state, textOnlyTurnStreak: 0, consecutiveMistakeCount: 0 },
				commands: [],
			}
		case "provider.turn_ready":
			return {
				state: {
					...state,
					phase: "running",
					error: undefined,
					// A turn that planned no block ends with nothing that could
					// report completion, so the streak is what later decides
					// whether the round is continued or handed back to the user.
					textOnlyTurnStreak: event.turnPlan.blocks.length === 0 ? (state.textOnlyTurnStreak ?? 0) + 1 : 0,
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
		case "tool.completed":
		case "tool.failed":
		case "tool.cancelled":
			return {
				state: {
					...state,
					...(event.mistakeCount === undefined ? {} : { consecutiveMistakeCount: event.mistakeCount }),
					...(event.mistakeLimit === undefined ? {} : { maxConsecutiveMistakes: event.mistakeLimit }),
				},
				commands: [],
			}
		case "provider.failed":
			return {
				state: {
					...state,
					phase: "error",
					error: event.message,
					provider: state.provider && { ...state.provider, status: "failed" },
				},
				commands: [],
			}
		case "dialog.responded":
			return {
				state:
					event.queueDeliveryId && event.queueDeliveryEntries && event.queueDeliveryMode
						? {
								...state,
								pendingQueueResponse: {
									deliveryId: event.queueDeliveryId,
									entries: event.queueDeliveryEntries,
									mode: event.queueDeliveryMode,
								},
							}
						: state,
				commands: [],
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
			// user decides what the task does next.
			return {
				state: {
					...state,
					phase: "waiting",
					compose: state.compose && { ...state.compose, status: "cancelled" },
				},
				commands: [],
			}
		case "approval.failed":
		case "dialog.failed":
			return { state: { ...state, phase: "error", error: event.message }, commands: [] }
		case "dialog.dismissed":
			return {
				state: state.phase === "error" ? { ...state, phase: "waiting", error: undefined } : state,
				commands: [],
			}
		case "lifecycle.spawned":
			return {
				state: {
					...state,
					spawn: state.spawn && { ...state.spawn, status: "completed", childTaskId: event.childTaskId },
				},
				commands: [],
			}
		case "lifecycle.spawn_failed":
			return {
				state: {
					...state,
					phase: "error",
					error: event.message ?? event.type,
					spawn: state.spawn && { ...state.spawn, status: "failed", message: event.message },
				},
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
