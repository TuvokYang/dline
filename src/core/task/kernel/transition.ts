import { reduceDialog, withoutAbandonedReview } from "./machines/dialog"
import { composeRoundCommand, expireAbandonedCompaction, reduceFlow } from "./machines/flow"
import { ALL_HALT_PARTICIPANTS, reduceHalt, validateHaltEvent } from "./machines/halt"
import {
    intakeHasCapacity,
    pendingIntakeEntryIds,
    reduceIntake,
    reserveIntakeEntries,
    reserveRetainedQueueEntries,
    retainedQueueDeliveryEntries,
    selectRetainedQueueEntryIds,
} from "./machines/intake"
import { settleTerminatedTurn } from "./machines/terminate"
import { reduceTurn, toolTerminalManifestPayload } from "./machines/turn"
import {
    allBlocksTerminal,
    canOpenNextRound,
    hasActiveRound,
    hasRunningBlocks,
    refusalContinuesTurn,
    TERMINAL_BLOCK_PHASES,
} from "./turn/turn-progress"
import type {
    Command,
    Diagnostic,
    DialogInteraction,
    JournalWatermark,
    RejectReason,
    TaskEvent,
    TaskState,
    TransitionResult,
} from "./types"

function reject(state: TaskState, reason: RejectReason, message: string): TransitionResult {
    return { kind: "rejected", state, reason, diagnostic: { code: reason, message } }
}

function commandBase(state: TaskState, sequence: number) {
    return {
        commandId:
            state.generation === 0
                ? `${state.taskId}:${state.revision}:${sequence}`
                : `${state.taskId}:g${state.generation}:${state.revision}:${sequence}`,
        originRevision: state.revision,
        generation: state.generation,
    }
}

type ValidationFailure = { readonly reason: RejectReason; readonly message: string }

function findInteraction(state: TaskState, interactionId: string) {
    if (state.dialog.primary?.interactionId === interactionId) return state.dialog.primary
    if (state.dialog.interrupted?.interactionId === interactionId) return state.dialog.interrupted
    return Object.values(state.dialog.approvalsByBlock).find((interaction) => interaction.interactionId === interactionId)
}

function updateInteraction(
    state: TaskState,
    interactionId: string,
    update: (interaction: DialogInteraction) => DialogInteraction,
): TaskState {
    const primary = state.dialog.primary?.interactionId === interactionId ? update(state.dialog.primary) : state.dialog.primary
    const interrupted =
        state.dialog.interrupted?.interactionId === interactionId ? update(state.dialog.interrupted) : state.dialog.interrupted
    const approvalsByBlock = Object.fromEntries(
        Object.entries(state.dialog.approvalsByBlock).map(([blockId, interaction]) => [
            blockId,
            interaction.interactionId === interactionId ? update(interaction) : interaction,
        ]),
    )
    return { ...state, dialog: { primary, interrupted, approvalsByBlock } }
}

function dialogCommandInput(interaction: DialogInteraction) {
    return {
        interactionId: interaction.interactionId,
        turnId: interaction.turnId,
        kind: interaction.kind,
        presentationRef: interaction.presentationRef,
        ...(interaction.presentationAsk === undefined ? {} : { presentationAsk: interaction.presentationAsk }),
        actionRules: interaction.actionRules,
        blockId: interaction.blockId,
        prepareKey: interaction.prepareKey ?? `dialog.prepare:${interaction.interactionId}`,
    }
}

function maxWatermark(current: JournalWatermark | undefined, incoming: JournalWatermark): JournalWatermark {
    if (!current) return incoming
    return current.seq >= incoming.seq ? current : incoming
}

function hasRequiredPayload(
    policy: "none" | "draft" | "selection" | "draft_and_selection",
    event: Extract<TaskEvent, { type: "dialog.responded" }>,
): boolean {
    if (policy === "none") return true
    if (policy === "draft") return event.draftRef !== undefined
    if (policy === "selection") return event.selectionRef !== undefined
    return event.draftRef !== undefined && event.selectionRef !== undefined
}

