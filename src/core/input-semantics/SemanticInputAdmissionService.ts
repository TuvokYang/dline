import { authorizedTools, type InputSemanticCatalog, type InputSemanticDescriptor } from "@shared/input-semantics/catalog"
import {
    planSemanticCommands,
    type SemanticCommandInvocation,
    type SemanticCommandPlan,
} from "@shared/input-semantics/command-plan"
import {
    isActiveEntity,
    isMentionNode,
    isSlashCommandNode,
    type MentionInputNode,
    type SemanticInputDocument,
    type SlashCommandInputNode,
} from "@shared/input-semantics/document"
import { documentMatchesPresentation, presentationTextOfNode } from "@shared/input-semantics/presentation"
import { type SemanticInputDiagnostic, validateSemanticInputDocument } from "@shared/input-semantics/validation"
import type { ExplicitInstructionDeclaration } from "@/core/task/explicit-instructions/types"

export interface SemanticCommandExpansion {
    /** Text that replaces the command in the provider projection. */
    readonly text: string
    /** One-shot tool authority the command grants for this turn. */
    readonly explicitInstructions?: readonly ExplicitInstructionDeclaration[]
}

/** Expands one recognized command into the instructions and authority Core sends for it. */
export interface SemanticCommandExpanderPort {
    expand(invocation: SemanticCommandInvocation): Promise<SemanticCommandExpansion>
}

/** Resolves one recognized mention into the text Core sends in its place. */
export interface SemanticMentionResolverPort {
    resolve(node: MentionInputNode): Promise<string>
}

/**
 * The lifecycle barrier of one submission, with its text split around it.
 *
 * A barrier changes the task rather than the turn, so whoever routes it needs
 * the projection before it (still ordinary content) apart from its premessage
 * (content addressed to the barrier itself), not one string where both blur.
 */
export interface AdmittedBarrier {
    readonly commandId: string
    /** Projection of every node before the barrier, in node order. */
    readonly before: string
    /**
     * What the user typed before the barrier, commands and mentions unexpanded.
     *
     * A carrier that grants no command authority - a dialog reply - keeps this
     * instead of `before`, so it never sends instructions without their tools.
     */
    readonly sourceBefore: string
    /** Projection of the barrier's premessage nodes, in node order. */
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
    readonly plan: SemanticCommandPlan
    /** The lifecycle barrier the user placed, when there is one. */
    readonly barrier?: AdmittedBarrier
    /** Tools the user authorized by naming a command, derived from catalog identity. */
    readonly authorizedTools: readonly string[]
    /** Declarations the provider request must register before the authorized tool may run. */
    readonly explicitInstructions: readonly ExplicitInstructionDeclaration[]
}

export type SemanticInputAdmission =
    | { readonly ok: true; readonly admitted: AdmittedSemanticInput }
    | { readonly ok: false; readonly diagnostics: readonly SemanticInputDiagnostic[] }

export interface SemanticInputAdmissionPorts {
    readonly catalog: () => InputSemanticCatalog
    readonly commands: SemanticCommandExpanderPort
    readonly mentions: SemanticMentionResolverPort
}

