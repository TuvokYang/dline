import { authorizedTools, type InputSemanticCatalog } from "@shared/input-semantics/catalog"
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
} from "@shared/input-semantics/document"
import { presentationTextOfNode } from "@shared/input-semantics/presentation"
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

export interface AdmittedSemanticInput {
	readonly documentId: string
	/** Ordered projection sent to the provider; node order is preserved exactly. */
	readonly text: string
	readonly plan: SemanticCommandPlan
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

	async admit(document: SemanticInputDocument): Promise<SemanticInputAdmission> {
		const structural = validateSemanticInputDocument(document)
		if (structural.length > 0) return { ok: false, diagnostics: structural }

		const catalog = this.ports.catalog()
		const catalogDiagnostics = this.reviewAgainstCatalog(document, catalog)
		if (catalogDiagnostics.length > 0) return { ok: false, diagnostics: catalogDiagnostics }

		const plan = planSemanticCommands(document)
		const projection = await this.project(document, plan)
		return {
			ok: true,
			admitted: {
				documentId: document.documentId,
				text: projection.text,
				plan,
				authorizedTools: authorizedTools(
					catalog,
					[...plan.invocations, ...(plan.barrier ? [plan.barrier] : [])].map((invocation) => invocation.commandId),
				),
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

		for (const node of document.nodes) {
			if (!isSlashCommandNode(node) || !isActiveEntity(node)) continue
			if (!catalog.descriptors.some((descriptor) => descriptor.id === node.commandId)) {
				diagnostics.push({
					code: "semantic_input_command_unknown",
					message: `command ${node.commandId} is no longer in the catalog`,
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
	): Promise<{ text: string; explicitInstructions: readonly ExplicitInstructionDeclaration[] }> {
		const planned = new Map(
			[...plan.invocations, ...(plan.barrier ? [plan.barrier] : [])].map((invocation) => [invocation.entityId, invocation]),
		)
		const parts: string[] = []
		const declarations: ExplicitInstructionDeclaration[] = []

		for (const node of document.nodes) {
			if (isSlashCommandNode(node)) {
				const invocation = planned.get(node.entityId)
				// A command the plan did not accept stays exactly as the user typed it.
				if (!invocation) {
					parts.push(node.sourceText)
					continue
				}
				const expansion = await this.ports.commands.expand(invocation)
				parts.push(expansion.text)
				declarations.push(...(expansion.explicitInstructions ?? []))
				continue
			}
			if (isMentionNode(node)) {
				parts.push(isActiveEntity(node) ? await this.ports.mentions.resolve(node) : node.sourceText)
				continue
			}
			parts.push(presentationTextOfNode(node))
		}

		return { text: parts.join(""), explicitInstructions: declarations }
	}
}
