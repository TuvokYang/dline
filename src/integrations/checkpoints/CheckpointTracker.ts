import { sendCheckpointEvent } from "@core/controller/checkpoints/subscribeToCheckpoints"
import fs from "fs/promises"
import { isBinaryFile } from "isbinaryfile"
import * as path from "path"
import simpleGit, { type SimpleGit } from "simple-git"
import type { FolderLockWithRetryResult } from "@/core/locks/types"
import { telemetryService } from "@/services/telemetry"
import { recordPerfPhase } from "@/services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "@/services/telemetry/instrumentation/perf-domains"
import { runWithSignalSpan, type SignalSpanHandle, startSignalSpan } from "@/services/telemetry/service/pipeline-port"
import { Logger } from "@/shared/services/Logger"
import { GitOperations, resolveCheckpointWorktreePath, toLiteralGitPathspec } from "./CheckpointGitOperations"
import { releaseCheckpointLock, tryAcquireCheckpointLockWithRetry } from "./CheckpointLockUtils"
import { CheckpointMutexRegistry } from "./CheckpointMutexRegistry"
import { getShadowGitPath, hashWorkingDir } from "./CheckpointUtils"
import type { TaskFileTracker } from "./TaskFileTracker"

/**
 * Operation types for checkpoint events
 */
type CheckpointOperation = "CHECKPOINT_INIT" | "CHECKPOINT_COMMIT" | "CHECKPOINT_RESTORE"

/** Which primitive actually serialized a commit on the shared shadow repository. */
type CheckpointLockMechanism = "folder_lock" | "process_mutex"

/** How a checkpoint lock request resolved; bounded for use as a metric dimension. */
type CheckpointLockOutcome = "acquired" | "skipped" | "conflicted" | "failed"

/**
 * How the Git half of a commit ended.
 *
 * `none` means the Git work returned without a usable hash. It is not the
 * "nothing changed" case: that path reuses the current shadow HEAD and reports
 * `success`. It is reported apart from `success` because the caller treats a
 * missing restore point as a failed checkpoint, which is the symptom users
 * report.
 */
type CheckpointGitOutcome = "success" | "none" | "error"

/**
 * How one whole commit attempt ended, from the caller's point of view.
 *
 * This is deliberately not the same as the Git outcome. The Git work runs only
 * once exclusive access to the shared shadow repository has been granted, so an
 * attempt refused the lock never reports a Git outcome at all. Reporting the
 * attempt separately is what keeps those refusals countable.
 *
 * `no_restore_point` is not the benign "nothing changed" case: when there is
 * genuinely nothing to commit the current shadow HEAD is reused and returned,
 * which counts as `created`. It covers the normal returns that produced no
 * usable hash — staging failures, and a commit that reported none — so this
 * outcome means the attempt finished without leaving the caller anything to
 * restore from.
 */
type CheckpointAttemptOutcome = "created" | "no_restore_point" | "lock_unavailable" | "error"

/**
 * Carries back why an attempt failed, for paths that throw.
 *
 * The commit body wraps every failure into one generic error before it reaches
 * the caller, so the thrown value cannot be inspected to tell a refused lock
 * apart from failed Git work.
 */
interface CheckpointAttemptState {
	lockUnavailable: boolean
}

type CheckpointChangedFile = {
	relativePath: string
	absolutePath: string
	before: string
	after: string
}

/**
 * CheckpointTracker Module
 *
 * Core implementation of Cline's Checkpoints system that provides version control
 * capabilities without interfering with the user's main Git repository. Key features:
 *
 * Shadow Git Repository:
 * - Creates and manages an isolated Git repository for tracking checkpoints
 * - Handles nested Git repositories by temporarily disabling them
 * - Configures Git settings automatically (identity, LFS, etc.)
 *
 * File Management:
 * - Integrates with CheckpointExclusions for file filtering
 * - Handles workspace validation and path resolution
 * - Manages Git worktree configuration
 *
 * Checkpoint Operations:
 * - Creates checkpoints (commits) of the current state
 * - Provides diff capabilities between checkpoints
 * - Supports resetting to previous checkpoints
 *
 * Safety Features:
 * - Prevents usage in sensitive directories (home, desktop, etc.)
 * - Validates workspace configuration
 * - Handles cleanup and resource disposal
 *
 * Checkpoint Architecture:
 * - Unique shadow git repository for each workspace
 * - Workspaces are identified by name, and hashed to a unique number
 * - All commits for a workspace are stored in one shadow git, under a single branch
 */

class CheckpointTracker {
	private taskId: string
	private cwd: string
	private cwdHash: string
	private shadowGitPath: string
	private lastRetrievedShadowGitConfigWorkTree?: string
	private gitOperations: GitOperations
	/** Optional reference to the per-task file tracker for incremental checkpoint staging */
	private taskFileTracker?: TaskFileTracker
	/**
	 * Consecutive staging failures since the last usable checkpoint.
	 *
	 * Staging failures happen below the chat layer, so without this counter a
	 * task can lose every restore point while the UI still reports checkpoints
	 * as healthy.
	 */
	private consecutiveStagingFailures = 0

	/** Number of consecutive staging failures since the last usable checkpoint. */
	public getConsecutiveStagingFailures(): number {
		return this.consecutiveStagingFailures
	}

	/**
	 * Inject the TaskFileTracker for this task so that commit() can stage only
	 * the files that were actually modified by tool handlers, instead of
	 * scanning the entire workspace with git add .
	 *
	 * @param tracker - The TaskFileTracker instance created alongside this checkpoint tracker
	 */
	public setTaskFileTracker(tracker: TaskFileTracker): void {
		this.taskFileTracker = tracker
		Logger.debug(
			`[CheckpointTracker] TaskFileTracker set for task ${this.taskId} ` +
				`(${tracker.getModifiedFiles().length} file(s) already tracked)`,
		)
	}

	/**
	 * Helper method to clean commit hashes that might have a "HEAD " prefix.
	 * Used for backward compatibility with old tasks that stored hashes with the prefix.
	 */
	private cleanCommitHash(hash: string): string {
		return hash.startsWith("HEAD ") ? hash.slice(5) : hash
	}

