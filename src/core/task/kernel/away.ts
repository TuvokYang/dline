import type {
    AwayConfigurationFact,
    AwayMode,
    AwaySlice,
    DialogInteraction,
    InteractionDeadline,
    RoundNotice,
    TaskEvent,
    TaskState,
    UserControl,
} from "./types"

export const ASK_AWAY_TIMEOUT_MS = 10 * 60 * 1000
export const EXTERNAL_COMMAND_TIMEOUT_MS = 60 * 1000
export const DISABLED_AWAY_CONFIGURATION: AwayConfigurationFact = {
    enabled: false,
    automatic: false,
    modeRevocation: 0,
    automaticRevocation: 0,
}

export function isAway(state: TaskState): state is TaskState & { readonly away: AwaySlice & { readonly mode: AwayMode } } {
    const away = state.away
    return (
        away?.mode !== undefined && away.configuration.enabled && away.mode.modeRevocation === away.configuration.modeRevocation
    )
}

function exit(state: TaskState, reason: RoundNotice["reason"]): TaskState {
    if (!state.away?.mode) return state
    const notice: RoundNotice = {
        id: `away-exit:${state.taskId}:${state.revision}`,
        kind: "away_exited",
        revision: state.revision,
        reason,
    }
    return {
        ...state,
        away: { ...state.away, mode: undefined },
        roundMaterial: {
            notices: [...(state.roundMaterial?.notices ?? []), notice],
            feedback: state.roundMaterial?.feedback ?? [],
        },
    }
}

export function enterAway(state: TaskState, source: "command" | "ask_timeout"): TaskState {
    const configuration = state.away?.configuration ?? DISABLED_AWAY_CONFIGURATION
    if (!configuration.enabled || isAway(state)) return state
    return {
        ...state,
        away: { configuration, mode: { source, modeRevocation: configuration.modeRevocation, enteredRevision: state.revision } },
    }
}

/** A retained batch accepts its controls at delivery, never at enqueue or edit. */
function acceptQueueControl(state: TaskState, entryIds: readonly string[]): TaskState {
    const selected = new Set(entryIds)
    const entries = state.intake.queued.filter((entry) => selected.has(entry.entryId) && entry.acceptedRevision === undefined)
    const control =
        entries.find((entry) => entry.userControl?.kind === "enter_away")?.userControl ??
        entries.find((entry) => entry.userControl?.kind === "user_returned")?.userControl
    const next = applyControl(state, control)
    return {
        ...next,
        intake: {
            ...next.intake,
            queued: next.intake.queued.map((entry) =>
                selected.has(entry.entryId) && entry.acceptedRevision === undefined
                    ? { ...entry, acceptedRevision: state.revision }
                    : entry,
            ),
        },
    }
}

function revokeExternalDeadlines(state: TaskState): TaskState {
    const revoke = (interaction: DialogInteraction | undefined) =>
        interaction?.deadline?.kind === "external_command" ? { ...interaction, deadline: undefined } : interaction
    return {
        ...state,
        dialog: {
            ...state.dialog,
            primary: revoke(state.dialog.primary),
            approvalsByBlock: Object.fromEntries(
                Object.entries(state.dialog.approvalsByBlock).map(([id, interaction]) => [id, revoke(interaction)!]),
            ),
        },
    }
}

function applyControl(state: TaskState, control: UserControl | undefined): TaskState {
    if (control?.kind === "enter_away") return enterAway(state, "command")
    return control?.kind === "user_returned" ? revokeExternalDeadlines(exit(state, "user_returned")) : state
}

/** Resume releases the already accepted result; it does not answer the old question again. */
export function resumesAutomaticResponse(state: TaskState, interactionId: string): boolean {
    const primary = state.dialog.primary
    return (
        primary?.interactionId === interactionId &&
        (primary.kind === "resume" || primary.kind === "cancelled_resume") &&
        primary.acceptedResponse?.actionId === "resume" &&
        state.dialog.interrupted?.acceptedResponse?.origin === "timeout"
    )
}

export function validDeadline(interaction: DialogInteraction, configuration: AwayConfigurationFact): boolean {
    const deadline = interaction.deadline
    if (!deadline || !configuration.enabled || deadline.modeRevocation !== configuration.modeRevocation) return false
    return (
        deadline.kind === "external_command" ||
        (configuration.automatic && deadline.automaticRevocation === configuration.automaticRevocation)
    )
}

