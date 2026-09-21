import type { SemanticInputDocument } from "@shared/input-semantics/document"
import type { SemanticInputDiagnostic } from "@shared/input-semantics/validation"
import type { ExplicitInstructionDeclaration } from "../explicit-instructions/types"

/** What one submission contributes once Core has reviewed it. */
export interface AdmittedTaskInput {
	readonly document: SemanticInputDocument
	/** Ordered projection for the provider; the raw text stays untouched for the UI. */
	readonly admittedText: string
	readonly authorizedTools: readonly string[]
	/** One-shot authority the named commands grant for the turn they open. */
	readonly explicitInstructions: readonly ExplicitInstructionDeclaration[]
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
	admit(input: {
		readonly text?: string
		readonly images?: readonly string[]
		readonly files?: readonly string[]
		readonly semanticInput?: SemanticInputDocument
	}): Promise<TaskInputAdmissionResult>
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
