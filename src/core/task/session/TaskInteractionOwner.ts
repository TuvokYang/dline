import { findLast } from "@shared/array"
import type { UiAsk, UiMessage } from "@shared/ExtensionMessage"
import { Logger } from "@shared/services/Logger"
import { commandLineOfApprovalBody, createCanonicalAskRow } from "../ask-row"
import type { RetainedInputPresentationPort } from "../executors/compose/RetainedInputPresentationPort"
import { type DraftAttachmentPort, resolveDraftForReceiver } from "../interaction/DraftAttachments"
import type { InteractionKind } from "../interaction/Interaction"
import { InteractionCancellationError } from "../interaction/InteractionCancellationError"
import type { CompleteInteractionRequest, InteractionOutcome, OpenInteractionRequest } from "../interaction/InteractionProtocol"
import { getInteraction } from "../interaction/InteractionRegistry"
import type { DialogActionRule, TaskEvent } from "../kernel"
import type { MessageStateHandler } from "../message-state"
import type { RuntimeDiagnosticSink } from "../runtime"
import type { TaskPayloadStore } from "../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { DialogDraftEnvelope, DialogPresentationEnvelope } from "../stores/payload/TaskPayloadEnvelopes"
import type { TaskInteractionPorts } from "../tools/types/TaskConfig"
import type { ActiveTaskSession } from "./ActiveTaskSession"
import type {
    CanonicalQueueTurnEndDelivery,
    CanonicalQueueTurnEndPort,
    CanonicalQueueTurnEndResult,
} from "./InputQueueApplicationPort"
import { RetainedInputPresenter } from "./RetainedInputPresenter"
import type { UnownedDialogContinuationPort, UnownedDialogOutcome, UnownedDialogResolution } from "./UnownedDialogContinuation"

interface PendingInteraction {
    resolve(outcome: InteractionOutcome): void
    reject(error: Error): void
}

interface InteractionRequest {
    readonly turnId: string
    readonly interactionId: string
    readonly kind: OpenInteractionRequest["kind"]
    readonly presentation: string
    readonly existingTs?: number
    readonly completionId?: string
}

function actionRules(kind: OpenInteractionRequest["kind"]): readonly DialogActionRule[] {
    const definition = getInteraction(kind)
    const rules = definition.actions.map((item) => ({ actionId: item.type, payloadPolicy: item.payloadPolicy }))
    const enterAction = definition.input.enterAction
    if (!enterAction || rules.some((rule) => rule.actionId === enterAction)) return rules
    return [...rules, { actionId: enterAction, payloadPolicy: "draft" }]
}

/** How every Profile-validity failure is described (see ApiProfileRecovery); only these are resolved by a Profile switch. */
const INVALID_PROFILE_FAILURE_PREFIX = "Profile not valid:"

const QUEUE_TURN_END_INTERACTIONS: ReadonlySet<InteractionKind> = new Set([
    "followup",
    "make_plan",
    "qna_response",
    "generate_report",
    "status_acknowledgment",
    "completion",
])

/** Owns causal interaction receivers while the kernel remains the lifecycle authority. */
export class TaskInteractionOwner implements TaskInteractionPorts, CanonicalQueueTurnEndPort {
    private session?: ActiveTaskSession
    private retainedPresentation?: RetainedInputPresentationPort
    private readonly pending = new Map<string, PendingInteraction>()
    /** Serializes duplicate reveal callbacks, never owns response membership. */
    private readonly restoring = new Map<string, Promise<void>>()
    /** Set while a halt holds the dialog domain; see suspend. */
    private suspendedReason: string | undefined

    constructor(
        private readonly messages: MessageStateHandler,
        private readonly payloads: TaskPayloadStore,
        /** Carries on when an answered dialog has no receiver; see UnownedDialogContinuation. */
        private readonly unownedContinuation?: UnownedDialogContinuationPort,
        /** Reports answers that reached nothing, which are otherwise invisible. */
        private readonly diagnostics?: RuntimeDiagnosticSink,
        /** Pushes a committed row to the chat as it is written, as host asks are. */
        private readonly publishRow?: (row: UiMessage) => unknown,
    ) {}

    bind(session: ActiveTaskSession): void {
        if (this.session) throw new Error("Task interaction owner is already bound")
        this.session = session
        this.retainedPresentation = new RetainedInputPresenter(this.payloads, this.messages, () => this.nextRowTs())
    }

