import { rename } from "node:fs/promises"
import { Logger } from "@/shared/services/Logger"
import type { StoredEntityClass } from "../backend/api/EntitySchema"
import { copyUnifyStoreDatabase } from "../backend/core/UnifyStoreCopy"
import {
	databaseLocation,
	existingBackends,
	type InstanceBackend,
	instanceBackend,
	removeDatabaseLocation,
	resolveDatabaseBackend,
	stagingLocation,
} from "./InstanceBackends"
import type { InstanceDatabase, InstanceLayout } from "./InstanceLayout"
import { hasOpenInstanceStoragesUnder } from "./InstanceStorage"

export interface InstanceBackendSwitchResult {
	readonly database: InstanceDatabase
	readonly from: InstanceBackend | undefined
	readonly to: InstanceBackend
	/** Rows copied per collection; empty when nothing had to move. */
	readonly rowsByCollection: ReadonlyMap<string, number>
	/** Whether the previous copy could not be deleted and was left behind with a lower generation. */
	readonly sourceRetained: boolean
}

/**
 * Moves one database of an instance to `target` without losing anything.
 *
 * Every collection is copied into a staging location in one transaction and compared row
 * by row with the source; only then is the copy renamed into place and the source deleted.
 * A crash at any point leaves either the untouched source or a verified copy with a higher
 * copy generation, which {@link resolveDatabaseBackend} prefers.
 *
 * The caller must hold the task lock so no other process writes the instance, and must have
 * closed every storage of the instance in this process.
 *
 * @param entities entity of every collection the database may hold; an unknown collection
 * aborts the switch rather than being dropped.
 * @throws when the instance is open in this process, a collection is unknown, or the
 * verification fails. The source is left untouched in every failure case.
 */
export async function switchInstanceDatabaseBackend(
	layout: InstanceLayout,
	database: InstanceDatabase,
	target: InstanceBackend,
	entities: readonly StoredEntityClass<object>[],
): Promise<InstanceBackendSwitchResult> {
	if (hasOpenInstanceStoragesUnder(layout.root)) {
		throw new Error(`Close every storage of ${layout.root} before switching its backend`)
	}
	const existing = await existingBackends(layout, database)
	if (existing.length === 0) {
		return { database, from: undefined, to: target, rowsByCollection: new Map(), sourceRetained: false }
	}
	const source = await resolveDatabaseBackend(layout, database, target)
	const targetLocation = databaseLocation(layout, database, target)
	if (source === target) {
		// A leftover copy in the other backend lost a previous comparison; finish its removal.
		const sourceRetained = await removeStaleCopies(layout, database, target)
		return { database, from: source, to: target, rowsByCollection: new Map(), sourceRetained }
	}

	const sourceLocation = databaseLocation(layout, database, source)
	const staging = stagingLocation(targetLocation)
	await removeDatabaseLocation(staging, target)
	const rowsByCollection = await copyInto(sourceLocation, source, staging, target, entities)

	// The target location may hold an older copy that lost to the source; the verified
	// staging copy replaces it.
	await removeDatabaseLocation(targetLocation, target)
	await rename(staging, targetLocation)

	let sourceRetained = false
	try {
		await removeDatabaseLocation(sourceLocation, source)
	} catch (error) {
		// Another process still has the old file open. The copy carries a higher generation,
		// so every later open picks it; the next switch removes the leftover.
		sourceRetained = true
		Logger.warn(`[InstanceStorage] Kept ${sourceLocation} after switching to ${target}: ${String(error)}`)
	}
	return { database, from: source, to: target, rowsByCollection, sourceRetained }
}

async function copyInto(
	sourceLocation: string,
	source: InstanceBackend,
	targetLocation: string,
	target: InstanceBackend,
	entities: readonly StoredEntityClass<object>[],
): Promise<ReadonlyMap<string, number>> {
	const from = await instanceBackend(source).open(sourceLocation)
	try {
		const to = await instanceBackend(target).open(targetLocation)
		try {
			return (
				await copyUnifyStoreDatabase({ source: from, target: to, entities, sourceLabel: `${source}:${sourceLocation}` })
			).rowsByCollection
		} catch (error) {
			await to.close()
			await removeDatabaseLocation(targetLocation, target).catch(() => undefined)
			throw error
		} finally {
			await to.close()
		}
	} finally {
		await from.close()
	}
}

async function removeStaleCopies(layout: InstanceLayout, database: InstanceDatabase, keep: InstanceBackend): Promise<boolean> {
	let retained = false
	for (const backend of await existingBackends(layout, database)) {
		if (backend === keep) continue
		try {
			await removeDatabaseLocation(databaseLocation(layout, database, backend), backend)
		} catch {
			retained = true
		}
	}
	return retained
}
