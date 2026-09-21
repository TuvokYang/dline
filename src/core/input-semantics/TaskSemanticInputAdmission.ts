import type { SemanticInputDocument } from "@shared/input-semantics/document"
import type { TaskInputAdmissionPort, TaskInputAdmissionResult } from "@/core/task/session/TaskInputAdmission"
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
		const document = input.semanticInput ?? this.legacy.adapt(input)
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