    /** Resolves a delivered draft's parts for receivers that read flat attachments. */
    private get draftAttachments(): DraftAttachmentPort | undefined {
        return this.session?.draftAttachments
    }

    /**
     * Id for a row this owner adds. Drawn from the session's sequence so it can
     * neither collide with nor sort before a row another producer wrote in the
     * same millisecond; a row that reused an id would replace the one holding it.
     */
    private nextRowTs(): number {
        const sequence = this.session?.owners?.nextPresentationId
        return sequence ? sequence() : Math.max(Date.now(), (this.messages.clineMessages.at(-1)?.ts ?? 0) + 1)
    }

    open(request: OpenInteractionRequest): Promise<InteractionOutcome> {
        return this.request(request)
    }

    complete(request: CompleteInteractionRequest): Promise<InteractionOutcome> {
        return this.request({ ...request, kind: "completion" })
    }

    async stageCompletion(request: CompleteInteractionRequest): Promise<void> {
        const session = this.session
        if (!session || this.suspendedReason) return
        const state = session.state()
        // Handlers name their turn after the tool call (`interactionTurnId`), while the
        // kernel names it after the compose command that produced it. The block id is
        // the identity both share, so the block is found by it and the event carries
        // the kernel's own turn.
        const turnId = state.turn.turnId
        const block = turnId ? state.turn.blocks.find((candidate) => candidate.blockId === request.interactionId) : undefined
        if (!turnId || !block) {
            Logger.debug(`[TaskInteractionOwner] Completion ${request.interactionId} has no block in the active turn`)
            return
        }
        try {
            const presentationRef = await this.payloads.put(
                encodeTaskPayload<DialogPresentationEnvelope>({
                    kind: "dialog_presentation",
                    presentationKind: "completion",
                    body: request.presentation,
                    existingTs: request.existingTs,
                    completionId: request.completionId,
                }),
            )
            const result = await session.assembly.runtime.submit({
                type: "tool.completion_presented",
                generation: session.state().generation,
                turnId,
                blockId: block.blockId,
                attempt: block.attempt,
                presentationRef,
                actionRules: actionRules("completion"),
            })
            if (result.kind === "rejected")
                Logger.debug(`[TaskInteractionOwner] Completion ${block.blockId} was not staged: ${result.reason}`)
        } catch (error) {
            Logger.warn(
                `[TaskInteractionOwner] Failed to stage completion ${block.blockId}: ${error instanceof Error ? error.message : error}`,
            )
        }
    }

    /**
     * Give a completion that a terminate installed the anchor row its request would have written.
     *
     * The terminate stopped the completion before it asked for its dialog, so
     * the result is still a plain row and nothing would let the user answer it.
     * Called after the halt settles and before the stores close.
     */
    async anchorStagedCompletion(): Promise<void> {
        const primary = this.session?.state().dialog.primary
        if (primary?.kind !== "completion" || primary.status !== "planned") return
        if (this.messages.clineMessages.some((message) => message.interactionId === primary.interactionId)) return
        try {
            const envelope = decodeTaskPayload<DialogPresentationEnvelope>(await this.payloads.read(primary.presentationRef))
            const anchorTs = envelope.existingTs ?? this.nextRowTs()
            await this.presentAnchor(
                createCanonicalAskRow(getInteraction("completion").taskAsk, envelope.body, anchorTs, primary.interactionId),
            )
        } catch (error) {
            Logger.warn(
                `[TaskInteractionOwner] Failed to anchor staged completion ${primary.interactionId}: ${error instanceof Error ? error.message : error}`,
            )
        }
    }

    async say(request: Parameters<TaskInteractionPorts["say"]>[0]): Promise<void> {
        await this.messages.addToClineMessages({
            ts: request.existingTs ?? this.nextRowTs(),
            type: "say",
            say: request.taskSay,
            text: request.presentation,
            images: request.images,
            files: request.files,
        })
    }