	/**
	 * Send a checkpoint event to all subscribers.
	 *
	 * @param operation - The operation type (CHECKPOINT_INIT, CHECKPOINT_COMMIT, or CHECKPOINT_RESTORE)
	 * @param isActive - true when operation starts, false when complete
	 * @param commitHash - Optional commit hash for CHECKPOINT_COMMIT and CHECKPOINT_RESTORE operations
	 */
	private async sendCheckpointSubscriptionEvent(
		operation: CheckpointOperation,
		isActive: boolean,
		commitHash?: string,
	): Promise<void> {
		try {
			await sendCheckpointEvent({
				operation,
				cwdHash: this.cwdHash,
				isActive,
				taskId: this.taskId,
				commitHash,
			})
		} catch (error) {
			Logger.debug("Failed to send checkpoint event:", error)
		}
	}

	/**
	 * Creates a new CheckpointTracker instance to manage checkpoints for a specific task.
	 * The constructor is private - use the static create() method to instantiate.
	 *
	 * @param taskId - Unique identifier for the task being tracked
	 * @param cwd - The current working directory to track files in
	 * @param cwdHash - Hash of the working directory path for shadow git organization
	 */
	private constructor(taskId: string, cwd: string, cwdHash: string, shadowGitPath: string) {
		this.taskId = taskId
		this.cwd = cwd
		this.cwdHash = cwdHash
		this.shadowGitPath = shadowGitPath
		this.gitOperations = new GitOperations(cwd)
	}

	/**
	 * Creates a new CheckpointTracker instance for tracking changes in a task.
	 * Handles initialization of the shadow git repository.
	 *
	 * @param taskId - Unique identifier for the task to track
	 * @param globalStoragePath - the globalStorage path
	 * @param enableCheckpointsSetting - Whether checkpoints are enabled in settings
	 * @param workspacePaths - The workspace directory path(s) to track (string or array of strings)
	 * @returns Promise resolving to new CheckpointTracker instance, or undefined if checkpoints are disabled
	 * @throws Error if:
	 * - globalStoragePath is not supplied
	 * - Git is not installed
	 * - Working directory is invalid or in a protected location
	 * - Shadow git initialization fails
	 *
	 * Key operations:
	 * - Validates git installation and settings
	 * - Creates/initializes shadow git repository
	 *
	 * Configuration:
	 * - Respects 'cline.enableCheckpoints' VS Code setting
	 */
	public static async create(
		taskId: string,
		enableCheckpointsSetting: boolean,
		workspacePaths: string | string[],
	): Promise<CheckpointTracker | undefined> {
		try {
			Logger.info(`Creating new CheckpointTracker for task ${taskId}`)
			const startTime = performance.now()

			// Check if checkpoints are disabled by setting
			if (!enableCheckpointsSetting) {
				Logger.info(`Checkpoints disabled by setting for task ${taskId}`)
				return undefined // Don't create tracker when disabled
			}

			// Check if git is installed by attempting to get version
			try {
				await simpleGit().version()
			} catch (_error) {
				throw new Error("Git must be installed to use checkpoints.") // FIXME: must match what we check for in TaskHeader to show link
			}

			// Validate and normalize workspace paths - for now, we just use the first valid path
			const pathsToValidate = Array.isArray(workspacePaths) ? workspacePaths : [workspacePaths]
			const { validateWorkspacePath } = await import("./CheckpointUtils")

			for (const workspacePath of pathsToValidate) {
				if (!workspacePath) {
					throw new Error("At least one workspace path must be provided")
				}

				await validateWorkspacePath(workspacePath)
			}

			// For now, we just use the first valid path
			const workingDir = Array.isArray(workspacePaths) ? workspacePaths[0] : workspacePaths

			const cwdHash = hashWorkingDir(workingDir)
			Logger.debug(`Repository ID (cwdHash): ${cwdHash}`)

			const gitPath = await getShadowGitPath(cwdHash)
			const newTracker = new CheckpointTracker(taskId, workingDir, cwdHash, gitPath)
			await newTracker.sendCheckpointSubscriptionEvent("CHECKPOINT_INIT", true)
			try {
				// Serialize shadow git initialization with other concurrent tasks
				// targeting the same workspace to prevent race conditions during
				// repository creation (VS Code: process-level mutex;
				// Standalone/CLI: cross-process SqliteLockManager).
				await CheckpointMutexRegistry.getInstance().runExclusive(newTracker.cwdHash, async () => {
					await newTracker.gitOperations.initShadowGit(gitPath, workingDir, taskId)
				})

				const durationMs = Math.round(performance.now() - startTime)
				telemetryService.captureCheckpointUsage(taskId, "shadow_git_initialized", durationMs)

				return newTracker
			} finally {
				await newTracker.sendCheckpointSubscriptionEvent("CHECKPOINT_INIT", false)
			}
		} catch (error) {
			Logger.error("Failed to create CheckpointTracker:", error)
			throw error
		}
	}

	/**
	 * Creates a new checkpoint commit in the shadow git repository.
	 *
	 * When a TaskFileTracker has been injected, only files tracked as modified
	 * by tool handlers are staged (incremental git add).  When no tracker is
	 * set or no files have been tracked, falls back to full workspace staging
	 * via git add . (backward compatible).
	 *
	 * @returns Promise<string | undefined> A restorable shadow revision, whether newly committed or already current
	 * @throws Error if the restore point cannot be produced
	 */
	public async commit(): Promise<string | undefined> {
		// Use tracked files for incremental checkpoint when available.
		const trackedFiles = this.taskFileTracker?.getModifiedFiles() ?? []
		return this.commitForFiles(trackedFiles)
	}

