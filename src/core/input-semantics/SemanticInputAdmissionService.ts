import { type AdmittedInputPart, appendAdmittedPart, trimAdmittedParts } from "@shared/input-semantics/admitted-parts"
import {
    authorizedTools,
    type CatalogConflict,
    type InputSemanticCatalog,
    type InputSemanticDescriptor,
} from "@shared/input-semantics/catalog"
import { planSemanticCommands, type SemanticCommandPlan } from "@shared/input-semantics/command-plan"
import { type SemanticInputDiagnostic, semanticInputDiagnostic } from "@shared/input-semantics/diagnostics"
import {
    isActiveEntity,
    isMentionNode,
    isResourceNode,
    isSlashCommandNode,
    type MentionInputNode,
    type ResourceInputNode,
    resourceRefOf,
    type SemanticInputDocument,
    type SlashCommandInputNode,
} from "@shared/input-semantics/document"
import { parseMentionReference, sameMentionReference } from "@shared/input-semantics/mention-reference"
import { documentMatchesPresentation, presentationTextOfNode } from "@shared/input-semantics/presentation"
import { validateSemanticInputDocument } from "@shared/input-semantics/validation"
import type { ExplicitInstructionDeclaration } from "@/core/task/explicit-instructions/types"

export interface SemanticCommandExpansion {
    /** Text that replaces the command in the provider projection. */
    readonly text: string
    /** One-shot tool authority the command grants for this turn. */
    readonly explicitInstructions?: readonly ExplicitInstructionDeclaration[]
}

/**
 * Expands one recognized command into the instructions and authority Core sends for it.
 *
 * The descriptor the node names is the whole input: expansion never reads the
 * trigger text again. `undefined` means the capability behind the command is
 * no longer available, and admission refuses the submission for it.
 */
export interface SemanticCommandExpanderPort {
    expand(descriptor: InputSemanticDescriptor): Promise<SemanticCommandExpansion | undefined>
}

/** Resolves one recognized mention into the text Core sends in its place. */
export interface SemanticMentionResolverPort {
    resolve(node: MentionInputNode): Promise<string>
}

/** Verifies the resource a node references against the owning store. */
export interface SemanticResourceVerifierPort {
    /** Returns the diagnostics that refuse the node, or none when its bytes are owned and unchanged. */
    verify(document: SemanticInputDocument, node: ResourceInputNode): Promise<readonly SemanticInputDiagnostic[]>
}

/**
 * The lifecycle barrier of one submission, with its content split around it.
 *
 * A barrier changes the task rather than the turn, so whoever routes it needs
 * what the turn keeps (still ordinary content) apart from its premessage
 * (guidance addressed to the command itself), not one string where both blur.
 */
export interface AdmittedBarrier {
    readonly commandId: string
    /** Identity of the barrier node, so a carrier can cut the document where the command stood. */
    readonly entityId: string
    /**
     * Projection of what the turn keeps once the command is taken out: every
     * node before the barrier, then each resource placed after it.
     *
     * A resource after the barrier is something the user attached, not words
     * steering the command, so it reaches the model with the turn the command
     * opens rather than with the command's own request.
     */
    readonly turnText: string
    /** The same projection as {@link turnText}, with resources kept in place. */
    readonly turnParts: readonly AdmittedInputPart[]
    /** Projection of the text, command and mention nodes after the barrier: the command's guidance. */
    readonly premessage: string
    /** Authority granted by the commands before the barrier, without the barrier's own. */
    readonly instructionsBefore: readonly ExplicitInstructionDeclaration[]
    /** Tools authorized by the commands before the barrier, without the barrier's own. */
    readonly toolsBefore: readonly string[]
}

export interface AdmittedSemanticInput {
    readonly documentId: string
    /** Ordered projection sent to the provider; node order is preserved exactly. */
    readonly text: string
    /** The same projection as {@link text}, with every resource kept as its own part. */
    readonly parts: readonly AdmittedInputPart[]
    readonly plan: SemanticCommandPlan
    /** The lifecycle barrier the user placed, when there is one. */
    readonly barrier?: AdmittedBarrier
    /** Tools the user authorized by naming a command, derived from catalog identity. */
    readonly authorizedTools: readonly string[]
    /** Declarations the provider request must register before the authorized tool may run. */
    readonly explicitInstructions: readonly ExplicitInstructionDeclaration[]
}

export interface SemanticInputAdmitOptions {
    /** The catalog a legacy text was just lexed against; defaults to the current catalog. */
    readonly composedWith?: InputSemanticCatalog
    /** Skip the revision check for a document recovered after it was accepted; see {@link SemanticInputAdmissionService.admit}. */
    readonly pinnedRevision?: boolean
}

export type SemanticInputAdmission =
    | { readonly ok: true; readonly admitted: AdmittedSemanticInput }
    | { readonly ok: false; readonly diagnostics: readonly SemanticInputDiagnostic[] }

