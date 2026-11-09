import type { TaskEvent, TaskState } from "../kernel"
import type { CommandPublicationStore, DurableTaskSnapshot, StateVault, TaskViewPort } from "../stores/contracts"
import { type AutomaticDialogDeliveryPort, withAutomaticDialogDelivery } from "./AutomaticDialogDelivery"
import { CommandRouter } from "./CommandRouter"
import { CommitPipeline } from "./CommitPipeline"
import type { CommandExecutor, EventSubmissionResult, RuntimeDiagnosticSink, RuntimeFacade, RuntimeRejection } from "./contracts"
import { DurableCommandOutbox } from "./DurableCommandOutbox"
import { EventLoop } from "./EventLoop"
import { systemTaskDeadlineClock, type TaskDeadlineClock, TaskDeadlineScheduler } from "./TaskDeadlineScheduler"

export interface TaskRuntimeOptions {
    readonly initialState: TaskState
    readonly vault: StateVault
    readonly taskView: TaskViewPort
    readonly publications: CommandPublicationStore
    readonly executors: readonly CommandExecutor[]
    readonly diagnostics?: RuntimeDiagnosticSink
    readonly restoredOutbox?: DurableTaskSnapshot["outbox"]
    /**
     * Open read-only until `grantWriteOwnership()`: hold restored commands and refuse every
     * event. A window that opens a task without owning its lock must neither dispatch
     * recovered work nor commit events, because both write the task databases the lock
     * owner is writing, and any entry it journals would also cancel the pending import of
     * the conversation an earlier version left behind.
     */
    readonly deferRestoredCommands?: boolean
    /** Separate bootstrap barrier; writer ownership alone does not release restored effects. */
    readonly holdRestoredCommands?: boolean
    readonly automaticResponses?: AutomaticDialogDeliveryPort
    readonly deadlineClock?: TaskDeadlineClock
}

export class TaskRuntime implements RuntimeFacade {
    private readonly router: CommandRouter
    private readonly commits: CommitPipeline
    private readonly outbox: DurableCommandOutbox
    private readonly events: EventLoop
    private readonly taskView: TaskViewPort
    private writable: boolean
    private durabilityRecovery: Promise<void> | undefined
    private restoredReleaseAllowed: boolean
    private automationClosed = false
    private automationPermission: () => boolean = () => true
    private readonly deadlineClock: TaskDeadlineClock
    private readonly deadlines: TaskDeadlineScheduler

    constructor(options: TaskRuntimeOptions) {
        this.taskView = options.taskView
        this.router = new CommandRouter(
            options.executors.map((executor) =>
                withAutomaticDialogDelivery(
                    executor,
                    options.automaticResponses,
                    () => this.writable && !this.automationClosed,
                    () => this.waitForDurable(this.getState().revision),
                ),
            ),
            options.diagnostics,
        )
        this.commits = new CommitPipeline(options.vault, options.taskView, options.diagnostics)
        this.outbox = new DurableCommandOutbox(this.router, options.publications, options.diagnostics)
        this.events = new EventLoop(options.initialState, this.commits, this.outbox)
        this.writable = options.deferRestoredCommands !== true
        this.restoredReleaseAllowed = options.holdRestoredCommands !== true
        this.deadlineClock = options.deadlineClock ?? systemTaskDeadlineClock
        this.deadlines = new TaskDeadlineScheduler(
            () => this.getState(),
            (event) => this.submit(event),
            () => this.writable && this.restoredReleaseAllowed && !this.automationClosed && this.automationPermission(),
            (error) =>
                options.diagnostics?.record({
                    source: "dialog",
                    code: "deadline_delivery_failed",
                    message: error instanceof Error ? error.message : String(error),
                }),
            this.deadlineClock,
        )
        if (options.restoredOutbox) {
            this.outbox.holdRestored(options.restoredOutbox, options.initialState.generation)
            this.releaseRestoredCommands()
        }
    }

    grantWriteOwnership(): void {
        this.writable = true
    }

    releaseRestoredCommands(): void {
        if (!this.writable || !this.restoredReleaseAllowed || this.automationClosed) return
        this.outbox.releaseRestored()
    }

    allowRestoredCommands(): void {
        this.restoredReleaseAllowed = true
        this.releaseRestoredCommands()
        this.deadlines.refresh()
    }

    setAutomationPermissionFence(read: () => boolean): void {
        this.automationPermission = read
        this.deadlines.refresh()
    }

    beginClose(): void {
        this.automationClosed = true
        this.deadlines.beginClose()
    }

    ownershipLost(): void {
        this.writable = false
        this.deadlines.refresh()
    }

    async disposeDeadlines(): Promise<void> {
        this.beginClose()
        await this.deadlines.dispose()
    }

    isWritable(): boolean {
        return this.writable
    }

    getState(): Readonly<TaskState> {
        return this.events.getState()
    }

    async submit(event: TaskEvent): Promise<EventSubmissionResult> {
        if (!this.canSubmit(event)) return readOnlyRejection(this.getState(), event)
        await this.recoverDurability()
        if (!this.canSubmit(event)) return readOnlyRejection(this.getState(), event)
        const result = await this.events.submit({ ...event, now: event.now ?? this.deadlineClock.now() })
        if (result.kind === "accepted") {
            void result.receipt.durable.then(() => this.deadlines.refresh()).catch(() => undefined)
        }
        return result
    }

    projectTransient(projection: Readonly<Record<string, unknown>>): void {
        this.taskView.notifyTransient(this.getState().taskId, projection)
    }

    async waitForDurable(revision: number): Promise<void> {
        if (this.writable) await this.recoverDurability()
        await this.commits.flushThrough(revision)
    }

    async waitForDomainCompletion(revision: number): Promise<void> {
        await this.commits.flushThrough(revision)
        await this.outbox.whenAdmitted(revision)
        await this.router.waitForRevision(revision)
    }

    async waitForQuiescence(): Promise<void> {
        await this.commits.flushAll()
        await this.outbox.whenIdle()
        await this.router.waitForQuiescence()
    }

    private canSubmit(event: TaskEvent): boolean {
        return this.writable && (event.type !== "away.deadline_due" || (!this.automationClosed && this.automationPermission()))
    }

    private recoverDurability(): Promise<void> {
        if (this.durabilityRecovery) return this.durabilityRecovery
        const attempt = this.retryFailedCommit()
        this.durabilityRecovery = attempt
        void attempt
            .finally(() => {
                if (this.durabilityRecovery === attempt) this.durabilityRecovery = undefined
            })
            .catch(() => undefined)
        return attempt
    }

    private async retryFailedCommit(): Promise<void> {
        const recovered = await this.commits.retryFailed()
        if (recovered) {
            this.outbox.holdRestored(recovered.outbox, recovered.state.generation)
            this.releaseRestoredCommands()
        }
    }
}

function readOnlyRejection(state: TaskState, event: TaskEvent): RuntimeRejection {
    return {
        kind: "rejected",
        state,
        reason: "read_only",
        diagnostic: {
            code: "task_read_only",
            message: `Refused ${event.type}: another window owns task ${state.taskId}`,
        },
    }
}