	/**
	 * Creates a checkpoint commit that only includes the specified files.
	 * When files array is empty, falls back to staging all files via `git add .`
	 * (backward compatible).
	 *
	 * Key behaviors:
	 * - Acquires folder lock before proceeding to prevent conflicts
	 * - Stages only the specified files (or all files when list is empty)
	 * - Creates commit with checkpoint files in shadow git repo
	 * - Releases folder lock after completion
	 *
	 * Commit structure:
	 * - Commit message: "checkpoint-{cwdHash}-{taskId}"
	 * - Reuses the current shadow revision when staging is unchanged
	 *
	 * @param files - List of file paths to include in this checkpoint.
	 *                When empty or omitted, all files are staged (full workspace).
	 * @returns Promise<string | undefined> A restorable shadow revision, or undefined if:
	 * - Folder lock acquisition fails or times out
	 * - Shadow git access fails
	 * - Staging files fails
	 * - Commit creation fails
	 * @throws Error if unable to:
	 * - Access shadow git path
	 * - Initialize simple-git
	 * - Stage or commit files
	 */
	public async commitForFiles(files: string[]): Promise<string | undefined> {
		// Users report checkpoint creation failing when many tasks run at once,
		// and the cost is split between waiting for the shared shadow-repository
		// lock and the Git work itself. One span over both is what makes that
		// split visible in a trace instead of being inferred from timings.
		const span = startSignalSpan({
			name: "checkpoint.commit",
			attributes: { task_id: this.taskId, explicit_files: files.length > 0 },
		})
		// One sample per attempt, whatever happens inside. `checkpoint.commit`
		// only covers the Git work, which never runs when the lock is refused,
		// so an attempt that never obtained exclusive access is absent from it
		// entirely. That gap is the one users report: under concurrent tasks the
		// checkpoint fails, and the metric that should show it stays empty.
		const startedAt = performance.now()
		const attempt: CheckpointAttemptState = { lockUnavailable: false }
		const report = (outcome: CheckpointAttemptOutcome): void => {
			span.setAttribute("attempt_outcome", outcome)
			recordPerfPhase(
				PerfDomain.Checkpoint,
				"commit_attempt",
				performance.now() - startedAt,
				{ outcome },
				{ taskId: this.taskId },
			)
		}
		try {
			const commitHash = await runWithSignalSpan(span, () => this.doCommitForFiles(files, span, attempt))
			// An absent hash means no checkpoint was created, which the caller
			// treats as a failed checkpoint. Reporting it as a successful span
			// would hide exactly the failure this span exists to find.
			const created = commitHash !== undefined && commitHash !== ""
			span.setAttribute("created", created)
			report(created ? "created" : "no_restore_point")
			span.end(created ? "success" : "failure")
			return commitHash
		} catch (error) {
			span.recordException(error)
			// Whether the lock was the reason is known only from the state the
			// body recorded: every failure below is rewrapped into one generic
			// error before arriving here.
			report(attempt.lockUnavailable ? "lock_unavailable" : "error")
			span.end("failure")
			throw error
		}
	}