export interface SemanticInputAdmissionPorts {
    readonly catalog: () => InputSemanticCatalog
    readonly commands: SemanticCommandExpanderPort
    readonly mentions: SemanticMentionResolverPort
    /**
     * Verifies referenced resources. Without it no resource is admitted: a
     * document that references one is refused rather than sent unverified.
     */
    readonly resources?: SemanticResourceVerifierPort
    /** Descriptors the catalog refused, so a withdrawn command can say why it is unknown. */
    readonly conflicts?: () => readonly CatalogConflict[]
}

/** The commands a document names, each paired with the catalog descriptor admission resolved for it. */
interface ReviewedEntities {
    readonly descriptors: ReadonlyMap<string, InputSemanticDescriptor>
}

type Review<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly diagnostics: readonly SemanticInputDiagnostic[] }

/**
 * Core admission for one submitted document.
 *
 * Admission reviews what the user already chose: it revalidates the structure,
 * the catalog, the typed identity of every entity and the resources it owns,
 * expands the entities the document names, and projects them in node order. It
 * never scans `rawText` for another command or mention, so a literal
 * "/compact" inside prose or a pasted log can no longer execute anything.
 */
export class SemanticInputAdmissionService {
    constructor(private readonly ports: SemanticInputAdmissionPorts) {}

    /**
     * Review one document, optionally against the catalog it was composed with.
     *
     * A client that composed the document names its own revision, so the current
     * catalog is the right thing to check it against. A submission upgraded from
     * legacy text has just been lexed inside this same call, and passing that
     * snapshot keeps the check honest: discovery may publish a new revision at
     * any moment, and comparing against it would refuse a document for drifting
     * from a catalog it never saw.
     *
     * A document recovered after it was accepted is reviewed with its revision
     * pinned: a newer catalog must not refuse it, so only the revision check is
     * skipped. Every identity check still runs, because recovery is not a way to
     * run a command the visible text never named.
     */
    async admit(document: SemanticInputDocument, options: SemanticInputAdmitOptions = {}): Promise<SemanticInputAdmission> {
        const structural = validateSemanticInputDocument(document)
        if (structural.length > 0) return { ok: false, diagnostics: structural }

        const catalog = options.composedWith ?? this.ports.catalog()
        const reviewed = this.reviewAgainstCatalog(document, catalog, options.pinnedRevision === true)
        if (!reviewed.ok) return reviewed

        const resources = await this.reviewResources(document)
        if (resources.length > 0) return { ok: false, diagnostics: resources }

        const plan = planSemanticCommands(document)
        const rejected = rejectedCommandDiagnostics(document, plan)
        if (rejected.length > 0) return { ok: false, diagnostics: rejected }

        const projected = await this.project(document, plan, reviewed.value)
        if (!projected.ok) return projected
        const projection = projected.value
        // Every composable invocation precedes the barrier: nothing may start after it.
        const composable = plan.invocations.map((invocation) => invocation.commandId)
        return {
            ok: true,
            admitted: {
                documentId: document.documentId,
                text: projection.text,
                parts: projection.parts,
                plan,
                ...(projection.barrier === undefined
                    ? {}
                    : { barrier: { ...projection.barrier, toolsBefore: authorizedTools(catalog, composable) } }),
                authorizedTools: authorizedTools(catalog, [...composable, ...(plan.barrier ? [plan.barrier.commandId] : [])]),
                explicitInstructions: projection.explicitInstructions,
            },
        }
    }