/**
 * Core admission for one submitted document.
 *
 * Admission reviews what the user already chose: it revalidates the structure and
 * the catalog, expands the entities the document names, and projects them in node
 * order. It never scans `rawText` for another command or mention, so a literal
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
     */
    async admit(document: SemanticInputDocument, composedWith?: InputSemanticCatalog): Promise<SemanticInputAdmission> {
        const structural = validateSemanticInputDocument(document)
        if (structural.length > 0) return { ok: false, diagnostics: structural }

        const catalog = composedWith ?? this.ports.catalog()
        const catalogDiagnostics = this.reviewAgainstCatalog(document, catalog)
        if (catalogDiagnostics.length > 0) return { ok: false, diagnostics: catalogDiagnostics }

        const plan = planSemanticCommands(document)
        const projection = await this.project(document, plan)
        // Every composable invocation precedes the barrier: nothing may start after it.
        const composable = plan.invocations.map((invocation) => invocation.commandId)
        return {
            ok: true,
            admitted: {
                documentId: document.documentId,
                text: projection.text,
                plan,
                ...(projection.barrier === undefined
                    ? {}
                    : { barrier: { ...projection.barrier, toolsBefore: authorizedTools(catalog, composable) } }),
                authorizedTools: authorizedTools(catalog, [...composable, ...(plan.barrier ? [plan.barrier.commandId] : [])]),
                explicitInstructions: projection.explicitInstructions,
            },
        }
    }

    /** A stale revision or a withdrawn command fails closed; it never degrades to plain text. */
    private reviewAgainstCatalog(
        document: SemanticInputDocument,
        catalog: InputSemanticCatalog,
    ): readonly SemanticInputDiagnostic[] {
        const diagnostics: SemanticInputDiagnostic[] = []
        if (document.catalogRevision !== String(catalog.revision)) {
            diagnostics.push({
                code: "semantic_input_catalog_stale",
                message: `document was composed against catalog revision ${document.catalogRevision}, current is ${catalog.revision}`,
                documentId: document.documentId,
            })
            return diagnostics
        }

        // The nodes are the authority, but only for the text the user actually
        // submitted: a structure that no longer reproduces it could name a
        // command the visible text does not contain.
        if (!documentMatchesPresentation(document)) {
            diagnostics.push({
                code: "semantic_input_node_invalid",
                message: "document nodes do not reproduce its raw text",
                documentId: document.documentId,
            })
            return diagnostics
        }

        for (const node of document.nodes) {
            if (!isSlashCommandNode(node) || !isActiveEntity(node)) continue
            const descriptor = catalog.descriptors.find((candidate) => candidate.id === node.commandId)
            if (!descriptor) {
                diagnostics.push({
                    code: "semantic_input_command_unknown",
                    message: `command ${node.commandId} is no longer in the catalog`,
                    documentId: document.documentId,
                    entityId: node.entityId,
                })
                continue
            }
            const mismatch = commandNodeMismatch(node, descriptor)
            if (mismatch) {
                diagnostics.push({
                    code: "semantic_input_node_invalid",
                    message: `command ${node.commandId} ${mismatch}`,
                    documentId: document.documentId,
                    entityId: node.entityId,
                })
            }
        }
        return diagnostics
    }

    private async project(
        document: SemanticInputDocument,
        plan: SemanticCommandPlan,
    ): Promise<{
        text: string
        explicitInstructions: readonly ExplicitInstructionDeclaration[]
        barrier?: Omit<AdmittedBarrier, "toolsBefore">
    }> {
        const planned = new Map(
            [...plan.invocations, ...(plan.barrier ? [plan.barrier] : [])].map((invocation) => [invocation.entityId, invocation]),
        )
        const parts: string[] = []
        // The typed form of each part, index-aligned with `parts`.
        const sources: string[] = []
        const declarations: ExplicitInstructionDeclaration[] = []
        // Index of the barrier's own part; every later part is its premessage.
        let barrierPart: number | undefined
        let declarationsBefore = 0

        for (const node of document.nodes) {
            if (isSlashCommandNode(node)) {
                const invocation = planned.get(node.entityId)
                // A command the plan did not accept stays exactly as the user typed it.
                if (!invocation) {
                    parts.push(node.sourceText)
                    sources.push(node.sourceText)
                    continue
                }
                const expansion = await this.ports.commands.expand(invocation)
                if (invocation === plan.barrier) {
                    barrierPart = parts.length
                    declarationsBefore = declarations.length
                }
                parts.push(expansion.text)
                sources.push(node.sourceText)
                declarations.push(...(expansion.explicitInstructions ?? []))
                continue
            }
            if (isMentionNode(node)) {
                parts.push(isActiveEntity(node) ? await this.ports.mentions.resolve(node) : node.sourceText)
                sources.push(node.sourceText)
                continue
            }
            const text = presentationTextOfNode(node)
            parts.push(text)
            sources.push(text)
        }

        const text = parts.join("")
        if (!plan.barrier || barrierPart === undefined) return { text, explicitInstructions: declarations }
        return {
            text,
            explicitInstructions: declarations,
            barrier: {
                commandId: plan.barrier.commandId,
                before: parts.slice(0, barrierPart).join("").trim(),
                sourceBefore: sources.slice(0, barrierPart).join("").trim(),
                premessage: parts
                    .slice(barrierPart + 1)
                    .join("")
                    .trim(),
                instructionsBefore: declarations.slice(0, declarationsBefore),
            },
        }
    }
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
