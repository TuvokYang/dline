import { fileExistsAtPath } from "@utils/fs"
import fs from "fs/promises"
import * as path from "path"
import simpleGit, { type SimpleGit } from "simple-git"
import { getDlineCheckpointsDir } from "@/core/storage/disk"
import { telemetryService } from "@/services/telemetry"
import { DiagnosticDomain, DiagnosticOutcome } from "@/services/telemetry/instrumentation/diagnostic-events"
import { recordDiagnostic } from "@/services/telemetry/instrumentation/diagnostic-recorder"
import { recordPerfPhase } from "@/services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "@/services/telemetry/instrumentation/perf-domains"
import { Logger } from "@/shared/services/Logger"
import { getLfsPatterns, loadWorkspaceIgnoreContent, writeExcludesFile } from "./CheckpointExclusions"
import { detectCheckpointWorkspaceTopology } from "./CheckpointWorkspaceTopology"
import { NestedRepositoryBoundaryDetector } from "./NestedRepositoryBoundaryDetector"

/**
 * Why a checkpoint add did not complete.
 *
 * A bounded set, because these values become metric labels. The message of the
 * underlying error is unbounded and must never be reported as a dimension; it
 * stays in the log line, which is not subject to cardinality limits.
 */
type CheckpointAddFailureReason =
	/** A caller passed an explicit file list to a mode that stages the whole workspace. */
	| "invalid_request"
	/** A tracked path resolved outside the worktree that owns this checkpoint. */
	| "path_outside_worktree"
	/** Git refused every batch, so nothing could be staged. */
	| "staging_rejected"
	/** Git or the filesystem raised an error that this layer does not classify. */
	| "git_error"

/** How a checkpoint add ended, as a bounded metric dimension. */
type CheckpointAddOutcome =
	/** Every requested path was staged. */
	| "success"
	/** Some paths were staged and the rest were reported as unstageable. */
	| "partial"
	/**
	 * Nothing was staged, but nothing could have been: every path belongs to a
	 * nested repository or is absent from both the worktree and the shadow index.
	 * Distinct from `failure` so the add rate keeps a complete denominator
	 * without inflating the failure ratio.
	 */
	| "nothing_to_stage"
	/** Nothing was staged and the caller cannot produce a usable checkpoint. */
	| "failure"

export interface CheckpointAddResult {
	success: boolean
	/** Number of paths handed to Git for staging. */
	stagedCount: number
	/**
	 * Worktree-relative paths Git refused to stage. The caller must stop
	 * retrying them, otherwise one poisoned path replays on every checkpoint.
	 */
	rejectedPaths: string[]
}

/**
 * Git validates every pathspec before staging anything, so a single rejected
 * path fails the whole batch. Batching bounds the blast radius and keeps the
 * command line below the Windows `CreateProcess` limit of 32767 characters.
 */
const MAX_PATHS_PER_ADD = 100
const MAX_PATHSPEC_BYTES_PER_ADD = 24_000

interface AddCheckpointFilesOptions {
	git: SimpleGit
	mode: "baseline" | "tracked" | "workspace-scan"
	fileList?: string[]
	taskId?: string
}

export interface CheckpointWorktreePath {
	absolute: string
	relative: string
}

function isOutsideDirectory(relativePath: string): boolean {
	return relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)
}

/** Prevent Git from interpreting a validated relative file name as a pathspec pattern. */
export function toLiteralGitPathspec(relativePath: string): string {
	return `:(literal)${relativePath}`
}

async function canonicalizeDirectory(directoryPath: string): Promise<string> {
	const absolute = path.resolve(directoryPath)
	let cursor = absolute
	const missingSegments: string[] = []
	while (true) {
		try {
			return path.resolve(await fs.realpath(cursor), ...missingSegments.reverse())
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error
			const parent = path.dirname(cursor)
			if (parent === cursor) throw error
			missingSegments.push(path.basename(cursor))
			cursor = parent
		}
	}
}

/**
 * Restore the on-disk spelling of a file name.
 *
 * Callers normalise tracked paths to lower case for de-duplication, which is
 * harmless on Windows but makes the path unusable as a Git pathspec on a
 * case-sensitive filesystem. Directory segments are already restored by
 * `canonicalizeDirectory`; only the final segment needs a directory lookup.
 */