    /** A stale revision, a withdrawn command or a forged identity fails closed; it never degrades to plain text. */
    private reviewAgainstCatalog(
        document: SemanticInputDocument,
        catalog: InputSemanticCatalog,
        pinnedRevision: boolean,
    ): Review<ReviewedEntities> {
        const locator = { documentId: document.documentId }
        if (!pinnedRevision && document.catalogRevision !== String(catalog.revision)) {
            return refuse(
                semanticInputDiagnostic(
                    "semantic_input_catalog_stale",
                    `document was composed against catalog revision ${document.catalogRevision}, current is ${catalog.revision}`,
                    locator,
                ),
            )
        }

        // The nodes are the authority, but only for the text the user actually
        // submitted: a structure that no longer reproduces it could name a
        // command the visible text does not contain.
        if (!documentMatchesPresentation(document)) {
            return refuse(
                semanticInputDiagnostic("semantic_input_node_invalid", "document nodes do not reproduce its raw text", locator),
            )
        }

        const diagnostics: SemanticInputDiagnostic[] = []
        const descriptors = new Map<string, InputSemanticDescriptor>()
        for (const node of document.nodes) {
            if (isMentionNode(node) && isActiveEntity(node)) {
                const mismatch = mentionNodeMismatch(node)
                if (mismatch) diagnostics.push(mismatch(document.documentId))
                continue
            }
            if (!isSlashCommandNode(node) || !isActiveEntity(node)) continue
            const entityLocator = { ...locator, entityId: node.entityId }
            const descriptor = catalog.descriptors.find((candidate) => candidate.id === node.commandId)
            if (!descriptor) {
                diagnostics.push(
                    semanticInputDiagnostic("semantic_input_command_unknown", this.unknownCommandMessage(node), entityLocator),
                )
                continue
            }
            const mismatch = commandNodeMismatch(node, descriptor)
            if (mismatch) {
                diagnostics.push(
                    semanticInputDiagnostic(
                        "semantic_input_node_invalid",
                        `command ${node.commandId} ${mismatch}`,
                        entityLocator,
                    ),
                )
                continue
            }
            descriptors.set(node.entityId, descriptor)
        }
        return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true, value: { descriptors } }
    }

    /** Say why a command is missing, naming the descriptor that took its trigger when there is one. */
    private unknownCommandMessage(node: SlashCommandInputNode): string {
        const conflict = this.ports.conflicts?.().find((candidate) => candidate.descriptorId === node.commandId)
        if (!conflict) return `command ${node.commandId} is no longer in the catalog`
        if (conflict.code === "invalid_trigger") return `command ${node.commandId} was withdrawn because its trigger is invalid`
        return `command ${node.commandId} was withdrawn because ${conflict.code === "duplicate_id" ? "its identity" : `its trigger ${conflict.trigger ?? ""}`} is held by ${conflict.heldBy ?? "another command"}`
    }

    /** Every resource node must point at bytes the task owns and that have not changed since they were staged. */
    private async reviewResources(document: SemanticInputDocument): Promise<readonly SemanticInputDiagnostic[]> {
        const nodes = document.nodes.filter(isResourceNode)
        if (nodes.length === 0) return []
        const verifier = this.ports.resources
        if (!verifier) {
            return nodes.map((node) =>
                semanticInputDiagnostic("semantic_input_resource_invalid", "resources cannot be admitted for this input", {
                    documentId: document.documentId,
                    entityId: node.entityId,
                    resourceId: node.resourceId,
                }),
            )
        }
        const results = await Promise.all(nodes.map((node) => verifier.verify(document, node)))
        return results.flat()
    }

    private async project(
        document: SemanticInputDocument,
        plan: SemanticCommandPlan,
        reviewed: ReviewedEntities,
    ): Promise<Review<Projection>> {
        const planned = new Map(
            [...plan.invocations, ...(plan.barrier ? [plan.barrier] : [])].map((invocation) => [invocation.entityId, invocation]),
        )
        const segments: ProjectedSegment[] = []
        const declarations: ExplicitInstructionDeclaration[] = []
        const unavailable: SemanticInputDiagnostic[] = []
        // Index of the barrier's own segment; every later segment follows the command.
        let barrierSegment: number | undefined
        let declarationsBefore = 0

        for (const node of document.nodes) {
            if (isSlashCommandNode(node)) {
                const invocation = planned.get(node.entityId)
                const descriptor = reviewed.descriptors.get(node.entityId)
                // A node that is not an active command stays exactly as the user typed it.
                if (!invocation || !descriptor) {
                    segments.push(textSegment(node.sourceText))
                    continue
                }
                const expansion = await this.ports.commands.expand(descriptor)
                if (!expansion) {
                    unavailable.push(
                        semanticInputDiagnostic(
                            "semantic_input_command_disabled",
                            `command ${node.commandId} is not available for this task`,
                            { documentId: document.documentId, entityId: node.entityId },
                        ),
                    )
                    continue
                }
                if (invocation === plan.barrier) {
                    barrierSegment = segments.length
                    declarationsBefore = declarations.length
                }
                segments.push(textSegment(expansion.text))
                declarations.push(...(expansion.explicitInstructions ?? []))
                continue
            }
            if (isMentionNode(node)) {
                const text = isActiveEntity(node) ? await this.ports.mentions.resolve(node) : node.sourceText
                segments.push(textSegment(text))
                continue
            }
            if (isResourceNode(node)) {
                segments.push(resourceSegment(document, node))
                continue
            }
            const text = presentationTextOfNode(node)
            segments.push(textSegment(text))
        }
        if (unavailable.length > 0) return { ok: false, diagnostics: unavailable }

        const parts = partsOf(segments)
        const projection = { text: textOf(segments), parts, explicitInstructions: declarations }
        if (!plan.barrier || barrierSegment === undefined) return { ok: true, value: projection }
        const after = segments.slice(barrierSegment + 1)
        const turn = [...segments.slice(0, barrierSegment), ...after.filter(isResourceSegment)]
        const premessage = after.filter((segment) => !isResourceSegment(segment))
        return {
            ok: true,
            value: {
                ...projection,
                barrier: {
                    commandId: plan.barrier.commandId,
                    entityId: plan.barrier.entityId,
                    turnText: textOf(turn).trim(),
                    turnParts: trimAdmittedParts(partsOf(turn)),
                    premessage: textOf(premessage).trim(),
                    instructionsBefore: declarations.slice(0, declarationsBefore),
                },
            },
        }
    }
}