function validateEvent(state: TaskState, event: TaskEvent): ValidationFailure | undefined {
    if (
        event.type === "user.submit" ||
        event.type === "background.ready" ||
        event.type === "cotask.received" ||
        event.type === "input_queue.enqueued"
    ) {
        const entries =
            event.type === "user.submit" || event.type === "input_queue.enqueued"
                ? state.intake.queued
                : event.type === "background.ready"
                  ? state.intake.background
                  : state.intake.coTask
        if (entries.some((entry) => entry.entryId === event.entryId))
            return { reason: "duplicate", message: `Entry ${event.entryId} already exists` }
        if (!intakeHasCapacity(entries)) return { reason: "capacity_exceeded", message: "Intake box capacity exceeded" }
    }
    if (
        event.type === "input_queue.mode_toggled" ||
        event.type === "input_queue.reordered" ||
        event.type === "input_queue.edit_started" ||
        event.type === "input_queue.edit_committed" ||
        event.type === "input_queue.edit_cancelled" ||
        event.type === "input_queue.removed"
    ) {
        const entry = state.intake.queued.find((candidate) => candidate.entryId === event.entryId)
        if (!entry || entry.source !== "user" || entry.queue === undefined)
            return { reason: "identity_mismatch", message: `Retained input ${event.entryId} does not exist` }
        if (event.type !== "input_queue.removed" && entry.state !== "accepted" && entry.state !== "released")
            return { reason: "phase_invalid", message: `Retained input ${event.entryId} is not mutable from ${entry.state}` }
    }
    if (event.type === "input_queue.delivery_reconciled") {
        const delivery = retainedQueueDeliveryEntries(state.intake, event.deliveryId)
        if (delivery.length === 0)
            return { reason: "identity_mismatch", message: `Queue delivery ${event.deliveryId} cannot be reconciled` }
        if (event.outcome === "consumed" && !event.journalWatermark)
            return { reason: "phase_invalid", message: "Consumed queue settlement requires a journal watermark" }
    }
    if (event.type === "input_queue.delivery_reserved") {
        if (state.halt.status === "stopping" || state.flow.phase === "paused")
            return { reason: "phase_invalid", message: "Retained input cannot be reserved while halted" }
        if (
            event.point === "turn_end" &&
            (state.dialog.primary?.interactionId !== event.ownerId || state.dialog.primary.status !== "awaiting")
        )
            return { reason: "identity_mismatch", message: "Retained delivery has no awaiting owner" }
        if (retainedQueueDeliveryEntries(state.intake, event.deliveryId).length > 0)
            return { reason: "duplicate", message: `Queue delivery ${event.deliveryId} is already reserved` }
        if (selectRetainedQueueEntryIds(state.intake, event.point).length === 0)
            return { reason: "phase_invalid", message: `No retained input is deliverable at ${event.point}` }
    }
    if (
        event.type === "input_queue.delivery_released" &&
        retainedQueueDeliveryEntries(state.intake, event.deliveryId).length === 0
    )
        return { reason: "identity_mismatch", message: `Queue delivery ${event.deliveryId} is not reserved` }
    const invalidHalt = validateHaltEvent(state.halt, event)
    if (invalidHalt) return invalidHalt
    if (event.type.startsWith("tool.")) {
        const toolEvent = event as Extract<
            TaskEvent,
            { type: "tool.started" | "tool.completed" | "tool.failed" | "tool.cancelled" | "tool.completion_presented" }
        >
        if (state.turn.turnId !== toolEvent.turnId)
            return { reason: "identity_mismatch", message: `Turn ${toolEvent.turnId} is not active` }
        const block = state.turn.blocks.find((candidate) => candidate.blockId === toolEvent.blockId)
        if (!block) return { reason: "identity_mismatch", message: `Block ${toolEvent.blockId} is not active` }
        if (block.attempt !== toolEvent.attempt)
            return { reason: "stale_attempt", message: `Attempt ${toolEvent.attempt ?? "missing"} is stale` }
        if (toolEvent.type === "tool.started" && block.phase !== "ready")
            return {
                reason: block.phase === "executing" ? "duplicate" : "phase_invalid",
                message: `Block ${block.blockId} cannot start from ${block.phase}`,
            }
        if (toolEvent.type !== "tool.started" && block.phase !== "executing")
            return {
                reason: TERMINAL_BLOCK_PHASES.has(block.phase) ? "duplicate" : "phase_invalid",
                message: `Block ${block.blockId} cannot finish from ${block.phase}`,
            }
        if (toolEvent.type === "tool.completion_presented") {
            if (state.halt.status !== "idle")
                return { reason: "phase_invalid", message: "A stopping task cannot present a completion" }
            if (!block.turnEnding) return { reason: "phase_invalid", message: `Block ${block.blockId} does not end the turn` }
            if (block.presentedCompletion)
                return { reason: "duplicate", message: `Block ${block.blockId} already presented its completion` }
        }
    }
    if (event.type === "approval.requested") {
        if (state.turn.turnId !== event.turnId || !state.turn.blocks.some((block) => block.blockId === event.blockId))
            return { reason: "identity_mismatch", message: `Approval block ${event.blockId} is not active` }
        if (state.turn.blocks.find((block) => block.blockId === event.blockId)?.phase !== "pending")
            return { reason: "phase_invalid", message: `Block ${event.blockId} is not pending` }
    }
    if (event.type === "approval.responded") {
        const block = state.turn.blocks.find((candidate) => candidate.blockId === event.blockId)
        const interaction = state.dialog.approvalsByBlock[event.blockId]
        if (state.turn.turnId !== event.turnId || !block || interaction?.interactionId !== event.interactionId)
            return { reason: "identity_mismatch", message: `Approval block ${event.blockId} is not active` }
        if (
            !state.turn.manualApprovalBlockIds.includes(event.blockId) ||
            block.phase !== "awaiting_approval" ||
            interaction.status !== "resolving"
        )
            return { reason: "phase_invalid", message: `Block ${event.blockId} is not awaiting a resolved approval` }
        const decision =
            interaction.acceptedResponse?.actionId === "approve"
                ? true
                : interaction.acceptedResponse?.actionId === "reject"
                  ? false
                  : undefined
        if (decision !== undefined && decision !== event.approved)
            return { reason: "identity_mismatch", message: "Approval result does not match the accepted dialog action" }
    }
    if (event.type === "approval.evaluation_requested") {
        const block = state.turn.blocks.find((candidate) => candidate.blockId === event.blockId)
        if (state.turn.turnId !== event.turnId || !block)
            return { reason: "identity_mismatch", message: `Policy block ${event.blockId} is not active` }
        if (block.attempt !== event.attempt)
            return { reason: "stale_attempt", message: `Policy attempt ${event.attempt} is stale` }
        if (block.policy?.status === "running")
            return { reason: "duplicate", message: `Policy evaluation for ${event.blockId} is already active` }
        if (block.phase !== "pending")
            return { reason: "phase_invalid", message: `Block ${event.blockId} cannot request policy from ${block.phase}` }
    }
    if (event.type === "approval.evaluated" || event.type === "approval.failed") {
        const block = state.turn.blocks.find((candidate) => candidate.blockId === event.blockId)
        const owner = block?.policy
        if (
            !block ||
            block.attempt !== event.attempt ||
            !owner ||
            owner.commandId !== event.commandId ||
            owner.originRevision !== event.originRevision ||
            owner.interactionId !== event.interactionId ||
            owner.policyRevision !== event.policyRevision
        )
            return { reason: "identity_mismatch", message: `Policy feedback ${event.commandId} is not active` }
        if (owner.status !== "running")
            return { reason: "duplicate", message: `Policy command ${event.commandId} already settled` }
        if (block.phase !== "pending" && block.phase !== "awaiting_approval")
            return {
                reason: "phase_invalid",
                message: `Block ${event.blockId} cannot accept policy feedback from ${block.phase}`,
            }
    }
    if (event.type === "compose.completed" || event.type === "compose.failed" || event.type === "compose.withdrawn") {
        const owner = state.flow.compose
        if (!owner || owner.commandId !== event.commandId || owner.originRevision !== event.originRevision)
            return { reason: "identity_mismatch", message: `Compose feedback ${event.commandId} is not active` }
        if (owner.status !== "running")
            return { reason: "duplicate", message: `Compose command ${event.commandId} already settled` }
        if (state.halt.status === "stopping" || state.flow.phase === "paused" || state.flow.phase === "terminated")
            return { reason: "phase_invalid", message: "Compose feedback arrived after task halt" }
        if (event.type === "compose.completed") {
            if (event.draftRef.length === 0)
                return { reason: "identity_mismatch", message: "Compose completion has no draft reference" }
            const retained = state.intake.queued
                .filter(
                    (entry) => owner.admittedEntryIds.includes(entry.entryId) && entry.queue?.delivery?.point === "tool_round",
                )
                .sort(
                    (left, right) => owner.admittedEntryIds.indexOf(left.entryId) - owner.admittedEntryIds.indexOf(right.entryId),
                )
            const receipt = event.queueJournalReceipt
            if (retained.length > 0 && !receipt)
                return { reason: "identity_mismatch", message: "Retained compose completion has no journal receipt" }
            if (receipt) {
                if (
                    receipt.deliveryId.length === 0 ||
                    receipt.journalWatermark.seq <= 0 ||
                    receipt.entries.length !== retained.length
                )
                    return { reason: "identity_mismatch", message: "Retained compose receipt is malformed" }
                if (
                    retained.some(
                        (entry, index) =>
                            entry.state !== "reserved" ||
                            entry.queue?.delivery?.deliveryId !== receipt.deliveryId ||
                            entry.queue.delivery.ownerId !== event.commandId ||
                            entry.queue.delivery.generation !== event.generation ||
                            entry.entryId !== receipt.entries[index]?.entryId ||
                            entry.payloadRef !== receipt.entries[index]?.payloadRef,
                    )
                )
                    return { reason: "identity_mismatch", message: "Retained compose receipt does not match its live batch" }
            }
        }
    }
    if (event.type === "provider.turn_ready" || event.type === "provider.failed") {
        const owner = state.flow.provider
        if (!owner || owner.commandId !== event.commandId || owner.originRevision !== event.originRevision)
            return { reason: "identity_mismatch", message: `Provider feedback ${event.commandId} is not active` }
        if (owner.status !== "running")
            return { reason: "duplicate", message: `Provider command ${event.commandId} already settled` }
        if (state.halt.status === "stopping" || state.flow.phase === "paused" || state.flow.phase === "terminated")
            return { reason: "phase_invalid", message: "Provider feedback arrived after task halt" }
    }
    if (event.type === "compaction.requested") {
        const current = state.flow.compaction
        if (current && (current.status === "scheduled" || current.status === "running"))
            return { reason: "duplicate", message: `Compaction ${current.compactionId} is already active` }
        if (current?.compactionId === event.compactionId && current.attempt === event.attempt)
            return { reason: "stale_attempt", message: `Compaction attempt ${event.attempt} was already consumed` }
    }
    if (
        event.type === "compaction.started" ||
        event.type === "compaction.completed" ||
        event.type === "compaction.failed" ||
        event.type === "compaction.expired"
    ) {
        const current = state.flow.compaction
        if (!current || current.compactionId !== event.compactionId)
            return { reason: "identity_mismatch", message: `Compaction ${event.compactionId} is not active` }
        if (current.attempt !== event.attempt)
            return { reason: "stale_attempt", message: `Compaction attempt ${event.attempt} is stale` }
        const expected = event.type === "compaction.started" ? "scheduled" : "running"
        if (current.status !== expected)
            return {
                reason: ["completed", "failed", "expired"].includes(current.status) ? "duplicate" : "phase_invalid",
                message: `Compaction ${event.compactionId} cannot accept ${event.type} from ${current.status}`,
            }
    }
    if (event.type === "dialog.requested" || event.type === "dialog.interrupt_requested") {
        if (findInteraction(state, event.interactionId))
            return { reason: "duplicate", message: `Interaction ${event.interactionId} already exists` }
        if (event.type === "dialog.requested" && state.dialog.primary)
            return { reason: "phase_invalid", message: `Primary interaction ${state.dialog.primary.interactionId} is active` }
        if (
            event.type === "dialog.interrupt_requested" &&
            (state.dialog.primary?.status !== "awaiting" || state.dialog.interrupted)
        )
            return { reason: "phase_invalid", message: "Only one awaiting primary interaction can be interrupted" }
    }
    if (event.type === "approval.requested" && findInteraction(state, event.interactionId))
        return { reason: "duplicate", message: `Interaction ${event.interactionId} already exists` }
    if (
        event.type === "dialog.prepared" ||
        event.type === "dialog.presented" ||
        event.type === "dialog.failed" ||
        event.type === "dialog.responded" ||
        event.type === "dialog.reopened" ||
        event.type === "dialog.resolved" ||
        event.type === "dialog.dismissed"
    ) {
        const interaction = findInteraction(state, event.interactionId)
        if (!interaction) return { reason: "identity_mismatch", message: `Interaction ${event.interactionId} is not active` }
        if (state.dialog.interrupted?.interactionId === event.interactionId)
            return { reason: "phase_invalid", message: `Interaction ${event.interactionId} is interrupted` }
        if (event.type === "dialog.prepared" || event.type === "dialog.presented" || event.type === "dialog.failed") {
            const stage =
                event.type === "dialog.prepared" ? "prepare" : event.type === "dialog.presented" ? "reveal" : event.stage
            const owner = stage === "prepare" ? interaction.prepare : interaction.reveal
            if (!owner || owner.commandId !== event.commandId || owner.originRevision !== event.originRevision)
                return { reason: "identity_mismatch", message: `Dialog feedback ${event.commandId} is not active` }
            if (owner.status !== "running")
                return { reason: "duplicate", message: `Dialog command ${event.commandId} already settled` }
        }
        if (event.type === "dialog.prepared" && interaction.status !== "planned")
            return {
                reason: interaction.status === "prepared" ? "duplicate" : "phase_invalid",
                message: "Interaction is not planned",
            }
        if (event.type === "dialog.presented" && interaction.status !== "prepared")
            return {
                reason: interaction.status === "awaiting" ? "duplicate" : "phase_invalid",
                message: "Interaction is not prepared",
            }
        if (event.type === "dialog.reopened" && interaction.status !== "resolving")
            return { reason: "phase_invalid", message: "Only a resolving interaction can be reopened" }
        if (
            event.type === "dialog.dismissed" &&
            (state.dialog.primary?.interactionId !== event.interactionId || interaction.kind !== "error_retry")
        )
            return { reason: "phase_invalid", message: "Only the active provider failure dialog can be dismissed" }
        if (
            event.type === "dialog.resolved" &&
            interaction.status !== "resolving" &&
            !(interaction.status === "awaiting" && interaction.acceptedResponse)
        )
            return { reason: "phase_invalid", message: "Interaction has no committed response to resolve" }
        if (event.type === "dialog.responded") {
            if (
                event.taskId !== state.taskId ||
                event.turnId !== interaction.turnId ||
                event.stateRevision < interaction.createdRevision ||
                event.stateRevision > state.revision ||
                event.receiverGeneration !== interaction.receiverGeneration
            )
                return { reason: "identity_mismatch", message: "Interaction response is outside its causal window" }
            if (interaction.acceptedResponse?.queuedInput)
                return { reason: "duplicate", message: "Retained response is already committed" }
            if (interaction.status !== "awaiting")
                return {
                    reason: interaction.status === "resolving" ? "duplicate" : "phase_invalid",
                    message: "Interaction is not awaiting response",
                }
            const rule = interaction.actionRules.find((candidate) => candidate.actionId === event.actionId)
            if (!rule) return { reason: "identity_mismatch", message: `Action ${event.actionId} is not valid` }
            if (!hasRequiredPayload(rule.payloadPolicy, event))
                return { reason: "phase_invalid", message: `Action ${event.actionId} is missing required payload` }
            if (event.queueDeliveryId) {
                if (state.halt.status === "stopping" || state.flow.phase === "paused")
                    return { reason: "phase_invalid", message: "Retained delivery cannot respond after halt" }
                const delivery = retainedQueueDeliveryEntries(state.intake, event.queueDeliveryId)
                if (
                    delivery.length === 0 ||
                    delivery.some(
                        (entry) =>
                            entry.state !== "reserved" ||
                            entry.queue?.delivery?.point !== "turn_end" ||
                            entry.queue.delivery.generation !== event.generation ||
                            entry.queue.delivery.ownerId !== event.interactionId,
                    )
                )
                    return {
                        reason: "identity_mismatch",
                        message: `Queue delivery ${event.queueDeliveryId} does not own this response`,
                    }
                const expected = event.queueDeliveryEntries
                if (
                    !expected ||
                    expected.length !== delivery.length ||
                    delivery.some(
                        (entry, index) =>
                            entry.entryId !== expected[index]?.entryId || entry.payloadRef !== expected[index]?.payloadRef,
                    )
                )
                    return { reason: "identity_mismatch", message: "Retained delivery content changed before response" }
                if (!event.queueDeliveryMode || delivery.some((entry) => entry.mode !== event.queueDeliveryMode))
                    return { reason: "identity_mismatch", message: "Retained delivery mode does not match its response" }
            }
        }
    }
    if (event.type === "lifecycle.open" && state.flow.phase !== "idle")
        return { reason: "phase_invalid", message: `Task cannot open from ${state.flow.phase}` }
    if (event.type === "lifecycle.consumed") {
        // Only the block that is running may hand the task over; anything else is a
        // stale or forged handoff that must not end a task still in use.
        if (!event.consumedRef) return { reason: "identity_mismatch", message: "Consumed task has no consumed identity" }
        const block = state.turn.blocks.find((candidate) => candidate.blockId === event.blockId)
        if (state.turn.turnId !== event.turnId || !block)
            return { reason: "identity_mismatch", message: `Consuming block ${event.blockId} is not active` }
        if (block.phase !== "executing")
            return { reason: "phase_invalid", message: `Block ${event.blockId} cannot hand off from ${block.phase}` }
        if (state.halt.status === "stopping")
            return { reason: "phase_invalid", message: "Task cannot hand off while it is stopping" }
    }
    return undefined
}

