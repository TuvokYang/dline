import { type CheckpointReferenceSet, createCheckpointReferenceSet, getCheckpointHashForWorkspace } from "@shared/checkpoints"
import type { WorkspaceRoot } from "@shared/multi-root/types"
import * as path from "path"
import { Logger } from "@/shared/services/Logger"
import CheckpointTracker, { type CheckpointChangedFile } from "./CheckpointTracker"
import type { TaskFileTracker } from "./TaskFileTracker"

export interface CheckpointRestoreFailure {
	workspacePath: string
	reason: string
}

export interface CheckpointRestoreOutcome {
	restoredWorkspacePaths: string[]
	restoredReferences: CheckpointReferenceSet
	failures: CheckpointRestoreFailure[]
}

export interface CheckpointDiffOutcome {
	changedFiles: CheckpointChangedFile[]
	failures: CheckpointRestoreFailure[]
}

export interface CheckpointCountOutcome {
	count: number
	failures: CheckpointRestoreFailure[]
}

interface CheckpointUnit {
	root: WorkspaceRoot
	tracker?: CheckpointTracker
	initializationError?: string
	currentHash?: string
}

export interface CheckpointUnitCoordinatorOptions {
	taskId: string
	enableCheckpoints: boolean
	roots: WorkspaceRoot[]
	primaryRootIndex: number
	taskFileTracker?: TaskFileTracker
	createCheckpointTracker?: (
		taskId: string,
		enableCheckpoints: boolean,
		workspacePath: string,
	) => Promise<CheckpointTracker | undefined>
}

/**
 * Coordinates one isolated shadow tracker per workspace root while keeping chat
 * checkpoint ownership in TaskCheckpointManager.
 */
export class CheckpointUnitCoordinator {
	private readonly units: CheckpointUnit[]
	private readonly createCheckpointTracker: NonNullable<CheckpointUnitCoordinatorOptions["createCheckpointTracker"]>
	private initializationPromise?: Promise<void>

	constructor(private readonly options: CheckpointUnitCoordinatorOptions) {
		this.units = options.roots.map((root) => ({ root }))
		this.createCheckpointTracker = options.createCheckpointTracker ?? CheckpointTracker.create
	}

	get workspaceRoots(): string[] {
		return this.units.map((unit) => unit.root.path)
	}

	get primaryTracker(): CheckpointTracker | undefined {
		return this.units[this.options.primaryRootIndex]?.tracker ?? this.units.find((unit) => unit.tracker)?.tracker
	}

	get hasReadyUnit(): boolean {
		return this.units.some((unit) => unit.tracker !== undefined)
	}

	get initializationFailures(): CheckpointRestoreFailure[] {
		return this.units.flatMap((unit) =>
			unit.initializationError ? [{ workspacePath: unit.root.path, reason: unit.initializationError }] : [],
		)
	}

	async initialize(forceRetry = false): Promise<void> {
		if (this.initializationPromise) {
			return await this.initializationPromise
		}
		this.initializationPromise = this.initializeUnits(forceRetry)
		try {
			await this.initializationPromise
		} finally {
			this.initializationPromise = undefined
		}
	}

	private async initializeUnits(forceRetry: boolean): Promise<void> {
		await Promise.all(
			this.units.map(async (unit) => {
				if (unit.tracker || (unit.initializationError && !forceRetry)) {
					return
				}
				try {
					const tracker = await this.createCheckpointTracker(
						this.options.taskId,
						this.options.enableCheckpoints,
						unit.root.path,
					)
					unit.tracker = tracker
					unit.initializationError = tracker ? undefined : "Checkpoint tracker was not created"
				} catch (error) {
					unit.initializationError = error instanceof Error ? error.message : String(error)
					Logger.error(`[CheckpointUnitCoordinator] Failed to initialize workspace ${unit.root.path}:`, error)
				}
			}),
		)
	}