	private async doCommitForFiles(
		files: string[],
		span: SignalSpanHandle,
		attempt: CheckpointAttemptState,
	): Promise<string | undefined> {
		let lockAcquired = false

		// When no explicit files are provided, try to get tracked files from the
		// per-task file tracker for incremental staging.
		let filesToCommit = files
		if (filesToCommit.length === 0 && this.taskFileTracker) {
			filesToCommit = this.taskFileTracker.getModifiedFiles()
		}
		try {
			await this.sendCheckpointSubscriptionEvent("CHECKPOINT_COMMIT", true)
			const startTime = performance.now()

			const lockStartedAt = performance.now()
			// A child span rather than an attribute on the parent: an attribute
			// has no extent, so it cannot show a reader where inside the commit
			// the time went. The waiting and the Git work are the two halves
			// being told apart, and only spans place them on the waterfall.
			const lockSpan = startSignalSpan({
				name: "checkpoint.commit_lock",
				parent: span,
				attributes: { task_id: this.taskId, mechanism: "folder_lock" satisfies CheckpointLockMechanism },
			})
			let lockResult: FolderLockWithRetryResult
			try {
				lockResult = await runWithSignalSpan(lockSpan, () => tryAcquireCheckpointLockWithRetry(this.cwdHash, this.taskId))
			} catch (error) {
				// The helper resolves the checkpoint directory before consulting
				// the lock, and that resolution creates directories, so it can
				// reject outright. Without this the span would stay open and the
				// failure would be missing from the lock metric entirely.
				attempt.lockUnavailable = true
				lockSpan.setAttribute("outcome", "failed" satisfies CheckpointLockOutcome)
				lockSpan.recordException(error)
				lockSpan.end("failure")
				span.setAttribute("lock_outcome", "failed" satisfies CheckpointLockOutcome)
				recordPerfPhase(
					PerfDomain.Checkpoint,
					"commit_lock",
					performance.now() - lockStartedAt,
					{ outcome: "failed" satisfies CheckpointLockOutcome, mechanism: "folder_lock" },
					{ taskId: this.taskId },
				)
				throw error
			}
			// Contention for the shared shadow repository is the suspected cause
			// of the reported failures, so how the lock resolved is reported as
			// its own bounded outcome rather than folded into the total.
			// A refusal is reported as `conflicted` only when another holder was
			// actually seen. The lock layer also reports failure when it could
			// not be consulted at all, and merging the two would send the reader
			// looking for contention that never happened.
			const lockOutcome: CheckpointLockOutcome = lockResult.acquired
				? "acquired"
				: lockResult.skipped
					? "skipped"
					: lockResult.conflictingLock
						? "conflicted"
						: "failed"
			span.setAttribute("lock_outcome", lockOutcome)
			lockSpan.setAttribute("outcome", lockOutcome)
			// `skipped` is not a failed span: in VS Code the folder lock declines
			// by design and the mutex below does the serializing. Only a refusal
			// that leaves the caller unable to proceed is a failure.
			lockSpan.end(lockOutcome === "conflicted" || lockOutcome === "failed" ? "failure" : "success")
			recordPerfPhase(
				PerfDomain.Checkpoint,
				"commit_lock",
				performance.now() - lockStartedAt,
				{ outcome: lockOutcome, mechanism: "folder_lock" satisfies CheckpointLockMechanism },
				{ taskId: this.taskId },
			)

			// Locking failed due to conflicting lock
			if (!lockResult.acquired && !lockResult.skipped) {
				attempt.lockUnavailable = true
				throw new Error(
					"Failed to acquire checkpoint folder lock - another Dline instance may be performing checkpoint operations",
				)
			}

			if (lockResult.acquired) {
				lockAcquired = true
			}

			// VS Code: fall back to process-level mutex to serialize
			// operations on the shared shadow git repository
			if (!lockResult.acquired && lockResult.skipped) {
				Logger.trace(`[Task ${this.taskId}] Using process-level mutex for checkpoint commit - VS Code`)
				// In VS Code the folder lock returns immediately and this mutex is
				// what actually serializes concurrent tasks, so the wait measured
				// above is not the wait users experience. Timing it from the
				// request to the point the callback gains entry is what makes
				// contention between tasks visible in this host.
				const mutexRequestedAt = performance.now()
				const mutexSpan = startSignalSpan({
					name: "checkpoint.commit_lock",
					parent: span,
					attributes: { task_id: this.taskId, mechanism: "process_mutex" satisfies CheckpointLockMechanism },
				})
				let mutexEntered = false
				try {
					const commitHash = await CheckpointMutexRegistry.getInstance().runExclusive(this.cwdHash, async () => {
						mutexEntered = true
						mutexSpan.setAttribute("outcome", "acquired" satisfies CheckpointLockOutcome)
						mutexSpan.end("success")
						recordPerfPhase(
							PerfDomain.Checkpoint,
							"commit_lock",
							performance.now() - mutexRequestedAt,
							{ outcome: "acquired" satisfies CheckpointLockOutcome, mechanism: "process_mutex" },
							{ taskId: this.taskId },
						)
						return this.runGitWork(filesToCommit, span)
					})

					const durationMs = Math.round(performance.now() - startTime)
					await this.sendCheckpointSubscriptionEvent("CHECKPOINT_COMMIT", false, commitHash)
					telemetryService.captureCheckpointUsage(this.taskId, "commit_created", durationMs)
					return commitHash
				} catch (error) {
					// Only unresolved while the wait itself is what failed. Once
					// the callback has entered, the span is already closed and
					// the failure belongs to the Git work, not to the lock.
					if (!mutexEntered) {
						attempt.lockUnavailable = true
						mutexSpan.setAttribute("outcome", "failed" satisfies CheckpointLockOutcome)
						mutexSpan.recordException(error)
						mutexSpan.end("failure")
						recordPerfPhase(
							PerfDomain.Checkpoint,
							"commit_lock",
							performance.now() - mutexRequestedAt,
							{ outcome: "failed" satisfies CheckpointLockOutcome, mechanism: "process_mutex" },
							{ taskId: this.taskId },
						)
					}
					throw error
				}
			}

			// Standalone/CLI: cross-process lock already held via SqliteLockManager
			const commitHash = await this.runGitWork(filesToCommit, span)

			const durationMs = Math.round(performance.now() - startTime)
			await this.sendCheckpointSubscriptionEvent("CHECKPOINT_COMMIT", false, commitHash)
			telemetryService.captureCheckpointUsage(this.taskId, "commit_created", durationMs)

			return commitHash
		} catch (error) {
			Logger.error("Failed to create checkpoint:", {
				taskId: this.taskId,
				error,
			})
			throw new Error(`Failed to create checkpoint: ${error instanceof Error ? error.message : String(error)}`)
		} finally {
			if (lockAcquired) {
				Logger.info(`[Task ${this.taskId}] Releasing checkpoint folder lock`)
				await releaseCheckpointLock(this.cwdHash, this.taskId)
			}
		}
	}

	/**
	 * Run the Git half of a commit as its own span and duration.
	 *
	 * This is the second half of the split the parent span exists to make
	 * visible: everything measured here happens with exclusive access already
	 * granted, so a slow sample means the repository work is slow rather than
	 * that the task was queued behind another one.
	 */
	private async runGitWork(files: string[], parent: SignalSpanHandle): Promise<string | undefined> {
		const startedAt = performance.now()
		const gitSpan = startSignalSpan({
			name: "checkpoint.git",
			parent,
			attributes: { task_id: this.taskId, staged_files: files.length },
		})
		const report = (outcome: CheckpointGitOutcome): void => {
			gitSpan.setAttribute("outcome", outcome)
			gitSpan.end(outcome === "error" ? "failure" : "success")
			recordPerfPhase(PerfDomain.Checkpoint, "commit", performance.now() - startedAt, { outcome }, { taskId: this.taskId })
		}
		try {
			const commitHash = await runWithSignalSpan(gitSpan, () => this.doCommitFiles(files))
			// Staging that produced nothing is reported apart from a created
			// commit. Both return normally, but only one leaves the caller with
			// a restore point, and folding them together would make the failure
			// users report invisible in this metric.
			report(commitHash === undefined || commitHash === "" ? "none" : "success")
			return commitHash
		} catch (error) {
			gitSpan.recordException(error)
			report("error")
			throw error
		}
	}