/**
 * How many consecutive answers without a tool call end the automatic run.
 *
 * The continuation exists so a model that replies in prose still reaches its
 * next tool call. A model that never calls one has to stop instead, so the task
 * returns to the user rather than spending an account on an endless loop. The
 * value matches the default `maxConsecutiveMistakes`, which is where the
 * previous runtime stopped the same loop.
 */
const MAX_TEXT_ONLY_TURNS = 3

/** Dialog kind the surface renders as "Task Needs Attention" with Process Anyway. */
const MISTAKE_LIMIT_DIALOG_KIND = "mistake_limit"

/** Guidance shown when the text-only limit hands the task back to the user. */
const MISTAKE_LIMIT_PRESENTATION =
    "Dline answered several times without using a tool. This may indicate a failure in its thought process or an " +
    'inability to use a tool properly, which can be mitigated with some user guidance (e.g. "Try breaking down the ' +
    'task into smaller steps").'

/**
 * Consecutive responses without a tool call at which the kernel stops opening
 * rounds on its own and hands the task back to the user.
 */
export function mistakeLimit(state: TaskState): number {
    const configured = state.flow.maxConsecutiveMistakes
    return typeof configured === "number" && Number.isFinite(configured)
        ? Math.max(1, Math.trunc(configured))
        : MAX_TEXT_ONLY_TURNS
}