async function restoreEntryNameCase(parentDirectory: string, entryName: string): Promise<string> {
	try {
		const entries = await fs.readdir(parentDirectory)
		if (entries.includes(entryName)) {
			return entryName
		}
		const lowered = entryName.toLowerCase()
		const matches = entries.filter((entry) => entry.toLowerCase() === lowered)
		// Ambiguous only on case-sensitive filesystems holding several spellings;
		// without further information the caller's spelling stays authoritative.
		return matches.length === 1 ? matches[0] : entryName
	} catch {
		return entryName
	}
}

/** Resolve one file against the canonical worktree, including symlinked parent directories. */
export async function resolveCheckpointWorktreePath(
	worktree: string,
	filePath: string,
): Promise<CheckpointWorktreePath | undefined> {
	const canonicalWorktree = await canonicalizeDirectory(worktree)
	const absoluteInput = path.resolve(filePath)
	const canonicalParent = await canonicalizeDirectory(path.dirname(absoluteInput))
	const entryName = await restoreEntryNameCase(canonicalParent, path.basename(absoluteInput))
	const absolute = path.resolve(canonicalParent, entryName)
	const relative = path.relative(canonicalWorktree, absolute)
	if (!relative || isOutsideDirectory(relative)) return undefined
	return { absolute, relative: relative.split(path.sep).join("/") }
}

/**
 * GitOperations Class
 *
 * Handles git-specific operations for Cline's Checkpoints system.
 *
 * Key responsibilities:
 * - Git repository initialization and configuration
 * - Git settings management (user, LFS, etc.)
 * - Worktree configuration and management
 * - Excluding nested repository ownership boundaries
 * - File staging and checkpoint creation
 * - Shadow git repository maintenance and cleanup
 */
export class GitOperations {
	private cwd: string
	/**
	 * Resolves nested repository ownership per file.
	 *
	 * Ownership must be resolved lazily: a submodule or linked worktree can be
	 * created at any point during a task, and `git add -f` bypasses the shadow
	 * `info/exclude` rules, so this detector is the only guard on the tracked
	 * staging path.
	 */
	private boundaryDetector: NestedRepositoryBoundaryDetector

	/**
	 * Creates a new GitOperations instance.
	 *
	 * @param cwd - The current working directory for git operations
	 */
	constructor(cwd: string) {
		this.cwd = cwd
		this.boundaryDetector = new NestedRepositoryBoundaryDetector(cwd)
	}