	async commit(): Promise<CheckpointReferenceSet | undefined> {
		if (!this.options.enableCheckpoints) {
			return undefined
		}
		await this.initialize()
		const modifiedFiles = this.options.taskFileTracker?.getModifiedFiles() ?? []
		const scanRequired = this.options.taskFileTracker?.isWorkspaceScanRequired() ?? false
		const filesByRoot = this.groupFilesByRoot(modifiedFiles)
		const successfullyRecordedFiles: string[] = []
		const checkpointHashes = this.units.map(() => "")
		let everyReadyUnitSucceeded = true

		await Promise.all(
			this.units.map(async (unit, index) => {
				const tracker = unit.tracker
				if (!tracker) {
					everyReadyUnitSucceeded = false
					return
				}
				const files = filesByRoot.get(index) ?? []
				if (unit.currentHash && modifiedFiles.length > 0 && files.length === 0 && !scanRequired) {
					checkpointHashes[index] = unit.currentHash
					return
				}
				const previousHash = unit.currentHash
				try {
					const hash = await tracker.commitForFiles(files, { forceWorkspaceScan: scanRequired })
					if (!hash) {
						everyReadyUnitSucceeded = false
						return
					}
					const scannedFiles =
						scanRequired && previousHash && previousHash !== hash ? await tracker.getDiffSet(previousHash, hash) : []
					const ownedScannedFiles = scannedFiles
						.filter((file) => this.findOwnerIndex(file.absolutePath) === index)
						.map((file) => file.absolutePath)
					for (const file of ownedScannedFiles) {
						this.options.taskFileTracker?.trackModification(file)
					}
					unit.currentHash = hash
					checkpointHashes[index] = hash
					successfullyRecordedFiles.push(...files, ...ownedScannedFiles)
				} catch (error) {
					everyReadyUnitSucceeded = false
					Logger.error(`[CheckpointUnitCoordinator] Failed to checkpoint workspace ${unit.root.path}:`, error)
				}
			}),
		)

		if (successfullyRecordedFiles.length > 0) {
			this.options.taskFileTracker?.dropModifiedFiles(successfullyRecordedFiles)
		}
		if (scanRequired && everyReadyUnitSucceeded) {
			this.options.taskFileTracker?.clearWorkspaceScanRequired()
		}

		const referenceSet = createCheckpointReferenceSet(checkpointHashes, this.workspaceRoots)
		return referenceSet.hashes.some(Boolean) ? referenceSet : undefined
	}

	async restore(referenceSet: CheckpointReferenceSet, taskFiles: readonly string[]): Promise<CheckpointRestoreOutcome> {
		await this.initialize()
		const filesByRoot = this.groupFilesByRoot(taskFiles)
		const restoreTrackedFilesOnly = taskFiles.length > 0
		const restoredWorkspacePaths: string[] = []
		const restoredHashes = this.units.map(() => "")
		const failures: CheckpointRestoreFailure[] = this.getMissingWorkspaceFailures(referenceSet)

		for (let index = 0; index < this.units.length; index++) {
			const unit = this.units[index]
			const hash = getCheckpointHashForWorkspace(referenceSet, unit.root.path, index)
			if (!hash) {
				continue
			}
			if (!unit.tracker) {
				failures.push({
					workspacePath: unit.root.path,
					reason: unit.initializationError ?? "Checkpoint tracker unavailable",
				})
				continue
			}
			const files = filesByRoot.get(index) ?? []
			if (restoreTrackedFilesOnly && files.length === 0) {
				continue
			}
			try {
				if (restoreTrackedFilesOnly) {
					await unit.tracker.restoreFiles(hash, files)
				} else {
					await unit.tracker.resetHead(hash)
				}
				unit.currentHash = hash
				restoredHashes[index] = hash
				restoredWorkspacePaths.push(unit.root.path)
			} catch (error) {
				failures.push({
					workspacePath: unit.root.path,
					reason: error instanceof Error ? error.message : String(error),
				})
			}
		}
		return {
			restoredWorkspacePaths,
			restoredReferences: createCheckpointReferenceSet(restoredHashes, this.workspaceRoots),
			failures,
		}
	}