	/**
	 * Execute the git add + git commit sequence for the given files.
	 * Extracted as a private helper so it can be called under different
	 * locking strategies (cross-process SqliteLockManager or process-level Mutex).
	 *
	 * Staging strategy:
	 * - When files are provided: incremental git add <files>.
	 * - When files are empty and command execution may have modified files:
	 *   run a guarded workspace scan after a readonly change preflight.
	 * - When files are empty and no workspace scan is required: reuse the validated shadow HEAD.
	 *
	 * When staging produces no changes, the current valid shadow HEAD remains the
	 * restore point. After a successful new commit the TaskFileTracker's
	 * modified-file cache is cleared so the next checkpoint only captures newly
	 * modified files.
	 */
	private async doCommitFiles(files: string[]): Promise<string | undefined> {
		const gitPath = this.shadowGitPath
		const git = simpleGit(path.dirname(gitPath))
		const requiresWorkspaceScan = this.taskFileTracker?.isWorkspaceScanRequired() ?? false

		Logger.trace(`[Task ${this.taskId}] Using shadow git at: ${gitPath}`)

		if (files.length > 0) {
			Logger.debug(`[CheckpointTracker] doCommitFiles: tracked add ${files.length} file(s) for task ${this.taskId}`)
			const addFilesResult = await this.gitOperations.addCheckpointFiles({
				git,
				mode: "tracked",
				fileList: files,
				taskId: this.taskId,
			})
			// Paths Git cannot stage must leave the pending set even when the whole
			// attempt failed. Retaining them replays the same rejected batch on every
			// later checkpoint and disables checkpoints for the rest of the task.
			this.dropUnstageablePaths(addFilesResult.rejectedPaths)
			if (!addFilesResult.success) {
				this.consecutiveStagingFailures += 1
				Logger.error(
					`[CheckpointTracker] Failed to stage ${files.length} tracked file(s) for task ${this.taskId} ` +
						`(consecutive failures: ${this.consecutiveStagingFailures}). ` +
						`Skipping commit to avoid an empty checkpoint.`,
				)
				return undefined
			}
			this.consecutiveStagingFailures = 0
		} else if (requiresWorkspaceScan) {
			const hasWorkspaceChanges = await this.gitOperations.hasWorkspaceChanges(git, this.taskId)
			if (!hasWorkspaceChanges) {
				this.taskFileTracker?.clearWorkspaceScanRequired()
				Logger.debug(
					`[CheckpointTracker] No workspace changes after command for task ${this.taskId}; reusing shadow HEAD`,
				)
				return this.getCurrentRestorePoint(git)
			}
			const addFilesResult = await this.gitOperations.addCheckpointFiles({
				git,
				mode: "workspace-scan",
				taskId: this.taskId,
			})
			if (!addFilesResult.success) {
				this.consecutiveStagingFailures += 1
				Logger.error(
					`[CheckpointTracker] Failed workspace-scan staging for task ${this.taskId} ` +
						`(consecutive failures: ${this.consecutiveStagingFailures})`,
				)
				return undefined
			}
			this.consecutiveStagingFailures = 0
		} else {
			return this.getCurrentRestorePoint(git)
		}

		const hasStagedChanges = await this.gitOperations.hasStagedChanges(git, this.taskId)
		if (!hasStagedChanges) {
			this.taskFileTracker?.clearModifiedFiles()
			this.taskFileTracker?.clearWorkspaceScanRequired()
			Logger.debug(`[CheckpointTracker] No staged changes for task ${this.taskId}; reusing shadow HEAD`)
			return this.getCurrentRestorePoint(git)
		}

		const commitMessage = this.getTaskCheckpointCommitMessage()

		// Ensure shadow git identity is set before committing to prevent
		// leaking the user's global git name/email into checkpoint history.
		await this.gitOperations.ensureShadowGitIdentity(git)

		Logger.info(`[Task ${this.taskId}] Creating checkpoint commit with message: ${commitMessage}`)
		const result = await git.commit(commitMessage, {
			"--no-verify": null,
		})
		const commitHash = (result.commit || "").replace(/^HEAD\s+/, "")
		Logger.warn(`[Task ${this.taskId}] Checkpoint commit created: ${commitHash}`)

		// Clear tracked files after a successful commit so the next
		// checkpoint only captures newly modified files.
		if (commitHash) {
			this.taskFileTracker?.clearModifiedFiles()
			this.taskFileTracker?.clearWorkspaceScanRequired()
			Logger.debug(`[CheckpointTracker] Cleared tracked files after successful commit for task ${this.taskId}`)
		}

		return commitHash
	}

	/**
	 * Remove worktree-relative paths the shadow repository refused to stage.
	 *
	 * Rejections are permanent for the current worktree state — a nested
	 * repository path or a deleted file will not become stageable by retrying —
	 * so they are dropped rather than carried into the next checkpoint.
	 */
	private dropUnstageablePaths(relativePaths: string[]): void {
		if (relativePaths.length === 0 || !this.taskFileTracker) {
			return
		}
		const absolutePaths = relativePaths.map((relativePath) => path.resolve(this.cwd, relativePath))
		const dropped = this.taskFileTracker.dropModifiedFiles(absolutePaths)
		if (dropped > 0) {
			Logger.warn(
				`[CheckpointTracker] Dropped ${dropped} unstageable path(s) from task ${this.taskId} tracking ` +
					`to prevent repeated checkpoint failures`,
			)
		}
	}

	/** Return the current validated shadow revision without creating an empty commit. */
	private async getCurrentRestorePoint(git: SimpleGit): Promise<string> {
		const revision = (await git.revparse(["HEAD"])).trim()
		if (!revision) {
			throw new Error("Checkpoint shadow repository has no valid HEAD revision")
		}
		return this.cleanCommitHash(revision)
	}

	/**
	 * Retrieves the worktree path from the shadow git configuration.
	 * The worktree path indicates where the shadow git repository is tracking files,
	 * which should match the current workspace directory.
	 *
	 * Key behaviors:
	 * - Caches result in lastRetrievedShadowGitConfigWorkTree to avoid repeated reads
	 * - Returns cached value if available
	 * - Reads git config if no cached value exists
	 *
	 * Configuration read:
	 * - Uses simple-git to read core.worktree config
	 * - Operates on shadow git at path from getShadowGitPath()
	 *
	 * @returns Promise<string | undefined> The configured worktree path, or undefined if:
	 * - Shadow git repository doesn't exist
	 * - Config read fails
	 * - No worktree is configured
	 * @throws Error if unable to:
	 * - Access shadow git path
	 * - Initialize simple-git
	 * - Read git configuration
	 */
	public async getShadowGitConfigWorkTree(): Promise<string | undefined> {
		if (this.lastRetrievedShadowGitConfigWorkTree) {
			return this.lastRetrievedShadowGitConfigWorkTree
		}
		try {
			const gitPath = this.shadowGitPath
			this.lastRetrievedShadowGitConfigWorkTree = await this.gitOperations.getShadowGitConfigWorkTree(gitPath)
			return this.lastRetrievedShadowGitConfigWorkTree
		} catch (error) {
			Logger.error("Failed to get shadow git config worktree:", error)
			return undefined
		}
	}