	/**
	 * Initializes or verifies a shadow Git repository for checkpoint tracking.
	 * Creates a new repository if one doesn't exist, or verifies the worktree
	 * configuration if it does.
	 *
	 * Key operations:
	 * - Creates/verifies shadow git repository
	 * - Configures git settings (user, LFS, etc.)
	 * - Sets up worktree to point to workspace
	 *
	 * @param gitPath - Path to the .git directory
	 * @param cwd - The current working directory for git operations
	 * @returns Promise<string> Path to the initialized .git directory
	 * @throws Error if:
	 * - Worktree verification fails for existing repository
	 * - Git initialization or configuration fails
	 * - Unable to create initial commit
	 * - LFS pattern setup fails
	 */
	public async initShadowGit(gitPath: string, cwd: string, taskId: string): Promise<string> {
		Logger.info(`Initializing shadow git`)

		// Load workspace-level ignore rules (.gitignore + .dlineignore) so that
		// directories already ignored by the user (e.g. tmp/) are also excluded
		// from shadow git info/exclude and the nested-git filesystem scan.
		const workspaceIgnoreContent = await loadWorkspaceIgnoreContent(cwd).catch((error) => {
			Logger.warn("CheckpointTracker failed to load workspace ignore files:", error)
			return ""
		})
		const topology = await detectCheckpointWorkspaceTopology(cwd)
		// The scan only seeds already-known boundaries; per-file detection stays
		// authoritative so repositories created later are still recognised.
		this.boundaryDetector.seed(topology.boundaries.map((boundary) => boundary.relativePath))
		Logger.info(
			`[Task ${taskId}] Checkpoint workspace topology: relation=${topology.repository.relation}, ` +
				`head=${topology.repository.head}, boundaries=${topology.boundaries.length}`,
		)

		// If repo exists, verify it is a shadow git and self-heal config
		if (await fileExistsAtPath(gitPath)) {
			const git = simpleGit(path.dirname(gitPath))

			// Safety: only allow git repos under the dline checkpoints directory.
			// This prevents the checkpoint system from ever operating on real project repos.
			const checkpointsBaseDir = await getDlineCheckpointsDir()
			const normalizedGitPath = path.resolve(gitPath)
			const normalizedBaseDir = path.resolve(checkpointsBaseDir)
			if (!normalizedGitPath.startsWith(normalizedBaseDir + path.sep)) {
				Logger.error(
					`Refusing to use non-shadow git at ${gitPath} for checkpoints. ` +
						`Expected path under ${checkpointsBaseDir}. ` +
						`This protects real project repositories from checkpoint pollution.`,
				)
				throw new Error(
					`Checkpoints can only operate on dedicated shadow repositories. ` +
						`The git at ${gitPath} is not a checkpoint shadow repo.`,
				)
			}

			// Detect incomplete shadow repos (git init was interrupted).
			// An incomplete .git skeleton causes git commands to fall through
			// to parent repositories, polluting real project repos.
			const headPath = path.join(gitPath, "HEAD")
			if (!(await fileExistsAtPath(headPath))) {
				Logger.warn(
					`Shadow git at ${gitPath} is incomplete (missing HEAD) — removing broken skeleton and reinitializing.`,
				)
				await fs.rm(gitPath, { recursive: true, force: true })
				// Fall through to the "initialize new repo" branch below
			} else {
				// Self-heal: ensure shadow git identity markers (user.name/email)
				// are set correctly before any operations.
				await this.ensureShadowGitIdentity(git)

				// Self-heal: ensure core.worktree matches current workspace.
				const worktree = await git.getConfig("core.worktree")
				if (!worktree.value) {
					Logger.warn(`Shadow git core.worktree is not set — configuring to ${cwd}`)
					await git.addConfig("core.worktree", cwd)
				} else if (worktree.value !== cwd) {
					Logger.error(
						`Shadow git core.worktree mismatch: stored="${worktree.value}", current="${cwd}". ` +
							`Auto-correcting to current workspace.`,
					)
					await git.addConfig("core.worktree", cwd)
				}
				Logger.warn(`Using existing shadow git at ${gitPath}`)

				// shadow git repo already exists, but update the excludes just in case
				const excludes = await writeExcludesFile(
					gitPath,
					await getLfsPatterns(this.cwd),
					workspaceIgnoreContent || undefined,
					topology.exclusionPatterns,
				)
				await this.refreshExistingShadowBaseline(git, taskId, excludes.changed)

				return gitPath
			}
		}

		// Initialize new repo
		const startTime = performance.now()
		const checkpointsDir = path.dirname(gitPath)
		Logger.warn(`Creating new shadow git in ${checkpointsDir}`)

		const git = simpleGit(checkpointsDir)
		await git.init()

		// Configure repo with git settings
		await git.addConfig("core.worktree", cwd)
		await git.addConfig("commit.gpgSign", "false")
		await git.addConfig("user.name", "Dline Checkpoint")
		await git.addConfig("user.email", "checkpoint@dline.bot")

		// Set up LFS patterns
		const lfsPatterns = await getLfsPatterns(cwd)
		await writeExcludesFile(gitPath, lfsPatterns, workspaceIgnoreContent || undefined, topology.exclusionPatterns)

		const addFilesResult = await this.addCheckpointFiles({ git, mode: "baseline", taskId })
		if (!addFilesResult.success) {
			Logger.error("Failed to add at least one file(s) to checkpoints shadow git")
			throw new Error("Failed to add at least one file(s) to checkpoints shadow git")
		}

		// Initial commit only on first repo creation
		await git.commit("initial commit", { "--allow-empty": null, "--no-verify": null })

		const durationMs = Math.round(performance.now() - startTime)
		telemetryService.captureCheckpointUsage(taskId, "shadow_git_initialized", durationMs)

		Logger.warn(`Shadow git initialization completed`)

		return gitPath
	}

