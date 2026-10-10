import type { DialogInteraction, TaskState } from "../../kernel"
import type {
    CanonicalDialogProjection,
    CanonicalTaskActivity,
    CanonicalTaskDiagnostic,
    CanonicalTaskInputProjection,
    CanonicalTaskTerminal,
    CanonicalTaskViewProjection,
} from "./CanonicalTaskViewProjection"

function projectTerminal(state: Readonly<TaskState>): CanonicalTaskTerminal {
    if (state.flow.terminalReason === "consumed") return "consumed"
    // Compatibility for snapshots written before completion presentation moved the
    // canonical flow to `completed`. The durable dialog is already the terminal
    // fact the user acts on, so it must not be rendered as a streaming task.
    if (
        state.flow.phase === "completed" ||
        (state.dialog.primary?.kind === "completion" && state.dialog.primary.status !== "failed")
    )
        return "completed"
    if (state.flow.phase === "error") return "error"
    if (state.flow.phase === "terminated") return "terminated"
    return "active"
}

function hasRunningCommand(state: Readonly<TaskState>): boolean {
    return (
        state.flow.phase === "initializing" ||
        state.flow.phase === "running" ||
        state.flow.compose?.status === "running" ||
        state.flow.provider?.status === "running" ||
        state.flow.compaction?.status === "scheduled" ||
        state.flow.compaction?.status === "running" ||
        state.turn.executingBlockIds.length > 0
    )
}

function hasAwaitingDialog(state: Readonly<TaskState>): boolean {
    return (
        state.dialog.primary?.status === "awaiting" ||
        Object.values(state.dialog.approvalsByBlock).some((interaction) => interaction.status === "awaiting")
    )
}

function projectActivity(state: Readonly<TaskState>, terminal: CanonicalTaskTerminal): CanonicalTaskActivity {
    if (state.halt.status === "stopping") return "halting"
    if (hasAwaitingDialog(state)) return "waiting_for_dialog"
    if (terminal !== "active") return "terminal"
    if (hasRunningCommand(state)) return "working"
    if (state.flow.phase === "waiting" || state.flow.phase === "paused") return "waiting"
    return "idle"
}

function projectDialog(
    state: Readonly<TaskState>,
    interaction: Readonly<DialogInteraction>,
    scope: CanonicalDialogProjection["scope"],
    blockId?: string,
): CanonicalDialogProjection {
    const responsive = scope !== "interrupted" && interaction.status === "awaiting"
    return {
        scope,
        ...(blockId ? { blockId } : {}),
        interactionId: interaction.interactionId,
        turnId: interaction.turnId,
        kind: interaction.kind,
        status: interaction.status,
        createdRevision: interaction.createdRevision,
        stateRevision: state.revision,
        receiverGeneration: interaction.receiverGeneration,
        presentationRef: interaction.presentationRef,
        journalRef: interaction.journalRef,
        journalWatermark: interaction.journalWatermark,
        actions: interaction.actionRules.map((rule) => ({
            actionId: rule.actionId,
            payloadPolicy: rule.payloadPolicy,
            enabled: responsive,
        })),
        failure: interaction.failure,
    }
}

function projectApprovals(state: Readonly<TaskState>): readonly CanonicalDialogProjection[] {
    const blockIndexes = new Map(state.turn.blocks.map((block) => [block.blockId, block.index]))
    return Object.entries(state.dialog.approvalsByBlock)
        .sort(
            ([left], [right]) =>
                (blockIndexes.get(left) ?? Number.MAX_SAFE_INTEGER) - (blockIndexes.get(right) ?? Number.MAX_SAFE_INTEGER),
        )
        .map(([blockId, interaction]) => projectDialog(state, interaction, "approval", blockId))
}