    /**
     * Write the chat row a revealed dialog anchors to, unless exactly one
     * complete ask row already anchors it.
     *
     * A tool that opens its own dialog writes the row in `request`. An approval
     * comes from the turn plan and has no such moment, so the dialog executor
     * calls this at reveal. A row left partial or duplicated by a process that
     * stopped mid-reveal cannot anchor the dialog, so a re-reveal after restore
     * replaces those rows with one complete anchor, which is what the surface
     * requires before it will dispatch a response.
     *
     * `ask` overrides the kind's default when the body was built for another
     * row type: a command approval carries a plain command line, which a `tool`
     * row would try to parse as JSON.
     */
    async anchor(request: {
        readonly interactionId: string
        readonly kind: string
        readonly body: string
        readonly ask?: string
    }): Promise<void> {
        const currentMessages = this.messages.clineMessages
        const asks = currentMessages.filter(
            (message) => message.type === "ask" && message.interactionId === request.interactionId,
        )
        if (asks.length === 1 && !asks[0].partial) return
        await this.messages.removeMessagesByTs(asks.map((message) => message.ts))
        const definition = getInteraction(request.kind as OpenInteractionRequest["kind"])
        const ask = (request.ask ?? definition.taskAsk) as UiAsk
        // Provider streaming presents a command before its approval interaction is
        // planned. Reuse that partial row so approval and denial update one command
        // in place; appending a second ask leaves the first statusless row rendered
        // as legacy Completed. The streamed row holds the command line alone, while
        // the approval body adds the working directory.
        const commandLine = ask === "command" ? commandLineOfApprovalBody(request.body) : undefined
        const streamedCommand =
            commandLine === undefined
                ? undefined
                : [...currentMessages]
                      .reverse()
                      .find(
                          (message) =>
                              message.type === "say" &&
                              message.say === "command" &&
                              message.partial === true &&
                              message.text === commandLine,
                      )
        // Other approval rows must sort after everything already written. Wall-clock
        // time is not enough when several rows are revealed in the same millisecond.
        await this.presentAnchor(
            createCanonicalAskRow(ask, request.body, streamedCommand?.ts ?? this.nextRowTs(), request.interactionId),
        )
    }

    /**
     * Write the row a dialog is answered from, commit it, and push it to the chat.
     *
     * A completion becomes its dialog's anchor by replacing its own row in
     * place, a staged rewrite the store would otherwise commit only on its
     * timer, so the row is committed before the dialog opens over it. It is
     * then pushed like any host ask: the reply surface must not depend on a
     * later state publication reaching the webview.
     */
    private async presentAnchor(anchor: UiMessage): Promise<void> {
        if (this.messages.clineMessages.some((message) => message.ts === anchor.ts))
            await this.messages.finalizeClineMessage(anchor)
        else await this.messages.addToClineMessages(anchor)
        await this.messages.flushUiMessages()
        if (!this.publishRow) return
        const committed = this.messages.clineMessages.find((message) => message.ts === anchor.ts) ?? anchor
        try {
            await this.publishRow(committed)
        } catch (error) {
            Logger.warn(
                `[TaskInteractionOwner] Failed to push anchor ${anchor.ts}: ${error instanceof Error ? error.message : error}`,
            )
        }
    }

    /**
     * Hand one answer to whatever is responsible for acting on it.
     *
     * Two things can be responsible, and which one it is decides when the
     * interaction may retire. A receiver parked on `open` or `complete` owns the
     * answer the moment it is delivered. A dialog the kernel synthesized —
     * recovery, arrival wakeup, round-failure retry, or any dialog restored into
     * a process whose original receiver is gone — has no receiver at all, so the
     * task itself has to carry on from it.
     *
     * Retiring is what tells the kernel the answer was consumed, and it clears
     * the dialog. Doing that before knowing whether anything acted on the answer
     * is what left a reopened task paused with no dialog and a dead composer, so
     * an unowned answer retires only once the continuation accepts it.
     */
    resolve(interactionId: string, outcome: InteractionOutcome): void {
        const pending = this.pending.get(interactionId)
        if (pending) {
            this.pending.delete(interactionId)
            // A queued answer must remain recoverable until the tool runner has
            // journaled its result. Terminal tool feedback retires this owner.
            if (this.session?.state().dialog.primary?.acceptedResponse?.queuedInput) {
                pending.resolve(outcome)
                return
            }
            // A normal turn-ending handler may launch the next provider round as
            // soon as its await resolves. Keep it parked until the old dialog is
            // durably retired, otherwise the next dialog races the still-primary one
            // and is rejected with phase_invalid.
            void this.retire(interactionId).then(() => pending.resolve(outcome))
            return
        }
        // Read the kind before retiring: the continuation needs to know what it is
        // resuming from, and retiring clears the dialog from state.
        void this.settleUnowned(interactionId, this.dialogKind(interactionId) ?? "", outcome)
    }