	/**
	 * Resets the shadow git repository's HEAD to a specific checkpoint commit.
	 * This will discard all changes after the target commit and restore the
	 * working directory to that checkpoint's state.
	 *
	 * Key behaviors:
	 * - Acquires folder lock before proceeding to prevent conflicts
	 * - Performs hard reset to target commit
	 * - Releases folder lock after completion
	 *
	 * Dependencies:
	 * - Requires initialized shadow git (getShadowGitPath)
	 * - Must be called with a valid commit hash from this task's history
	 *
	 * @param commitHash - The hash of the checkpoint commit to reset to
	 * @returns Promise<void> Resolves when reset is complete
	 * @throws Error if unable to:
	 * - Acquire folder lock (timeout or conflict)
	 * - Access shadow git path
	 * - Initialize simple-git
	 * - Reset to target commit
	 */
	public async resetHead(commitHash: string): Promise<void> {
		let lockAcquired = false

		try {
			Logger.info(`Resetting to checkpoint: ${commitHash}`)
			const startTime = performance.now()
			await this.sendCheckpointSubscriptionEvent("CHECKPOINT_RESTORE", true, commitHash)
			const lockResult: FolderLockWithRetryResult = await tryAcquireCheckpointLockWithRetry(this.cwdHash, this.taskId)

			// Locking failed due to conflicting lock
			if (!lockResult.acquired && !lockResult.skipped) {
				throw new Error(
					"Failed to acquire checkpoint folder lock - another Dline instance may be performing checkpoint operations",
				)
			}

			if (lockResult.acquired) {
				lockAcquired = true
			}

			// VS Code: fall back to process-level mutex
			if (!lockResult.acquired && lockResult.skipped) {
				Logger.log(`[Task ${this.taskId}] Using process-level mutex for checkpoint reset - VS Code`)
				await CheckpointMutexRegistry.getInstance().runExclusive(this.cwdHash, async () => {
					await this.doResetHead(commitHash)
				})
			} else {
				// Standalone/CLI: cross-process lock already held
				await this.doResetHead(commitHash)
			}

			const durationMs = Math.round(performance.now() - startTime)
			await this.sendCheckpointSubscriptionEvent("CHECKPOINT_RESTORE", false, commitHash)
			telemetryService.captureCheckpointUsage(this.taskId, "restored", durationMs)
		} catch (error) {
			Logger.error("Failed to reset to checkpoint:", {
				taskId: this.taskId,
				commitHash,
				error,
			})
			throw error
		} finally {
			if (lockAcquired) {
				await releaseCheckpointLock(this.cwdHash, this.taskId)
			}
		}
	}

	/**
	 * Execute the git reset --hard operation.
	 * Extracted as a private helper for use under different locking strategies.
	 */
	private async doResetHead(commitHash: string): Promise<void> {
		const gitPath = this.shadowGitPath
		const git = simpleGit(path.dirname(gitPath))
		const cleanHash = this.cleanCommitHash(commitHash)
		Logger.debug(
			`[CheckpointTracker] doResetHead: resetting to commit ${cleanHash} for task ${this.taskId}, shadow git at ${gitPath}`,
		)
		await git.reset(["--hard", cleanHash])
		Logger.debug(`[CheckpointTracker] Successfully reset to checkpoint: ${cleanHash}`)
	}

	/**
	 * Restores only the specified files to a previous checkpoint commit.
	 * Unlike resetHead which does a full `git reset --hard`, this restores only
	 * the working-tree copies of the given files from the selected revision,
	 * leaving all other files untouched.
	 *
	 * Key behaviors:
	 * - Acquires folder lock before proceeding to prevent conflicts
	 * - Checks out specified files from the target commit
	 * - Releases folder lock after completion
	 * - Does NOT change HEAD — only updates the working tree for those files
	 *
	 * @param commitHash - The hash of the checkpoint commit to restore files from
	 * @param files - List of absolute file paths to restore
	 * @returns Promise<void> Resolves when restore is complete
	 * @throws Error if unable to:
	 * - Acquire folder lock (timeout or conflict)
	 * - Access shadow git path
	 * - Checkout files from the target commit
	 */
	public async restoreFiles(commitHash: string, files: string[]): Promise<void> {
		if (files.length === 0) {
			Logger.debug(`[CheckpointTracker] restoreFiles called with empty file list, nothing to restore`)
			return
		}

		let lockAcquired = false

		try {
			const cleanHash = this.cleanCommitHash(commitHash)
			Logger.info(`Restoring ${files.length} file(s) to checkpoint: ${cleanHash}`)
			const startTime = performance.now()
			await this.sendCheckpointSubscriptionEvent("CHECKPOINT_RESTORE", true, commitHash)

			const lockResult: FolderLockWithRetryResult = await tryAcquireCheckpointLockWithRetry(this.cwdHash, this.taskId)

			if (!lockResult.acquired && !lockResult.skipped) {
				throw new Error(
					"Failed to acquire checkpoint folder lock - another Dline instance may be performing checkpoint operations",
				)
			}

			if (lockResult.acquired) {
				lockAcquired = true
			}

			// VS Code: fall back to process-level mutex
			if (!lockResult.acquired && lockResult.skipped) {
				Logger.log(`[Task ${this.taskId}] Using process-level mutex for checkpoint restore - VS Code`)
				await CheckpointMutexRegistry.getInstance().runExclusive(this.cwdHash, async () => {
					await this.doRestoreFiles(cleanHash, files)
				})
			} else {
				// Standalone/CLI: cross-process lock already held
				await this.doRestoreFiles(cleanHash, files)
			}

			const durationMs = Math.round(performance.now() - startTime)
			await this.sendCheckpointSubscriptionEvent("CHECKPOINT_RESTORE", false, commitHash)
			telemetryService.captureCheckpointUsage(this.taskId, "restored", durationMs)
		} catch (error) {
			Logger.error("Failed to restore files to checkpoint:", {
				taskId: this.taskId,
				commitHash,
				files,
				error,
			})
			throw error
		} finally {
			if (lockAcquired) {
				await releaseCheckpointLock(this.cwdHash, this.taskId)
			}
		}
	}

