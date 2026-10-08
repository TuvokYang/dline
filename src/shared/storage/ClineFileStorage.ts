import * as fs from "node:fs"
import fsPromises from "node:fs/promises"
import { Logger } from "../services/Logger"
import { writeJsonAtomic, writeJsonAtomicSync } from "./atomic-file"
import { ClineSyncStorage } from "./ClineStorage"

export interface ClineFileStorageOptions {
	/**
	 * File permissions mode (e.g., 0o600 for owner read/write only).
	 * If not set, uses the system default.
	 */
	fileMode?: number
}

/**
 * File-backed JSON storage.
 * Keeps synchronous methods for VSCode Memento compatibility and CLI environments,
 * while exposing an asynchronous batch path for Extension Host persistence.
 */
export class ClineFileStorage<T = any> extends ClineSyncStorage<T> {
	protected name: string
	private data: Record<string, T>
	private readonly fsPath: string
	private readonly fileMode?: number
	private asyncWriteQueue: Promise<void> = Promise.resolve()

	constructor(filePath: string, name = "ClineFileStorage", options?: ClineFileStorageOptions) {
		super()
		this.fsPath = filePath
		this.name = name
		this.fileMode = options?.fileMode
		this.data = this.readFromDisk()
	}

	protected _get(key: string): T | undefined {
		return this.data[key]
	}

	protected _set(key: string, value: T | undefined): void {
		// Use setBatch for consistency - all writes go through one path
		this.setBatch({ [key]: value })
	}

	protected _delete(key: string): void {
		this.setBatch({ [key]: undefined })
	}

	/**
	 * Set multiple keys in a single write operation.
	 * More efficient than calling set() for each key individually,
	 * since it only writes to disk once.
	 */
	public setBatch(entries: Record<string, T | undefined>): Thenable<void> {
		// Merge writes against the latest persisted snapshot so another process's
		// completed updates are not discarded by this instance's stale cache.
		const nextData = this.readFromDisk()
		const changedKeys: string[] = []
		for (const [key, value] of Object.entries(entries)) {
			if (value === undefined) {
				if (key in nextData) {
					delete nextData[key]
					changedKeys.push(key)
				}
			} else {
				nextData[key] = value
				changedKeys.push(key)
			}
		}
		if (changedKeys.length > 0) {
			this.writeToDisk(nextData)
		}
		this.data = nextData
		for (const key of changedKeys) {
			this.fireChange(key)
		}
		return Promise.resolve()
	}

	/**
	 * Set multiple keys without blocking the caller's event loop on filesystem I/O.
	 * Writes are serialized per storage instance and become observable only after
	 * the durable write succeeds.
	 */
	public setBatchAsync(entries: Record<string, T | undefined>): Promise<void> {
		const operation = this.asyncWriteQueue.then(async () => {
			const nextData = await this.readFromDiskAsync()
			const changedKeys = applyEntries(nextData, entries)
			if (changedKeys.length > 0) {
				await this.writeToDiskAsync(nextData)
			}
			this.data = nextData
			for (const key of changedKeys) {
				this.fireChange(key)
			}
		})
		this.asyncWriteQueue = operation.then(
			() => undefined,
			() => undefined,
		)
		return operation
	}

	/** Reload the in-memory snapshot from disk before a freshness-sensitive read. */
	public reload(): void {
		this.data = this.readFromDisk()
	}

	protected _keys(): readonly string[] {
		return Object.keys(this.data)
	}

	private readFromDisk(): Record<string, T> {
		try {
			if (fs.existsSync(this.fsPath)) {
				return JSON.parse(fs.readFileSync(this.fsPath, "utf-8"))
			}
		} catch (error) {
			Logger.error(`[${this.name}] failed to read from ${this.fsPath}:`, error)
		}
		return {}
	}

	private writeToDisk(data: Record<string, T>): void {
		try {
			writeJsonAtomicSync(this.fsPath, data, { mode: this.fileMode })
		} catch (error) {
			Logger.error(`[${this.name}] failed to write to ${this.fsPath}:`, error)
			throw error
		}
	}

	private async readFromDiskAsync(): Promise<Record<string, T>> {
		try {
			return JSON.parse(await fsPromises.readFile(this.fsPath, "utf-8"))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				Logger.error(`[${this.name}] failed to read from ${this.fsPath}:`, error)
			}
			return {}
		}
	}

	private async writeToDiskAsync(data: Record<string, T>): Promise<void> {
		try {
			await writeJsonAtomic(this.fsPath, data, { mode: this.fileMode })
		} catch (error) {
			Logger.error(`[${this.name}] failed to write to ${this.fsPath}:`, error)
			throw error
		}
	}
}

function applyEntries<T>(nextData: Record<string, T>, entries: Record<string, T | undefined>): string[] {
	const changedKeys: string[] = []
	for (const [key, value] of Object.entries(entries)) {
		if (value === undefined) {
			if (key in nextData) {
				delete nextData[key]
				changedKeys.push(key)
			}
		} else {
			nextData[key] = value
			changedKeys.push(key)
		}
	}
	return changedKeys
}
