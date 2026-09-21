import type { TaskInput } from "../shell/TaskShell"
import type { TaskPayloadStore } from "../stores"
import { encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { UserInputEnvelope } from "../stores/payload/TaskPayloadEnvelopes"
import { SemanticInputRejectedError, type TaskInputAdmissionPort } from "./TaskInputAdmission"

export interface TaskInputIdentityPort {
	nextEntryId(): string
	nextSequence(): number
}

/**
 * The single place a submission becomes a durable task input.
 *
 * Admission runs here, at submit time, so a mention is captured when the user
 * agreed to it rather than whenever the queue happens to deliver the entry.
 */
export class TaskInputMaterializer {
	constructor(
		private readonly payloads: TaskPayloadStore,
		private readonly identity: TaskInputIdentityPort,
		private readonly admission?: TaskInputAdmissionPort,
	) {}

	async materialize(envelope: Omit<UserInputEnvelope, "kind">, mode: TaskInput["mode"] = "queued"): Promise<TaskInput> {
		const admitted = await this.review(envelope)
		return {
			entryId: this.identity.nextEntryId(),
			sequence: this.identity.nextSequence(),
			mode,
			payloadRef: await this.payloads.put(
				encodeTaskPayload<UserInputEnvelope>({ kind: "user_input", ...envelope, ...admitted }),
			),
		}
	}

	/** Refusing here keeps a rejected submission out of the journal entirely. */
	private async review(envelope: Omit<UserInputEnvelope, "kind">): Promise<Partial<UserInputEnvelope>> {
		if (!this.admission) return {}

		const result = await this.admission.admit(envelope)
		if (!result.ok) throw new SemanticInputRejectedError(result.diagnostics)

		return {
			semanticInput: result.admitted.document,
			admittedText: result.admitted.admittedText,
			authorizedTools: result.admitted.authorizedTools,
			explicitInstructions: result.admitted.explicitInstructions,
		}
	}
}
