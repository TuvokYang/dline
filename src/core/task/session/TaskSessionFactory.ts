import { randomUUID } from "node:crypto"
import { composeTask, type TaskCompositionOptions } from "../composition/TaskCompositionRoot"
import { ActiveTaskSession, type ActiveTaskSessionReleasePort } from "./ActiveTaskSession"
import { CanonicalInputQueueApplication } from "./CanonicalInputQueueApplication"
import type { LifecycleBarrierPort, TaskInputAdmissionPort } from "./TaskInputAdmission"
import { type TaskInputIdentityPort, TaskInputMaterializer } from "./TaskInputMaterializer"
import type { TaskSessionOwners } from "./TaskSessionOwners"

export interface OpenActiveTaskSessionOptions extends TaskCompositionOptions {
	readonly inputIdentity?: TaskInputIdentityPort
	readonly owners: TaskSessionOwners
	readonly releases?: readonly ActiveTaskSessionReleasePort[]
	/** Reviews each submission before it is journaled; omitted only where no catalog exists. */
	readonly inputAdmission?: TaskInputAdmissionPort
	/** Carries out lifecycle commands such as `/compact`; absent means they stay prose. */
	readonly lifecycleBarriers?: LifecycleBarrierPort
}

function createInputIdentity(taskId: string): TaskInputIdentityPort {
	let sequence = 0
	return {
		nextEntryId: () => `${taskId}:input:${randomUUID()}`,
		nextSequence: () => sequence++,
	}
}

/** Open one task session; opening an existing task always succeeds, see `hydrate`. */
export async function openActiveTaskSession(options: OpenActiveTaskSessionOptions): Promise<ActiveTaskSession> {
	const composed = await composeTask(options)
	const inputs = new TaskInputMaterializer(
		composed.payloads,
		options.inputIdentity ?? createInputIdentity(options.taskId),
		options.inputAdmission,
		options.lifecycleBarriers,
	)
	return new ActiveTaskSession({
		task: composed.task,
		checkpointRestore: composed.checkpointRestore,
		readState: () => composed.runtime.getState(),
		assembly: composed.assembly,
		payloads: composed.payloads,
		inputs,
		inputQueue: new CanonicalInputQueueApplication(composed.runtime, inputs, composed.payloads, options.owners.interactions),
		owners: options.owners,
		approvalFeedback: composed.approvalFeedback,
		conversation: composed.conversation,
		releases: options.releases,
	})
}