    /**
     * Fail everyone waiting for an answer, and refuse new waiters until resumed.
     *
     * A halt fences the dialog domain, so the response these receivers await can
     * never arrive. They have to be told, because the tool domain drains by
     * waiting for its in-flight effects and a turn-ending tool parked on `open`
     * or `complete` is exactly such an effect. Leaving them waiting made the stop
     * wait for an answer that the same stop had just made impossible, which
     * wedged every later lifecycle operation behind an unfinished teardown.
     *
     * Refusal lasts for the whole halt rather than this instant. A tool that was
     * busy elsewhere when the stop arrived asks for its dialog slightly later,
     * and admitting it then would recreate the same unanswerable wait.
     */
    suspend(reason: string): void {
        this.suspendedReason = reason
        for (const pending of this.pending.values()) pending.reject(new InteractionCancellationError(reason))
        this.pending.clear()
    }

    /** Accept receivers again: a cancelled task may resume and ask anew. */
    resume(): void {
        this.suspendedReason = undefined
    }

    /** Forward one durably revealed turn-ending interaction to retained-input settling. */
    async awaiting(boundary: { readonly turnId: string; readonly interactionId: string; readonly kind: string }): Promise<void> {
        if (!QUEUE_TURN_END_INTERACTIONS.has(boundary.kind as InteractionKind)) return
        const session = this.session
        const interaction = session?.state().dialog.primary
        if (
            !session ||
            this.suspendedReason ||
            session.state().halt.status !== "idle" ||
            interaction?.interactionId !== boundary.interactionId ||
            interaction.turnId !== boundary.turnId
        )
            return
        if (this.pending.has(boundary.interactionId)) {
            session.inputQueue.onTurnEndAwaiting({ ...boundary, kind: boundary.kind as InteractionKind })
            return
        }
        if (!interaction.acceptedResponse?.queuedInput) return
        const existing = this.restoring.get(boundary.interactionId)
        if (existing) return existing
        const recovery = this.restoreQueuedResponse(boundary.interactionId).finally(() =>
            this.restoring.delete(boundary.interactionId),
        )
        this.restoring.set(boundary.interactionId, recovery)
        return recovery
    }

    private async restoreQueuedResponse(interactionId: string): Promise<void> {
        const session = this.requireSession()
        const interaction = session.state().dialog.primary
        const response = interaction?.acceptedResponse
        if (interaction?.interactionId !== interactionId || !response?.queuedInput || !response.draftRef) return
        const generation = session.state().generation
        const current = () =>
            !this.suspendedReason &&
            session.state().halt.status === "idle" &&
            session.state().generation === generation &&
            session.state().dialog.primary?.acceptedResponse === response
        try {
            const draft = decodeTaskPayload<DialogDraftEnvelope>(await this.payloads.read(response.draftRef))
            if (draft.kind !== "dialog_draft") throw new Error(`InvalidQueuedDialogDraft:${interactionId}`)
            const presentation = await this.retainedPresentation?.prepare(response.queuedInput)
            if (!current()) return
            await presentation?.commit()
            if (!current()) return
            await this.settleUnowned(interactionId, interaction.kind, {
                actionId: response.actionId as InteractionOutcome["actionId"],
                feedbackPresented: true,
                draft: {
                    text: draft.text,
                    images: [...draft.images],
                    files: [...draft.files],
                    ...(draft.semanticInput === undefined ? {} : { semanticInput: draft.semanticInput }),
                    ...(draft.admittedParts === undefined ? {} : { admittedParts: draft.admittedParts }),
                },
            })
        } catch (error) {
            // The accepted response remains the owner; never enqueue or respond again.
            Logger.error(`[inputQueue] Could not restore accepted response ${interactionId}`, error)
        }
    }

