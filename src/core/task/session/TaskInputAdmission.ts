import type { AdmittedInputPart } from "@shared/input-semantics/admitted-parts"
import type { SemanticInputDiagnostic } from "@shared/input-semantics/diagnostics"
import type { SemanticInputDocument } from "@shared/input-semantics/document"
import type { ExplicitInstructionDeclaration } from "../explicit-instructions/types"
import type { LifecycleCommand } from "../stores/payload/TaskPayloadEnvelopes"

/**
 * A lifecycle command the user placed, with the content on either side of it.
 *
 * The turn text is still ordinary content for the turn: everything before the
 * command and every resource attached after it. `premessage` is the guidance
 * addressed to the command itself, so whoever carries the command decides
 * where it goes.
 */
export interface AdmittedLifecycleBarrier {
    readonly commandId: string
    /** Identity of the barrier node in the admitted document. */
    readonly entityId: string
    readonly turnText: string
    /** The same projection as {@link turnText}, with resources kept where the user placed them. */
    readonly turnParts: readonly AdmittedInputPart[]
    readonly premessage: string
    /** Authority from the commands before the barrier; what the turn keeps once the barrier is claimed. */
    readonly instructionsBefore: readonly ExplicitInstructionDeclaration[]
    /** Tools the commands before the barrier authorized; what the turn keeps once the barrier is claimed. */
    readonly toolsBefore: readonly string[]
}

/** What one submission contributes once Core has reviewed it. */
export interface AdmittedTaskInput {
    readonly document: SemanticInputDocument
    /** Ordered projection for the provider; the raw text stays untouched for the UI. */
    readonly admittedText: string
    /** The same projection as {@link admittedText}, with every resource kept as its own part. */
    readonly parts: readonly AdmittedInputPart[]
    readonly authorizedTools: readonly string[]
    /** One-shot authority the named commands grant for the turn they open. */
    readonly explicitInstructions: readonly ExplicitInstructionDeclaration[]
    /** The lifecycle barrier the submission placed, when it placed one. */
    readonly barrier?: AdmittedLifecycleBarrier
}

/**
 * Carries out a lifecycle command outside the turn it was typed in.
 *
 * A barrier such as `/compact` changes the task, not the next answer, so its
 * text must not reach the model as prose. The session declares this port and
 * the owning domain implements it; a barrier no domain owns stays ordinary
 * content, which is the behavior of an assembly that offers no such domain.
 *
 * Owning is a question, not a hand-over: the command only acts once the input
 * carrying it has been accepted, so a refused input changes nothing.
 */
export interface LifecycleBarrierPort {
    /** Whether a domain carries out this command, so its text stays out of the turn. */
    owns(commandId: string): boolean
    /**
     * Carry out a command that arrived in an accepted dialog reply.
     *
     * A reply is not an intake entry, so no round admits it; the owner holds the
     * command for the round the reply opens. Call only after the reply was
     * accepted - the owner binds it to the generation current at that moment.
     */
    request(command: LifecycleCommand): void
    /**
     * Carry out a command the user sent on its own while a dialog stays open.
     *
     * A reply holding nothing but the command answers nothing, so it must not
     * resolve the dialog: the owner acts now, outside any round, and the dialog
     * keeps waiting for its answer. Resolves whether the command was admitted.
     */
    perform(command: LifecycleCommand): Promise<boolean>
}

/**
 * A dialog reply whose lifecycle command was taken out of its text.
 *
 * Split in two like a submission's chat row: the text is settled now, the
 * command only once the runtime accepted the reply, so a stale or refused
 * reply never leaves a command behind for a later round.
 */
export interface ReviewedReply {
    /** What the reply still says to the model. */
    readonly text: string
    /**
     * The reply as typed, with each verified resource where the user placed it.
     *
     * Empty when the reply carries no resource: text alone then represents it.
     * The parts are what a dialog draft persists; a receiver that reads flat
     * attachments resolves them when it consumes the draft, never earlier.
     */
    readonly parts: readonly AdmittedInputPart[]
    /**
     * The structure of {@link text}: the submitted document cut before the
     * command. Stored instead of the whole document, so a later stage that
     * admits the reply again finds no command left to act a second time.
     */
    readonly document: SemanticInputDocument
    /**
     * Entity of the lifecycle command the reply handed to its owner, in the
     * submitted document; absent when nothing was claimed. It is the only part
     * of a reply that acts rather than reaching the dialog as typed.
     */
    readonly claimedBarrier?: string
    /** Carry out the reply's command; call only after the reply was accepted. */
    commit(): void
    /**
     * Carry out the command instead of answering the dialog.
     *
     * Present only when the reply holds nothing besides the command, which
     * then is everything the user asked for.
     */
    readonly performAlone?: () => Promise<boolean>
}

export type TaskInputAdmissionResult =
    | { readonly ok: true; readonly admitted: AdmittedTaskInput }
    | { readonly ok: false; readonly diagnostics: readonly SemanticInputDiagnostic[] }

/**
 * Reviews one submission before it becomes a durable task input.
 *
 * Declared by the task session, implemented by the input-semantics module, so the
 * session never depends on catalog discovery, mention resolution or command
 * expansion details.
 */
export interface TaskInputAdmissionPort {
    admit(
        input: {
            readonly text?: string
            readonly images?: readonly string[]
            readonly files?: readonly string[]
            readonly semanticInput?: SemanticInputDocument
        },
        options?: TaskInputAdmissionOptions,
    ): Promise<TaskInputAdmissionResult>
}

export interface TaskInputAdmissionOptions {
    /**
     * The document was already accepted once, under the catalog revision it
     * names: a reply recovered after the runtime stored it. Its revision is then
     * not compared with the current catalog - a revision is a counter local to
     * one process and a recovered draft may come from another - but its
     * structure, command identities, mentions and resources are still checked.
     */
    readonly pinnedRevision?: boolean
}

/**
 * Raised when admission refuses a submission.
 *
 * Refusing is the point: a stale catalog, a withdrawn command or a broken
 * document must not be silently downgraded to plain text, because the user would
 * see their command disappear without being told.
 */
export class SemanticInputRejectedError extends Error {
    constructor(readonly diagnostics: readonly SemanticInputDiagnostic[]) {
        super(`semantic input rejected: ${diagnostics.map((diagnostic) => diagnostic.code).join(", ")}`)
        this.name = "SemanticInputRejectedError"
    }
}