/** Whether a turn that planned no tool may open the next round on its own. */
function continuesWithoutTools(state: TaskState): boolean {
    return canOpenNextRound(state) && (state.flow.textOnlyTurnStreak ?? 0) < mistakeLimit(state)
}

function applyCommandOwnership(state: TaskState, commands: readonly Command[]): TaskState {
    let next = state
    for (const command of commands) {
        if (command.type === "compose.round") {
            const retained = command.queueDelivery
                ? reserveRetainedQueueEntries(next.intake, command.admittedEntryIds, command.queueDelivery)
                : next.intake
            next = {
                ...next,
                flow: {
                    ...next.flow,
                    compose: {
                        commandId: command.commandId,
                        originRevision: command.originRevision,
                        status: "running",
                        admittedEntryIds: command.admittedEntryIds,
                        turnId: command.turnId,
                        ...(command.respondedQueue ? { respondedQueue: command.respondedQueue } : {}),
                    },
                },
                intake: reserveIntakeEntries(retained, command.admittedEntryIds),
            }
        }
        if (command.type === "provider.start") {
            next = {
                ...next,
                flow: {
                    ...next.flow,
                    provider: {
                        commandId: command.commandId,
                        originRevision: command.originRevision,
                        status: "running",
                        turnId: command.turnId,
                    },
                },
            }
        }
        if (command.type === "dialog.prepare" || command.type === "dialog.reveal") {
            next = updateInteraction(next, command.interactionId, (interaction) => ({
                ...interaction,
                [command.type === "dialog.prepare" ? "prepare" : "reveal"]: {
                    commandId: command.commandId,
                    originRevision: command.originRevision,
                    status: "running",
                },
            }))
        }
        if (command.type === "approval.evaluate") {
            next = {
                ...next,
                turn: {
                    ...next.turn,
                    blocks: next.turn.blocks.map((block) =>
                        block.blockId === command.blockId
                            ? {
                                  ...block,
                                  policy: {
                                      commandId: command.commandId,
                                      originRevision: command.originRevision,
                                      status: "running",
                                      interactionId: command.interactionId,
                                      policyRevision: command.policyRevision,
                                  },
                              }
                            : block,
                    ),
                },
            }
        }
    }
    return next
}

