import type { TaskEvent } from "../kernel"

export interface AdmittedTaskInput {
	readonly entryId: string
	readonly payloadRef: string
	readonly origin: "prefilled" | "user_typed"
	readonly mode: "queued" | "steering"
	readonly sequence: number
}

export function admittedTaskInputEvent(
	input: AdmittedTaskInput,
	generation: number,
): Extract<TaskEvent, { type: "user.submit" }> {
	return {
		type: "user.submit",
		generation,
		entryId: input.entryId,
		payloadRef: input.payloadRef,
		mode: input.mode,
		sequence: input.sequence,
	}
}