	/**
	 * Bring an existing baseline up to date with the current workspace, resetting
	 * its index to HEAD on failure.
	 *
	 * The staging mode is chosen by whether the exclusion ruleset changed:
	 *
	 * - Changed rules can make already-indexed files invalid, so the index must be
	 *   discarded and rebuilt (`baseline`) to drop newly excluded entries.
	 * - Unchanged rules leave every indexed entry valid, so the index stat cache is
	 *   preserved and only modified files are re-hashed (`workspace-scan`). On a
	 *   large repository this is the difference between re-hashing every tracked
	 *   file and touching only what actually changed.
	 *
	 * Both paths stage the whole worktree, so a workspace edit made between tasks
	 * is captured either way.
	 */
	private async refreshExistingShadowBaseline(git: SimpleGit, taskId: string, exclusionsChanged: boolean): Promise<void> {
		const startedAt = performance.now()
		const mode = exclusionsChanged ? "baseline" : "workspace-scan"
		try {
			const baselineResult = await this.addCheckpointFiles({ git, mode, taskId })
			if (!baselineResult.success) {
				throw new Error("Failed to refresh the existing checkpoints shadow baseline")
			}
			const stageMs = Math.round(performance.now() - startedAt)
			const detectStartedAt = performance.now()
			const staged = await this.hasStagedChanges(git, taskId)
			const detectMs = Math.round(performance.now() - detectStartedAt)
			const commitStartedAt = performance.now()
			if (staged) {
				await git.commit(`workspace baseline-${taskId}`, { "--no-verify": null })
				Logger.info(`[Task ${taskId}] Refreshed existing checkpoints shadow baseline`)
			}
			// Only bounded dimensions are reported. The stage, detect and commit
			// durations are unbounded numerics that would each become their own
			// Prometheus label; they stay in the debug line below, which is not
			// subject to cardinality limits.
			recordPerfPhase(
				PerfDomain.Checkpoint,
				"existing_shadow_baseline",
				performance.now() - startedAt,
				{ mode, exclusionsChanged, staged },
				{ taskId },
			)
			if (Logger.isDebugEnabled()) {
				Logger.debug(
					`[CheckpointPerf] phase=existing_shadow_baseline taskId=${taskId} mode=${mode} exclusionsChanged=${exclusionsChanged} stageMs=${stageMs} detectMs=${detectMs} commitMs=${Math.round(performance.now() - commitStartedAt)} totalMs=${Math.round(performance.now() - startedAt)} staged=${staged}`,
				)
			}
		} catch (error) {
			try {
				// Initialization never owns staged user work: discard both this
				// attempt and residue left by an older interrupted refresh.
				await git.raw(["read-tree", "--reset", "HEAD"])
			} catch (rollbackError) {
				Logger.error(`[Task ${taskId}] Failed to restore shadow index after baseline refresh failure:`, rollbackError)
			}
			throw error
		}
	}

	/**
	 * Ensures the shadow git identity markers are set to Dline branding.
	 * This prevents commits from leaking the user's global git identity
	 * into checkpoint history. Safe to call before any git commit in a
	 * shadow repository.
	 *
	 * @param git - SimpleGit instance pointing to the shadow git
	 */
	public async ensureShadowGitIdentity(git: SimpleGit): Promise<void> {
		const userName = await git.getConfig("user.name")
		if (userName.value !== "Dline Checkpoint") {
			Logger.warn(`Shadow git user.name is "${userName.value}" — resetting to Dline Checkpoint`)
			await git.addConfig("user.name", "Dline Checkpoint")
		}
		const userEmail = await git.getConfig("user.email")
		if (userEmail.value !== "checkpoint@dline.bot") {
			Logger.warn(`Shadow git user.email is "${userEmail.value}" — resetting to checkpoint@dline.bot`)
			await git.addConfig("user.email", "checkpoint@dline.bot")
		}
	}

	/**
	 * Retrieves the worktree path from the shadow git configuration.
	 * The worktree path indicates where the shadow git repository is tracking files,
	 * which should match the current workspace directory.
	 *
	 * @param gitPath - Path to the .git directory
	 * @returns Promise<string | undefined> The worktree path or undefined if not found
	 * @throws Error if unable to get worktree path
	 */
	public async getShadowGitConfigWorkTree(gitPath: string): Promise<string | undefined> {
		try {
			const git = simpleGit(path.dirname(gitPath))
			const worktree = await git.getConfig("core.worktree")
			return worktree.value || undefined
		} catch (error) {
			Logger.error("Failed to get shadow git config worktree:", error)
			return undefined
		}
	}

