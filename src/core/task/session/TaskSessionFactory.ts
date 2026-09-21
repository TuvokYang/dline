import { randomUUID } from "node:crypto"
import { composeTask, type TaskCompositionOptions } from "../composition/TaskCompositionRoot"
import { ActiveTaskSession, type ActiveTaskSessionReleasePort } from "./ActiveTaskSession"
import type { TaskInputAdmissionPort } from "./TaskInputAdmission"
import { type TaskInputIdentityPort, TaskInputMaterializer } from "./TaskInputMaterializer"
import type { TaskSessionOwners } from "./TaskSessionOwners"

export interface OpenActiveTaskSessionOptions extends TaskCompositionOptions {
	readonly inputIdentity?: TaskInputIdentityPort
	readonly owners: TaskSessionOwners
	readonly releases?: readonly ActiveTaskSessionReleasePort[]
	/** Reviews each submission before it is journaled; omitted only where no catalog exists. */
	readonly inputAdmission?: TaskInputAdmissionPort
}

export type OpenActiveTaskSessionResult =
	| { readonly kind: "ready"; readonly session: ActiveTaskSession }
	| { readonly kind: "read_only"; readonly reason: string; readonly diagnostics: readonly { code: string; message: string }[] }

function createInputIdentity(taskId: string): TaskInputIdentityPort {
	let sequence = 0
	return {
		nextEntryId: () => `${taskId}:input:${randomUUID()}`,
		nextSequence: () => sequence++,
	}
}

export async function openActiveTaskSession(options: OpenActiveTaskSessionOptions): Promise<OpenActiveTaskSessionResult> {
	const composed = await composeTask(options)
	if (composed.kind === "read_only") return composed
	return {
		kind: "ready",
		session: new ActiveTaskSession({
			task: composed.task,
			readState: () => composed.runtime.getState(),
			assembly: composed.assembly,
			payloads: composed.payloads,
			inputs: new TaskInputMaterializer(
				composed.payloads,
				options.inputIdentity ?? createInputIdentity(options.taskId),
				options.inputAdmission,
			),
			owners: options.owners,
			releases: options.releases,
		}),
	}
}