/** Retire a settled turn and compose the round that reports every block's outcome. */
function settledTurnCommands(next: TaskState, turnId: string): readonly Command[] {
    const retained = selectRetainedQueueEntryIds(next.intake, "tool_round")
    const compose = composeRoundCommand(commandBase(next, 1), {
        admittedEntryIds: [...pendingIntakeEntryIds(next.intake), ...retained],
        ...toolTerminalManifestPayload(next.turn),
    })
    const queueDelivery =
        retained.length > 0
            ? {
                  deliveryId: `queue:tool_round:${compose.commandId}`,
                  point: "tool_round" as const,
                  ownerId: compose.commandId,
                  generation: next.generation,
              }
            : undefined
    return [
        { ...commandBase(next, 0), type: "tool.retire", turnId },
        queueDelivery === undefined ? compose : { ...compose, queueDelivery },
    ]
}

function deriveCommands(previous: TaskState, next: TaskState, event: TaskEvent): readonly Command[] {
    if (event.type === "user.cancel" || event.type === "user.terminate") {
        // A terminate received during an active halt is an escalation of that same
        // barrier, not a second stop operation with a competing identity.
        if (previous.halt.status === "stopping") return []
        return [
            {
                ...commandBase(next, 0),
                type: "halt.stop",
                haltId: event.haltId,
                participantIds: ALL_HALT_PARTICIPANTS,
                reason: event.type === "user.terminate" ? "terminate" : "cancel",
            },
        ]
    }
    if (event.type === "approval.requested" || event.type === "dialog.requested" || event.type === "dialog.interrupt_requested") {
        const interaction = findInteraction(next, event.interactionId)
        return interaction ? [{ ...commandBase(next, 0), type: "dialog.prepare", ...dialogCommandInput(interaction) }] : []
    }
    if (event.type === "dialog.prepared") {
        const interaction = findInteraction(next, event.interactionId)
        return interaction?.journalRef && interaction.receiverGeneration !== undefined
            ? [
                  {
                      ...commandBase(next, 0),
                      type: "dialog.reveal",
                      ...dialogCommandInput(interaction),
                      journalRef: interaction.journalRef,
                      receiverGeneration: interaction.receiverGeneration,
                      revealKey:
                          interaction.revealKey ?? `dialog.reveal:${interaction.interactionId}:${interaction.receiverGeneration}`,
                  },
              ]
            : []
    }
    if (event.type === "approval.evaluation_requested") {
        return [
            {
                ...commandBase(next, 0),
                type: "approval.evaluate",
                interactionId: event.interactionId,
                blockId: event.blockId,
                policyRevision: event.policyRevision,
                riskFacts: event.riskFacts,
                attempt: event.attempt,
            },
        ]
    }
    if ((event.type === "approval.evaluated" || event.type === "approval.responded") && event.approved) {
        const before = previous.turn.blocks.find((block) => block.blockId === event.blockId)
        const after = next.turn.blocks.find((block) => block.blockId === event.blockId)
        if (before?.phase !== "ready" && after?.phase === "ready" && next.turn.turnId && after) {
            return [
                {
                    ...commandBase(next, 0),
                    type: "tool.run",
                    turnId: next.turn.turnId,
                    mode: next.turn.mode,
                    blocks: [
                        {
                            blockId: after.blockId,
                            attempt: after.attempt,
                            index: after.index,
                            lanes: after.lanes,
                            turnEnding: after.turnEnding,
                            invocationRef: after.invocationRef,
                        },
                    ],
                },
            ]
        }
    }
    if (refusalContinuesTurn(previous, next, event) && next.turn.turnId) {
        return settledTurnCommands(next, next.turn.turnId)
    }
    if (
        (event.type === "approval.evaluated" || event.type === "approval.responded") &&
        event.approved === false &&
        !allBlocksTerminal(previous) &&
        allBlocksTerminal(next) &&
        next.turn.turnId
    ) {
        return [{ ...commandBase(next, 0), type: "tool.retire", turnId: next.turn.turnId }]
    }
    if (
        (event.type === "user.submit" || event.type === "background.ready" || event.type === "cotask.received") &&
        previous.flow.phase !== "terminated" &&
        !hasActiveRound(previous)
    ) {
        if (event.type !== "user.submit") {
            if (["idle", "paused", "completed"].includes(previous.flow.phase)) {
                const interaction = next.dialog.primary
                return interaction
                    ? [{ ...commandBase(next, 0), type: "dialog.prepare", ...dialogCommandInput(interaction) }]
                    : []
            }
            // A background arrival never takes the next request from the user or
            // from the turn in progress: an open dialog waits for the user's answer
            // and running tools compose their own continuation, and both of those
            // rounds carry the pending intake with them.
            if (previous.dialog.primary || hasRunningBlocks(previous)) return []
        }
        return [
            composeRoundCommand(commandBase(next, 0), {
                // Anything still waiting rides along with the arrival that opened
                // this round, so an entry that arrived mid-round is not left behind.
                admittedEntryIds: pendingIntakeEntryIds(next.intake),
                ...toolTerminalManifestPayload(next.turn),
            }),
        ]
    }
    if (
        (event.type === "tool.completed" || event.type === "tool.failed" || event.type === "tool.cancelled") &&
        !allBlocksTerminal(previous) &&
        allBlocksTerminal(next) &&
        !hasActiveRound(previous)
    ) {
        if (!previous.dialog.primary && next.dialog.primary?.kind === MISTAKE_LIMIT_DIALOG_KIND) {
            return [{ ...commandBase(next, 0), type: "dialog.prepare", ...dialogCommandInput(next.dialog.primary) }]
        }
        const completedTurnId = next.turn.turnId
        return completedTurnId ? settledTurnCommands(next, completedTurnId) : []
    }
    if (event.type === "compose.completed") {
        return [{ ...commandBase(next, 0), type: "provider.start", draftRef: event.draftRef, turnId: event.turnId }]
    }
    if (event.type === "provider.turn_ready") {
        const commands: Command[] = []
        let sequence = 0
        // A turn that planned no block has nothing that will ever settle it, so
        // the conversation only moves if the kernel opens the next round itself.
        // Without this a plain answer ended the task silently: no tool ran, no
        // interaction was offered, and no further request was ever made.
        if (event.turnPlan.blocks.length === 0) {
            // Anything that arrived while the turn ran is waiting for a round to
            // carry it. That is the user speaking again, not the model continuing
            // itself, so it opens a round regardless of the text-only budget.
            const pending = pendingIntakeEntryIds(next.intake)
            if (pending.length > 0 && canOpenNextRound(next)) {
                return [composeRoundCommand(commandBase(next, 0), { admittedEntryIds: pending })]
            }
            if (!previous.dialog.primary && next.dialog.primary?.kind === MISTAKE_LIMIT_DIALOG_KIND) {
                return [{ ...commandBase(next, 0), type: "dialog.prepare", ...dialogCommandInput(next.dialog.primary) }]
            }
            return continuesWithoutTools(next)
                ? [composeRoundCommand(commandBase(next, 0), { admittedEntryIds: [], continuation: "no_tools_used" })]
                : []
        }
        const readyBlocks = next.turn.blocks.filter((block) => block.phase === "ready")
        if (readyBlocks.length > 0) {
            commands.push({
                ...commandBase(next, sequence++),
                type: "tool.run",
                turnId: event.turnId,
                mode: next.turn.mode,
                blocks: readyBlocks.map((block) => ({
                    blockId: block.blockId,
                    attempt: block.attempt,
                    index: block.index,
                    lanes: block.lanes,
                    turnEnding: block.turnEnding,
                    invocationRef: block.invocationRef,
                })),
            })
        }
        for (const block of event.turnPlan.blocks) {
            if (block.approval.kind === "manual") {
                const interaction = next.dialog.approvalsByBlock[block.blockId]
                if (interaction)
                    commands.push({
                        ...commandBase(next, sequence++),
                        type: "dialog.prepare",
                        ...dialogCommandInput(interaction),
                    })
            }
            if (block.approval.kind === "automatic") {
                commands.push({
                    ...commandBase(next, sequence++),
                    type: "approval.evaluate",
                    interactionId: block.approval.interactionId,
                    blockId: block.blockId,
                    policyRevision: block.approval.policyRevision,
                    riskFacts: block.approval.riskFacts,
                    attempt: block.attempt,
                })
            }
        }
        return commands
    }
    if (event.type === "compaction.requested") {
        return [
            {
                ...commandBase(next, 0),
                type: "compaction.run",
                compactionId: event.compactionId,
                attempt: event.attempt,
                contextRef: event.contextRef,
            },
        ]
    }
    if (
        (event.type === "provider.failed" || event.type === "compose.failed") &&
        !previous.dialog.primary &&
        next.dialog.primary
    ) {
        return [{ ...commandBase(next, 0), type: "dialog.prepare", ...dialogCommandInput(next.dialog.primary) }]
    }
    return []
}