	/**
	 * Adds files to the shadow git repository while handling nested git repos.
	 * Uses git commands to list files and stages them for commit.
	 * Respects .gitignore and handles LFS patterns.
	 *
	 * Process:
	 * 1. Uses shadow-repository exclusions for workspace scans
	 * 2. Filters tracked files owned by nested repository boundaries
	 * 3. Stages the remaining explicit files or the root workspace
	 *
	 * @param git - SimpleGit instance configured for the shadow git repo
	 * @param fileList - Optional list of file paths to add. When provided, only
	 *                   these files are staged. When omitted, all files are staged
	 *                   via `git add .` (backward compatible).
	 * @param taskId - Optional task ID for logging purposes
	 * @returns Promise<CheckpointAddResult> Object containing success status
	 * @throws Error if file staging cannot be attempted
	 */
	public async addCheckpointFiles(options: AddCheckpointFilesOptions): Promise<CheckpointAddResult> {
		const { git, mode, fileList, taskId } = options
		const explicitFiles = fileList ?? []
		const startTime = performance.now()
		const reportFailure = (reason: CheckpointAddFailureReason, error?: unknown): CheckpointAddResult => {
			recordPerfPhase(
				PerfDomain.Checkpoint,
				"add",
				performance.now() - startTime,
				{ mode, outcome: "failure" satisfies CheckpointAddOutcome, reason },
				{ taskId },
			)
			recordDiagnostic(DiagnosticDomain.Checkpoint, "add_failed", DiagnosticOutcome.Failed, { mode, reason }, { taskId })
			if (error !== undefined) {
				Logger.error(`[Task ${taskId}] Checkpoint add operation failed (${mode}, ${reason}):`, error)
			}
			return { success: false, stagedCount: 0, rejectedPaths: [] }
		}
		// Staging nothing is a normal outcome rather than a failure, but it still
		// has to be reported: without it the add metric loses calls entirely and
		// the failure ratio is computed against an incomplete denominator.
		const reportNothingToStage = (rejectedPaths: string[]): CheckpointAddResult => {
			recordPerfPhase(
				PerfDomain.Checkpoint,
				"add",
				performance.now() - startTime,
				{ mode, outcome: "nothing_to_stage" satisfies CheckpointAddOutcome },
				{ taskId },
			)
			return { success: true, stagedCount: 0, rejectedPaths }
		}
		if (mode === "tracked" && explicitFiles.length === 0) {
			Logger.error(`[Task ${taskId}] tracked checkpoint add requires explicit files`)
			return reportFailure("invalid_request")
		}
		if ((mode === "baseline" || mode === "workspace-scan") && explicitFiles.length > 0) {
			Logger.error(`[Task ${taskId}] ${mode} checkpoint add must not receive explicit fileList`)
			return reportFailure("invalid_request")
		}
		Logger.info(`[Task ${taskId}] Starting checkpoint add operation (${mode})...`)
		try {
			if (mode === "tracked") {
				const resolvedFiles = await Promise.all(
					explicitFiles.map((file) => resolveCheckpointWorktreePath(this.cwd, file)),
				)
				if (resolvedFiles.some((file) => file === undefined)) {
					Logger.error(`[Task ${taskId}] Checkpoint add rejected a tracked path outside ${this.cwd}`)
					return reportFailure("path_outside_worktree")
				}
				const ownedFiles = resolvedFiles as CheckpointWorktreePath[]
				const nestedOwnership = await Promise.all(
					ownedFiles.map((file) => this.boundaryDetector.isInsideNestedRepository(file.absolute)),
				)
				const nestedFiles = ownedFiles.filter((_file, index) => nestedOwnership[index])
				const safeFiles = ownedFiles.filter((_file, index) => !nestedOwnership[index])
				if (nestedFiles.length > 0) {
					recordDiagnostic(
						DiagnosticDomain.Checkpoint,
						"nested_repository_skipped",
						DiagnosticOutcome.Degraded,
						{ excluded: nestedFiles.length, total: ownedFiles.length },
						{ taskId },
					)
					Logger.warn(`[Task ${taskId}] Checkpoint add excluded ${nestedFiles.length} nested repository file(s)`)
				}
				if (safeFiles.length === 0) {
					// Every tracked file lives in a submodule or linked worktree.
					// That is a normal situation, not a staging failure: the caller
					// must be able to drop these paths and continue.
					Logger.debug(
						`[Task ${taskId}] Checkpoint add staged nothing: all tracked files belong to nested repositories`,
					)
					return reportNothingToStage(nestedFiles.map((file) => file.relative))
				}

				const existence = await Promise.all(safeFiles.map((file) => fileExistsAtPath(file.absolute)))
				const missingFiles = safeFiles.filter((_file, index) => !existence[index])
				let indexedPaths = new Set<string>()
				if (missingFiles.length > 0) {
					const output = await git.raw(["ls-files", "-z"])
					indexedPaths = new Set(
						output
							.split("\0")
							.filter(Boolean)
							.map((file) => this.normalizeGitPath(file)),
					)
				}
				const stageFiles = safeFiles.filter(
					(file, index) => existence[index] || indexedPaths.has(this.normalizeGitPath(file.relative)),
				)
				const absentPaths = safeFiles.filter((file) => !stageFiles.includes(file)).map((file) => file.relative)
				if (absentPaths.length > 0) {
					recordDiagnostic(
						DiagnosticDomain.Checkpoint,
						"paths_unstageable",
						DiagnosticOutcome.Degraded,
						{ absent: absentPaths.length, total: safeFiles.length },
						{ taskId },
					)
					Logger.warn(
						`[Task ${taskId}] Checkpoint add ignored ${absentPaths.length} path(s) absent from both worktree and shadow index`,
					)
				}
				// Absent and nested paths can never be staged; reporting them lets the
				// caller drop them instead of replaying the same batch forever.
				const unstageablePaths = [...nestedFiles.map((file) => file.relative), ...absentPaths]
				if (stageFiles.length === 0) {
					Logger.debug(
						`[Task ${taskId}] Checkpoint add staged nothing: no tracked path exists in the worktree or shadow index`,
					)
					return reportNothingToStage(unstageablePaths)
				}
				const staging = await this.stageInBatches(
					git,
					stageFiles.map((file) => file.relative),
					taskId,
				)
				const durationMs = performance.now() - startTime
				// A batch Git refused still yields a usable checkpoint from the
				// paths that did stage, so the two are reported as different
				// outcomes rather than both as plain success.
				const rejectedPaths = [...unstageablePaths, ...staging.rejectedPaths]
				const outcome: CheckpointAddOutcome =
					staging.stagedCount === 0 && rejectedPaths.length > 0
						? "failure"
						: rejectedPaths.length > 0
							? "partial"
							: "success"
				recordPerfPhase(
					PerfDomain.Checkpoint,
					"add",
					durationMs,
					{
						mode,
						outcome,
						...(outcome === "failure" ? { reason: "staging_rejected" satisfies CheckpointAddFailureReason } : {}),
					},
					{ taskId },
				)
				if (outcome === "failure") {
					recordDiagnostic(
						DiagnosticDomain.Checkpoint,
						"add_failed",
						DiagnosticOutcome.Failed,
						{ mode, reason: "staging_rejected" },
						{ taskId },
					)
				}
				if (Logger.isDebugEnabled()) {
					Logger.debug(`Checkpoint add operation completed in ${Math.round(durationMs)}ms`)
				}
				return {
					// Only a total staging failure is a failure: partial progress still
					// produces a usable checkpoint once the bad paths are dropped.
					success: staging.stagedCount > 0 || staging.rejectedPaths.length === 0,
					stagedCount: staging.stagedCount,
					rejectedPaths,
				}
			}
			if (mode === "baseline") {
				// Rebuild the complete index so newly ignored or newly excluded files
				// are removed from the current baseline as well as omitted from additions.
				recordDiagnostic(DiagnosticDomain.Checkpoint, "baseline_rebuilt", DiagnosticOutcome.Observed, undefined, {
					taskId,
				})
				await git.raw(["read-tree", "--empty"])
			}
			await git.add([".", "--ignore-errors"])
			const durationMs = performance.now() - startTime
			recordPerfPhase(
				PerfDomain.Checkpoint,
				"add",
				durationMs,
				{ mode, outcome: "success" satisfies CheckpointAddOutcome },
				{ taskId },
			)
			if (Logger.isDebugEnabled()) {
				Logger.debug(`[Task ${taskId}] Checkpoint add operation: staged workspace via ${mode}`)
				Logger.debug(`Checkpoint add operation completed in ${Math.round(durationMs)}ms`)
			}
			return { success: true, stagedCount: 0, rejectedPaths: [] }
		} catch (error) {
			return reportFailure("git_error", error)
		}
	}

