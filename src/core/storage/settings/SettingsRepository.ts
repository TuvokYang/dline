import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import * as path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { Logger } from "@shared/services/Logger"
import { writeJsonAtomic } from "@shared/storage/atomic-file"
import type { Settings, SettingsKey } from "@shared/storage/state-keys"
import { SettingsKeys } from "@shared/storage/state-keys"
import chokidar, { type FSWatcher } from "chokidar"
import { recordPerfPhase } from "@/services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "@/services/telemetry/instrumentation/perf-domains"
import { FileLock } from "../backend/jsonl/FileLock"
import {
	SETTINGS_REPOSITORY_SCHEMA_VERSION,
	type SettingsCommit,
	type SettingsCommitListener,
	type SettingsRepositoryOptions,
	type SettingsSnapshot,
} from "./settings-types"
import { applySettingsPatch, buildPersistedSettingsDocument, parseSettingsDocument } from "./settings-validation"

const SETTINGS_KEY_SET = new Set<string>(SettingsKeys as string[])

function cloneValues(values: Settings): Settings {
	return JSON.parse(JSON.stringify(values)) as Settings
}

function contentHash(values: Settings): string {
	return createHash("sha256").update(JSON.stringify(values)).digest("hex")
}

function snapshot(values: Settings, revision: number): SettingsSnapshot {
	const cloned = cloneValues(values)
	return Object.freeze({
		schemaVersion: SETTINGS_REPOSITORY_SCHEMA_VERSION,
		revision,
		values: Object.freeze(cloned),
		contentHash: contentHash(cloned),
	})
}

function changedKeys(previous: Settings, next: Settings): SettingsKey[] {
	const keys = new Set([...Object.keys(previous), ...Object.keys(next)])
	return [...keys]
		.filter((key) => SETTINGS_KEY_SET.has(key) && !isDeepStrictEqual(previous[key as SettingsKey], next[key as SettingsKey]))
		.sort() as SettingsKey[]
}

async function readDocument(filePath: string): Promise<Record<string, unknown>> {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
		throw error
	}
}

export class SettingsRepository {
	private readonly fileLock = new FileLock()
	private readonly filePath: string
	private readonly listeners = new Set<SettingsCommitListener>()
	private readonly sourceId: string
	private readonly watchEnabled: boolean
	private currentSnapshot = snapshot({} as Settings, 0)
	private initialized = false
	private disposed = false
	private operationQueue: Promise<void> = Promise.resolve()
	private watcher?: FSWatcher

	constructor(options: SettingsRepositoryOptions) {
		this.filePath = options.filePath
		this.sourceId = options.sourceId ?? randomUUID()
		this.watchEnabled = options.watch ?? true
	}

	async initialize(): Promise<SettingsSnapshot> {
		if (this.initialized) return this.currentSnapshot
		const parsed = parseSettingsDocument(await readDocument(this.filePath))
		this.currentSnapshot = snapshot(parsed.values, parsed.revision)
		this.initialized = true
		if (this.watchEnabled) {
			await this.startWatcher()
			await this.enqueue(() => this.reconcileFromDisk())
		}
		return this.currentSnapshot
	}

	readSnapshot(): SettingsSnapshot {
		if (!this.initialized) throw new Error("SettingsRepository has not been initialized")
		return this.currentSnapshot
	}

	mutate(patch: Partial<Settings>, sourceId = this.sourceId): Promise<SettingsCommit> {
		return this.mutateResolved(() => patch, sourceId)
	}

	/** Resolve a Settings patch from the latest disk snapshot while holding the cross-process file lock. */
	mutateResolved(
		resolvePatch: (values: Readonly<Settings>) => Partial<Settings>,
		sourceId = this.sourceId,
	): Promise<SettingsCommit> {
		const requestedAt = performance.now()
		return this.enqueue(async () => {
			const queueMs = Math.round(performance.now() - requestedAt)
			this.ensureAvailable()
			const mkdirStartedAt = performance.now()
			await fs.mkdir(path.dirname(this.filePath), { recursive: true })
			const mkdirMs = Math.round(performance.now() - mkdirStartedAt)
			let commit: SettingsCommit | undefined
			const lockRequestedAt = performance.now()
			let lockAcquiredAt = lockRequestedAt
			let readMs = 0
			let writeMs = 0
			await this.fileLock.withLock(this.filePath, async () => {
				lockAcquiredAt = performance.now()
				const parsed = parseSettingsDocument(await readDocument(this.filePath))
				readMs = Math.round(performance.now() - lockAcquiredAt)
				const nextValues = applySettingsPatch(parsed.values, resolvePatch(parsed.values))
				const keys = changedKeys(parsed.values, nextValues)
				if (isDeepStrictEqual(parsed.values, nextValues)) {
					this.currentSnapshot = snapshot(parsed.values, Math.max(parsed.revision, this.currentSnapshot.revision))
					commit = {
						revision: this.currentSnapshot.revision,
						changedKeys: [],
						snapshot: this.currentSnapshot,
						sourceId,
					}
					return
				}
				const revision = Math.max(parsed.revision, this.currentSnapshot.revision) + 1
				const writeStartedAt = performance.now()
				await writeJsonAtomic(this.filePath, buildPersistedSettingsDocument(nextValues, revision, sourceId))
				writeMs = Math.round(performance.now() - writeStartedAt)
				this.currentSnapshot = snapshot(nextValues, revision)
				commit = { revision, changedKeys: keys, snapshot: this.currentSnapshot, sourceId }
			})
			if (!commit) throw new Error("Settings transaction completed without a commit")
			const publishStartedAt = performance.now()
			if (commit.changedKeys.length > 0) await this.publish(commit)
			recordPerfPhase(PerfDomain.SettingsRepository, "mutate_complete", performance.now() - requestedAt, {
				queueMs,
				mkdirMs,
				lockWaitMs: Math.round(lockAcquiredAt - lockRequestedAt),
				transactionMs: Math.round(publishStartedAt - lockAcquiredAt),
				readMs,
				writeMs,
				publishMs: Math.round(performance.now() - publishStartedAt),
				revision: commit.revision,
				changedKeys: commit.changedKeys.length,
				listeners: this.listeners.size,
			})
			if (Logger.isDebugEnabled()) {
				Logger.debug(
					`[SettingsRepositoryPerf] phase=mutate_complete queueMs=${queueMs} mkdirMs=${mkdirMs} lockWaitMs=${Math.round(lockAcquiredAt - lockRequestedAt)} transactionMs=${Math.round(publishStartedAt - lockAcquiredAt)} readMs=${readMs} writeMs=${writeMs} publishMs=${Math.round(performance.now() - publishStartedAt)} totalMs=${Math.round(performance.now() - requestedAt)} revision=${commit.revision} changedKeys=${commit.changedKeys.join(",") || "none"} listeners=${this.listeners.size} path=${path.basename(path.dirname(this.filePath))}/${path.basename(this.filePath)}`,
				)
			}
			return commit
		})
	}

