import { randomUUID } from "node:crypto"
import { composeTask, type TaskCompositionOptions } from "../composition/TaskCompositionRoot"
import type { DraftAttachmentPort } from "../interaction/DraftAttachments"
import { ActiveTaskSession, type ActiveTaskSessionReleasePort } from "./ActiveTaskSession"
import { CanonicalInputQueueApplication } from "./CanonicalInputQueueApplication"
import type { LifecycleBarrierPort, TaskInputAdmissionPort } from "./TaskInputAdmission"
import { type TaskInputIdentityPort, TaskInputMaterializer } from "./TaskInputMaterializer"
import type { TaskSessionOwners } from "./TaskSessionOwners"
import { TransitionDraftApplication } from "./TransitionDraftApplication"

export interface OpenActiveTaskSessionOptions extends TaskCompositionOptions {
    readonly inputIdentity?: TaskInputIdentityPort
    readonly owners: TaskSessionOwners
    readonly releases?: readonly ActiveTaskSessionReleasePort[]
    /** Reviews every submission before it becomes durable task input. */
    readonly inputAdmission: TaskInputAdmissionPort
    /** Carries out lifecycle commands such as `/compact`; absent means they stay prose. */
    readonly lifecycleBarriers?: LifecycleBarrierPort
    /** Resolves a draft's resources from the task's store when a receiver consumes it. */
    readonly draftAttachments: DraftAttachmentPort
    /** See {@link ActiveTaskSession.upgradeImportPending}. */
    readonly upgradeImportPending?: boolean
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
        draftAttachments: options.draftAttachments,
        task: composed.task,
        checkpointRestore: composed.checkpointRestore,
        readState: () => composed.runtime.getState(),
        isWritable: () => composed.runtime.isWritable(),
        assembly: composed.assembly,
        payloads: composed.payloads,
        inputs,
        inputQueue: new CanonicalInputQueueApplication(composed.runtime, inputs, composed.payloads, options.owners.interactions),
        transitionDrafts: new TransitionDraftApplication(composed.runtime, composed.payloads),
        owners: options.owners,
        approvalFeedback: composed.approvalFeedback,
        conversation: composed.conversation,
        contextTruncation: composed.contextTruncation,
        releases: options.releases,
        upgradeImportPending: options.upgradeImportPending,
    })
}