/** A configuration update invalidates old qualifications; enabling never arms an existing ask. */
export function reduceAway(state: TaskState, event: TaskEvent): TaskState {
    const now = event.now
    if (event.type === "away.configured") {
        const previous = state.away?.configuration ?? DISABLED_AWAY_CONFIGURATION
        const configuration = {
            ...event.configuration,
            modeRevocation: Math.max(previous.modeRevocation, event.configuration.modeRevocation),
            automaticRevocation: Math.max(previous.automaticRevocation, event.configuration.automaticRevocation),
        }
        let next: TaskState = { ...state, away: { configuration, mode: state.away?.mode } }
        if (next.away?.mode && (!configuration.enabled || next.away.mode.modeRevocation !== configuration.modeRevocation)) {
            next = exit(next, "configuration_revoked")
        }
        const revoke = (interaction: DialogInteraction | undefined) =>
            interaction?.deadline && !validDeadline(interaction, configuration)
                ? { ...interaction, deadline: undefined }
                : interaction
        return {
            ...next,
            dialog: {
                primary: revoke(next.dialog.primary),
                interrupted: revoke(next.dialog.interrupted),
                approvalsByBlock: Object.fromEntries(
                    Object.entries(next.dialog.approvalsByBlock).map(([id, interaction]) => [id, revoke(interaction)!]),
                ),
            },
        }
    }
    if (event.type === "away.stopped") return revokeExternalDeadlines(exit(state, "stopped"))
    if (event.type === "dialog.responded" && resumesAutomaticResponse(state, event.interactionId) && event.draftRef) {
        const next = applyControl(state, event.userControl)
        return next
    }
    if (event.type === "input_queue.delivery_accepted")
        return acceptQueueControl(
            state,
            state.intake.queued
                .filter((entry) => entry.queue?.delivery?.deliveryId === event.deliveryId)
                .map((entry) => entry.entryId),
        )
    if (event.type === "dialog.responded" && event.queueDeliveryEntries)
        return acceptQueueControl(
            state,
            event.queueDeliveryEntries.map((entry) => entry.entryId),
        )
    if (event.type === "user.submit" || event.type === "dialog.responded") return applyControl(state, event.userControl)
    if (event.type === "provider.turn_ready" && isAway(state) && typeof now === "number" && Number.isFinite(now)) {
        const configuration = state.away.configuration
        const external = new Set(
            event.turnPlan.blocks
                .filter((block) => block.approval.kind === "manual" && block.approval.externalCommand)
                .map((block) => block.blockId),
        )
        return {
            ...state,
            dialog: {
                ...state.dialog,
                approvalsByBlock: Object.fromEntries(
                    Object.entries(state.dialog.approvalsByBlock).map(([id, interaction]) => [
                        id,
                        external.has(id)
                            ? {
                                  ...interaction,
                                  deadline: {
                                      kind: "external_command" as const,
                                      deadlineAt: now + EXTERNAL_COMMAND_TIMEOUT_MS,
                                      modeRevocation: configuration.modeRevocation,
                                      automaticRevocation: configuration.automaticRevocation,
                                  },
                              }
                            : interaction,
                    ]),
                ),
            },
        }
    }
    if (
        (event.type === "dialog.requested" || event.type === "dialog.interrupt_requested") &&
        event.externalCommand &&
        isAway(state) &&
        typeof now === "number" &&
        Number.isFinite(now)
    ) {
        const configuration = state.away.configuration
        const interaction = state.dialog.primary
        if (!interaction || interaction.interactionId !== event.interactionId) return state
        return {
            ...state,
            dialog: {
                ...state.dialog,
                primary: {
                    ...interaction,
                    deadline: {
                        kind: "external_command",
                        deadlineAt: now + EXTERNAL_COMMAND_TIMEOUT_MS,
                        modeRevocation: configuration.modeRevocation,
                        automaticRevocation: configuration.automaticRevocation,
                    },
                },
            },
        }
    }
    if ((event.type === "dialog.requested" || event.type === "dialog.interrupt_requested") && event.kind === "followup") {
        const configuration = state.away?.configuration
        if (!configuration?.enabled || !configuration.automatic || typeof now !== "number" || !Number.isFinite(now)) return state
        const interaction = state.dialog.primary
        if (!interaction || interaction.interactionId !== event.interactionId) return state
        return {
            ...state,
            dialog: {
                ...state.dialog,
                primary: {
                    ...interaction,
                    deadline: {
                        kind: "ask",
                        deadlineAt: now + ASK_AWAY_TIMEOUT_MS,
                        modeRevocation: configuration.modeRevocation,
                        automaticRevocation: configuration.automaticRevocation,
                    },
                },
            },
        }
    }
    return state
}

