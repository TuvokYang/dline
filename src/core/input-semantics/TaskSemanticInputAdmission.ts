import { isSlashCommandNode, type SemanticInputDocument } from "@shared/input-semantics/document"
import type { TaskInputAdmissionPort, TaskInputAdmissionResult } from "@/core/task/session/TaskInputAdmission"
import { Logger } from "@shared/services/Logger"
import type { LegacyInputAdapter } from "./LegacyInputAdapter"
import type { SemanticInputAdmissionService } from "./SemanticInputAdmissionService"

/**
 * Binds the two input paths to one admission.
 *
 * A structured submission is admitted as it stands. A legacy submission is
 * upgraded by the single adapter first. Either way exactly one parse happened,
 * and admission sees the same document shape.
 */
export class TaskSemanticInputAdmission implements TaskInputAdmissionPort {
	constructor(
		private readonly legacy: LegacyInputAdapter,
		private readonly admission: SemanticInputAdmissionService,
	) {}

	async admit(input: {
		readonly text?: string
		readonly images?: readonly string[]
		readonly files?: readonly string[]
		readonly semanticInput?: SemanticInputDocument
	}): Promise<TaskInputAdmissionResult> {
		const document = input.semanticInput ?? (await this.legacy.adapt(input))
		reportUnresolvedCommands(document)
		const result = await this.admission.admit(document)
		if (!result.ok) return result
		return {
			ok: true,
			admitted: {
				document,
				admittedText: result.admitted.text,
				authorizedTools: result.admitted.authorizedTools,
				explicitInstructions: result.admitted.explicitInstructions,
			},
		}
	}
}

/**
 * Report a command shape the catalog did not recognize.
 *
 * Such a node stays literal text, so the user sees their command silently do
 * nothing. Naming the catalog revision makes a discovery gap distinguishable
 * from a genuinely unknown command.
 */
function reportUnresolvedCommands(document: SemanticInputDocument): void {
	const unresolved = document.nodes
		.filter(isSlashCommandNode)
		.filter((node) => node.state !== "recognized" && node.state !== "literal")
	if (unresolved.length === 0) return
	Logger.warn(
		`[SemanticInput] catalog revision ${document.catalogRevision} did not resolve ${unresolved
			.map((node) => node.sourceText)
			.join(", ")}; it will be sent as plain text`,
	)
}