    /** Submit a retained batch as the response owned by its turn-ending tool. */
    async deliverTurnEnd(delivery: CanonicalQueueTurnEndDelivery): Promise<CanonicalQueueTurnEndResult> {
        const session = this.session
        const interaction = session?.state().dialog.primary
        if (
            !session ||
            !this.pending.has(delivery.interaction.interactionId) ||
            interaction?.interactionId !== delivery.interaction.interactionId ||
            interaction.turnId !== delivery.interaction.turnId ||
            interaction.status !== "awaiting" ||
            interaction.receiverGeneration === undefined ||
            session.state().generation !== delivery.generation ||
            session.state().halt.status === "stopping"
        )
            return "stale"

        const draftRef = await this.payloads.put(
            encodeTaskPayload<DialogDraftEnvelope>({
                kind: "dialog_draft",
                text: delivery.modelDraft.text,
                images: [...delivery.modelDraft.images],
                files: [...delivery.modelDraft.files],
                ...(delivery.modelDraft.semanticInput === undefined ? {} : { semanticInput: delivery.modelDraft.semanticInput }),
                ...(delivery.modelDraft.admittedParts === undefined ? {} : { admittedParts: delivery.modelDraft.admittedParts }),
            }),
        )
        const actionId = getInteraction(delivery.interaction.kind).input.enterAction ?? "reply"
        const presentation = await this.retainedPresentation?.prepare({
            deliveryId: delivery.deliveryId,
            mode: delivery.mode,
            entries: delivery.entries,
        })
        const submitted = await session.task.respond({
            type: "dialog.respond",
            taskId: session.taskId,
            turnId: interaction.turnId,
            interactionId: interaction.interactionId,
            stateRevision: session.state().revision,
            receiverGeneration: interaction.receiverGeneration,
            actionId,
            draftRef,
            queueDeliveryId: delivery.deliveryId,
            queueDeliveryEntries: delivery.entries,
            queueDeliveryMode: delivery.mode,
            generation: delivery.generation,
        })
        if (submitted.kind === "rejected") {
            const current = session.state()
            return this.pending.has(interaction.interactionId) &&
                current.generation === delivery.generation &&
                current.halt.status === "idle" &&
                current.dialog.primary?.interactionId === interaction.interactionId &&
                current.dialog.primary.status === "awaiting"
                ? "changed"
                : "stale"
        }
        try {
            await submitted.receipt.durable
        } catch (error) {
            Logger.error(`[inputQueue] Dialog response ${delivery.deliveryId} was not durable`, error)
            return "uncertain"
        }
        try {
            await presentation?.commit()
        } catch (error) {
            // The model-facing response is already durable. Presentation failure must
            // not release it back to the queue and send it a second time.
            Logger.error(`[inputQueue] Could not present delivered input ${delivery.deliveryId}`, error)
        }
        if (!this.pending.has(interaction.interactionId) || session.state().generation !== delivery.generation) return "accepted"
        this.resolve(interaction.interactionId, {
            actionId,
            feedbackPresented: true,
            draft: {
                text: delivery.modelDraft.text,
                images: [...delivery.modelDraft.images],
                files: [...delivery.modelDraft.files],
                ...(delivery.modelDraft.semanticInput === undefined ? {} : { semanticInput: delivery.modelDraft.semanticInput }),
                ...(delivery.modelDraft.admittedParts === undefined ? {} : { admittedParts: delivery.modelDraft.admittedParts }),
            },
        })
        return "accepted"
    }

    /**
     * Clear the provider-failure dialog made obsolete by a successful Profile rebuild.
     *
     * Only a failure that reported the Profile itself as invalid is resolved by
     * switching Profiles. Any other failure, such as a rate limit, keeps its
     * dialog so the user can still retry it through the newly bound Profile.
     */
    async dismissProviderFailure(): Promise<void> {
        const session = this.session
        const interaction = session?.state().dialog.primary
        if (!session || interaction?.kind !== "error_retry") return
        if (!this.reportsInvalidProfile(interaction)) return
        try {
            const result = await session.assembly.runtime.submit({
                type: "dialog.dismissed",
                generation: session.state().generation,
                interactionId: interaction.interactionId,
            })
            if (result.kind === "rejected") {
                Logger.warn(`Failed to dismiss provider failure ${interaction.interactionId}: ${result.reason}`)
                return
            }
            const retryCard = [...this.messages.clineMessages].reverse().find((message) => message.say === "error_retry")
            const timestamps = this.messages.clineMessages
                .filter((message) => message.interactionId === interaction.interactionId || message.ts === retryCard?.ts)
                .map((message) => message.ts)
            await this.messages.removeMessagesByTs(timestamps)
        } catch (error) {
            Logger.warn(
                `Failed to dismiss provider failure ${interaction.interactionId}: ${error instanceof Error ? error.message : error}`,
            )
        }
    }

