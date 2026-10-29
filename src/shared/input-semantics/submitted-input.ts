import { planSemanticCommands } from "./command-plan"
import {
    isActiveEntity,
    isMentionNode,
    isResourceNode,
    isSlashCommandNode,
    resourceRefOf,
    type SemanticInputDocument,
    type SemanticResourceRef,
} from "./document"

// The facts persist in chat history and travel to the Webview, so this module
// stays pure: no catalog, no store, nothing that could change after submission.

/**
 * What one span of a submitted input is.
 *
 * Roles only grow. A reader that meets a role it does not know drops the row's
 * facts as a whole and shows the row's text, so an older build never draws a
 * newer row half-structured.
 */
export type SubmittedInputSegmentRole = "text" | "command" | "mention" | "resource"

export const SUBMITTED_INPUT_SEGMENT_ROLES: readonly SubmittedInputSegmentRole[] = ["text", "command", "mention", "resource"]

/** One span of a submitted input, as the task read it. */
export interface SubmittedInputSegment {
    readonly text: string
    readonly role: SubmittedInputSegmentRole
    /**
     * Whether the entity acted when the input was submitted: a command that ran,
     * a mention whose target was read, a resource that was attached. A command
     * or mention that stayed prose is inactive and must not look like an entity.
     */
    readonly active: boolean
    /**
     * The resource a `resource` segment names, so its chip can open it while the
     * task is open. Identity and integrity claims only, never a path or payload.
     * Rows written before this field existed lack it; their chips stay static.
     */
    readonly resource?: SemanticResourceRef
}

/**
 * What one submitted input said and did, fixed when it was submitted.
 *
 * History renders from these facts and never from the current catalog, so a
 * command added, renamed or withdrawn later cannot change how an old message
 * reads: a literal `/compact` stays literal and a command that ran stays a
 * command.
 */
export interface SubmittedInputFacts {
    readonly segments: readonly SubmittedInputSegment[]
}

/**
 * How the runtime read an input when it was submitted.
 *
 * A task submission passes admission, which runs every planned command and
 * reads every recognized mention. A dialog reply reaches its receiver as typed,
 * so nothing in it acts except a lifecycle command the reply handed to its
 * owner.
 */
export type SubmittedInputExecution =
    | { readonly admitted: true }
    | {
          readonly admitted: false
          /** Entity of the lifecycle command the reply's owner carried out, if one was claimed. */
          readonly claimedBarrier?: string
      }

export const ADMITTED_SUBMISSION: SubmittedInputExecution = { admitted: true }
export const REPLY_AS_TYPED: SubmittedInputExecution = { admitted: false }

/**
 * Project a submitted document into its facts.
 *
 * Reads only the document and how it was executed. The document's node states
 * were fixed against the catalog it was composed with, so the projection is the
 * same whatever catalog is current when history is shown.
 */
export function projectSubmittedInput(document: SemanticInputDocument, execution: SubmittedInputExecution): SubmittedInputFacts {
    const ran = commandsThatRan(document, execution)
    // A reply reaches its receiver as typed, except what follows a barrier its
    // owner claimed: that text is the barrier's content, read with its mentions.
    let mentionsRead = execution.admitted
    const segments = document.nodes.map((node): SubmittedInputSegment => {
        if (isSlashCommandNode(node)) {
            if (!execution.admitted && node.entityId === execution.claimedBarrier) mentionsRead = true
            return { text: node.sourceText, role: "command", active: ran.has(node.entityId) }
        }
        if (isMentionNode(node)) return { text: node.sourceText, role: "mention", active: mentionsRead && isActiveEntity(node) }
        if (isResourceNode(node)) {
            const resource = resourceRefOf(document, node)
            return { text: `[${node.displayName}]`, role: "resource", active: true, ...(resource ? { resource } : {}) }
        }
        return { text: node.text, role: "text", active: false }
    })
    return { segments }
}

function commandsThatRan(document: SemanticInputDocument, execution: SubmittedInputExecution): ReadonlySet<string> {
    if (!execution.admitted) return new Set(execution.claimedBarrier === undefined ? [] : [execution.claimedBarrier])
    // The plan is derived from the document alone; a command after the barrier
    // was content for it and a rejected one never ran.
    const plan = planSemanticCommands(document)
    return new Set([...plan.invocations, ...(plan.barrier ? [plan.barrier] : [])].map((command) => command.entityId))
}

/** What separates the inputs one row shows, both in its text and when its facts are rendered. */
export const SUBMITTED_INPUT_SEPARATOR = "\n\n"

/** The text a person reads for the facts: every segment in order. */
export function submittedInputText(facts: SubmittedInputFacts): string {
    return facts.segments.map((segment) => segment.text).join("")
}

/** Facts for an input that carries no structure: its text, read as plain prose. */
export function plainSubmittedInput(text: string): SubmittedInputFacts {
    return { segments: text.length > 0 ? [{ text, role: "text", active: false }] : [] }
}

/** One input as it was submitted: its structure when it had one, its legacy attachments otherwise. */
export interface SubmittedInput {
    readonly text?: string
    readonly images?: readonly string[]
    readonly files?: readonly string[]
    readonly semanticInput?: SemanticInputDocument
}