export type TimedDialogInteraction = DialogInteraction & {
    readonly deadline: InteractionDeadline
    readonly receiverGeneration: number
}

/** Retain the deadline and receiver qualification across scheduler and kernel calls. */
export function hasInteractionDeadline(interaction: DialogInteraction | undefined): interaction is TimedDialogInteraction {
    return interaction?.deadline !== undefined && interaction.receiverGeneration !== undefined
}

export function dueAwayInteraction(
    state: TaskState,
    event: Extract<TaskEvent, { type: "away.deadline_due" }>,
): TimedDialogInteraction | undefined {
    if (state.halt.status !== "idle" || !["running", "waiting"].includes(state.flow.phase)) return undefined
    const interaction = [state.dialog.primary, ...Object.values(state.dialog.approvalsByBlock)].find(
        (candidate) => candidate?.interactionId === event.interactionId,
    )
    if (
        !hasInteractionDeadline(interaction) ||
        interaction.status !== "awaiting" ||
        interaction.acceptedResponse ||
        interaction.turnId !== event.turnId ||
        interaction.receiverGeneration !== event.receiverGeneration ||
        interaction.deadline.deadlineAt !== event.deadlineAt ||
        !Number.isFinite(event.now) ||
        event.now < event.deadlineAt ||
        !validDeadline(interaction, state.away?.configuration ?? DISABLED_AWAY_CONFIGURATION)
    )
        return undefined
    if (interaction.deadline.kind === "external_command" && !isAway(state)) return undefined
    return interaction
}

/** Commit the typed result before the live receiver or restored continuation is woken. */
export function acceptAwayDeadline(state: TaskState, interaction: TimedDialogInteraction): TaskState {
    const deadlineKind = interaction.deadline.kind
    const accepted: DialogInteraction = {
        ...interaction,
        status: "resolving",
        deadline: undefined,
        acceptedResponse: {
            origin: "timeout",
            deadlineKind,
            actionId: deadlineKind === "ask" ? "reply" : "reject",
            stateRevision: state.revision - 1,
            receiverGeneration: interaction.receiverGeneration,
        },
    }
    const next: TaskState = {
        ...state,
        dialog: {
            ...state.dialog,
            primary: state.dialog.primary?.interactionId === interaction.interactionId ? accepted : state.dialog.primary,
            approvalsByBlock: Object.fromEntries(
                Object.entries(state.dialog.approvalsByBlock).map(([id, current]) => [
                    id,
                    current.interactionId === interaction.interactionId ? accepted : current,
                ]),
            ),
        },
    }
    return deadlineKind === "ask" ? enterAway(next, "ask_timeout") : next
}

export function validAwayConfiguration(value: unknown): value is AwayConfigurationFact {
    if (typeof value !== "object" || value === null) return false
    const configuration = value as AwayConfigurationFact
    return (
        typeof configuration.enabled === "boolean" &&
        typeof configuration.automatic === "boolean" &&
        Number.isSafeInteger(configuration.modeRevocation) &&
        configuration.modeRevocation >= 0 &&
        Number.isSafeInteger(configuration.automaticRevocation) &&
        configuration.automaticRevocation >= 0
    )
}

/** Validate only at snapshot ingress; ordinary transitions carry typed domain values. */
export function validAwaySnapshot(value: unknown): boolean {
    if (value === undefined) return true
    if (typeof value !== "object" || value === null) return false
    const away = value as NonNullable<TaskState["away"]>
    if (!validAwayConfiguration(away.configuration)) return false
    const mode = away.mode
    return (
        mode === undefined ||
        (mode !== null &&
            (mode.source === "command" || mode.source === "ask_timeout") &&
            Number.isSafeInteger(mode.modeRevocation) &&
            mode.modeRevocation >= 0 &&
            Number.isSafeInteger(mode.enteredRevision) &&
            mode.enteredRevision >= 0)
    )
}