	async getDiffSet(
		target: CheckpointReferenceSet,
		base?: CheckpointReferenceSet,
		taskOwnedOnly = false,
	): Promise<CheckpointDiffOutcome> {
		await this.initialize()
		const failures = this.getMissingWorkspaceFailures(target)
		const results = await Promise.all(
			this.units.map(async (unit, index) => {
				const targetHash = getCheckpointHashForWorkspace(target, unit.root.path, index)
				if (!targetHash) {
					return []
				}
				const tracker = unit.tracker
				if (!tracker) {
					failures.push({
						workspacePath: unit.root.path,
						reason: unit.initializationError ?? "Checkpoint tracker unavailable",
					})
					return []
				}
				const baseHash = base ? getCheckpointHashForWorkspace(base, unit.root.path, index) : undefined
				try {
					if (taskOwnedOnly) {
						return baseHash ? await tracker.getTaskDiffSet(baseHash, targetHash) : []
					}
					return baseHash ? await tracker.getDiffSet(baseHash, targetHash) : await tracker.getDiffSet(targetHash)
				} catch (error) {
					failures.push({
						workspacePath: unit.root.path,
						reason: error instanceof Error ? error.message : String(error),
					})
					return []
				}
			}),
		)
		return { changedFiles: results.flat(), failures }
	}

	async getTaskDiffCount(base: CheckpointReferenceSet, target: CheckpointReferenceSet): Promise<CheckpointCountOutcome> {
		await this.initialize()
		const failures = this.getMissingWorkspaceFailures(target)
		const counts = await Promise.all(
			this.units.map(async (unit, index) => {
				const baseHash = getCheckpointHashForWorkspace(base, unit.root.path, index)
				const targetHash = getCheckpointHashForWorkspace(target, unit.root.path, index)
				if (!baseHash || !targetHash) {
					return 0
				}
				const tracker = unit.tracker
				if (!tracker) {
					failures.push({
						workspacePath: unit.root.path,
						reason: unit.initializationError ?? "Checkpoint tracker unavailable",
					})
					return 0
				}
				try {
					return await tracker.getTaskDiffCount(baseHash, targetHash)
				} catch (error) {
					failures.push({
						workspacePath: unit.root.path,
						reason: error instanceof Error ? error.message : String(error),
					})
					return 0
				}
			}),
		)
		return { count: counts.reduce((total, count) => total + count, 0), failures }
	}

	getConsecutiveStagingFailures(): number {
		return Math.max(0, ...this.units.map((unit) => unit.tracker?.getConsecutiveStagingFailures() ?? 0))
	}

	private getMissingWorkspaceFailures(referenceSet: CheckpointReferenceSet): CheckpointRestoreFailure[] {
		if (referenceSet.workspaceRoots.length === 0) {
			return []
		}
		const activeRoots = new Set(this.workspaceRoots.map((workspaceRoot) => this.normalizeWorkspacePath(workspaceRoot)))
		return referenceSet.workspaceRoots.flatMap((workspaceRoot, index) => {
			const hash = referenceSet.hashes[index]
			return hash && !activeRoots.has(this.normalizeWorkspacePath(workspaceRoot))
				? [{ workspacePath: workspaceRoot, reason: "Workspace root is not currently open" }]
				: []
		})
	}

	private normalizeWorkspacePath(workspacePath: string): string {
		const resolved = path.resolve(workspacePath)
		return process.platform === "win32" ? resolved.toLowerCase() : resolved
	}

	private groupFilesByRoot(files: readonly string[]): Map<number, string[]> {
		const grouped = new Map<number, string[]>()
		for (const file of files) {
			const resolvedFile = path.resolve(file)
			const ownerIndex = this.findOwnerIndex(resolvedFile)
			if (ownerIndex < 0) {
				Logger.warn(`[CheckpointUnitCoordinator] Ignoring tracked path outside every workspace root: ${resolvedFile}`)
				continue
			}
			const existing = grouped.get(ownerIndex)
			if (existing) existing.push(resolvedFile)
			else grouped.set(ownerIndex, [resolvedFile])
		}
		return grouped
	}

	private findOwnerIndex(filePath: string): number {
		const resolvedFile = path.resolve(filePath)
		let ownerIndex = -1
		let ownerLength = -1
		for (let index = 0; index < this.units.length; index++) {
			const rootPath = this.units[index].root.path
			const relative = path.relative(rootPath, resolvedFile)
			if (!relative.startsWith("..") && !path.isAbsolute(relative) && rootPath.length > ownerLength) {
				ownerIndex = index
				ownerLength = rootPath.length
			}
		}
		return ownerIndex
	}
}
