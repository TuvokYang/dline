import type { InputSemanticCatalog } from "@shared/input-semantics/catalog"
import { planSemanticCommands } from "@shared/input-semantics/command-plan"
import { isMentionNode, isSlashCommandNode } from "@shared/input-semantics/document"
import { lexSemanticInput } from "@shared/input-semantics/lexer"

export type SemanticSegmentRole = "text" | "command" | "mention"

export interface SemanticHighlightSegment {
	readonly text: string
	readonly role: SemanticSegmentRole
	/**
	 * Whether the entity still acts as an entity.
	 *
	 * An unrecognized mention, or anything a lifecycle barrier pushed into the
	 * pre-message, reads as literal text and must not look like an entity.
	 */
	readonly active: boolean
}

/** The composer lexes on every keystroke, so its document identity is fixed. */
const COMPOSER_DOCUMENT_ID = "composer"

function escapeHtml(text: string): string {
	return text.replace(/[<>&]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[character] ?? character)
}

/**
 * Split composer text the same way the task will read it.
 *
 * The segments come from the shared lexer and command plan, so what the user
 * sees highlighted is what the task admits: a command after a lifecycle barrier
 * is shown as literal text because that is how it will be sent.
 */
export function segmentSemanticInput(rawText: string, catalog: InputSemanticCatalog): readonly SemanticHighlightSegment[] {
	const document = lexSemanticInput(rawText, { catalog, documentId: COMPOSER_DOCUMENT_ID, activation: "auto" })
	const plan = planSemanticCommands(document)
	// The barrier is a command the task will run, so it stays an entity; only the
	// nodes it pushed into the pre-message become literal text.
	const invoked = new Set([...plan.invocations, ...(plan.barrier ? [plan.barrier] : [])].map((command) => command.entityId))
	return document.nodes.map((node) => {
		if (isSlashCommandNode(node)) {
			return { text: node.sourceText, role: "command" as const, active: invoked.has(node.entityId) }
		}
		if (isMentionNode(node)) {
			return { text: node.sourceText, role: "mention" as const, active: node.state === "recognized" }
		}
		return { text: node.kind === "text" ? node.text : "", role: "text" as const, active: false }
	})
}

/** Render the composer highlight layer from the shared semantic segments. */
export function renderSemanticHighlightHtml(rawText: string, catalog: InputSemanticCatalog): string {
	const html = segmentSemanticInput(rawText, catalog)
		.map((segment) =>
			segment.active && segment.role !== "text"
				? `<mark class="mention-context-textarea-highlight">${escapeHtml(segment.text)}</mark>`
				: escapeHtml(segment.text),
		)
		.join("")
	// A trailing newline would otherwise collapse and misalign the layer.
	return html.replace(/\n$/, "\n\n")
}