	/**
	 * Execute git checkout to restore files from a checkpoint.
	 * Extracted as a private helper for use under different locking strategies.
	 */
	private async doRestoreFiles(cleanHash: string, files: string[]): Promise<void> {
		const gitPath = this.shadowGitPath
		const git = simpleGit(path.dirname(gitPath))

		// Convert absolute paths to workspace-relative paths for git checkout.
		// git checkout requires paths relative to the worktree root (this.cwd).
		const resolvedFiles = await Promise.all(files.map((file) => resolveCheckpointWorktreePath(this.cwd, file)))
		if (resolvedFiles.some((file) => file === undefined)) {
			throw new Error("Checkpoint restore path is outside the worktree")
		}
		const ownedFiles = resolvedFiles as Array<{ absolute: string; relative: string }>
		const relativeFiles = ownedFiles.map((file) => file.relative)
		Logger.debug(
			`[CheckpointTracker] doRestoreFiles: restoring ${files.length} file(s) to commit ${cleanHash} for task ${this.taskId}` +
				`\n  shadow git: ${gitPath}` +
				`\n  files: ${relativeFiles.join(", ")}`,
		)
		const literalPathspecs = relativeFiles.map(toLiteralGitPathspec)
		const treeOutput = await git.raw(["ls-tree", "-r", "--name-only", "-z", cleanHash, "--", ...literalPathspecs])
		const normalizeGitPath = (file: string) => {
			const normalized = file.replaceAll("\\", "/")
			return process.platform === "win32" ? normalized.toLowerCase() : normalized
		}
		const filesInCheckpoint = new Set(treeOutput.split("\0").filter(Boolean).map(normalizeGitPath))
		const presentFiles = relativeFiles.filter((file) => filesInCheckpoint.has(normalizeGitPath(file)))
		const deletedFiles = relativeFiles.filter((file) => !filesInCheckpoint.has(normalizeGitPath(file)))
		if (presentFiles.length > 0) {
			await git.raw(["restore", `--source=${cleanHash}`, "--worktree", "--", ...presentFiles.map(toLiteralGitPathspec)])
		}
		if (deletedFiles.length > 0) {
			const deletedPaths = new Set(deletedFiles.map(normalizeGitPath))
			await Promise.all(
				ownedFiles
					.filter((file) => deletedPaths.has(normalizeGitPath(file.relative)))
					.map((file) => fs.rm(file.absolute, { force: true })),
			)
		}
		Logger.debug(`[CheckpointTracker] Successfully restored ${files.length} file(s) to checkpoint: ${cleanHash}`)
	}

	private getTaskCheckpointCommitMessage(): string {
		return `checkpoint-${this.cwdHash}-${this.taskId}`
	}

	/**
	 * Return the files with a net change between two boundaries that were touched
	 * by checkpoint commits owned by this task. Commits from other tasks share the
	 * same shadow branch and must not leak into completion results.
	 */
	private async getTaskOwnedNetChangedFileNames(git: SimpleGit, lhsHash: string, rhsHash: string): Promise<string[]> {
		const diffRange = `${lhsHash}..${rhsHash}`
		const logOutput = await git.raw(["log", "--format=%H%x00%s%x00", diffRange])
		const logFields = logOutput.split("\0")
		const taskCommitHashes: string[] = []
		const taskCommitMessage = this.getTaskCheckpointCommitMessage()

		for (let index = 0; index + 1 < logFields.length; index += 2) {
			const commitHash = logFields[index]?.trim()
			const subject = logFields[index + 1]?.trim()
			if (commitHash && subject === taskCommitMessage) {
				taskCommitHashes.push(commitHash)
			}
		}

		if (taskCommitHashes.length === 0) {
			return []
		}

		const taskTouchedFiles = new Set<string>()
		for (const commitHash of taskCommitHashes) {
			const pathsOutput = await git.raw(["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", commitHash])
			for (const filePath of pathsOutput.split("\0").filter(Boolean)) {
				taskTouchedFiles.add(filePath)
			}
		}

		const netChangedOutput = await git.raw(["diff", "--name-only", "-z", diffRange])
		return netChangedOutput
			.split("\0")
			.filter(Boolean)
			.filter((filePath) => taskTouchedFiles.has(filePath))
	}

	/** Return completion changes owned by this task between two checkpoint hashes. */
	public async getTaskDiffSet(lhsHash: string, rhsHash: string): Promise<CheckpointChangedFile[]> {
		const startTime = performance.now()
		const cleanLhs = this.cleanCommitHash(lhsHash)
		const cleanRhs = this.cleanCommitHash(rhsHash)
		const git = simpleGit(path.dirname(this.shadowGitPath))
		const changedFileNames = await this.getTaskOwnedNetChangedFileNames(git, cleanLhs, cleanRhs)
		return this.readDiffSet(git, cleanLhs, cleanRhs, changedFileNames, startTime)
	}

	/** Return the number of completion changes owned by this task between two checkpoint hashes. */
	public async getTaskDiffCount(lhsHash: string, rhsHash: string): Promise<number> {
		const startTime = performance.now()
		const cleanLhs = this.cleanCommitHash(lhsHash)
		const cleanRhs = this.cleanCommitHash(rhsHash)
		const git = simpleGit(path.dirname(this.shadowGitPath))
		const changedFileNames = await this.getTaskOwnedNetChangedFileNames(git, cleanLhs, cleanRhs)
		const durationMs = Math.round(performance.now() - startTime)
		telemetryService.captureCheckpointUsage(this.taskId, "diff_generated", durationMs)
		return changedFileNames.length
	}

