import type { TaskInput } from "../shell/TaskShell"
import type { TaskPayloadStore } from "../stores"
import { encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { UserInputEnvelope } from "../stores/payload/TaskPayloadEnvelopes"

export interface TaskInputIdentityPort {
	nextEntryId(): string
	nextSequence(): number
}

export class TaskInputMaterializer {
	constructor(
		private readonly payloads: TaskPayloadStore,
		private readonly identity: TaskInputIdentityPort,
	) {}

	async materialize(envelope: Omit<UserInputEnvelope, "kind">, mode: TaskInput["mode"] = "queued"): Promise<TaskInput> {
		return {
			entryId: this.identity.nextEntryId(),
			sequence: this.identity.nextSequence(),
			mode,
			payloadRef: await this.payloads.put(encodeTaskPayload<UserInputEnvelope>({ kind: "user_input", ...envelope })),
		}
	}
}