function installArrivalWakeup(state: TaskState, event: TaskEvent, nextRevision: number): TaskState {
    if (event.type !== "background.ready" && event.type !== "cotask.received") return state
    if (!["idle", "paused", "completed"].includes(state.flow.phase) || state.dialog.primary) return state
    const interactionId = `arrival:${event.type}:${event.entryId}:${nextRevision}`
    return {
        ...state,
        dialog: {
            ...state.dialog,
            primary: {
                interactionId,
                turnId: state.turn.turnId ?? `arrival:${event.entryId}`,
                kind: "background_wakeup",
                status: "planned",
                createdRevision: nextRevision,
                presentationRef: event.payloadRef,
                actionRules: [{ actionId: "resume", payloadPolicy: "none" }],
                prepareKey: `dialog.prepare:${interactionId}`,
            },
        },
    }
}

/**
 * Hand the task back to the user once the model keeps answering without a tool.
 *
 * Stopping silently left the task looking finished with nothing to answer, so
 * the limit opens the same recovery the previous runtime offered: the user can
 * add guidance and process anyway, or start over. An entry waiting in intake is
 * the user already speaking, so it is carried into a round instead.
 */
function installMistakeLimit(state: TaskState, event: TaskEvent, nextRevision: number): TaskState {
    const textOnlyLimitReached =
        event.type === "provider.turn_ready" &&
        event.turnPlan.blocks.length === 0 &&
        (state.flow.textOnlyTurnStreak ?? 0) >= mistakeLimit(state)
    const toolLimitReached =
        (event.type === "tool.completed" || event.type === "tool.failed" || event.type === "tool.cancelled") &&
        allBlocksTerminal(state) &&
        (state.flow.consecutiveMistakeCount ?? 0) >= mistakeLimit(state)
    if (!textOnlyLimitReached && !toolLimitReached) return state
    if (!canOpenNextRound(state) || pendingIntakeEntryIds(state.intake).length > 0) return state
    const interactionId = `mistake-limit:${state.taskId}:${nextRevision}`
    return {
        ...state,
        flow: { ...state.flow, phase: "waiting" },
        dialog: {
            ...state.dialog,
            primary: {
                interactionId,
                turnId: event.turnId,
                kind: MISTAKE_LIMIT_DIALOG_KIND,
                status: "planned",
                createdRevision: nextRevision,
                presentationRef: MISTAKE_LIMIT_PRESENTATION,
                actionRules: [
                    { actionId: "process_anyway", payloadPolicy: "draft" },
                    { actionId: "start_new_task", payloadPolicy: "draft" },
                ],
                prepareKey: `dialog.prepare:${interactionId}`,
            },
        },
    }
}