    /** The failure text the dialog shows: its anchored ask row, else the description it was raised with. */
    private reportsInvalidProfile(interaction: { readonly interactionId: string; readonly presentationRef?: string }): boolean {
        const anchor = findLast(
            this.messages.clineMessages,
            (message) =>
                message.type === "ask" && message.ask === "api_req_failed" && message.interactionId === interaction.interactionId,
        )
        return (anchor?.text ?? interaction.presentationRef ?? "").includes(INVALID_PROFILE_FAILURE_PREFIX)
    }

    dispose(reason = "task_disposed"): void {
        this.suspend(reason)
    }

    /**
     * The kernel's kind for a dialog that is still in state.
     *
     * A synthesized dialog lives in `primary` or, when an interrupted task parks
     * its recovery question, in `interrupted`.
     */
    private dialogKind(interactionId: string): string | undefined {
        const dialog = this.session?.state().dialog
        return [dialog?.primary, dialog?.interrupted].find((candidate) => candidate?.interactionId === interactionId)?.kind
    }

    /**
     * Put the task back to work after an answer nobody was waiting for, and
     * retire the interaction only if that succeeded.
     *
     * A declined or failed continuation leaves the dialog in place deliberately.
     * The user's answer did not reach anything, so the question is still open;
     * retiring it anyway would record a consumed answer the task never acted on
     * and remove the only control the user has left.
     */
    private async settleUnowned(interactionId: string, kind: string, answered: InteractionOutcome): Promise<void> {
        const session = this.session
        const generation = session?.state().generation
        const isCurrent = () =>
            session !== undefined &&
            !this.suspendedReason &&
            session.state().generation === generation &&
            session.state().halt.status === "idle"
        const queuedInput = session?.state().dialog.primary?.acceptedResponse?.queuedInput
        const currentBeforeResolve = isCurrent()
        const outcome = await this.forReceiver(answered)
        // Resolving the reply's resources reads files; a task that moved on
        // meanwhile must not be continued with an answer meant for its past.
        if (currentBeforeResolve && !isCurrent()) return
        const resolution: UnownedDialogResolution = {
            interactionId,
            kind,
            outcome,
            ...(queuedInput ? { queuedInput, isCurrent } : {}),
        }
        const accepted = this.unownedContinuation?.accepts(resolution) ?? false
        let continuation: UnownedDialogOutcome = "declined"
        let retired = false
        if (accepted) {
            // A restored tool stages its paired result before retirement so a crash
            // between these awaits never loses both the answer and its owner.
            const prepared = (await this.unownedContinuation?.prepare?.(resolution)) ?? true
            if (!isCurrent()) return
            if (prepared) {
                retired = await this.retire(interactionId, generation)
                if (!isCurrent()) return
                continuation = retired ? await this.carryOn(resolution) : "failed"
            } else continuation = "failed"
        }
        // Recorded for every unowned answer, not only the ones that went nowhere.
        // Whether a restored dialog resumed the task or was left answerable is
        // the difference between a task that continues and one that appears to
        // ignore the user, and nothing else in the log distinguishes them.
        this.diagnostics?.record({
            source: "dialog",
            code: "unowned_dialog_settled",
            message: `Interaction ${interactionId} (${kind}) answered with ${outcome.actionId} was ${continuation}`,
            severity: continuation === "failed" ? "failure" : "observation",
        })
        // The answer reached nothing, so the question it answered is still open.
        // Reopening keeps it answerable instead of leaving the task paused with
        // no dialog, which is what disabled the composer for good.
        if (continuation === "failed" && retired) await this.reopen(interactionId)
    }

    /** Put a retired interaction back in play after its continuation failed. */
    private async reopen(interactionId: string): Promise<void> {
        const session = this.session
        if (!session) return
        try {
            await session.assembly.runtime.submit({
                type: "dialog.reopened",
                generation: session.state().generation,
                interactionId,
            })
        } catch (error) {
            Logger.warn(`Failed to reopen interaction ${interactionId}: ${error instanceof Error ? error.message : error}`)
        }
    }

