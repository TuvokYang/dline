import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { HistoryItem } from "@shared/HistoryItem"
import { afterAll, describe, expect, it } from "vitest"
import { openTaskHistory } from "../TaskHistory"

/**
 * Behavior guard for reading the history while a write is still settling.
 *
 * Metadata updates sit on the UI hot path, so `upsertTaskHistory` hands the
 * caller the staged row and lets the transaction commit in the background. A
 * reader that goes straight to disk during that window observes the previous
 * value, so rebuilding a cache from such a read rolls back a row this process
 * has already published to its own callers.
 */

const roots: string[] = []

function createDatabasePath(): string {
	const root = mkdtempSync(path.join(os.tmpdir(), "dline-history-overlay-"))
	roots.push(root)
	return path.join(root, "taskHistory.db")
}

function createItem(overrides: Partial<HistoryItem> = {}): HistoryItem {
	return {
		id: "task-1",
		ulid: "ulid-1",
		ts: 1_000,
		task: "example task",
		tokensIn: 10,
		tokensOut: 20,
		cacheWrites: 0,
		cacheReads: 0,
		totalCost: 0,
		size: 0,
		...overrides,
	} as HistoryItem
}

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe("TaskHistory.getDeduplicatedWithPendingWrites", () => {
	it("reports a queued update before its transaction commits", async () => {
		const history = await openTaskHistory(createDatabasePath())
		try {
			await history.upsert(createItem({ task: "committed" }))

			const staged = await history.upsertTaskHistory(createItem({ task: "queued", tokensIn: 99 }))
			// Read before flushing: this is exactly the window in which a file
			// watcher can fire for an unrelated change.
			const overlaid = await history.getDeduplicatedWithPendingWrites()

			expect(staged.task).toBe("queued")
			expect(overlaid).toHaveLength(1)
			expect(overlaid[0]?.task).toBe("queued")
			expect(overlaid[0]?.tokensIn).toBe(99)
		} finally {
			await history.flush()
			await history.dispose()
		}
	})

	it("includes a task whose first write has not landed yet", async () => {
		const history = await openTaskHistory(createDatabasePath())
		try {
			await history.upsert(createItem({ id: "task-old", ulid: "ulid-old", ts: 1_000 }))
			await history.upsertTaskHistory(createItem({ id: "task-new", ulid: "ulid-new", ts: 2_000 }))

			const overlaid = await history.getDeduplicatedWithPendingWrites()

			expect(overlaid.map((entry) => entry.id)).toEqual(["task-new", "task-old"])
		} finally {
			await history.flush()
			await history.dispose()
		}
	})

	it("stops overlaying once the write settled", async () => {
		const history = await openTaskHistory(createDatabasePath())
		try {
			await history.upsertTaskHistory(createItem({ task: "queued" }))
			await history.flush()

			const overlaid = await history.getDeduplicatedWithPendingWrites()
			const committed = await history.getDeduplicated()

			expect(overlaid).toEqual(committed)
			expect(overlaid[0]?.task).toBe("queued")
		} finally {
			await history.dispose()
		}
	})

	it("keeps the newest staged row when a task is updated twice before settling", async () => {
		const history = await openTaskHistory(createDatabasePath())
		try {
			await history.upsertTaskHistory(createItem({ task: "first", tokensIn: 1 }))
			await history.upsertTaskHistory(createItem({ task: "second", tokensIn: 2 }))

			const overlaid = await history.getDeduplicatedWithPendingWrites()

			expect(overlaid).toHaveLength(1)
			expect(overlaid[0]?.task).toBe("second")
			expect(overlaid[0]?.tokensIn).toBe(2)
		} finally {
			await history.flush()
			await history.dispose()
		}
	})

	it("matches the committed read when nothing is queued", async () => {
		const history = await openTaskHistory(createDatabasePath())
		try {
			await history.upsert(createItem())

			expect(await history.getDeduplicatedWithPendingWrites()).toEqual(await history.getDeduplicated())
		} finally {
			await history.dispose()
		}
	})

	it("reorders an existing task whose queued update moved it to the front", async () => {
		const history = await openTaskHistory(createDatabasePath())
		try {
			await history.upsert(createItem({ id: "task-a", ulid: "ulid-a", ts: 1_000 }))
			await history.upsert(createItem({ id: "task-b", ulid: "ulid-b", ts: 2_000 }))

			// `ts` is the time of the latest activity, so a metadata update for
			// an existing task routinely moves it past the others.
			await history.upsertTaskHistory(createItem({ id: "task-a", ulid: "ulid-a", ts: 3_000 }))
			const overlaid = await history.getDeduplicatedWithPendingWrites()

			expect(overlaid.map((entry) => entry.id)).toEqual(["task-a", "task-b"])
		} finally {
			await history.flush()
			await history.dispose()
		}
	})

	it("exposes a queued write to a read that starts before the lookup finishes", async () => {
		const history = await openTaskHistory(createDatabasePath())
		try {
			await history.upsert(createItem({ task: "committed" }))

			// Both are started without awaiting the first: the refresh runs
			// while the write is still resolving its existing row, which is the
			// window in which a disk-only read would publish the stale value.
			const queued = history.upsertTaskHistory(createItem({ task: "queued", tokensIn: 99 }))
			const overlaid = await history.getDeduplicatedWithPendingWrites()
			await queued

			expect(overlaid[0]?.task).toBe("queued")
			expect(overlaid[0]?.tokensIn).toBe(99)
		} finally {
			await history.flush()
			await history.dispose()
		}
	})
})