export function transition(state: TaskState, event: TaskEvent): TransitionResult {
    if (event.generation !== state.generation)
        return reject(state, "generation_mismatch", `Event generation ${event.generation} does not match ${state.generation}`)
    if (state.flow.phase === "terminated" && event.type !== "lifecycle.open")
        return reject(state, "phase_invalid", "Terminated tasks reject new events")
    const invalid = validateEvent(state, event)
    if (invalid) return reject(state, invalid.reason, invalid.message)

    const nextRevision = state.revision + 1
    const flow = reduceFlow(state.flow, event)
    const turn = reduceTurn(state.turn, event)
    const dialog = reduceDialog(state.dialog, event, nextRevision)
    const intake = reduceIntake(state.intake, event, {
        admittedEntryIds: state.flow.compose?.admittedEntryIds,
        journalWatermark: state.journalWatermark,
    })
    const halt = reduceHalt(state.halt, event)
    let next: TaskState = {
        ...state,
        revision: nextRevision,
        generation: event.type === "user.cancel" || event.type === "user.terminate" ? state.generation + 1 : state.generation,
        flow: flow.state,
        turn: turn.state,
        dialog: dialog.state,
        intake: intake.state,
        halt: halt.state,
        journalWatermark:
            event.type === "provider.turn_ready"
                ? maxWatermark(state.journalWatermark, event.journalWatermark)
                : event.type === "dialog.prepared" && event.journalWatermark
                  ? maxWatermark(state.journalWatermark, event.journalWatermark)
                  : event.type === "input_queue.delivery_reconciled" && event.journalWatermark
                    ? maxWatermark(state.journalWatermark, event.journalWatermark)
                    : state.journalWatermark,
    }
    next = installArrivalWakeup(next, event, nextRevision)
    next = installMistakeLimit(next, event, nextRevision)
    if (halt.state.status === "stopping" && halt.state.pending.length === 0) {
        next = {
            ...next,
            flow: {
                ...next.flow,
                phase: halt.state.target,
                forcedClosedParticipants:
                    halt.state.forcedClosed && halt.state.forcedClosed.length > 0 ? halt.state.forcedClosed : undefined,
                compose:
                    next.flow.compose?.status === "running" ? { ...next.flow.compose, status: "cancelled" } : next.flow.compose,
                provider:
                    next.flow.provider?.status === "running"
                        ? { ...next.flow.provider, status: "cancelled" }
                        : next.flow.provider,
                compaction: expireAbandonedCompaction(next.flow.compaction, "compaction_cancelled"),
            },
            // Read against the compaction as it was before expiry above.
            dialog: withoutAbandonedReview(next.dialog, next.flow.compaction),
            turn: {
                ...next.turn,
                blocks: next.turn.blocks.map((block) =>
                    block.policy?.status === "running"
                        ? { ...block, policy: { ...block.policy, status: "cancelled" as const } }
                        : block,
                ),
            },
            halt: { status: "idle", generation: halt.state.generation },
        }
        if (halt.state.target === "terminated") next = settleTerminatedTurn(next, nextRevision)
    }
    if (event.type === "lifecycle.consumed") {
        // The successor owns the conversation now, so no question is left for the
        // user here; hydrating the consumed form clears the dialog the same way.
        next = { ...next, dialog: { approvalsByBlock: {} } }
    }
    if (event.type === "approval.responded") {
        next = {
            ...next,
            dialog: {
                ...next.dialog,
                approvalsByBlock: Object.fromEntries(
                    Object.entries(next.dialog.approvalsByBlock).filter(([blockId]) =>
                        next.turn.blocks.some((block) => block.blockId === blockId && block.phase === "awaiting_approval"),
                    ),
                ),
            },
        }
    }
    // A refusal ends the round once nothing is left to run, whichever authority
    // issued it. The policy refuses for the same reason a human does — the call
    // is not permitted — so the flow must be released identically. Releasing only
    // on the human event left a policy-refused turn with every block terminal and
    // the flow still active: no command was ever derived again, and the task
    // simply stopped with no error and no interaction to answer.
    // A human refusal that settles a turn the kernel can continue is not a
    // release: the next round carries the refusal to the model instead.
    if (
        (event.type === "approval.responded" || event.type === "approval.evaluated") &&
        !event.approved &&
        allBlocksTerminal(next) &&
        !refusalContinuesTurn(state, next, event)
    ) {
        next = { ...next, flow: { phase: "waiting" } }
    }
    const commands = [
        ...flow.commands,
        ...turn.commands,
        ...dialog.commands,
        ...intake.commands,
        ...halt.commands,
        ...deriveCommands(state, next, event).map(
            (command): Command =>
                command.type === "compose.round" && next.flow.pendingQueueResponse
                    ? { ...command, respondedQueue: next.flow.pendingQueueResponse }
                    : command,
        ),
    ]
    next = applyCommandOwnership(next, commands)
    return { kind: "accepted", state: next, commands }
}

export function diagnostic(code: string, message: string): Diagnostic {
    return { code, message }
}