    /** Ask the host how an unowned answer carries the task on. */
    private async carryOn(resolution: UnownedDialogResolution): Promise<UnownedDialogOutcome> {
        if (!this.unownedContinuation) return "declined"
        try {
            return await this.unownedContinuation.continue(resolution)
        } catch (error) {
            // The user already answered, so the failure belongs in diagnostics: it
            // says the task accepted a resume it could not act on.
            Logger.error(
                `Failed to continue unowned interaction ${resolution.interactionId}: ${
                    error instanceof Error ? error.message : error
                }`,
            )
            return "failed"
        }
    }

    /** Tell the kernel this receiver has consumed the response. */
    private async retire(interactionId: string, generation = this.session?.state().generation): Promise<boolean> {
        const session = this.session
        if (!session || generation === undefined) return false
        try {
            const result = await session.assembly.runtime.submit({
                type: "dialog.resolved",
                generation,
                interactionId,
            })
            if (result.kind === "rejected") return false
            await result.receipt?.durable
            return true
        } catch (error) {
            // A retired interaction only affects later dialogs, so a failure here
            // must be visible without failing the answer the user already gave.
            Logger.warn(`Failed to retire interaction ${interactionId}: ${error instanceof Error ? error.message : error}`)
            return false
        }
    }

    private async request(request: InteractionRequest): Promise<InteractionOutcome> {
        // Refused rather than parked: the domain that would answer is stopped, so
        // admitting this caller would block the very stop it is waiting behind.
        if (this.suspendedReason) throw new InteractionCancellationError(this.suspendedReason)
        if (this.pending.has(request.interactionId)) throw new Error(`Interaction ${request.interactionId} is already pending`)
        const presentationRef = await this.payloads.put(
            encodeTaskPayload<DialogPresentationEnvelope>({
                kind: "dialog_presentation",
                presentationKind: request.kind,
                body: request.presentation,
                existingTs: request.existingTs,
                completionId: request.completionId,
            }),
        )
        const definition = getInteraction(request.kind)
        const anchorTs = request.existingTs ?? this.nextRowTs()
        await this.presentAnchor(createCanonicalAskRow(definition.taskAsk, request.presentation, anchorTs, request.interactionId))
        const session = this.requireSession()
        const state = session.state()
        const event: TaskEvent = {
            type: "dialog.requested",
            generation: state.generation,
            interactionId: request.interactionId,
            turnId: request.turnId,
            kind: request.kind,
            presentationRef,
            actionRules: actionRules(request.kind),
        }
        const outcome = new Promise<InteractionOutcome>((resolve, reject) => {
            this.pending.set(request.interactionId, { resolve, reject })
        })
        const result = await session.assembly.runtime.submit(event)
        if (result.kind === "rejected") {
            this.pending.delete(request.interactionId)
            const active = session.state().dialog.primary
            const rejectionMessage = "message" in result ? result.message : result.diagnostic.message
            Logger.error(
                `[TaskInteractionOwner] Rejected ${request.kind} interaction ${request.interactionId}: ${result.reason} (${rejectionMessage}); active=${active?.interactionId ?? "none"}/${active?.kind ?? "none"}/${active?.status ?? "none"}; requestedTurn=${request.turnId}; activeTurn=${active?.turnId ?? "none"}; revision=${session.state().revision}`,
            )
            throw new Error(`${result.reason}: ${rejectionMessage}`)
        }
        return outcome.then((answered) => this.forReceiver(answered))
    }

    /**
     * The outcome as every receiver reads it: a draft's admitted resource parts
     * resolved into the flat attachments handlers consume.
     *
     * This is the one place a receiver's draft is resolved, so neither a live
     * handler nor a restored continuation can be handed parts it ignores, and a
     * persisted draft never holds the resolved bytes or paths.
     */
    private async forReceiver(outcome: InteractionOutcome): Promise<InteractionOutcome> {
        if (!outcome.draft) return outcome
        return { ...outcome, draft: await resolveDraftForReceiver(outcome.draft, this.draftAttachments) }
    }

    private requireSession(): ActiveTaskSession {
        if (!this.session) throw new Error("Task interaction owner is not bound")
        return this.session
    }
}
