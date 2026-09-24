import { mkdir } from "node:fs/promises"
import path from "node:path"
import type { TransactionalUnifyStoreDatabase } from "../backend/api/UnifyStore"
import { SqliteUnifyStoreBackend } from "../backend/sqlite/SqliteUnifyStore"
import { getDlineDocumentsPath } from "../documents-path"
import { type InstanceDatabase, InstanceLayout, type InstanceLocation, instanceRoot } from "./InstanceLayout"

/**
 * Writer of each open instance database in this process, keyed by normalized path.
 *
 * A high-frequency database has exactly one writing module. Two owners opening the
 * same file would interleave their writes on one connection, so the second claim
 * fails instead of silently sharing it.
 */
const writerByDatabase = new Map<string, WriterClaim>()

/** Every instance storage that is still open, so deletion can release file handles first. */
const openStorages = new Set<InstanceStorage>()

interface WriterClaim {
	readonly storage: InstanceStorage
	readonly writer: string
}

interface OpenedDatabase {
	readonly key: string
	readonly database: TransactionalUnifyStoreDatabase
}

function normalizedPath(location: string): string {
	const resolved = path.resolve(location)
	return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function isSameOrInside(candidate: string, root: string): boolean {
	return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

/**
 * Databases of one task or subagent instance.
 *
 * Each database is opened by the one module that writes it and closed with the
 * instance. Closing is idempotent; a closed storage rejects new opens.
 */
export class InstanceStorage {
	private readonly databases = new Map<InstanceDatabase, OpenedDatabase>()
	private closePromise: Promise<void> | undefined

	constructor(readonly layout: InstanceLayout) {}

	/**
	 * Opens `kind` for its single writer.
	 *
	 * @throws when the storage is closed, or when another owner already writes the same file.
	 */
	async openDatabase(kind: InstanceDatabase, writer: string): Promise<TransactionalUnifyStoreDatabase> {
		if (this.closePromise) throw new Error(`Instance storage ${this.layout.root} is closed`)
		const location = this.layout.database(kind)
		const key = normalizedPath(location)
		const claim = writerByDatabase.get(key)
		if (claim) {
			throw new Error(
				`InstanceDatabaseWriterConflict: ${kind} at ${location} is written by ${claim.writer}; ${writer} cannot open it`,
			)
		}
		writerByDatabase.set(key, { storage: this, writer })
		let database: TransactionalUnifyStoreDatabase
		try {
			database = await new SqliteUnifyStoreBackend().open(location)
		} catch (error) {
			writerByDatabase.delete(key)
			throw error
		}
		if (this.closePromise) {
			// Closed while the file was opening: nothing may keep it past close().
			writerByDatabase.delete(key)
			await database.close()
			throw new Error(`Instance storage ${this.layout.root} is closed`)
		}
		this.databases.set(kind, { key, database })
		return database
	}

	/** Closes every database this instance opened and releases their writer claims. */
	close(): Promise<void> {
		this.closePromise ??= this.closeDatabases()
		return this.closePromise
	}

	private async closeDatabases(): Promise<void> {
		openStorages.delete(this)
		const opened = [...this.databases.values()]
		this.databases.clear()
		const results = await Promise.allSettled(opened.map(({ database }) => database.close()))
		for (const { key } of opened) {
			if (writerByDatabase.get(key)?.storage === this) writerByDatabase.delete(key)
		}
		const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
		if (failure) throw failure.reason
	}
}

/** Starts tracking the storage of one instance root; the caller owns closing it. */
export function openInstanceStorage(root: string): InstanceStorage {
	const storage = new InstanceStorage(new InstanceLayout(root))
	openStorages.add(storage)
	return storage
}

/** Resolves the layout of one instance without touching the file system. */
export async function resolveInstanceLayout(location: InstanceLocation): Promise<InstanceLayout> {
	return new InstanceLayout(instanceRoot(await getDlineDocumentsPath(), location))
}

/** Resolves the layout of one instance and creates its root directory. */
export async function ensureInstanceLayout(location: InstanceLocation): Promise<InstanceLayout> {
	const layout = await resolveInstanceLayout(location)
	await mkdir(layout.root, { recursive: true })
	return layout
}

/**
 * Closes every open instance at or below `taskRoot`, including its subagents.
 *
 * Deleting a task directory while SQLite still holds its database, `-wal` or `-shm`
 * fails on Windows and can leave a half-deleted task, so deletion calls this first.
 */
export async function closeInstanceStoragesUnder(taskRoot: string): Promise<void> {
	const root = normalizedPath(taskRoot)
	const affected = [...openStorages].filter((storage) => isSameOrInside(normalizedPath(storage.layout.root), root))
	const results = await Promise.allSettled(affected.map((storage) => storage.close()))
	const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
	if (failure) throw failure.reason
}