/** What a user's own chat row shows. */
export interface SubmittedInputRow {
    readonly text: string
    /**
     * Legacy attachments only. A structured input names each resource in its
     * text where the user placed it, so the row never holds image data or a
     * local path a resource resolved to.
     */
    readonly images: readonly string[]
    readonly files: readonly string[]
    /** One entry per input; absent when no input had structure, so the row reads as plain text. */
    readonly submittedInputs?: readonly SubmittedInputFacts[]
}

/**
 * The row for one or more inputs a user submitted together.
 *
 * Every producer of a user's row builds it here, so a direct submission, a
 * queued batch, a reply a command consumed and a dialog's echo of a reply all
 * show the same input the same way. The facts are fixed now, from the document
 * and how it was executed, so history never re-reads the text against a later
 * catalog. A legacy input has no document and is shown as typed.
 */
export function submittedInputRow(inputs: readonly SubmittedInput[], execution: SubmittedInputExecution): SubmittedInputRow {
    const facts = inputs.map((input) =>
        input.semanticInput ? projectSubmittedInput(input.semanticInput, execution) : plainSubmittedInput(input.text ?? ""),
    )
    const structured = inputs.some((input) => input.semanticInput !== undefined)
    return {
        text: facts.map(submittedInputText).join(SUBMITTED_INPUT_SEPARATOR),
        images: inputs.flatMap((input) => [...legacyAttachments(input).images]),
        files: inputs.flatMap((input) => [...legacyAttachments(input).files]),
        ...(structured ? { submittedInputs: facts } : {}),
    }
}

/**
 * The attachments a row shows beside one input's text.
 *
 * A document that names resources already shows each one in its text. Separate
 * images or files travelling with it are what those resources resolved to for
 * the receiver (data URLs, local paths), so the row keeps none of them; showing
 * them would draw every resource twice. Admission refuses a reply that carries
 * both, so this drops nothing the user attached beside the document.
 */
function legacyAttachments(input: SubmittedInput): { images: readonly string[]; files: readonly string[] } {
    if (input.semanticInput?.nodes.some(isResourceNode)) return { images: [], files: [] }
    return { images: input.images ?? [], files: input.files ?? [] }
}

/** Whether the row has anything a person would see. */
export function rowHasVisibleContent(row: SubmittedInputRow): boolean {
    return row.text.trim().length > 0 || row.images.length > 0 || row.files.length > 0
}

/** The fields a chat message takes from a user's row; every producer writes the row through this. */
export function submittedRowFields(row: SubmittedInputRow): {
    text: string
    images: string[]
    files: string[]
    submittedInputs?: SubmittedInputFacts[]
} {
    return {
        text: row.text,
        images: [...row.images],
        files: [...row.files],
        ...(row.submittedInputs === undefined ? {} : { submittedInputs: [...row.submittedInputs] }),
    }
}

/**
 * The facts a row may be shown with, or undefined to show its text as typed.
 *
 * Facts cross storage and the wire as untyped data, so they are trusted only
 * whole: every entry well formed, and together spelling exactly the row's text.
 * Anything else, a damaged record or facts left behind by an edit of the text,
 * falls back to the text, so every surface shows the same words.
 */
export function normalizeSubmittedInputs(value: unknown, text: string | undefined): SubmittedInputFacts[] | undefined {
    if (!Array.isArray(value) || value.length === 0) return undefined
    const facts: SubmittedInputFacts[] = []
    for (const entry of value) {
        if (!isSubmittedInputFacts(entry)) return undefined
        facts.push(entry)
    }
    return facts.map(submittedInputText).join(SUBMITTED_INPUT_SEPARATOR) === (text ?? "") ? facts : undefined
}

/** Whether a value read back from storage or the wire is a well-formed set of facts. */
export function isSubmittedInputFacts(value: unknown): value is SubmittedInputFacts {
    if (typeof value !== "object" || value === null) return false
    const segments = (value as { segments?: unknown }).segments
    return Array.isArray(segments) && segments.every(isSubmittedInputSegment)
}

function isSubmittedInputSegment(value: unknown): value is SubmittedInputSegment {
    if (typeof value !== "object" || value === null) return false
    const segment = value as Partial<SubmittedInputSegment>
    return (
        typeof segment.text === "string" &&
        typeof segment.active === "boolean" &&
        SUBMITTED_INPUT_SEGMENT_ROLES.includes(segment.role as SubmittedInputSegmentRole) &&
        (segment.resource === undefined || isSemanticResourceRef(segment.resource))
    )
}

function isSemanticResourceRef(value: unknown): value is SemanticResourceRef {
    if (typeof value !== "object" || value === null) return false
    const ref = value as Partial<SemanticResourceRef>
    const owner = ref.owner as { kind?: unknown; draftId?: unknown; taskId?: unknown } | undefined
    return (
        typeof ref.resourceId === "string" &&
        typeof ref.expectedContentHash === "string" &&
        typeof ref.mediaType === "string" &&
        typeof ref.byteLength === "number" &&
        typeof ref.generation === "number" &&
        ((owner?.kind === "task" && typeof owner.taskId === "string") ||
            (owner?.kind === "draft" && typeof owner.draftId === "string"))
    )
}