	/**
	 * Return an array describing changed files between one commit and either:
	 *   - another commit (rhsHash provided): uses `git diff --name-only` (read-only, fast)
	 *   - the current working directory (rhsHash omitted): stages files first to discover untracked changes
	 *
	 * @param lhsHash - The commit to compare from (older commit)
	 * @param rhsHash - The commit to compare to (newer commit).
	 *                  If omitted, we compare to the working directory.
	 * @returns Array of file changes with before/after content
	 */
	public async getDiffSet(lhsHash: string, rhsHash?: string): Promise<CheckpointChangedFile[]> {
		const startTime = performance.now()
		const cleanLhs = this.cleanCommitHash(lhsHash)
		const cleanRhs = rhsHash ? this.cleanCommitHash(rhsHash) : undefined
		const diffRange = cleanRhs ? `${cleanLhs}..${cleanRhs}` : cleanLhs

		Logger.info(`Getting diff between commits: ${lhsHash || "initial"} -> ${rhsHash || "working directory"}`)
		Logger.info(`[Task ${this.taskId}] Diff range: ${diffRange}`)

		const gitPath = this.shadowGitPath
		const git = simpleGit(path.dirname(gitPath))

		// When comparing two commits, use read-only `git diff --name-only`
		// to get the file list without staging — avoids expensive `git add .`
		let changedFileNames: string[]
		if (cleanRhs) {
			// Two-commit comparison: pure read, no index mutation needed
			const nameOnlyOutput = await git.raw(["diff", "--name-only", diffRange])
			changedFileNames = nameOnlyOutput.split("\n").filter((f) => f.length > 0)
		} else {
			// Working-directory comparison: stage files to discover untracked changes,
			// then diff. Serialized via mutex to protect the shared shadow git index.
			changedFileNames = await CheckpointMutexRegistry.getInstance().runExclusive(this.cwdHash, async () => {
				await this.gitOperations.addCheckpointFiles({ git, mode: "workspace-scan", taskId: this.taskId })
				const summary = await git.diffSummary([diffRange])
				return summary.files.map((f) => f.file)
			})
		}

		return this.readDiffSet(git, cleanLhs, cleanRhs, changedFileNames, startTime)
	}

	private async readDiffSet(
		git: SimpleGit,
		cleanLhs: string,
		cleanRhs: string | undefined,
		changedFileNames: readonly string[],
		startTime: number,
	): Promise<CheckpointChangedFile[]> {
		const result: CheckpointChangedFile[] = []

		for (const filePath of changedFileNames) {
			const absolutePath = path.join(this.cwd, filePath)
			const lastDotIndex = filePath.lastIndexOf(".")
			const lastSlashIndex = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"))
			const ext = lastDotIndex > lastSlashIndex ? filePath.substring(lastDotIndex).toLowerCase() : ""
			const isDotfile = lastDotIndex !== -1 && lastDotIndex === lastSlashIndex + 1

			if (!ext || isDotfile) {
				try {
					const isBinary = await isBinaryFile(absolutePath).catch(() => false)
					if (isBinary) {
						continue
					}
				} catch {
					continue
				}
			}

			let beforeContent = ""
			try {
				beforeContent = await git.show([`${cleanLhs}:${filePath}`])
			} catch (_) {
				// File did not exist in the older commit.
			}

			let afterContent = ""
			if (cleanRhs) {
				try {
					afterContent = await git.show([`${cleanRhs}:${filePath}`])
				} catch (_) {
					// File did not exist in the newer commit.
				}
			} else {
				try {
					afterContent = await fs.readFile(absolutePath, "utf8")
				} catch (_) {
					// File may have been deleted from the working directory.
				}
			}

			result.push({
				relativePath: filePath,
				absolutePath,
				before: beforeContent,
				after: afterContent,
			})
		}

		const durationMs = Math.round(performance.now() - startTime)
		telemetryService.captureCheckpointUsage(this.taskId, "diff_generated", durationMs)
		return result
	}

	/**
	 * Returns the number of files changed between two commits.
	 *
	 * When comparing two commits (rhsHash provided), uses `git diff --name-only`
	 * (read-only, no staging required). When comparing to the working directory
	 * (rhsHash omitted), stages files first to discover untracked changes.
	 *
	 * @param lhsHash - The commit to compare from (older commit)
	 * @param rhsHash - The commit to compare to (newer commit).
	 *                  If omitted, we compare to the working directory.
	 * @returns The number of files changed between the commits
	 */
	public async getDiffCount(lhsHash: string, rhsHash?: string): Promise<number> {
		const startTime = performance.now()
		const cleanLhs = this.cleanCommitHash(lhsHash)
		const cleanRhs = rhsHash ? this.cleanCommitHash(rhsHash) : undefined
		const diffRange = cleanRhs ? `${cleanLhs}..${cleanRhs}` : cleanLhs

		Logger.info(`Getting diff count between commits: ${lhsHash || "initial"} -> ${rhsHash || "working directory"}`)

		const gitPath = this.shadowGitPath
		const git = simpleGit(path.dirname(gitPath))

		let changedFileCount: number
		if (cleanRhs) {
			// Two-commit comparison: pure read, no index mutation needed
			const nameOnlyOutput = await git.raw(["diff", "--name-only", diffRange])
			const changedFileNames = nameOnlyOutput.split("\n").filter((f) => f.length > 0)
			changedFileCount = changedFileNames.length
		} else {
			// Working-directory comparison: stage files to discover untracked changes
			changedFileCount = await CheckpointMutexRegistry.getInstance().runExclusive(this.cwdHash, async () => {
				await this.gitOperations.addCheckpointFiles({ git, mode: "workspace-scan", taskId: this.taskId })
				const diffSummary = await git.diffSummary([diffRange])
				return diffSummary.files.length
			})
		}

		const durationMs = Math.round(performance.now() - startTime)
		telemetryService.captureCheckpointUsage(this.taskId, "diff_generated", durationMs)

		return changedFileCount
	}
}

export default CheckpointTracker