	/**
	 * Stage worktree-relative paths in bounded batches, isolating rejects.
	 *
	 * A batch that Git refuses is retried one path at a time so a single
	 * unstageable entry cannot discard the rest of the checkpoint.
	 */
	private async stageInBatches(
		git: SimpleGit,
		relativePaths: string[],
		taskId?: string,
	): Promise<{ stagedCount: number; rejectedPaths: string[] }> {
		let stagedCount = 0
		const rejectedPaths: string[] = []

		for (const batch of this.splitIntoPathspecBatches(relativePaths)) {
			try {
				await git.add(["-A", "-f", "--", ...batch.map(toLiteralGitPathspec)])
				stagedCount += batch.length
				continue
			} catch (error) {
				if (batch.length === 1) {
					rejectedPaths.push(batch[0])
					Logger.warn(`[Task ${taskId}] Checkpoint add rejected '${batch[0]}':`, error)
					continue
				}
				Logger.warn(
					`[Task ${taskId}] Checkpoint add batch of ${batch.length} path(s) failed; isolating rejected paths`,
					error,
				)
			}
			for (const relativePath of batch) {
				try {
					await git.add(["-A", "-f", "--", toLiteralGitPathspec(relativePath)])
					stagedCount += 1
				} catch (error) {
					rejectedPaths.push(relativePath)
					Logger.warn(`[Task ${taskId}] Checkpoint add rejected '${relativePath}':`, error)
				}
			}
		}

		Logger.debug(
			`[Task ${taskId}] Checkpoint add operation: staged ${stagedCount} tracked file(s), rejected ${rejectedPaths.length}`,
		)
		return { stagedCount, rejectedPaths }
	}