	subscribe(listener: SettingsCommitListener): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	async flush(): Promise<void> {
		await this.operationQueue
	}

	async dispose(): Promise<void> {
		if (this.disposed) return
		this.disposed = true
		const watcher = this.watcher
		this.watcher = undefined
		if (watcher) await watcher.close()
		await this.operationQueue
		this.listeners.clear()
	}

	private ensureAvailable(): void {
		if (!this.initialized) throw new Error("SettingsRepository has not been initialized")
		if (this.disposed) throw new Error("SettingsRepository has been disposed")
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operationQueue.then(operation)
		this.operationQueue = result.then(
			() => undefined,
			() => undefined,
		)
		return result
	}

	private async startWatcher(): Promise<void> {
		const watcher = chokidar.watch(this.filePath, {
			persistent: true,
			ignoreInitial: true,
			atomic: true,
			awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
		})
		this.watcher = watcher
		const reconcile = () => {
			void this.enqueue(() => this.reconcileFromDisk()).catch((error) => {
				Logger.error("[SettingsRepository] Failed to reconcile external Settings commit:", error)
			})
		}
		watcher
			.on("add", reconcile)
			.on("change", reconcile)
			.on("unlink", reconcile)
			.on("error", (error) => {
				Logger.error("[SettingsRepository] Watcher error:", error)
			})
		await new Promise<void>((resolve) => {
			watcher.once("ready", resolve)
			watcher.once("error", () => resolve())
		})
	}

	private async reconcileFromDisk(): Promise<void> {
		if (this.disposed) return
		const startedAt = performance.now()
		const parsed = parseSettingsDocument(await readDocument(this.filePath))
		const diskHash = contentHash(parsed.values)
		if (diskHash === this.currentSnapshot.contentHash) return
		if (parsed.revision > 0 && parsed.revision <= this.currentSnapshot.revision) return
		const previous = this.currentSnapshot
		const revision = parsed.revision > previous.revision ? parsed.revision : previous.revision + 1
		this.currentSnapshot = snapshot(parsed.values, revision)
		const keys = changedKeys(previous.values, this.currentSnapshot.values)
		if (keys.length === 0) return
		await this.publish({
			revision,
			changedKeys: keys,
			snapshot: this.currentSnapshot,
			sourceId: parsed.sourceId,
		})
		recordPerfPhase(PerfDomain.SettingsRepository, "reconcile", performance.now() - startedAt, {
			revision,
			changedKeys: keys.length,
			listeners: this.listeners.size,
		})
		if (Logger.isDebugEnabled()) {
			Logger.debug(
				`[SettingsRepositoryPerf] phase=reconcile durationMs=${Math.round(performance.now() - startedAt)} revision=${revision} changedKeys=${keys.join(",")} listeners=${this.listeners.size}`,
			)
		}
	}

	private async publish(commit: SettingsCommit): Promise<void> {
		const startedAt = performance.now()
		let index = 0
		for (const listener of this.listeners) {
			const listenerStartedAt = performance.now()
			try {
				await listener(commit)
			} catch (error) {
				Logger.error("[SettingsRepository] Commit listener failed:", error)
			} finally {
				recordPerfPhase(PerfDomain.SettingsRepository, "listener", performance.now() - listenerStartedAt, {
					index,
					revision: commit.revision,
				})
				if (Logger.isDebugEnabled()) {
					Logger.debug(
						`[SettingsRepositoryPerf] phase=listener index=${index} durationMs=${Math.round(performance.now() - listenerStartedAt)} revision=${commit.revision}`,
					)
				}
				index++
			}
		}
		recordPerfPhase(PerfDomain.SettingsRepository, "publish", performance.now() - startedAt, {
			revision: commit.revision,
			listeners: this.listeners.size,
		})
		if (Logger.isDebugEnabled()) {
			Logger.debug(
				`[SettingsRepositoryPerf] phase=publish durationMs=${Math.round(performance.now() - startedAt)} revision=${commit.revision} listeners=${this.listeners.size}`,
			)
		}
	}
}
