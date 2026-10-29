import type { UiAskQuestion, UiMessage } from "@shared/ExtensionMessage"
import {
    ADMITTED_SUBMISSION,
    REPLY_AS_TYPED,
    rowHasVisibleContent,
    submittedInputRow,
    submittedRowFields,
} from "@shared/input-semantics/submitted-input"
import { Logger } from "@shared/services/Logger"
import { serializeDurableToolResult, toolResultReplayOf } from "../DurableToolResult"
import { interactionKindForToolName, projectInteractionContinuation } from "../interaction/InteractionContinuation"
import type { InteractionOutcome } from "../interaction/InteractionProtocol"
import type { KernelBlock, TaskState } from "../kernel"
import type { MessageStateHandler } from "../message-state"
import { newTaskCallOf, successorDirective } from "../new-task/new-task-answer"
import type { PostCommitPublisher } from "../new-task/successor-handoff"
import type { ConversationJournal, TaskPayloadStore } from "../stores"
import { putAttachedDocuments } from "../stores/payload/AttachedDocuments"
import { decodeTaskPayload, encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { ToolInvocationEnvelope, ToolResultEnvelope } from "../stores/payload/TaskPayloadEnvelopes"
import type { ToolPostCommitDirective } from "../tools/ToolExecutionResult"
import type { AdmittedReply } from "./TaskInputAdmission"
import {
    dialogAnswerOf,
    type ResumptionInput,
    type TaskResumptionPort,
    type UnownedDialogContinuationPort,
    type UnownedDialogOutcome,
    type UnownedDialogResolution,
} from "./UnownedDialogContinuation"

/**
 * What answering a restored dialog commits its source to.
 *
 * - `resume`: the answer is recorded as the tool's result and the source resumes.
 * - `post_commit`: the directive replaces the resume, and the answer is
 *   recorded only once the directive is accepted.
 * - `unanswerable`: the record cannot carry out what the answer asks, so the
 *   dialog stays answerable instead of recording a result that claims it did.
 */
type RestoredAnswerEffect =
    | { readonly kind: "resume" }
    | { readonly kind: "post_commit"; readonly directive: ToolPostCommitDirective }
    | { readonly kind: "unanswerable" }

/** How the restored dialog of one tool is answered; every tool-specific rule lives in its entry. */
interface RestoredToolDialogPolicy {
    /**
     * Whether the answer replaces the interruption written for the stopped block.
     *
     * Stopping the task keeps some dialogs open with their options and buttons
     * restored. The failure written for such a stopped block does not settle
     * the call: the user's answer is still the tool's result, as dev restores
     * these dialogs and commits the answer to the call.
     */
    readonly replacesInterruption: (block: KernelBlock) => boolean
    /** What the answer commits the source to; without it every answer resumes the source. */
    readonly effect?: (invocation: ToolInvocationEnvelope, resolution: UnownedDialogResolution) => RestoredAnswerEffect
}

const RESUME: RestoredAnswerEffect = { kind: "resume" }
const always = () => true
const never = () => false

/**
 * Dialogs a tool opens and waits on inside its own execution.
 *
 * When the process that ran the tool is gone, the dialog survives the restore
 * but its tool block does not: hydration cancels it. The user's answer is
 * still the tool's result, so it has to be recorded as that result rather than
 * as new input the model would read as an unrelated message.
 */
const RESTORED_TOOL_DIALOG_POLICIES: ReadonlyMap<string, RestoredToolDialogPolicy> = new Map<string, RestoredToolDialogPolicy>([
    ["followup", { replacesInterruption: always }],
    ["make_plan", { replacesInterruption: never }],
    ["qna_response", { replacesInterruption: never }],
    ["generate_report", { replacesInterruption: never }],
    ["report_bug", { replacesInterruption: always }],
    ["status_acknowledgment", { replacesInterruption: always }],
    // Only a completion the user had already been shown stays open.
    ["completion", { replacesInterruption: (block) => Boolean(block.presentedCompletion) }],
    [
        "new_task",
        {
            // A handoff answered as new input would never start its successor and
            // would lose the marker that lets the model ask again.
            replacesInterruption: always,
            effect: (invocation, resolution) => {
                if (!isApproval(resolution)) return RESUME
                // The live handler refuses a call that lacks its task or context
                // before it opens the dialog, so a restored one cannot hand off either.
                const call = newTaskCallOf(invocation)
                return call ? { kind: "post_commit", directive: successorDirective(call) } : { kind: "unanswerable" }
            },
        },
    ],
])

export interface RestoredToolDialogPorts {
    readonly state: () => Readonly<TaskState>
    readonly payloads: Pick<TaskPayloadStore, "read" | "put">
    readonly journal: Pick<ConversationJournal, "append" | "findByOperation" | "read">
    readonly messages: Pick<
        MessageStateHandler,
        "clineMessages" | "addToClineMessages" | "updateClineMessage" | "flushMessageUpdate"
    >
    readonly nextPresentationId: () => number
    /**
     * Push an edited row to the view. Persisting a row does not publish it, and
     * the ask row is already on screen, so without this the picked option only
     * appears after the next full reload.
     */
    readonly publishRow?: (row: UiMessage) => Promise<void>
    /**
     * Carry out what an answer commits the source to, as the tool adapter does
     * for a live block: an approved `new_task` starts its successor. Without it
     * such an answer cannot take effect, so the dialog stays answerable instead.
     */
    readonly publishPostCommit?: PostCommitPublisher
    /** Replays the report's confirmed external effect before recording its restored tool result. */
    readonly reportBug?: (outcome: InteractionOutcome) => Promise<boolean>
    /**
     * Admit a reply that names a command or mention, as `TaskInputMaterializer.admitReply` does.
     *
     * The reply is user input: recorded as typed, `/reportbug` would reach the
     * model as its literal trigger with no authority to file the report.
     */
    readonly admitReply: (reply: ResumptionInput) => Promise<AdmittedReply | undefined>
}

/** The option a follow-up answer picked, matched the way the live handler matches it. */
export function selectedFollowupOption(options: readonly string[], text: string | undefined): string | undefined {
    if (!text) return undefined
    return (
        options.find((option) => text === option) ??
        options.filter((option) => text.startsWith(`${option}: `)).sort((left, right) => right.length - left.length)[0]
    )
}

/**
 * Answers a restored tool dialog the way its tool would have.
 *
 * A tool-opened dialog is keyed by its block's `dlineTid`, so the block is
 * found from the interaction alone; the dialog itself is already retired when
 * this runs. The answer is journaled as the block's durable result under an
 * operation id derived from the turn and block, which makes a repeated answer
 * a no-op, and the task then resumes with an empty submission so the next
 * round reads that result. An answer whose tool commits the source to a
 * directive, such as an approved `new_task` starting its successor, carries
 * that out instead of resuming. Every other unowned dialog keeps the generic
 * resume path, which submits the answer as ordinary input.
 */
export class RestoredToolDialogContinuation implements UnownedDialogContinuationPort {
    /**
     * One admission per answer. `continue` prepares again, and an answer that
     * commits its source is recorded only after the directive is accepted, so
     * every step that shows or records the reply reads this same admission.
     */
    private readonly admissions = new WeakMap<UnownedDialogResolution, Promise<AdmittedReply | undefined>>()

    constructor(
        private readonly ports: RestoredToolDialogPorts,
        private readonly resumption: TaskResumptionPort,
        private readonly fallback: UnownedDialogContinuationPort,
    ) {}

    accepts(resolution: UnownedDialogResolution): boolean {
        // Stop is accepted here even though it ends a generic dialog: for a
        // restored tool it is still the tool's answer, which the model must see.
        return this.restoredBlock(resolution) !== undefined || (!resolution.queuedInput && this.fallback.accepts(resolution))
    }

    async prepare(resolution: UnownedDialogResolution): Promise<boolean> {
        const block = this.restoredBlock(resolution)
        if (!block) return !resolution.queuedInput
        try {
            const target = await this.target(block, resolution)
            if (!target) return false
            // `continue` submits the answer as ordinary input, which writes its own row.
            if (target.recorded === "failed") return true
            // Admitted before anything acts or is shown, so a reply admission
            // refuses leaves the dialog answerable with nothing done.
            const reply = await this.reply(target, resolution)
            if (
                target.kind === "report_bug" &&
                target.recorded === "none" &&
                !(await this.ports.reportBug?.(resolution.outcome))
            ) {
                return false
            }
            await this.present(resolution, resolution.outcome.draft, reply)
            if (target.recorded === "answered") return true
            // An answer that commits the source is recorded only once its directive is accepted; see `commit`.
            if (target.postCommit) return true
            return await this.record(target, resolution, resolution.isCurrent)
        } catch (error) {
            Logger.error(`Failed to prepare restored tool interaction ${resolution.interactionId}`, error)
            return false
        }
    }

    /**
     * Journal the answer as the block's durable result.
     *
     * The operation id is derived from the turn and block, so the first answer
     * recorded wins and a repeated one is a no-op.
     */
    private async record(
        target: RestoredToolTarget,
        resolution: UnownedDialogResolution,
        isCurrent?: () => boolean,
    ): Promise<boolean> {
        const { invocation, kind, turnId, operationId } = target
        const draft = resolution.outcome.draft
        const reply = await this.reply(target, resolution)
        const result = await projectInteractionContinuation({
            kind,
            functionId: invocation.functionId,
            dlineTid: invocation.dlineTid,
            chatContent: { message: reply?.modelText ?? draft?.text, images: draft?.images, files: draft?.files },
            actionId: resolution.outcome.actionId,
        })
        const documentPayloadRefs = await putAttachedDocuments(this.ports.payloads, result.documents)
        const envelope: ToolResultEnvelope = {
            kind: "tool_result",
            blockId: invocation.dlineTid,
            content: serializeDurableToolResult(result.toolResult, toolResultReplayOf(invocation)),
            ...(documentPayloadRefs ? { documentPayloadRefs } : {}),
            // The result carries the reply's text; the ref only keeps the authority its admission granted.
            ...(reply ? { feedbackInputRefs: [reply.payloadRef] } : {}),
        }
        const payloadRef = await this.ports.payloads.put(encodeTaskPayload(envelope))
        if (isCurrent && !isCurrent()) return false
        await this.ports.journal.append({
            operationId,
            payloadRef,
            source: "tool",
            causation: { ...(turnId === undefined ? {} : { turnId }), interactionId: resolution.interactionId },
        })
        return true
    }

    async continue(resolution: UnownedDialogResolution): Promise<UnownedDialogOutcome> {
        const block = this.restoredBlock(resolution)
        if (!block) return resolution.queuedInput ? "declined" : this.fallback.continue(resolution)
        try {
            if (!(await this.prepare(resolution))) return "failed"
            const target = await this.target(block, resolution)
            if (this.fallback.accepts(resolution) && target?.recorded === "failed") {
                return this.fallback.continue(resolution)
            }
            if (target?.postCommit) return await this.commit(target, target.postCommit, resolution)
            return await this.resume(resolution)
        } catch (error) {
            Logger.error(`Failed to continue restored tool interaction ${resolution.interactionId}`, error)
            return "failed"
        }
    }

    /** Resume the source with an empty submission, so the next round reads the recorded result. */
    private async resume(resolution: UnownedDialogResolution): Promise<UnownedDialogOutcome> {
        const input = await this.resumption.materialize({})
        if (resolution.isCurrent && !resolution.isCurrent()) return "declined"
        await this.resumption.submit(input)
        return "continued"
    }

    /**
     * Carry out the directive an answer commits the source to.
     *
     * The source does not resume: an accepted handoff gives the conversation to
     * the successor. The answer is recorded only after the kernel accepts the
     * directive, so a refused one leaves the dialog answerable with nothing in
     * the journal claiming it took effect, and a later answer still records its
     * own result.
     */
    private async commit(
        target: RestoredToolTarget,
        postCommit: RestoredPostCommit,
        resolution: UnownedDialogResolution,
    ): Promise<UnownedDialogOutcome> {
        if (resolution.isCurrent && !resolution.isCurrent()) return "declined"
        const outcome = await postCommit.publish({
            command: { turnId: target.turnId, dlineTid: target.invocation.dlineTid, restoredDialog: true },
            directive: postCommit.directive,
            beforeStart: () => this.recordCommitted(target, resolution),
        })
        if (outcome === "refused") return "failed"
        if (outcome === "handed_off") return "continued"
        // The publisher does not own this directive, so nothing replaced the resume.
        if (!(await this.record(target, resolution, resolution.isCurrent))) return "declined"
        return await this.resume(resolution)
    }

    /**
     * Record an answer whose directive was accepted.
     *
     * The source is already consumed, so a failed write cannot undo the
     * directive; it only leaves the source's history without the result, and
     * the successor starts regardless.
     */
    private async recordCommitted(target: RestoredToolTarget, resolution: UnownedDialogResolution): Promise<void> {
        try {
            await this.record(target, resolution)
        } catch (error) {
            Logger.error(`Failed to record the committed answer of restored interaction ${resolution.interactionId}`, error)
        }
    }

    /**
     * The reply admitted as user input, or undefined when it stands as typed.
     *
     * Only an answer about to become the block's result is admitted: a queued
     * answer was admitted when it was queued, and a block that already has its
     * result records nothing more.
     */
    private reply(target: RestoredToolTarget, resolution: UnownedDialogResolution): Promise<AdmittedReply | undefined> {
        const draft = resolution.outcome.draft
        if (!draft || resolution.queuedInput || target.recorded !== "none") return Promise.resolve(undefined)
        let admission = this.admissions.get(resolution)
        if (!admission) {
            admission = this.ports.admitReply(dialogAnswerOf(draft))
            this.admissions.set(resolution, admission)
        }
        return admission
    }

    /** The tool behind a restored dialog, or undefined when the dialog does not belong to its block's tool. */
    private async target(block: KernelBlock, resolution: UnownedDialogResolution): Promise<RestoredToolTarget | undefined> {
        const invocation = decodeTaskPayload<ToolInvocationEnvelope>(await this.ports.payloads.read(block.invocationRef))
        const kind = invocation.kind === "tool_invocation" ? interactionKindForToolName(invocation.toolName) : undefined
        const policy = kind ? RESTORED_TOOL_DIALOG_POLICIES.get(kind) : undefined
        if (!kind || !policy || kind !== resolution.kind || invocation.dlineTid !== block.blockId) return undefined
        const effect = policy.effect?.(invocation, resolution) ?? RESUME
        // An answer that cannot take effect must not record a result claiming it did.
        if (effect.kind === "unanswerable") return undefined
        const publish = this.ports.publishPostCommit
        if (effect.kind === "post_commit" && !publish) return undefined
        const turnId = this.ports.state().turn.turnId
        const operationId = `tool.restored_result:${turnId ?? "none"}:${block.blockId}`
        const recorded = await this.recordedResult(operationId, turnId, block, policy)
        return {
            invocation,
            kind,
            turnId,
            operationId,
            recorded,
            ...(effect.kind === "post_commit" && publish ? { postCommit: { directive: effect.directive, publish } } : {}),
        }
    }

    /**
     * The durable result the block already has.
     *
     * The live runner may have journaled a real answer just before the process
     * died. When the process was stopped while the tool waited on the dialog,
     * the runner instead journaled the interruption as the tool's failed
     * result; the call is then settled and a later answer cannot become its
     * result, so it has to reach the model as new input.
     *
     * Dialogs the restored view keeps answerable are the exception: see
     * `RestoredToolDialogPolicy.replacesInterruption`.
     */
    private async recordedResult(
        operationId: string,
        turnId: string | undefined,
        block: KernelBlock,
        policy: RestoredToolDialogPolicy,
    ): Promise<RecordedResult> {
        if (await this.ports.journal.findByOperation(operationId)) return "answered"
        const state = this.ports.state()
        const lowerBound = state.dialog.primary?.journalWatermark ?? state.journalWatermark
        for (const entry of await this.ports.journal.read(lowerBound)) {
            if (entry.kind !== "message" || entry.source !== "tool" || !entry.payloadRef || entry.causation?.turnId !== turnId)
                continue
            const payload = decodeTaskPayload<ToolResultEnvelope>(await this.ports.payloads.read(entry.payloadRef))
            if (payload.kind !== "tool_result" || payload.blockId !== block.blockId) continue
            if (!payload.failed) return "answered"
            if (!policy.replacesInterruption(block)) return "failed"
        }
        return "none"
    }

    /** The cancelled block a restored tool dialog belongs to, if this is one. */
    private restoredBlock(resolution: UnownedDialogResolution): KernelBlock | undefined {
        if (!RESTORED_TOOL_DIALOG_POLICIES.has(resolution.kind)) return undefined
        return this.ports
            .state()
            .turn.blocks.find((block) => block.blockId === resolution.interactionId && block.phase === "cancelled")
    }

    /** Show the answer as the live handler does: the picked option and one feedback row. */
    private async present(
        resolution: UnownedDialogResolution,
        draft: InteractionOutcome["draft"],
        reply: AdmittedReply | undefined,
    ): Promise<void> {
        const messages = this.ports.messages
        if (resolution.kind === "followup") {
            const index = lastIndexOfInteraction(messages.clineMessages, resolution.interactionId)
            const question = index === -1 ? undefined : parseQuestion(messages.clineMessages[index]?.text)
            const selected = question ? selectedFollowupOption(question.options ?? [], draft?.text) : undefined
            if (question && selected) {
                await messages.updateClineMessage(index, { text: JSON.stringify({ ...question, selected }) })
                await messages.flushMessageUpdate(index)
                await this.publish(messages.clineMessages[index])
            }
        }
        if (resolution.outcome.feedbackPresented || !draft) return
        // A reply admitted as input shows what acted in it. Otherwise nothing in
        // it ran: it is shown as typed, and a structured reply names its
        // resources without resolving them.
        const row = reply
            ? submittedInputRow([{ ...draft, semanticInput: reply.document }], ADMITTED_SUBMISSION)
            : submittedInputRow([draft], REPLY_AS_TYPED)
        if (!rowHasVisibleContent(row)) return
        const interactionId = `tool-feedback:${resolution.interactionId}`
        if (messages.clineMessages.some((message) => message.interactionId === interactionId)) return
        await messages.addToClineMessages({
            ts: this.ports.nextPresentationId(),
            type: "say",
            say: "user_feedback",
            interactionId,
            ...submittedRowFields(row),
        })
    }

    /** View delivery is best effort: the row is already durable. */
    private async publish(row: UiMessage | undefined): Promise<void> {
        if (!row || !this.ports.publishRow) return
        await this.ports.publishRow(row).catch((error: unknown) => {
            Logger.warn(
                `Could not publish restored dialog row ${row.ts}: ${error instanceof Error ? error.message : String(error)}`,
            )
        })
    }
}

function isApproval(resolution: UnownedDialogResolution): boolean {
    return resolution.outcome.actionId === "approve"
}

/** Whether a restored tool block already has its durable result, and what kind. */
type RecordedResult = "none" | "answered" | "failed"

/** A directive an answer commits the source to, and the port that carries it out. */
interface RestoredPostCommit {
    readonly directive: ToolPostCommitDirective
    readonly publish: PostCommitPublisher
}

interface RestoredToolTarget {
    readonly invocation: ToolInvocationEnvelope
    readonly kind: NonNullable<ReturnType<typeof interactionKindForToolName>>
    readonly turnId: string | undefined
    readonly operationId: string
    readonly recorded: RecordedResult
    /** Set when the answer commits the source to a directive instead of resuming it. */
    readonly postCommit?: RestoredPostCommit
}

function lastIndexOfInteraction(messages: readonly { readonly interactionId?: string }[], interactionId: string): number {
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index]?.interactionId === interactionId) return index
    }
    return -1
}

function parseQuestion(text: string | undefined): UiAskQuestion | undefined {
    if (!text) return undefined
    try {
        const parsed = JSON.parse(text) as UiAskQuestion
        return parsed && typeof parsed === "object" ? parsed : undefined
    } catch {
        return undefined
    }
}