	/** Split paths so each batch stays within the count and command-line budgets. */
	private splitIntoPathspecBatches(relativePaths: string[]): string[][] {
		const batches: string[][] = []
		let current: string[] = []
		let currentBytes = 0

		for (const relativePath of relativePaths) {
			const cost = Buffer.byteLength(toLiteralGitPathspec(relativePath), "utf8") + 1
			const exceedsBudget = current.length >= MAX_PATHS_PER_ADD || currentBytes + cost > MAX_PATHSPEC_BYTES_PER_ADD
			if (current.length > 0 && exceedsBudget) {
				batches.push(current)
				current = []
				currentBytes = 0
			}
			current.push(relativePath)
			currentBytes += cost
		}
		if (current.length > 0) {
			batches.push(current)
		}
		return batches
	}

	private normalizeGitPath(filePath: string): string {
		const normalized = filePath.replaceAll("\\", "/")
		return process.platform === "win32" ? normalized.toLowerCase() : normalized
	}

	/**
	 * Check whether the shadow git worktree has unstaged or untracked changes.
	 *
	 * @param git SimpleGit instance configured for the shadow repository.
	 * @param taskId Optional task ID for logging.
	 * @returns true when workspace changes exist.
	 */
	public async hasWorkspaceChanges(git: SimpleGit, taskId?: string): Promise<boolean> {
		try {
			const output = await git.raw(["status", "--porcelain", "--untracked-files=all"])
			const hasChanges = output.trim().length > 0
			Logger.debug(`[Task ${taskId}] Workspace change preflight: ${hasChanges ? "changes detected" : "clean"}`)
			return hasChanges
		} catch (error) {
			Logger.warn(`[Task ${taskId}] Workspace change preflight failed; assuming changes exist:`, error)
			return true
		}
	}

	/**
	 * Check whether the shadow git index has staged changes ready to commit.
	 *
	 * @param git SimpleGit instance configured for the shadow repository.
	 * @param taskId Optional task ID for logging.
	 * @returns true when staged changes exist.
	 */
	public async hasStagedChanges(git: SimpleGit, taskId?: string): Promise<boolean> {
		try {
			const output = await git.raw(["diff", "--cached", "--name-only"])
			const hasChanges = output.trim().length > 0
			Logger.debug(
				`[Task ${taskId}] ${hasChanges ? "Staged checkpoint changes detected" : "No staged checkpoint changes detected"}`,
			)
			return hasChanges
		} catch (error) {
			Logger.warn(`[Task ${taskId}] Failed to inspect staged checkpoint changes:`, error)
			return true
		}
	}
}
