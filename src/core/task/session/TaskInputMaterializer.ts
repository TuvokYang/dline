import type { TaskInput } from "../shell/TaskShell"
import type { TaskPayloadStore } from "../stores"
import { encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { UserInputEnvelope } from "../stores/payload/TaskPayloadEnvelopes"
import {
	type AdmittedLifecycleBarrier,
	type AdmittedTaskInput,
	type LifecycleBarrierPort,
	type ReviewedReply,
	SemanticInputRejectedError,
	type TaskInputAdmissionPort,
} from "./TaskInputAdmission"

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
		/** Takes over lifecycle commands such as `/compact`; absent means they stay prose. */
		private readonly barriers?: LifecycleBarrierPort,
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

		const owned = this.ownedBarrier(result.admitted)
		if (!owned) {
			return {
				semanticInput: result.admitted.document,
				admittedText: envelope.admittedText ?? result.admitted.admittedText,
				authorizedTools: result.admitted.authorizedTools,
				explicitInstructions: result.admitted.explicitInstructions,
			}
		}
		// An owned barrier leaves the turn entirely - its text, its authority and
		// its tools - and travels with the input instead, so it only acts once
		// the kernel accepted the input and a round admitted it.
		return {
			semanticInput: result.admitted.document,
			admittedText: owned.before,
			authorizedTools: owned.toolsBefore,
			explicitInstructions: owned.instructionsBefore,
			lifecycle: { commandId: owned.commandId, premessage: owned.premessage },
		}
	}

	/**
	 * Review a reply typed into an open dialog.
	 *
	 * A reply is the same user input as a submission, so a lifecycle command in
	 * it must act rather than reach the model as literal feedback. Returns the
	 * text the reply keeps once an owned command and its premessage are taken
	 * out, or undefined when nothing was owned and the reply stands as typed.
	 *
	 * The kept text is what the user typed, not its expansion: a reply grants no
	 * command authority, so expanded instructions would arrive without the tools
	 * they name. A refused reply stays literal too - the user answered a
	 * question, and dropping that answer would be worse than sending it as is.
	 */
	async reviewReply(reply: Omit<UserInputEnvelope, "kind">): Promise<ReviewedReply | undefined> {
		const barriers = this.barriers
		if (!this.admission || !barriers || !reply.text) return undefined
		const result = await this.admission.admit(reply)
		if (!result.ok) return undefined
		const owned = this.ownedBarrier(result.admitted)
		if (!owned) return undefined
		const command = { commandId: owned.commandId, premessage: owned.premessage }
		return { text: owned.sourceBefore, commit: () => barriers.request(command) }
	}

	private ownedBarrier(admitted: AdmittedTaskInput): AdmittedLifecycleBarrier | undefined {
		const barrier = admitted.barrier
		return barrier && this.barriers?.owns(barrier.commandId) ? barrier : undefined
	}
}