interface Projection {
    readonly text: string
    readonly parts: readonly AdmittedInputPart[]
    readonly explicitInstructions: readonly ExplicitInstructionDeclaration[]
    readonly barrier?: Omit<AdmittedBarrier, "toolsBefore">
}

/** One node's projection, both as an ordered part and as text. */
interface ProjectedSegment {
    readonly part: AdmittedInputPart
    /** The node's projection as text; a resource keeps its presentation placeholder here. */
    readonly text: string
}

function textSegment(text: string): ProjectedSegment {
    return { part: { kind: "text", text }, text }
}

function resourceSegment(document: SemanticInputDocument, node: ResourceInputNode): ProjectedSegment {
    const ref = resourceRefOf(document, node)
    // Structural validation and resource verification both ran first, so an
    // unbound node here is a broken invariant, not input to degrade to text.
    if (!ref) throw new Error(`UnboundResourceNode:${node.entityId}`)
    return {
        part: { kind: "resource", entityId: node.entityId, nodeKind: node.kind, ref, displayName: node.displayName },
        text: presentationTextOfNode(node),
    }
}

function isResourceSegment(segment: ProjectedSegment): boolean {
    return segment.part.kind === "resource"
}

function textOf(segments: readonly ProjectedSegment[]): string {
    return segments.map((segment) => segment.text).join("")
}

function partsOf(segments: readonly ProjectedSegment[]): AdmittedInputPart[] {
    const parts: AdmittedInputPart[] = []
    for (const segment of segments) appendAdmittedPart(parts, segment.part)
    return parts
}

function refuse(diagnostic: SemanticInputDiagnostic): {
    readonly ok: false
    readonly diagnostics: readonly SemanticInputDiagnostic[]
} {
    return { ok: false, diagnostics: [diagnostic] }
}

/**
 * Commands the plan could not place refuse the whole submission.
 *
 * Running the rest would execute a different request from the one the user
 * wrote; the diagnostic points at the node so the draft can be fixed instead.
 */
function rejectedCommandDiagnostics(document: SemanticInputDocument, plan: SemanticCommandPlan): SemanticInputDiagnostic[] {
    return plan.rejected.map((rejection) =>
        semanticInputDiagnostic(
            "semantic_input_lifecycle_barrier_invalid",
            rejection.reason === "duplicate_invocation"
                ? `command ${rejection.commandId} is invoked more than once`
                : `command ${rejection.commandId} exceeds the number of commands one submission may run`,
            { documentId: document.documentId, entityId: rejection.entityId },
        ),
    )
}

/**
 * A diagnostic when an active mention's typed identity disagrees with its visible text.
 *
 * Resolution reads only the typed fields, so a node that spells one path and
 * names another would read a file the user never saw in their message.
 */
function mentionNodeMismatch(node: MentionInputNode): ((documentId: string) => SemanticInputDiagnostic) | undefined {
    const typed = {
        kind: node.mentionKind,
        ref: node.canonicalRef,
        ...(node.workspaceHint === undefined ? {} : { workspaceHint: node.workspaceHint }),
    }
    if (node.sourceText.startsWith("@") && sameMentionReference(parseMentionReference(node.sourceText.slice(1)), typed)) {
        return undefined
    }
    return (documentId) =>
        semanticInputDiagnostic("semantic_input_source_mismatch", "mention identity does not match its visible text", {
            documentId,
            entityId: node.entityId,
        })
}

/**
 * Why an active command node disagrees with the descriptor it names, if it does.
 *
 * The composer derives trigger and composition from the descriptor; a node
 * whose typed text is not one of that descriptor's triggers, or that claims a
 * different lifecycle, would let a structure run a command the user never
 * typed, or run it with the wrong barrier semantics.
 */
function commandNodeMismatch(node: SlashCommandInputNode, descriptor: InputSemanticDescriptor): string | undefined {
    if (descriptor.kind !== "command") return "does not name a command"
    const triggers = [descriptor.trigger, ...(descriptor.aliases ?? [])]
    if (!triggers.includes(node.sourceText)) return `was typed as ${node.sourceText}, which is not one of its triggers`
    const expected = descriptor.lifecycle === "task" ? "lifecycle_barrier" : "composable"
    if (node.compositionMode !== expected) return `declares ${node.compositionMode} composition, expected ${expected}`
    return undefined
}