function projectInput(
    state: Readonly<TaskState>,
    terminal: CanonicalTaskTerminal,
    approvals: readonly CanonicalDialogProjection[],
): CanonicalTaskInputProjection {
    if (state.halt.status === "stopping" || terminal === "consumed" || terminal === "terminated") return { mode: "disabled" }
    if (state.dialog.primary?.status === "awaiting") {
        return { mode: "dialog", ownerInteractionId: state.dialog.primary.interactionId }
    }
    const approval = approvals.find((candidate) => candidate.status === "awaiting")
    if (approval) {
        return { mode: "dialog", ownerInteractionId: approval.interactionId, ownerBlockId: approval.blockId }
    }
    if (terminal !== "active") return { mode: "disabled" }
    if (state.flow.phase === "idle") return { mode: "disabled" }
    if (state.flow.phase === "waiting" && state.flow.replyAdmission === "profile_recovery") return { mode: "reply" }
    return { mode: "queued" }
}

function projectDiagnostics(
    state: Readonly<TaskState>,
    primary: CanonicalDialogProjection | undefined,
    approvals: readonly CanonicalDialogProjection[],
): readonly CanonicalTaskDiagnostic[] {
    const diagnostics: CanonicalTaskDiagnostic[] = []
    if (state.flow.error) diagnostics.push({ code: "task_error", message: state.flow.error })
    if (state.flow.forcedClosedParticipants?.length) {
        diagnostics.push({
            code: "forced_closed",
            message: `Task termination abandoned unresponsive halt participants: ${state.flow.forcedClosedParticipants.join(", ")}`,
        })
    }
    for (const dialog of [primary, ...approvals].filter((candidate): candidate is CanonicalDialogProjection =>
        Boolean(candidate),
    )) {
        if (dialog.failure) {
            diagnostics.push({
                code: "dialog_failed",
                message: dialog.failure.message,
                interactionId: dialog.interactionId,
                blockId: dialog.blockId,
            })
        }
        if (dialog.status === "awaiting" && dialog.receiverGeneration === undefined) {
            diagnostics.push({
                code: "dialog_receiver_generation_missing",
                message: `Awaiting dialog ${dialog.interactionId} has no receiver generation`,
                interactionId: dialog.interactionId,
                blockId: dialog.blockId,
            })
        }
        if (dialog.scope === "approval" && !state.turn.blocks.some((block) => block.blockId === dialog.blockId)) {
            diagnostics.push({
                code: "approval_block_missing",
                message: `Approval dialog ${dialog.interactionId} references an unknown block`,
                interactionId: dialog.interactionId,
                blockId: dialog.blockId,
            })
        }
    }
    return diagnostics
}

export function projectCanonicalTaskView(state: Readonly<TaskState>): CanonicalTaskViewProjection {
    const terminal = projectTerminal(state)
    const activity = projectActivity(state, terminal)
    const primary = state.dialog.primary ? projectDialog(state, state.dialog.primary, "primary") : undefined
    const approvals = projectApprovals(state)
    const interrupted = state.dialog.interrupted ? projectDialog(state, state.dialog.interrupted, "interrupted") : undefined
    return {
        taskId: state.taskId,
        revision: state.revision,
        generation: state.generation,
        flowPhase: state.flow.phase,
        terminal,
        activity,
        input: projectInput(state, terminal, approvals),
        taskActions:
            state.halt.status === "stopping"
                ? [{ actionId: "cancel", enabled: false }]
                : terminal === "active" && hasRunningCommand(state)
                  ? [{ actionId: "cancel", enabled: true }]
                  : [],
        primary,
        approvals,
        interrupted,
        halt: state.halt,
        compaction: state.flow.compaction
            ? {
                  compactionId: state.flow.compaction.compactionId,
                  attempt: state.flow.compaction.attempt,
                  status: state.flow.compaction.status,
                  resultRef: state.flow.compaction.resultRef,
                  message: state.flow.compaction.message,
              }
            : undefined,
        journalWatermark: state.journalWatermark,
        diagnostics: projectDiagnostics(state, primary, approvals),
    }
}
