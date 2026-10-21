import { ContextManager } from "@core/context/context-management/ContextManager"
import { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import type { Controller } from "@core/controller/index"
import { sendRelinquishControlEvent } from "@core/controller/ui/subscribeToRelinquishControl"
import { ensureTaskDirectoryExists } from "@core/storage/disk"
import {
    CheckpointGate,
    type CheckpointGateObservation,
    type CheckpointGateState,
    type CheckpointRoundReason,
    type CheckpointRoundSource,
    type CheckpointRow,
    type CheckpointRowReservation,
} from "@core/task/checkpoints/CheckpointGate"
import { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import CheckpointTracker, { type CheckpointChangedFile } from "@integrations/checkpoints/CheckpointTracker"
import { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import { findLast, findLastIndex } from "@shared/array"
import { drawsNothingBetween } from "@shared/chat/drawnMessages"
import {
    type CheckpointReferenceSet,
    checkpointReferenceSetsEqual,
    createCheckpointReferenceSet,
    getCheckpointHashForWorkspace,
    hasFileCheckpoint,
    readCheckpointReferenceSet,
} from "@shared/checkpoints"
import { combineApiRequests } from "@shared/combineApiRequests"
import { combineCommandSequences } from "@shared/combineCommandSequences"
import { type CheckpointSource, UiApiReqInfo, UiMessage, UiSay } from "@shared/ExtensionMessage"
import { getApiMetrics } from "@shared/getApiMetrics"
import { HistoryItem } from "@shared/HistoryItem"
import { ClineCheckpointRestore } from "@shared/WebviewMessage"
import pTimeout from "p-timeout"
import { HostProvider } from "@/hosts/host-provider"
import { DiagnosticDomain, DiagnosticOutcome } from "@/services/telemetry/instrumentation/diagnostic-events"
import { recordDiagnostic } from "@/services/telemetry/instrumentation/diagnostic-recorder"
import { recordPerfPhase } from "@/services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "@/services/telemetry/instrumentation/perf-domains"
import { ShowMessageType } from "@/shared/proto/dline/host/window"
import { Logger } from "@/shared/services/Logger"
import { retryWithBackoff } from "@/utils/retry"
import { MessageStateHandler } from "../../core/task/message-state"
import type { ClineContent } from "../../shared/messages/content"
import { CheckpointUnitCoordinator } from "./CheckpointUnitCoordinator"
import {
    type ChatRestoreBoundary,
    type ChatRestoreRow,
    chatRestoreRow,
    resolveChatRestoreBoundary,
} from "./chat-restore-boundary"
import { decodeCheckpointWorkspaceRef, encodeCheckpointWorkspaceRef } from "./checkpoint-references"
import { resolveCompletionDiffBaseReferences } from "./completion-diff"
import { CHECKPOINT_TRACKER_ATTEMPT_TIMEOUT_MS } from "./initializer"
import type { CanonicalCheckpointPort, ConversationRewindPort, ICheckpointManager } from "./types"
import { WorkspaceChangeFeed } from "./WorkspaceChangeFeed"

/**
 * Consecutive staging failures tolerated before the user is told that
 * checkpoints stopped recording. One failure can be a transient lock or a
 * file removed mid-flight; a run of them means no restore point is produced.
 */
const CHECKPOINT_STAGING_FAILURE_ALERT_THRESHOLD = 3

/** Prefix identifying the message this manager raises for staging failures. */
const STAGING_FAILURE_MESSAGE_PREFIX = "Checkpoints could not record"

/** Whether two optional reference sets restore the same files. */
function sameReferences(left: CheckpointReferenceSet | undefined, right: CheckpointReferenceSet | undefined): boolean {
    if (!left || !right) return left === right
    return checkpointReferenceSetsEqual(left, right)
}

/** The row fields that let a checkpoint restore files; empty when the references hold none. */
function fileCheckpointFields(
    refs: CheckpointReferenceSet | undefined,
): Pick<CheckpointRowFields, "lastCheckpointHash" | "checkpointWorkspaceRoots"> {
    if (!refs || !hasFileCheckpoint(refs)) return {}
    return { lastCheckpointHash: refs.hashes, checkpointWorkspaceRoots: refs.workspaceRoots }
}

/** A checkpoint row as the gate tracks it, once the row is durable. */
function checkpointRowOf(row: UiMessage, hasFiles: boolean): CheckpointRow {
    return { ts: row.ts, position: row.conversationJournalSeq, hasFiles }
}

/**
 * Where a checkpoint row restores to when its canonical bundle was never written.
 *
 * A bundle is captured after its row, and a checkpoint is a side feature whose
 * parts may fail independently, so a row can outlive a missing bundle. The row
 * still records the journal position it was written at and the files it
 * committed, which is everything the restore needs.
 */
function canonicalRestoreFallback(
    message: UiMessage,
): { readonly journalTarget: { readonly seq: number }; readonly workspaceRef?: string } | undefined {
    if (message.say !== "checkpoint_created" || message.conversationJournalSeq === undefined) return undefined
    const references = readCheckpointReferenceSet(message)
    return {
        journalTarget: { seq: message.conversationJournalSeq },
        ...(references && hasFileCheckpoint(references) ? { workspaceRef: encodeCheckpointWorkspaceRef(references) } : {}),
    }
}

/**
 * Whether a row shows input the user submitted. Such a row is written just
 * before its input is journaled, so the input sits right after the row's position.
 */
function showsUserInput(message: UiMessage): boolean {
    return message.type === "say" && (message.say === "task" || message.say === "user_feedback")
}

// Type definitions for better code organization
type SayFunction = (
    type: UiSay,
    text?: string,
    images?: string[],
    files?: string[],
    partial?: boolean,
) => Promise<number | undefined>
type UpdateTaskHistoryFunction = (historyItem: HistoryItem) => Promise<HistoryItem[]>

/** The fields a checkpoint row carries beyond its identity. */
export type CheckpointRowFields = Pick<
    UiMessage,
    | "lastCheckpointHash"
    | "checkpointWorkspaceRoots"
    | "checkpointAnchorTs"
    | "checkpointSource"
    | "conversationJournalSeq"
    | "conversationHistoryIndex"
    | "conversationHistoryDeletedRange"
>

/** A row registered in presentation order whose durable write is still settling. */
export interface BegunCheckpointRow {
    readonly ts: number
    readonly persistence: Promise<UiMessage>
}

/** A row shown in presentation order before its restore point exists. */
export interface HeldCheckpointRow {
    readonly ts: number
    /** Commit the held row in its place, adding the fields it was missing. */
    fill(fields: CheckpointRowFields): BegunCheckpointRow
    /** Drop the held row; nothing was written for it. */
    withdraw(): void
}

interface CheckpointManagerTask {
    readonly taskId: string
    readonly controller: Controller
}
interface CheckpointManagerConfig {
    readonly enableCheckpoints: boolean
    readonly createCheckpointTracker?: (
        taskId: string,
        enableCheckpoints: boolean,
        workspacePath: string,
    ) => Promise<CheckpointTracker | undefined>
}
/**
 * The exact mutable runtime state a checkpoint restore must clear.
 *
 * Declared here as a narrow port so the manager stays independent of whichever
 * class owns those fields; restore must be able to cancel a pending ask and
 * drop half-built turn content without importing the task runtime.
 */
export interface CheckpointRuntimeState {
    userMessageContent: unknown[]
    assistantMessageContent: unknown[]
    userMessageContentReady: boolean
    lastMessageTs?: number
    askResponseText?: string
    askResponseImages?: string[]
    askResponseFiles?: string[]
    isAwaitingPlanResponse: boolean
    didRespondToPlanAskBySwitchingMode: boolean
    conversationHistoryDeletedRange?: [number, number]
    checkpointManagerErrorMessage?: string
    resetMistakeLimitState(): void
}

interface CheckpointManagerServices {
    readonly fileContextTracker: FileContextTracker
    readonly contextManager: ContextManager
    readonly diffViewProvider: DiffViewProvider
    readonly messageStateHandler: MessageStateHandler
    readonly taskState: CheckpointRuntimeState
    readonly taskFileTracker?: import("./TaskFileTracker").TaskFileTracker
    readonly workspaceManager?: WorkspaceRootManager
    /** Rewinds the task's journal conversation; required only to restore a journal-bounded card. */
    readonly conversationRewind?: ConversationRewindPort
    readonly canonicalCheckpoint?: CanonicalCheckpointPort
}
interface CheckpointManagerCallbacks {
    readonly updateTaskHistory: UpdateTaskHistoryFunction
    readonly cancelTask: () => Promise<void>
    readonly restoreChatRuntime: (input: { apiIndex: number; editedText?: string }) => Promise<void>
    readonly say: SayFunction
    /**
     * Register one `checkpoint_created` row. The row takes its place in the chat
     * before this returns, so rows written later always sort after it.
     */
    readonly beginRow: (fields: CheckpointRowFields) => BegunCheckpointRow
    /**
     * Show a `checkpoint_created` row in presentation order before its restore
     * point exists. The held row offers no restore and is not written until it is
     * filled. Absent on a surface that places a row only when it is written.
     */
    readonly holdRow?: (fields: CheckpointRowFields) => HeldCheckpointRow
    readonly postStateToWebview: () => Promise<void>
    /**
     * Redraws one row the view already shows. A state post only carries the
     * task view, so a row patched after it was published stays stale on screen
     * until something republishes it.
     */
    readonly publishMessage: (message: UiMessage) => Promise<void>
}
interface CheckpointManagerInternalState {
    conversationHistoryDeletedRange?: [number, number]
    checkpointTracker?: CheckpointTracker
    checkpointUnitCoordinator?: CheckpointUnitCoordinator
    /** What the task shows about checkpoints; a warning or a failure an earlier session persisted. */
    checkpointManagerErrorMessage?: string
    /**
     * Why this manager's own initialization failed. Only this stops further
     * attempts: the displayed message may be a slow-start warning or a failure
     * restored from an earlier session, and neither proves the tracker cannot
     * start now. Gating on it left a reopened task without file checkpoints for good.
     */
    initializationFailure?: string
    checkpointTrackerInitPromise?: Promise<CheckpointTracker | undefined>
}

interface CheckpointRestoreStateUpdate {
    conversationHistoryDeletedRange?: [number, number]
    checkpointManagerErrorMessage?: string
}

type WorkspaceRestoreResult =
    | { readonly status: "restored"; readonly checkpointReferences: CheckpointReferenceSet }
    | {
          readonly status: "partial"
          readonly checkpointReferences: CheckpointReferenceSet
          readonly warning: string
      }
    | { readonly status: "failed"; readonly error: string }

/**
 * TaskCheckpointManager
 *
 * A dedicated service for managing all checkpoint-related operations within a task.
 * Provides a clean separation of concerns from the main Task class while maintaining
 * full access to necessary dependencies and state.
 *
 * Public API:
 * - saveCheckpoint: Creates a new checkpoint of the current workspace state
 * - restoreCheckpoint: Restores the task to a previous checkpoint
 * - presentMultifileDiff: Displays a multi-file diff view between checkpoints
 * - doesLatestTaskCompletionHaveNewChanges: Checks if the latest task completion has new changes, used by the "See New Changes" button
 *
 * This class is designed as the main interface between the task and the checkpoint system. It is responsible for:
 * - Task-specific checkpoint operations (save/restore/diff)
 * - State management and coordination with other Task components
 * - Interaction with message state, file context tracking etc.
 * - User interaction (error messages, notifications)
 *
 * For checkpoint operations, the CheckpointTracker class is used to interact with the underlying git logic.
 */
export class TaskCheckpointManager implements ICheckpointManager {
    private readonly task: CheckpointManagerTask
    private readonly config: CheckpointManagerConfig
    private readonly services: CheckpointManagerServices
    private readonly callbacks: CheckpointManagerCallbacks
    private readonly taskState: CheckpointRuntimeState

    private state: CheckpointManagerInternalState
    /** Decides and writes every checkpoint row of this task incarnation. */
    private readonly gate: CheckpointGate<CheckpointReferenceSet>
    /** Workspace changes since the last checkpoint commit; absent when checkpoints are off. */
    private readonly changes: WorkspaceChangeFeed | undefined
    /** Recursive observation is requested after provider wire and starts once the baseline tracker is ready. */
    private workspaceWatcherRequested = false
    private workspaceWatcherStarted = false
    /**
     * Set when the task incarnation releases its resources.
     *
     * Work still running at that point must not write into stores that are
     * about to close; the shadow commit itself is harmless and is left to finish.
     */
    private disposed = false

    constructor(
        task: CheckpointManagerTask,
        config: CheckpointManagerConfig,
        services: CheckpointManagerServices,
        callbacks: CheckpointManagerCallbacks,
        initialState: CheckpointManagerInternalState,
    ) {
        this.task = Object.freeze(task)
        this.config = config
        this.services = services
        this.callbacks = Object.freeze(callbacks)
        this.taskState = services.taskState
        this.state = { ...initialState }
        this.changes =
            config.enableCheckpoints && services.taskFileTracker ? new WorkspaceChangeFeed(services.taskFileTracker) : undefined
        const holdRow = callbacks.holdRow
        this.gate = new CheckpointGate<CheckpointReferenceSet>({
            taskId: this.task.taskId,
            workspace: {
                hasChanges: () => this.changes?.hasChanges() ?? true,
                commit: () => this.commitWorkspace(),
                sameRefs: sameReferences,
            },
            conversation: {
                advancedSince: (position) =>
                    this.services.canonicalCheckpoint?.advancedSince?.(position) ?? Promise.resolve(true),
            },
            rows: {
                write: (input) => this.writeCheckpointRow(input),
                retire: (row) => this.retireCheckpointRow(row),
                ...(holdRow ? { reserve: (input) => this.reserveCheckpointRow(holdRow, input) } : {}),
            },
            bundles: { capture: (input) => this.captureCheckpointBundle(input) },
            initialState: () => this.latestCheckpointState(),
            observe: (observation) => this.reportGateObservation(observation),
        })
    }

    /**
     * Before a provider request or compaction: add a checkpoint row unless the
     * latest one still covers the conversation and the files.
     */
    async ensureRoundCheckpoint(
        reason: CheckpointRoundReason,
        sourceOrSignal?: CheckpointSource | AbortSignal,
        signal?: AbortSignal,
    ): Promise<void> {
        if (!this.config.enableCheckpoints || this.disposed) return
        const source = sourceOrSignal instanceof AbortSignal ? undefined : sourceOrSignal
        const operationSignal = sourceOrSignal instanceof AbortSignal ? sourceOrSignal : signal
        if (reason === "round_start" && source?.kind === "round_start") {
            await this.gate.ensureRound(reason, source, operationSignal)
        } else if (reason === "pre_compaction" && source?.kind === "pre_compaction") {
            await this.gate.ensureRound(reason, source, operationSignal)
        } else {
            await this.gate.ensureRound(reason, operationSignal)
        }
    }

    /** Order one workspace mutation after the prior baseline and before the next round. */
    async beginWorkspaceMutation(): Promise<() => void> {
        if (!this.config.enableCheckpoints || this.disposed) return () => undefined
        return await this.gate.beginMutation()
    }

    /**
     * Stop creating checkpoints for this task incarnation.
     *
     * Called before the task's stores close. A check already admitted finishes,
     * so no row is left without its bundle; nothing new starts.
     */
    async dispose(): Promise<void> {
        this.changes?.dispose()
        await this.gate.close()
        this.disposed = true
    }

    /**
     * Start recursive observation once request-critical filesystem work is complete.
     *
     * The feed already requires a full first checkpoint scan, so deferring chokidar's
     * own recursive baseline cannot lose startup changes. It only prevents that
     * baseline from occupying the filesystem pool before the first provider request.
     */
    startWorkspaceWatcher(): void {
        this.workspaceWatcherRequested = true
        this.startWorkspaceWatcherIfReady()
    }

    private startWorkspaceWatcherIfReady(): void {
        if (
            !this.workspaceWatcherRequested ||
            this.workspaceWatcherStarted ||
            !this.changes ||
            !this.state.checkpointTracker ||
            this.disposed
        ) {
            return
        }
        this.workspaceWatcherStarted = true
        void this.watchWorkspace(this.changes)
    }

    /** Watch every workspace root; a root that cannot be watched is scanned instead. */
    private async watchWorkspace(changes: WorkspaceChangeFeed): Promise<void> {
        try {
            const roots = this.services.workspaceManager?.getRoots?.().map((root) => root.path) ?? []
            const watched = roots.length > 0 ? roots : [await this.getWorkspacePath()]
            if (this.disposed) return
            changes.start(watched)
        } catch (error) {
            Logger.warn(`[TaskCheckpointManager] Could not watch the workspace of task ${this.task.taskId}:`, error)
        }
    }

    /** Register one complete checkpoint row and wait until it is durable. */
    private async writeCheckpointRow(input: {
        readonly source?: CheckpointSource
        readonly refs?: CheckpointReferenceSet
    }): Promise<CheckpointRow> {
        if (this.disposed) throw new Error("The task is closing")
        this.releaseCheckedOutRows()
        const files = fileCheckpointFields(input.refs)
        const begun = this.callbacks.beginRow({
            ...(input.source ? { checkpointSource: input.source } : {}),
            ...files,
        })
        return checkpointRowOf(await begun.persistence, files.lastCheckpointHash !== undefined)
    }

    /**
     * Hold a round's row in the chat while its workspace commit runs. The provider
     * streams the round's rows meanwhile, so a row placed only once the commit
     * settled would sort below them. The held row takes the conversation position
     * of the round boundary, which is what the model is about to see.
     */
    private reserveCheckpointRow(
        holdRow: (fields: CheckpointRowFields) => HeldCheckpointRow,
        input: { readonly source?: CheckpointSource },
    ): CheckpointRowReservation<CheckpointReferenceSet> {
        const held = holdRow(input.source ? { checkpointSource: input.source } : {})
        return {
            fill: async ({ refs }) => {
                if (this.disposed) throw new Error("The task is closing")
                this.releaseCheckedOutRows()
                const files = fileCheckpointFields(refs)
                return checkpointRowOf(await held.fill(files).persistence, files.lastCheckpointHash !== undefined)
            },
            withdraw: async () => held.withdraw(),
            adjoins: (row) => drawsNothingBetween(this.services.messageStateHandler.clineMessages, row.ts, held.ts),
        }
    }

    /** A new restore point supersedes the one the workspace was checked out to. */
    private releaseCheckedOutRows(): void {
        for (const message of this.services.messageStateHandler.clineMessages) {
            if (message.say === "checkpoint_created") message.isCheckpointCheckedOut = false
        }
    }

    /**
     * Remove a round row that the gate found replaced by a newer file-backed row in
     * the same place, so the chat does not show two adjacent checkpoints. Its bundle
     * is left in place: nothing restores to it once the row is gone.
     */
    private async retireCheckpointRow(row: CheckpointRow): Promise<boolean> {
        if (this.disposed) return false
        const messages = this.services.messageStateHandler.clineMessages
        const target = messages.find((message) => message.ts === row.ts)
        if (target?.say !== "checkpoint_created") return false
        // A pre-edit row restores its chat through this row, so this row must stay.
        if (messages.some((message) => message.checkpointAnchorTs === row.ts)) return false
        await this.services.messageStateHandler.removeMessagesByTs([row.ts])
        return true
    }

    private async currentWorkspaceDelta(references: CheckpointReferenceSet): Promise<CheckpointChangedFile[]> {
        const coordinator = this.state.checkpointUnitCoordinator
        if (coordinator) {
            const outcome = await coordinator.getDiffSet(references)
            this.showPartialCheckpointWarning("Checkpoint diff is partial", outcome.failures)
            return outcome.changedFiles
        }
        const tracker = this.state.checkpointTracker
        if (!tracker) return []
        const hash = await this.getCurrentWorkspaceHash(references)
        return hash ? await tracker.getDiffSet(hash) : []
    }

    private async captureCheckpointBundle(input: {
        readonly row: CheckpointRow
        readonly refs?: CheckpointReferenceSet
        readonly anchor?: CheckpointRow
    }): Promise<void> {
        const checkpoint = this.services.canonicalCheckpoint
        if (!checkpoint) return
        await checkpoint.capture({
            messageTs: input.row.ts,
            ...(input.refs ? { workspaceRef: encodeCheckpointWorkspaceRef(input.refs) } : {}),
            ...(input.row.position === undefined ? {} : { boundary: { seq: input.row.position } }),
            ...(input.anchor ? { anchorTs: input.anchor.ts } : {}),
        })
    }

    /** Where a reopened task continues from: its latest round row and non-stale file references. */
    private latestCheckpointState(): CheckpointGateState<CheckpointReferenceSet> {
        const messages = this.services.messageStateHandler.clineMessages
        // A held row is still waiting for its round and restores nothing yet.
        const latestRoundIndex = findLastIndex(
            messages,
            (message) =>
                message.say === "checkpoint_created" && message.partial !== true && message.checkpointAnchorTs === undefined,
        )
        const latestFileIndex = findLastIndex(messages, (message) => hasFileCheckpoint(readCheckpointReferenceSet(message)))
        const latestRound = latestRoundIndex >= 0 ? messages[latestRoundIndex] : undefined
        // A task-only row created after a failed file commit invalidates older refs.
        // Completion refs written after the latest round remain reusable.
        const latestRefs =
            latestFileIndex >= 0 && latestFileIndex >= latestRoundIndex
                ? readCheckpointReferenceSet(messages[latestFileIndex])
                : undefined
        const latestSource = latestRound?.checkpointSource
        const latestRoundSource: CheckpointRoundSource | undefined =
            latestSource?.kind === "round_start" || latestSource?.kind === "pre_compaction" ? latestSource : undefined
        return {
            ...(latestRound
                ? {
                      latestChat: {
                          ts: latestRound.ts,
                          position: latestRound.conversationJournalSeq,
                          hasFiles: hasFileCheckpoint(readCheckpointReferenceSet(latestRound)),
                      },
                  }
                : {}),
            ...(latestRoundSource ? { latestSource: latestRoundSource } : {}),
            ...(latestRefs ? { latestRefs } : {}),
        }
    }

    private reportGateObservation(observation: CheckpointGateObservation): void {
        const dimensions = {
            reason: observation.reason,
            outcome: observation.outcome,
            ...(observation.part ? { part: observation.part } : {}),
        }
        const context = { taskId: this.task.taskId }
        recordPerfPhase(PerfDomain.Checkpoint, "gate_wait", observation.waitMs, dimensions, context)
        recordPerfPhase(PerfDomain.Checkpoint, "gate_ensure", observation.holdMs, dimensions, context)
        if (observation.commitMs !== undefined) {
            recordPerfPhase(PerfDomain.Checkpoint, "gate_commit", observation.commitMs, dimensions, context)
        }
        if (observation.outcome === "failed") {
            recordDiagnostic(
                DiagnosticDomain.Checkpoint,
                "gate_part_failed",
                DiagnosticOutcome.Degraded,
                { ...dimensions, ...(observation.errorName ? { errorName: observation.errorName } : {}) },
                context,
            )
        }
    }

    private async persistCheckpointHash(messageIndex: number, references: CheckpointReferenceSet): Promise<void> {
        await this.services.messageStateHandler.updateClineMessage(messageIndex, {
            lastCheckpointHash: references.hashes,
            checkpointWorkspaceRoots: references.workspaceRoots,
        })
        await this.services.messageStateHandler.flushMessageUpdate(messageIndex)
        await this.publishPatchedRow(messageIndex)
        await this.callbacks.postStateToWebview()
    }

    /** View delivery only: the hash is already durable, so a failed redraw must not fail the checkpoint. */
    private async publishPatchedRow(messageIndex: number): Promise<void> {
        const row = this.services.messageStateHandler.clineMessages[messageIndex]
        if (!row) return
        try {
            await this.callbacks.publishMessage(row)
        } catch (error) {
            Logger.warn(
                `[TaskCheckpointManager] Could not publish checkpoint row ${messageIndex} for task ${this.task.taskId}: ${error instanceof Error ? error.message : String(error)}`,
            )
        }
    }

    private async captureCanonicalCheckpoint(
        messageIndex: number | undefined,
        workspaceReferences?: CheckpointReferenceSet,
    ): Promise<void> {
        const checkpoint = this.services.canonicalCheckpoint
        const message = messageIndex === undefined ? undefined : this.services.messageStateHandler.clineMessages[messageIndex]
        if (!checkpoint || !message) return
        await checkpoint.capture({
            messageTs: message.ts,
            ...(workspaceReferences === undefined ? {} : { workspaceRef: encodeCheckpointWorkspaceRef(workspaceReferences) }),
        })
    }

    // ============================================================================
    // Public API - Core checkpoints operations
    // ============================================================================

    /**
     * Commit the post-state of a task completion and bind it to the completion row.
     *
     * Every other checkpoint is added by the gate before a request, before
     * compaction or before a named file edit; a call that is not for a
     * completion asks the gate for a round checkpoint, which is covered when
     * nothing moved. Never rejects.
     *
     * @param isAttemptCompletionMessage - Whether this checkpoint is for an attempt completion message
     * @param completionMessageTs - Optional timestamp of the completion message to update with checkpoint hash
     */
    async saveCheckpoint(isAttemptCompletionMessage = false, completionMessageTs?: number): Promise<void> {
        if (!this.config.enableCheckpoints || this.disposed) return
        if (!isAttemptCompletionMessage) {
            await this.gate.ensureRound("round_start")
            return
        }
        try {
            const clineMessages = this.services.messageStateHandler.clineMessages
            for (const message of clineMessages) {
                if (message.say === "checkpoint_created") message.isCheckpointCheckedOut = false
            }
            const completionMessageIndex = (): number | undefined => {
                const index =
                    completionMessageTs === undefined
                        ? findLastIndex(clineMessages, (message) => message.say === "completion_result")
                        : clineMessages.findIndex((message) => message.ts === completionMessageTs)
                return index === -1 ? undefined : index
            }

            // By its ts when known: the completion's dialog takes the row over
            // while this runs and clears its `say`.
            const lastCompletionResultMessage =
                completionMessageTs === undefined
                    ? findLast(clineMessages.slice(-3), (m) => m.say === "completion_result")
                    : clineMessages.find((m) => m.ts === completionMessageTs)
            const existingReferences = lastCompletionResultMessage && readCheckpointReferenceSet(lastCompletionResultMessage)
            if (existingReferences && hasFileCheckpoint(existingReferences)) {
                Logger.log("Completion checkpoint already exists, skipping duplicate checkpoint creation")
                await this.captureCanonicalCheckpoint(completionMessageIndex(), existingReferences)
                return
            }

            // Through the gate, so later rounds reuse these references instead of committing again.
            const checkpointReferences = await this.gate.commitFiles()
            const targetMessageIndex = completionMessageIndex()
            if (checkpointReferences && targetMessageIndex !== undefined) {
                await this.persistCheckpointHash(targetMessageIndex, checkpointReferences)
            } else if (!checkpointReferences) {
                Logger.debug(
                    `[TaskCheckpointManager] No file checkpoint hash for completion message in task ${this.task.taskId}; using chat checkpoint only`,
                )
            }
            await this.captureCanonicalCheckpoint(targetMessageIndex, checkpointReferences)
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error"
            Logger.error(`[TaskCheckpointManager] Failed to save checkpoint for task ${this.task.taskId}:`, errorMessage)
        }
    }

    /**
     * Surface repeated staging failures that happen after initialization.
     *
     * Initialization failures already reach the user, but a tracker that
     * initializes and then fails to stage produces no restore points at all
     * while the UI still looks healthy. Only sustained failure is reported so a
     * single transient error does not raise a false alarm.
     */
    private async reportStagingHealth(): Promise<void> {
        const tracker = this.state.checkpointTracker
        const coordinator = this.state.checkpointUnitCoordinator
        if (!tracker && !coordinator) {
            return
        }
        try {
            const failures = coordinator?.getConsecutiveStagingFailures() ?? tracker?.getConsecutiveStagingFailures() ?? 0
            if (failures >= CHECKPOINT_STAGING_FAILURE_ALERT_THRESHOLD) {
                await this.setcheckpointManagerErrorMessage(
                    `${STAGING_FAILURE_MESSAGE_PREFIX} the last ${failures} change sets. ` +
                        `Files inside nested repositories are not covered by checkpoints; ` +
                        `other paths may be unreadable or locked.`,
                )
                return
            }
            // A later success clears only the message this method raised.
            if (failures === 0 && this.state.checkpointManagerErrorMessage?.startsWith(STAGING_FAILURE_MESSAGE_PREFIX)) {
                await this.setcheckpointManagerErrorMessage(undefined)
            }
        } catch (error) {
            // Health reporting is diagnostic only. It must never prevent a
            // successful checkpoint hash from being bound to its message.
            Logger.debug(`[TaskCheckpointManager] Skipped staging health report for task ${this.task.taskId}:`, error)
        }
    }

    /**
     * Restores a checkpoint by message timestamp
     * @param messageTs - Timestamp of the message to restore to
     * @param restoreType - Type of restoration (task, workspace, or both)
     * @param offset - Optional offset for the message index
     * @returns checkpointManagerStateUpdate with any state changes that need to be applied
     */
    async restoreCheckpoint(
        messageTs: number,
        restoreType: ClineCheckpointRestore,
        offset?: number,
        editedText?: string,
    ): Promise<CheckpointRestoreStateUpdate> {
        try {
            // Restore rewinds durable conversation state only. Presentation overlays that
            // never reached a durable commit belong to the superseded continuation, so they
            // are dropped before the boundary is resolved. Keeping them made the loaded
            // length disagree with the durable count, which rejected the restore outright
            // and left in-flight compaction cards rendered after the rewind.
            if (restoreType !== "workspace" && !this.services.canonicalCheckpoint) {
                this.services.messageStateHandler.clearTransientClineMessages()
            }
            const clineMessages =
                restoreType === "workspace"
                    ? this.services.messageStateHandler.clineMessages
                    : this.services.messageStateHandler.durableClineMessages
            const messageIndex = clineMessages.findIndex((m) => m.ts === messageTs) - (offset || 0)
            // Find the last message before messageIndex that has a usable file reference set.
            const lastHashIndex = findLastIndex(clineMessages.slice(0, messageIndex), (m) =>
                hasFileCheckpoint(readCheckpointReferenceSet(m)),
            )
            const message = clineMessages[messageIndex]
            const lastMessageWithHash = lastHashIndex >= 0 ? clineMessages[lastHashIndex] : undefined

            if (!message) {
                Logger.error(`[TaskCheckpointManager] Message not found for timestamp ${messageTs} in task ${this.task.taskId}`)
                return {}
            }
            // The row whose chat state the restore returns to; see chatRestoreRow.
            const chat =
                restoreType === "workspace" ? { message, index: messageIndex } : chatRestoreRow(clineMessages, messageIndex)

            const chatRestoreBoundary =
                restoreType === "workspace"
                    ? undefined
                    : resolveChatRestoreBoundary({
                          messages: clineMessages,
                          messageIndex: chat.index,
                          // Rows record their index against the journal conversation, so the
                          // boundary is measured against the same sequence.
                          apiCount: await this.conversationLength(),
                          uiCount: this.services.messageStateHandler.uiMessage?.count ?? clineMessages.length,
                      })
            // A chat restore the task cannot complete is refused before the workspace
            // is touched; otherwise the files would rewind while the chat stays put.
            if (chatRestoreBoundary) this.assertChatRestoreAdmissible(chat.message, chatRestoreBoundary, editedText)
            // A multi-diff can retain editor models for files the restore will delete.
            // Close only Dline-owned compare tabs before mutating the workspace so VS Code
            // cannot persist a stale model back over the restored filesystem state.
            if (restoreType !== "task") await HostProvider.diff.closeAllDiffs({})
            if (chatRestoreBoundary && this.services.canonicalCheckpoint) {
                // Awaited here so a refused or failed restore lands in the catch below
                // instead of escaping to the caller with nothing restored.
                return await this.restoreCanonicalCheckpoint({
                    message,
                    chat,
                    restoreType: restoreType as "task" | "taskAndWorkspace",
                    editedText,
                    boundary: chatRestoreBoundary,
                })
            }
            const workspaceRestoreResult =
                restoreType === "task"
                    ? undefined
                    : await this.restoreWorkspaceCheckpoint(message, lastMessageWithHash, messageTs, offset)
            const workspaceRestoreError = workspaceRestoreResult?.status === "failed" ? workspaceRestoreResult.error : undefined
            const workspaceRestoreWarning =
                workspaceRestoreResult?.status === "partial" ? workspaceRestoreResult.warning : undefined

            const checkpointManagerStateUpdate: CheckpointRestoreStateUpdate = {}

            const successfulRestoreType: ClineCheckpointRestore | undefined =
                restoreType === "taskAndWorkspace"
                    ? workspaceRestoreError
                        ? "task"
                        : "taskAndWorkspace"
                    : restoreType === "workspace" && workspaceRestoreError
                      ? undefined
                      : restoreType

            if (successfulRestoreType) {
                if (successfulRestoreType !== "workspace") {
                    await this.restoreChatCheckpoint(
                        chat.message,
                        chat.index,
                        chat.message.ts,
                        editedText,
                        successfulRestoreType === "taskAndWorkspace",
                        chatRestoreBoundary as ChatRestoreBoundary,
                    )
                }
                await this.finalizeSuccessfulRestore(
                    successfulRestoreType,
                    messageTs,
                    editedText,
                    workspaceRestoreResult && workspaceRestoreResult.status !== "failed"
                        ? workspaceRestoreResult.checkpointReferences
                        : undefined,
                    chatRestoreBoundary,
                    workspaceRestoreWarning,
                )
                if (this.state.conversationHistoryDeletedRange !== undefined) {
                    checkpointManagerStateUpdate.conversationHistoryDeletedRange = this.state.conversationHistoryDeletedRange
                }
            } else {
                sendRelinquishControlEvent(this.task.controller)
            }

            if (workspaceRestoreError) {
                checkpointManagerStateUpdate.checkpointManagerErrorMessage = workspaceRestoreError
            } else if (this.state.checkpointManagerErrorMessage !== undefined) {
                checkpointManagerStateUpdate.checkpointManagerErrorMessage = this.state.checkpointManagerErrorMessage
            }

            return checkpointManagerStateUpdate
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error"
            Logger.error(`[TaskCheckpointManager] Failed to restore checkpoint for task ${this.task.taskId}:`, errorMessage)
            sendRelinquishControlEvent(this.task.controller)
            return {
                checkpointManagerErrorMessage: errorMessage,
            }
        }
    }

    private async restoreCanonicalCheckpoint(input: {
        /** The row the user restored; its bundle holds the files and the chat state to return to. */
        readonly message: UiMessage
        /** The row whose chat state that is; see chatRestoreRow. */
        readonly chat: ChatRestoreRow
        readonly restoreType: "task" | "taskAndWorkspace"
        readonly editedText?: string
        readonly boundary: ChatRestoreBoundary
    }): Promise<CheckpointRestoreStateUpdate> {
        const canonical = this.services.canonicalCheckpoint
        if (!canonical) throw new Error("Canonical checkpoint port is unavailable")
        let workspaceRestoreResult: WorkspaceRestoreResult | undefined
        const fallback = canonicalRestoreFallback(input.message)
        const restored = await canonical.restore({
            messageTs: input.message.ts,
            mode: input.restoreType === "task" ? "chat_only" : "combined",
            ...(input.boundary.journalTarget === undefined ? {} : { journalTarget: input.boundary.journalTarget }),
            ...(fallback === undefined ? {} : { fallback }),
            restoreWorkspace: async (workspaceRef) => {
                const references = decodeCheckpointWorkspaceRef(workspaceRef)
                workspaceRestoreResult = references
                    ? await this.restoreWorkspaceReference(references)
                    : { status: "failed", error: "Failed to restore checkpoint: No valid checkpoint hash found" }
                // A partial restore moved at least one root; its warning reaches the user after the chat restore.
                return workspaceRestoreResult.status !== "failed"
                    ? { ok: true }
                    : {
                          ok: false,
                          diagnostic: { code: "workspace_restore_failed", message: workspaceRestoreResult.error },
                      }
            },
        })
        if (restored.kind === "rejected") {
            const message =
                restored.diagnostics.map((diagnostic) => diagnostic.message).join("; ") || "Checkpoint restore rejected"
            sendRelinquishControlEvent(this.task.controller)
            return { checkpointManagerErrorMessage: message }
        }

        this.services.messageStateHandler.clearTransientClineMessages()
        const workspaceRestoreError = workspaceRestoreResult?.status === "failed" ? workspaceRestoreResult.error : undefined
        const successfulRestoreType: ClineCheckpointRestore =
            input.restoreType === "taskAndWorkspace" && workspaceRestoreError ? "task" : input.restoreType
        await this.restoreChatCheckpoint(
            input.chat.message,
            input.chat.index,
            input.chat.message.ts,
            input.editedText,
            successfulRestoreType === "taskAndWorkspace",
            input.boundary,
            true,
        )
        await this.finalizeSuccessfulRestore(
            successfulRestoreType,
            input.message.ts,
            input.editedText,
            workspaceRestoreResult && workspaceRestoreResult.status !== "failed"
                ? workspaceRestoreResult.checkpointReferences
                : undefined,
            input.boundary,
            workspaceRestoreResult?.status === "partial" ? workspaceRestoreResult.warning : undefined,
        )
        const update: CheckpointRestoreStateUpdate = {}
        if (this.state.conversationHistoryDeletedRange !== undefined) {
            update.conversationHistoryDeletedRange = this.state.conversationHistoryDeletedRange
        }
        if (workspaceRestoreError) update.checkpointManagerErrorMessage = workspaceRestoreError
        else if (this.state.checkpointManagerErrorMessage !== undefined) {
            update.checkpointManagerErrorMessage = this.state.checkpointManagerErrorMessage
        }
        return update
    }

    /**
     * Presents a multi-file diff view between checkpoints
     * @param messageTs - Timestamp of the message to show diff for
     * @param seeNewChangesSinceLastTaskCompletion - Whether to show changes since last completion
     */
    async presentMultifileDiff(messageTs: number, seeNewChangesSinceLastTaskCompletion: boolean): Promise<void> {
        const relinquishButton = () => {
            sendRelinquishControlEvent(this.task.controller)
        }

        try {
            if (!this.config.enableCheckpoints) {
                const errorMessage = "Checkpoints are disabled in settings. Cannot show diff."
                Logger.error(`[TaskCheckpointManager] ${errorMessage} for task ${this.task.taskId}`)
                HostProvider.window.showMessage({
                    type: ShowMessageType.INFORMATION,
                    message: errorMessage,
                })
                relinquishButton()
                return
            }

            Logger.log(`[TaskCheckpointManager] presentMultifileDiff for task ${this.task.taskId}, messageTs: ${messageTs}`)
            const clineMessages = this.services.messageStateHandler.clineMessages
            const messageIndex = clineMessages.findIndex((m) => m.ts === messageTs)
            const message = clineMessages[messageIndex]
            if (!message) {
                Logger.error(`[TaskCheckpointManager] Message not found for timestamp ${messageTs} in task ${this.task.taskId}`)
                relinquishButton()
                return
            }
            const checkpointReferences = readCheckpointReferenceSet(message)
            if (!checkpointReferences || !hasFileCheckpoint(checkpointReferences)) {
                Logger.error(
                    `[TaskCheckpointManager] No checkpoint hash found for message ${messageTs} in task ${this.task.taskId}`,
                )
                relinquishButton()
                return
            }

            if (!this.state.checkpointTracker && this.config.enableCheckpoints) {
                this.state.checkpointTracker = await this.checkpointTrackerCheckAndInit()
            }
            if (!this.state.checkpointTracker) {
                Logger.error(`[TaskCheckpointManager] Checkpoint tracker not available for task ${this.task.taskId}`)
                HostProvider.window.showMessage({ type: ShowMessageType.ERROR, message: "Checkpoint tracker not available" })
                relinquishButton()
                return
            }

            const previousReferences = seeNewChangesSinceLastTaskCompletion
                ? resolveCompletionDiffBaseReferences(this.services.messageStateHandler.clineMessages, messageIndex)
                : undefined
            if (seeNewChangesSinceLastTaskCompletion && !previousReferences) {
                const errorMessage = "Unexpected error: No checkpoint hash found"
                Logger.error(`[TaskCheckpointManager] ${errorMessage} for task ${this.task.taskId}`)
                HostProvider.window.showMessage({ type: ShowMessageType.ERROR, message: errorMessage })
                relinquishButton()
                return
            }

            const coordinator = this.state.checkpointUnitCoordinator
            const targetHash = coordinator ? undefined : await this.getCurrentWorkspaceHash(checkpointReferences)
            const previousHash =
                coordinator || !previousReferences ? undefined : await this.getCurrentWorkspaceHash(previousReferences)
            let changedFiles: CheckpointChangedFile[]
            if (!seeNewChangesSinceLastTaskCompletion) {
                changedFiles = await this.currentWorkspaceDelta(checkpointReferences)
            } else if (coordinator) {
                const outcome = await coordinator.getDiffSet(checkpointReferences, previousReferences, true)
                changedFiles = outcome.changedFiles
                this.showPartialCheckpointWarning("Checkpoint diff is partial", outcome.failures)
            } else {
                changedFiles = await this.state.checkpointTracker.getTaskDiffSet(previousHash!, targetHash!)
            }
            if (!changedFiles.length) {
                HostProvider.window.showMessage({ type: ShowMessageType.INFORMATION, message: "No changes found" })
                relinquishButton()
                return
            }

            // Open multi-diff editor
            const title = seeNewChangesSinceLastTaskCompletion ? "New changes" : "Changes since snapshot"
            const diffs = changedFiles.map((file) => ({
                filePath: file.absolutePath,
                leftContent: file.before,
                rightContent: file.after,
            }))
            await HostProvider.diff.openMultiFileDiff({ title, diffs })

            relinquishButton()
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error"
            Logger.error(`[TaskCheckpointManager] Failed to present multifile diff for task ${this.task.taskId}:`, errorMessage)
            HostProvider.window.showMessage({
                type: ShowMessageType.ERROR,
                message: `Failed to retrieve diff set: ${errorMessage}`,
            })
            relinquishButton()
        }
    }

    /** Return Task-owned changes for one checkpoint through the same root coordinator used by Compare. */
    async getTaskChangesForCheckpoint(messageTs: number): Promise<CheckpointChangedFile[]> {
        if (!this.config.enableCheckpoints) {
            throw new Error("Checkpoints are disabled in settings. Cannot review changes.")
        }
        const clineMessages = this.services.messageStateHandler.clineMessages
        const messageIndex = clineMessages.findIndex((message) => message.ts === messageTs)
        const message = clineMessages[messageIndex]
        if (!message) {
            throw new Error(`Checkpoint message ${messageTs} was not found`)
        }
        const checkpointReferences = readCheckpointReferenceSet(message)
        if (!checkpointReferences || !hasFileCheckpoint(checkpointReferences)) {
            throw new Error(`No file checkpoint is available for message ${messageTs}`)
        }
        const previousReferences = resolveCompletionDiffBaseReferences(clineMessages, messageIndex)
        if (!previousReferences || !hasFileCheckpoint(previousReferences)) {
            throw new Error("No earlier file checkpoint is available for comparison")
        }
        if (!this.state.checkpointTracker) {
            this.state.checkpointTracker = await this.checkpointTrackerCheckAndInit()
        }
        if (!this.state.checkpointTracker) {
            throw new Error("Checkpoint tracker is not available")
        }
        const coordinator = this.state.checkpointUnitCoordinator
        if (coordinator) {
            const outcome = await coordinator.getDiffSet(checkpointReferences, previousReferences, true)
            this.showPartialCheckpointWarning("Change review is partial", outcome.failures)
            return outcome.changedFiles
        }
        const previousHash = await this.getCurrentWorkspaceHash(previousReferences)
        const checkpointHash = await this.getCurrentWorkspaceHash(checkpointReferences)
        if (!previousHash || !checkpointHash) {
            throw new Error("No valid checkpoint hash is available for comparison")
        }
        return await this.state.checkpointTracker.getTaskDiffSet(previousHash, checkpointHash)
    }

    /** Creates one ordered reference set across every available workspace root. */
    async commit(): Promise<CheckpointReferenceSet | undefined> {
        try {
            return await this.commitWorkspace()
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error"
            Logger.error(`[TaskCheckpointManager] Failed to create checkpoint commit for task ${this.task.taskId}:`, errorMessage)
            return undefined
        }
    }

    /**
     * Commit the workspace for a checkpoint.
     *
     * Resolves undefined when this task keeps no file checkpoints (disabled, or
     * no shadow repository could be set up); rejects when the commit failed, so
     * the caller never mistakes an older restore point for the current files.
     */
    private async commitWorkspace(): Promise<CheckpointReferenceSet | undefined> {
        if (!this.config.enableCheckpoints) return undefined
        if (!this.state.checkpointTracker && !this.state.initializationFailure) {
            await this.checkpointTrackerCheckAndInit()
        }

        const coordinator = this.state.checkpointUnitCoordinator
        if (coordinator) {
            const references = await coordinator.commit()
            await this.reportStagingHealth()
            if (!references) throw new Error("No workspace root produced a checkpoint")
            return references
        }

        const tracker = this.state.checkpointTracker
        if (!tracker) {
            Logger.debug(`[TaskCheckpointManager] File checkpoints unavailable for task ${this.task.taskId}`)
            return undefined
        }

        const files = this.services.taskFileTracker
        // Only a scan this task's own command asked for finds files the task wrote.
        const attributeScan = files?.isScanAttributedToTask() ?? false
        const previousHash = attributeScan ? await this.getLatestCheckpointHashForCurrentWorkspace() : undefined
        let commitHash: string | undefined
        try {
            commitHash = await tracker.commit()
        } finally {
            await this.reportStagingHealth()
        }
        if (!commitHash) throw new Error("Checkpoint staging produced no restore point")
        if (attributeScan && previousHash && previousHash !== commitHash) {
            const changedPaths = (await tracker.getDiffSet(previousHash, commitHash)).map((file) => file.absolutePath)
            for (const file of changedPaths) files?.trackModification(file)
            files?.dropModifiedFiles(changedPaths)
        }
        return createCheckpointReferenceSet([commitHash], [await this.getWorkspacePath()])
    }

    /**
     * Checks if the latest task completion has new changes
     * @param completionMessageTs - The completion's row; its dialog may already have rewritten it as an ask
     * @returns Promise<boolean> - True if there are new changes since last completion
     */
    async doesLatestTaskCompletionHaveNewChanges(completionMessageTs?: number): Promise<boolean> {
        try {
            if (!this.config.enableCheckpoints) {
                return false
            }

            const clineMessages = this.services.messageStateHandler.clineMessages
            const messageIndex =
                completionMessageTs === undefined
                    ? findLastIndex(clineMessages, (m) => m.say === "completion_result")
                    : clineMessages.findIndex((m) => m.ts === completionMessageTs)
            const message = clineMessages[messageIndex]
            if (!message) {
                Logger.error(`[TaskCheckpointManager] Completion message not found for task ${this.task.taskId}`)
                return false
            }
            const checkpointReferences = readCheckpointReferenceSet(message)
            if (!checkpointReferences || !hasFileCheckpoint(checkpointReferences)) {
                Logger.debug(
                    `[TaskCheckpointManager] No file checkpoint hash found for completion message in task ${this.task.taskId}; treating as chat-only checkpoint`,
                )
                return false
            }

            if (this.config.enableCheckpoints && !this.state.checkpointTracker) {
                this.state.checkpointTracker = await this.checkpointTrackerCheckAndInit()
            }

            if (!this.state.checkpointTracker) {
                Logger.error(`[TaskCheckpointManager] Checkpoint tracker not available for task ${this.task.taskId}`)
                return false
            }

            const previousCheckpointReferences = resolveCompletionDiffBaseReferences(clineMessages, messageIndex)

            if (!previousCheckpointReferences) {
                // A task closed before its baseline commit landed has no file
                // checkpoint to diff against. That is a chat-only history, the same
                // case the completion message handles above, not a failure.
                Logger.debug(
                    `[TaskCheckpointManager] No file checkpoint baseline for task ${this.task.taskId}; treating as chat-only history`,
                )
                return false
            }

            const coordinator = this.state.checkpointUnitCoordinator
            if (coordinator) {
                const outcome = await coordinator.getTaskDiffCount(previousCheckpointReferences, checkpointReferences)
                if (outcome.failures.length > 0) {
                    Logger.warn(
                        `[TaskCheckpointManager] Completion diff is partial for task ${this.task.taskId}: ${this.formatCheckpointFailures(outcome.failures)}`,
                    )
                }
                return outcome.count > 0
            }
            const previousHash = await this.getCurrentWorkspaceHash(previousCheckpointReferences)
            const checkpointHash = await this.getCurrentWorkspaceHash(checkpointReferences)
            if (!previousHash || !checkpointHash) {
                return false
            }
            const changedFilesCount = await this.state.checkpointTracker.getTaskDiffCount(previousHash, checkpointHash)
            return changedFilesCount > 0
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error"
            Logger.error(`[TaskCheckpointManager] Failed to check for new changes in task ${this.task.taskId}:`, errorMessage)
            return false
        }
    }

    private async restoreWorkspaceCheckpoint(
        message: UiMessage,
        lastMessageWithHash: UiMessage | undefined,
        messageTs: number,
        offset?: number,
    ): Promise<WorkspaceRestoreResult> {
        const messageReferences = readCheckpointReferenceSet(message)
        const checkpointReferences = messageReferences ?? (lastMessageWithHash && readCheckpointReferenceSet(lastMessageWithHash))
        if (!checkpointReferences) {
            const errorMessage = "Failed to restore checkpoint: No valid checkpoint hash found"
            Logger.error(`[TaskCheckpointManager] ${errorMessage} for task ${this.task.taskId}`)
            HostProvider.window.showMessage({ type: ShowMessageType.ERROR, message: errorMessage })
            return { status: "failed", error: errorMessage }
        }

        const usesFallback = messageReferences === undefined
        if (usesFallback && !offset) {
            Logger.warn(
                `[TaskCheckpointManager] Message ${messageTs} has no checkpoint hash, falling back to previous checkpoint for task ${this.task.taskId}`,
            )
        }
        const diagnosticPrefix = usesFallback && offset ? "Failed to restore offset checkpoint" : "Failed to restore checkpoint"
        return this.restoreWorkspaceReference(checkpointReferences, diagnosticPrefix)
    }

    private async restoreWorkspaceReference(
        checkpointReferences: CheckpointReferenceSet,
        diagnosticPrefix = "Failed to restore checkpoint",
    ): Promise<WorkspaceRestoreResult> {
        if (!this.config.enableCheckpoints) {
            const errorMessage = "Checkpoints are disabled in settings."
            Logger.error(`[TaskCheckpointManager] ${errorMessage} for task ${this.task.taskId}`)
            HostProvider.window.showMessage({ type: ShowMessageType.ERROR, message: errorMessage })
            return { status: "failed", error: errorMessage }
        }
        if (!this.state.checkpointTracker) this.state.checkpointTracker = await this.checkpointTrackerCheckAndInit()
        if (!this.state.checkpointTracker) {
            const errorMessage = "Failed to restore checkpoint: No valid checkpoint hash found"
            Logger.error(`[TaskCheckpointManager] ${errorMessage} for task ${this.task.taskId}`)
            HostProvider.window.showMessage({ type: ShowMessageType.ERROR, message: errorMessage })
            return { status: "failed", error: errorMessage }
        }

        try {
            const taskFiles = this.services.taskFileTracker?.getAllModifiedFiles() ?? []
            const changedFiles = await this.currentWorkspaceDelta(checkpointReferences)
            const effectiveFiles =
                taskFiles.length === 0 ? changedFiles : changedFiles.filter((file) => taskFiles.includes(file.absolutePath))
            if (effectiveFiles.length === 0) {
                return { status: "failed", error: "No workspace changes to restore" }
            }
            const coordinator = this.state.checkpointUnitCoordinator
            if (coordinator) {
                const outcome = await coordinator.restore(checkpointReferences, taskFiles)
                if (outcome.restoredWorkspacePaths.length === 0) {
                    const errorMessage = outcome.failures[0]?.reason ?? "No matching workspace checkpoint could be restored"
                    return { status: "failed", error: `Failed to restore checkpoint: ${errorMessage}` }
                }
                if (outcome.failures.length > 0) {
                    return {
                        status: "partial",
                        checkpointReferences: outcome.restoredReferences,
                        warning: `Some workspaces could not be restored:\n${this.formatCheckpointFailures(outcome.failures)}`,
                    }
                }
                return { status: "restored", checkpointReferences: outcome.restoredReferences }
            }

            const checkpointHash = await this.getCurrentWorkspaceHash(checkpointReferences)
            if (!checkpointHash) {
                return { status: "failed", error: "Failed to restore checkpoint: No valid checkpoint hash found" }
            }
            if (taskFiles.length > 0) {
                Logger.debug(
                    `[TaskCheckpointManager] Restoring ${taskFiles.length} task-owned file(s) for task ${this.task.taskId}`,
                )
                await this.state.checkpointTracker.restoreFiles(checkpointHash, taskFiles)
            } else {
                await this.state.checkpointTracker.resetHead(checkpointHash)
            }
            return { status: "restored", checkpointReferences }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error"
            Logger.error(`[TaskCheckpointManager] ${diagnosticPrefix} for task ${this.task.taskId}:`, errorMessage)
            const restoreError = `${diagnosticPrefix}: ${errorMessage}`
            HostProvider.window.showMessage({ type: ShowMessageType.ERROR, message: restoreError })
            return { status: "failed", error: restoreError }
        }
    }

    /**
     * Synchronously abort all active operations and reset runtime state.
     *
     * Called at the start of every restore so that stale asks (e.g.
     * qna_respond waiting in idle state) are terminated before we mutate
     * the conversation.  Uses askResponse="no" to wake pWaitFor without
     * producing an error say, and abort=true for streaming / tool-exec
     * safety.  This is independent of Controller.cancelTask — restore
     * owns its own cleanup lifecycle.
     */
    private abortAndClearState(): void {
        this.taskState.userMessageContent = []
        this.taskState.assistantMessageContent = []
        this.taskState.userMessageContentReady = false
        this.taskState.resetMistakeLimitState()
        this.taskState.lastMessageTs = undefined
        this.taskState.askResponseText = undefined
        this.taskState.askResponseImages = undefined
        this.taskState.askResponseFiles = undefined
        this.taskState.isAwaitingPlanResponse = false
        this.taskState.didRespondToPlanAskBySwitchingMode = false
    }

    /**
     * Refuses a chat restore this manager cannot carry out, before anything is
     * written. Both checks depend only on the boundary and the injected ports,
     * so they give the same answer before the workspace rewind and at the chat
     * commit point.
     */
    private assertChatRestoreAdmissible(message: UiMessage, boundary: ChatRestoreBoundary, editedText: string | undefined): void {
        if ((message.compactionConversationRange || boundary.journalTarget) && editedText !== undefined) {
            throw new Error("Editing input is unavailable when restoring a compaction card")
        }
        if (boundary.journalTarget) this.requireConversationRewind()
    }

    private requireConversationRewind(): ConversationRewindPort {
        const rewind = this.services.conversationRewind
        if (!rewind) throw new Error("Compaction Restore requires the task conversation journal")
        return rewind
    }

    /** The conversation length rows are measured against, including entries journaled since the last read. */
    private async conversationLength(): Promise<number> {
        const handler = this.services.messageStateHandler
        return (await handler.currentConversationSize?.()) ?? handler.apiConversation?.count ?? 0
    }

    /**
     * Return the journal conversation to the restored row. This is the restore's
     * commit point, so it runs before any chat, API or context file is
     * truncated: a refused rewind leaves the task exactly as it was, and a
     * restore retried after a crash replays the same record.
     *
     * @returns whether the journal holds the conversation; when it does, the
     * legacy API rows are not its record and are left alone.
     */
    private async rewindConversation(
        message: UiMessage,
        messageTs: number,
        editedText: string | undefined,
        boundary: ChatRestoreBoundary,
    ): Promise<boolean> {
        const operationId = `checkpoint.restore:${messageTs}`
        if (boundary.journalTarget) {
            await this.requireConversationRewind().rewindTo({ operationId, target: boundary.journalTarget })
            return true
        }
        const rewind = this.services.conversationRewind
        if (!rewind?.holdsConversation()) return false
        await rewind.rewindToRow({
            operationId,
            row: {
                keep: (message.conversationHistoryIndex ?? -1) + 1,
                ...(message.conversationJournalSeq === undefined ? {} : { seq: message.conversationJournalSeq }),
                // An edit submits its text again as new input, so the input it replaces goes.
                keepInput: editedText === undefined && showsUserInput(message),
            },
        })
        return true
    }

    /** Truncate the legacy API rows of a task whose conversation predates the journal. */
    private async truncateLegacyConversation(boundary: ChatRestoreBoundary, editedText: string | undefined): Promise<void> {
        const apiConversation = this.services.messageStateHandler.apiConversation
        const userMsgIdx = boundary.apiKeepCount - 1
        await apiConversation?.truncateByLineNum(boundary.apiKeepCount)

        // Modify the user message text in-place when editing input,
        // preserving tool_result blocks so the preceding assistant's
        // tool_use stays paired.
        if (editedText === undefined || userMsgIdx < 0 || !apiConversation || userMsgIdx >= apiConversation.count) return
        const userMsg = apiConversation.getAt(userMsgIdx)
        if (!userMsg || userMsg.role !== "user" || !Array.isArray(userMsg.content)) return
        const replaceInBlocks = (blocks: ClineContent[]): void => {
            for (const block of blocks) {
                if (block.type === "text") {
                    block.text = block.text.replace(
                        /<user_message>\n[\s\S]*?\n<\/user_message>/,
                        `<user_message>\n${editedText}\n</user_message>`,
                    )
                }
                if (block.type === "tool_result" && Array.isArray(block.content)) {
                    replaceInBlocks(block.content)
                }
            }
        }
        replaceInBlocks(userMsg.content)
    }

    private async restoreChatCheckpoint(
        message: UiMessage,
        messageIndex: number,
        messageTs: number,
        editedText: string | undefined,
        workspaceRestored: boolean,
        boundary: ChatRestoreBoundary,
        conversationAlreadyRewound = false,
    ): Promise<void> {
        this.assertChatRestoreAdmissible(message, boundary, editedText)
        const journalRewound =
            conversationAlreadyRewound || (await this.rewindConversation(message, messageTs, editedText, boundary))
        // The boundary indexes the durable sequence, so the deleted slice must read it too.
        const deletedMessages = this.services.messageStateHandler.durableClineMessages.slice(boundary.uiKeepCount)
        this.abortAndClearState()
        this.state.conversationHistoryDeletedRange = boundary.conversationHistoryDeletedRange
        this.taskState.conversationHistoryDeletedRange = boundary.conversationHistoryDeletedRange

        if (!journalRewound) await this.truncateLegacyConversation(boundary, editedText)

        await this.services.messageStateHandler.uiMessage?.truncateByLineNum(boundary.uiKeepCount)
        // Truncating writes the durable store directly, so aggregates computed
        // from the discarded messages have to be dropped with them. Called
        // optionally: this collaborator is supplied by the task runtime, and a
        // restore must not fail because a caller provided a narrower one.
        this.services.messageStateHandler.invalidateDerivedAggregates?.()

        await this.services.contextManager.truncateContextHistory(
            boundary.contextAnchorTs,
            await ensureTaskDirectoryExists(this.task.taskId),
        )
        const deletedApiReqsMetrics = getApiMetrics(combineApiRequests(combineCommandSequences(deletedMessages)))

        if (!workspaceRestored) {
            const filesEditedAfterMessage = await this.services.fileContextTracker.detectFilesEditedAfterMessage(
                messageTs,
                deletedMessages,
            )
            if (filesEditedAfterMessage.length > 0) {
                await this.services.fileContextTracker.storePendingFileContextWarning(filesEditedAfterMessage)
            }
        }

        await this.callbacks.say(
            "deleted_api_reqs",
            JSON.stringify({
                tokensIn: deletedApiReqsMetrics.totalTokensIn,
                tokensOut: deletedApiReqsMetrics.totalTokensOut,
                cacheWrites: deletedApiReqsMetrics.totalCacheWrites,
                cacheReads: deletedApiReqsMetrics.totalCacheReads,
                cost: deletedApiReqsMetrics.totalCost,
            } satisfies UiApiReqInfo),
        )

        if (editedText !== undefined) {
            await this.callbacks.say("user_feedback", editedText)
        }
    }

    private async finalizeSuccessfulRestore(
        restoreType: ClineCheckpointRestore,
        messageTs: number,
        editedText: string | undefined,
        workspaceCheckpointReferences: CheckpointReferenceSet | undefined,
        chatRestoreBoundary: ChatRestoreBoundary | undefined,
        workspaceRestoreWarning?: string,
    ): Promise<void> {
        if (workspaceRestoreWarning) {
            HostProvider.window.showMessage({
                type: ShowMessageType.WARNING,
                message:
                    restoreType === "taskAndWorkspace"
                        ? `Task messages were restored, but workspace files were restored partially. ${workspaceRestoreWarning}`
                        : `Workspace files were restored partially. ${workspaceRestoreWarning}`,
            })
        } else
            switch (restoreType) {
                case "task":
                    HostProvider.window.showMessage({
                        type: ShowMessageType.INFORMATION,
                        message: "Task messages have been restored to the checkpoint",
                    })
                    break
                case "workspace":
                    HostProvider.window.showMessage({
                        type: ShowMessageType.INFORMATION,
                        message: "Workspace files have been restored to the checkpoint",
                    })
                    break
                case "taskAndWorkspace":
                    HostProvider.window.showMessage({
                        type: ShowMessageType.INFORMATION,
                        message: "Task and workspace have been restored to the checkpoint",
                    })
                    break
            }

        if (workspaceCheckpointReferences !== undefined) {
            const checkpointMessages = this.services.messageStateHandler.clineMessages.filter(
                (m) => m.say === "checkpoint_created",
            )
            checkpointMessages.forEach((checkpointMessage) => {
                checkpointMessage.isCheckpointCheckedOut =
                    workspaceRestoreWarning === undefined &&
                    checkpointReferenceSetsEqual(readCheckpointReferenceSet(checkpointMessage), workspaceCheckpointReferences)
            })
        }

        await this.services.messageStateHandler.updateTaskHistory()

        if (restoreType !== "workspace") {
            if (!chatRestoreBoundary) throw new Error("Chat Restore completed without a validated boundary")
            await this.callbacks.restoreChatRuntime({
                apiIndex: chatRestoreBoundary.runtimeApiIndex,
                ...(editedText === undefined ? {} : { editedText }),
            })
        }

        await this.callbacks.postStateToWebview()
    }

    // ============================================================================
    // State management - interfaces for updating internal state
    // ============================================================================

    /**
     * Checks for an active checkpoint tracker instance, creates if needed
     * Uses promise-based synchronization to prevent race conditions when called concurrently
     */
    async retryCheckpointInitialization(): Promise<boolean> {
        if (!this.config.enableCheckpoints) {
            await this.setcheckpointManagerErrorMessage("Checkpoints are disabled in settings.")
            return false
        }

        this.state.checkpointTracker = undefined
        this.services.messageStateHandler.setCheckpointTracker(undefined)
        const tracker = await this.checkpointTrackerCheckAndInit(true)
        return tracker !== undefined
    }

    private formatCheckpointFailures(failures: ReadonlyArray<{ workspacePath: string; reason: string }>): string {
        return failures.map((failure) => `${failure.workspacePath}: ${failure.reason}`).join("\n")
    }

    private showPartialCheckpointWarning(
        prefix: string,
        failures: ReadonlyArray<{ workspacePath: string; reason: string }>,
    ): void {
        if (failures.length === 0) {
            return
        }
        HostProvider.window.showMessage({
            type: ShowMessageType.WARNING,
            message: `${prefix}:\n${this.formatCheckpointFailures(failures)}`,
        })
    }

    async checkpointTrackerCheckAndInit(forceRetry = false): Promise<CheckpointTracker | undefined> {
        // If tracker already exists or there was an error, return immediately
        if (this.state.checkpointTracker) {
            return this.state.checkpointTracker
        }
        if (forceRetry) {
            this.state.initializationFailure = undefined
            await this.setcheckpointManagerErrorMessage(undefined)
        } else if (this.state.initializationFailure) {
            return undefined
        }

        // If initialization is already in progress, wait for it to complete.
        // A slow-start warning is only a message, so callers keep waiting here
        // instead of committing a row without file references.
        if (this.state.checkpointTrackerInitPromise) {
            return await this.state.checkpointTrackerInitPromise
        }

        // Start initialization and store the promise to prevent concurrent attempts
        this.state.checkpointTrackerInitPromise = this.initializeCheckpointTracker(forceRetry)

        try {
            const tracker = await this.state.checkpointTrackerInitPromise
            return tracker
        } finally {
            // Clear the promise once initialization is complete (success or failure)
            this.state.checkpointTrackerInitPromise = undefined
        }
    }

    /**
     * Internal method to actually create the checkpoint tracker
     */
    private async initializeCheckpointTracker(forceRetry = false): Promise<CheckpointTracker | undefined> {
        // Warning Timer - If checkpoints take a while to initialize, show a warning message
        let checkpointsWarningTimer: NodeJS.Timeout | null = null
        let checkpointsWarningShown = false

        try {
            checkpointsWarningTimer = setTimeout(async () => {
                if (!checkpointsWarningShown) {
                    checkpointsWarningShown = true
                    await this.setcheckpointManagerErrorMessage(
                        "Checkpoints are taking longer than expected to initialize. Working in a large repository? Consider re-opening Dline in a project that uses git, or disabling checkpoints.",
                    )
                }
            }, 15_000)

            const coordinator = this.getOrCreateCheckpointUnitCoordinator()
            if (coordinator) {
                await pTimeout(coordinator.initialize(forceRetry), {
                    milliseconds: CHECKPOINT_TRACKER_ATTEMPT_TIMEOUT_MS,
                    message:
                        "Checkpoints taking too long to initialize. Consider re-opening Dline in a project that uses git, or disabling checkpoints.",
                })
                if (!coordinator.hasReadyUnit) {
                    const details = coordinator.initializationFailures.map((failure) => failure.reason).join("; ")
                    throw new Error(details || "No workspace checkpoint tracker could be initialized")
                }
                const tracker = coordinator.primaryTracker
                this.state.checkpointTracker = tracker
                this.services.messageStateHandler.setCheckpointTracker(tracker)
                this.startWorkspaceWatcherIfReady()
                await this.setcheckpointManagerErrorMessage(undefined)
                return tracker
            }

            // Timeout - If checkpoints take too long to initialize, warn user and disable checkpoints for the task
            const workspacePath = await this.getWorkspacePath()
            const createTracker = this.config.createCheckpointTracker ?? CheckpointTracker.create

            // Single-flight across retry attempts: pTimeout only stops waiting, it
            // cannot cancel the underlying Git work. Starting a second tracker
            // after a timeout made both attempts fight for the same shadow-repo
            // mutex and repeat the whole topology/baseline scan. A timed-out
            // attempt therefore stays in flight and the retry waits on the same
            // promise; only a real rejection clears it so the retry can start
            // a fresh attempt.
            let inFlightCreate: Promise<CheckpointTracker | undefined> | undefined
            const startOrReuseCreate = (): Promise<CheckpointTracker | undefined> => {
                if (!inFlightCreate) {
                    const attempt = createTracker(this.task.taskId, this.config.enableCheckpoints, workspacePath)
                    inFlightCreate = attempt
                    attempt.catch(() => {
                        if (inFlightCreate === attempt) inFlightCreate = undefined
                    })
                }
                return inFlightCreate
            }

            const tracker = await retryWithBackoff(
                () =>
                    pTimeout(startOrReuseCreate(), {
                        milliseconds: CHECKPOINT_TRACKER_ATTEMPT_TIMEOUT_MS,
                        message:
                            "Checkpoints taking too long to initialize. Consider re-opening Dline in a project that uses git, or disabling checkpoints.",
                    }),
                {
                    operationName: "Checkpoint shadow initialization",
                    maxAttempts: 2,
                    baseDelayMs: 50,
                    shouldRetry: (error) => !this.isPermanentCheckpointCapabilityError(error),
                    onRetry: (error, attempt, maxAttempts, delayMs) => {
                        Logger.warn(
                            `Checkpoint shadow initialization failed on attempt ${attempt}/${maxAttempts}; retrying in ${delayMs}ms:`,
                            error,
                        )
                    },
                },
            )

            // Inject the per-task file tracker so that subsequent checkpoint
            // commits stage only files modified by tool handlers (incremental
            // git add), avoiding expensive full-workspace scans.
            if (tracker && this.services.taskFileTracker) {
                tracker.setTaskFileTracker(this.services.taskFileTracker)
            }

            // Update the state with the created tracker
            this.state.checkpointTracker = tracker
            this.services.messageStateHandler.setCheckpointTracker(tracker)
            this.startWorkspaceWatcherIfReady()
            await this.setcheckpointManagerErrorMessage(undefined)
            return tracker
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error"
            Logger.error("Failed to initialize checkpoint tracker:", errorMessage)

            // A failed attempt disables file checkpoints for the rest of this session
            // only; a reopened task tries again.
            this.state.initializationFailure = errorMessage
            if (errorMessage.includes("Checkpoints taking too long to initialize")) {
                await this.setcheckpointManagerErrorMessage(
                    "Checkpoints initialization timed out. Consider re-opening Dline in a project that uses git, or disabling checkpoints.",
                )
            } else {
                await this.setcheckpointManagerErrorMessage(errorMessage)
            }
            return undefined
        } finally {
            // Always clean up the timer to prevent memory leaks
            if (checkpointsWarningTimer) {
                clearTimeout(checkpointsWarningTimer)
                checkpointsWarningTimer = null
            }
        }
    }

    private isPermanentCheckpointCapabilityError(error: unknown): boolean {
        const message = error instanceof Error ? error.message : String(error)
        return (
            message.includes("Git must be installed to use checkpoints") ||
            message.includes("Cannot access workspace directory") ||
            message.includes("Cannot use checkpoints in") ||
            message.includes("No workspace detected") ||
            message.includes("Checkpoints are disabled in settings")
        )
    }

    /**
     * Updates the checkpoint tracker instance
     */
    setCheckpointTracker(checkpointTracker: CheckpointTracker | undefined): void {
        this.state.checkpointTracker = checkpointTracker
    }

    /**
     * Updates the checkpoint tracker error message and posts to webview
     */
    async setcheckpointManagerErrorMessage(errorMessage: string | undefined): Promise<void> {
        this.state.checkpointManagerErrorMessage = errorMessage
        this.taskState.checkpointManagerErrorMessage = errorMessage
        // Post state to webview so users can see the error message immediately
        try {
            await this.callbacks.postStateToWebview()
        } catch (error) {
            Logger.error("Failed to post state to webview after checkpoint error:", error)
        }
        // TODO - Future telemetry event capture here
    }

    /**
     * Updates the conversation history deleted range
     */
    updateConversationHistoryDeletedRange(range: [number, number] | undefined): void {
        this.state.conversationHistoryDeletedRange = range
        // TODO - Future telemetry event capture here
    }

    // ============================================================================
    // Internal utilities - Private helpers for checkpoint operations
    // ============================================================================

    /**
     * Gets the workspace path from WorkspaceRootManager when available, otherwise falls back to CheckpointUtils
     * @returns Promise<string> The workspace path to use for checkpoint operations
     */
    private async getCurrentWorkspaceHash(referenceSet: CheckpointReferenceSet): Promise<string | undefined> {
        if (referenceSet.workspaceRoots.length === 0) {
            const legacyHash = referenceSet.hashes[0]
            return legacyHash && legacyHash.length > 0 ? legacyHash : undefined
        }
        return getCheckpointHashForWorkspace(referenceSet, await this.getWorkspacePath(), 0)
    }

    private async getLatestCheckpointHashForCurrentWorkspace(): Promise<string | undefined> {
        const latestMessage = findLast(this.services.messageStateHandler.clineMessages, (message) =>
            hasFileCheckpoint(readCheckpointReferenceSet(message)),
        )
        const referenceSet = latestMessage && readCheckpointReferenceSet(latestMessage)
        return referenceSet ? await this.getCurrentWorkspaceHash(referenceSet) : undefined
    }

    private getOrCreateCheckpointUnitCoordinator(): CheckpointUnitCoordinator | undefined {
        if (this.state.checkpointUnitCoordinator) {
            return this.state.checkpointUnitCoordinator
        }
        const workspaceManager = this.services.workspaceManager
        if (!workspaceManager || typeof workspaceManager.getRoots !== "function") {
            return undefined
        }
        const roots = workspaceManager.getRoots()
        if (roots.length <= 1) {
            return undefined
        }
        const coordinator = new CheckpointUnitCoordinator({
            taskId: this.task.taskId,
            enableCheckpoints: this.config.enableCheckpoints,
            roots,
            primaryRootIndex: typeof workspaceManager.getPrimaryIndex === "function" ? workspaceManager.getPrimaryIndex() : 0,
            taskFileTracker: this.services.taskFileTracker,
            createCheckpointTracker: this.config.createCheckpointTracker,
        })
        this.state.checkpointUnitCoordinator = coordinator
        return coordinator
    }

    private async getWorkspacePath(): Promise<string> {
        // Try to use the centralized WorkspaceRootManager first
        if (this.services.workspaceManager) {
            try {
                const primaryRoot = this.services.workspaceManager.getPrimaryRoot()
                if (primaryRoot) {
                    return primaryRoot.path
                }
                Logger.warn(`[TaskCheckpointManager] WorkspaceRootManager returned no primary root for task ${this.task.taskId}`)
            } catch (error) {
                Logger.warn(
                    `[TaskCheckpointManager] Failed to get workspace path from WorkspaceRootManager for task ${this.task.taskId}:`,
                    error,
                )
            }
        }

        // Fallback to the legacy CheckpointUtils implementation
        const { getWorkingDirectory: getWorkingDirectoryImpl } = await import("./CheckpointUtils")
        return getWorkingDirectoryImpl()
    }

    /**
     * Provides read-only access to current state for internal operations
     */
    //private get currentState(): Readonly<CheckpointManagerInternalState> {
    //	return Object.freeze({ ...this.state })
    //}

    /**
     * Provides public read-only access to current state
     */
    public getCurrentState(): Readonly<CheckpointManagerInternalState> {
        return Object.freeze({ ...this.state })
    }

    /**
     * Provides read-only access to dependencies for internal operations
     */
    //private get deps(): Readonly<CheckpointManagerDependencies> {
    //	return this.dependencies
    //}
}

// ============================================================================
// Factory function for clean instantiation
// ============================================================================

/**
 * Creates a new TaskCheckpointManager instance
 */
export function createTaskCheckpointManager(
    task: CheckpointManagerTask,
    config: CheckpointManagerConfig,
    services: CheckpointManagerServices,
    callbacks: CheckpointManagerCallbacks,
    initialState: CheckpointManagerInternalState,
): TaskCheckpointManager {
    return new TaskCheckpointManager(task, config, services, callbacks, initialState)
}
