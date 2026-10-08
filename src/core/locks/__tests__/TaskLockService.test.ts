import { expect } from "chai"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, it } from "vitest"
import { TaskLockService } from "../TaskLockService"

/**
 * Unit tests for TaskLockService — file-based task locking.
 *
 * Each test uses a temporary directory as the tasks root so that
 * tests run in isolation and never touch real task data.
 */
describe("TaskLockService", () => {
	let testDir: string
	let lockService: TaskLockService
	const instanceA = "vscode-instance-a"
	const instanceB = "vscode-instance-b"
	const taskId = "test-task-001"

	beforeEach(async () => {
		testDir = path.join(os.tmpdir(), `cline-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
		await fs.mkdir(testDir, { recursive: true })
		lockService = new TaskLockService(testDir, instanceA)
	})

	afterEach(async () => {
		await fs.rm(testDir, { recursive: true, force: true }).catch(() => {})
	})

	// ──────────────────────────────────────────────
	// checkTaskLock
	// ──────────────────────────────────────────────

	it("checkTaskLock returns unlocked when no lock file exists", async () => {
		const status = await lockService.checkTaskLock(taskId)
		expect(status.isLocked).to.be.false
		expect(status.isStale).to.be.false
	})

	it("checkTaskLock returns locked after acquire", async () => {
		await lockService.acquireTaskLock(taskId)
		const status = await lockService.checkTaskLock(taskId)
		expect(status.isLocked).to.be.true
		expect(status.lockedBy).to.equal(instanceA)
		expect(status.isStale).to.be.false
		expect(status.lockedAt).to.be.a("number")
	})

	// ──────────────────────────────────────────────
	// acquireTaskLock
	// ──────────────────────────────────────────────

	it("acquireTaskLock returns true on first acquisition", async () => {
		const result = await lockService.acquireTaskLock(taskId)
		expect(result).to.be.true
	})

	it("acquireTaskLock returns false when already held by another instance", async () => {
		// Instance A acquires
		await lockService.acquireTaskLock(taskId)

		// Instance B tries
		const svcB = new TaskLockService(testDir, instanceB)
		const result = await svcB.acquireTaskLock(taskId)
		expect(result).to.be.false
	})

	it("acquireTaskLock creates .lock file with correct JSON", async () => {
		await lockService.acquireTaskLock(taskId)
		const raw = await fs.readFile(path.join(testDir, taskId, ".lock"), "utf-8")
		const data = JSON.parse(raw)
		expect(data.held_by).to.equal(instanceA)
		expect(data.pid).to.equal(process.pid)
		expect(data.locked_at).to.be.a("number")
	})

	it("acquireTaskLock returns true for same instance re-acquire", async () => {
		await lockService.acquireTaskLock(taskId)
		// Same service (same instanceAddress) should be able to "re-acquire"
		const result = await lockService.acquireTaskLock(taskId)
		expect(result).to.be.true
	})

	// ──────────────────────────────────────────────
	// releaseTaskLock
	// ──────────────────────────────────────────────

	it("releaseTaskLock removes .lock file", async () => {
		await lockService.acquireTaskLock(taskId)
		await lockService.releaseTaskLock(taskId)
		const status = await lockService.checkTaskLock(taskId)
		expect(status.isLocked).to.be.false
	})

	it("releaseTaskLock is safe when no lock exists", async () => {
		// Should not throw
		await lockService.releaseTaskLock("nonexistent-task")
	})

	// ──────────────────────────────────────────────
	// touchTaskLock
	// ──────────────────────────────────────────────

	it("touchTaskLock returns true and updates locked_at", async () => {
		await lockService.acquireTaskLock(taskId)
		const before = (await lockService.checkTaskLock(taskId)).lockedAt!

		// Wait 10ms to ensure timestamp changes
		await new Promise((r) => setTimeout(r, 10))
		const touched = await lockService.touchTaskLock(taskId)
		expect(touched).to.be.true

		const after = (await lockService.checkTaskLock(taskId)).lockedAt!
		expect(after).to.be.greaterThan(before)
	})

	it("touchTaskLock returns false when lock is held by another instance", async () => {
		await lockService.acquireTaskLock(taskId)
		const svcB = new TaskLockService(testDir, instanceB)
		const result = await svcB.touchTaskLock(taskId)
		expect(result).to.be.false
	})

	it("touchTaskLock returns false when no lock file exists", async () => {
		const result = await lockService.touchTaskLock("no-such-task")
		expect(result).to.be.false
	})

	// ──────────────────────────────────────────────
	// forceReleaseTaskLock
	// ──────────────────────────────────────────────

	it("forceReleaseTaskLock removes lock held by another instance", async () => {
		// Instance A acquires
		await lockService.acquireTaskLock(taskId)

		// Instance B force-releases
		const svcB = new TaskLockService(testDir, instanceB)
		await svcB.forceReleaseTaskLock(taskId)

		// Lock should be gone
		const status = await lockService.checkTaskLock(taskId)
		expect(status.isLocked).to.be.false

		// Instance B can now acquire
		const result = await svcB.acquireTaskLock(taskId)
		expect(result).to.be.true
	})

	// ──────────────────────────────────────────────
	// cleanupOrphaned (stale lock cleanup)
	// ──────────────────────────────────────────────

	it("cleanupOrphaned removes stale lock file", async () => {
		// Create a lock file manually with an old timestamp
		const lockDir = path.join(testDir, "stale-task")
		await fs.mkdir(lockDir, { recursive: true })
		const staleData = {
			held_by: "dead-instance",
			locked_at: Date.now() - 10 * 60 * 1000, // 10 minutes ago
			pid: 99999,
		}
		await fs.writeFile(path.join(lockDir, ".lock"), JSON.stringify(staleData))

		await lockService.cleanupOrphaned()

		// Stale lock should be removed
		const status = await lockService.checkTaskLock("stale-task")
		expect(status.isLocked).to.be.false
	})

	it("cleanupOrphaned keeps fresh lock file", async () => {
		await lockService.acquireTaskLock(taskId)
		await lockService.cleanupOrphaned()

		// Fresh lock should still be there
		const status = await lockService.checkTaskLock(taskId)
		expect(status.isLocked).to.be.true
	})

	// ──────────────────────────────────────────────
	// unreadable lock files count as no lock
	// ──────────────────────────────────────────────

	/** Write `content` as the task's lock file, last modified `ageMs` ago. */
	async function writeRawLock(content: string, ageMs: number): Promise<string> {
		const lockPath = path.join(testDir, taskId, ".lock")
		await fs.mkdir(path.dirname(lockPath), { recursive: true })
		await fs.writeFile(lockPath, content)
		const at = new Date(Date.now() - ageMs)
		await fs.utimes(lockPath, at, at)
		return lockPath
	}

	for (const [label, content] of [
		["corrupt JSON", "{not json"],
		["an empty file", ""],
		["a record without its holder", JSON.stringify({ locked_at: Date.now(), pid: 1 })],
	] as const) {
		it(`checkTaskLock treats ${label} as unlocked`, async () => {
			await writeRawLock(content, 60_000)

			const status = await lockService.checkTaskLock(taskId)

			expect(status.isLocked).to.be.false
		})

		it(`acquireTaskLock replaces an abandoned lock holding ${label}`, async () => {
			const lockPath = await writeRawLock(content, 60_000)

			expect(await lockService.acquireTaskLock(taskId)).to.be.true
			expect(JSON.parse(await fs.readFile(lockPath, "utf-8")).held_by).to.equal(instanceA)
		})
	}

	it("acquireTaskLock leaves a lock another writer is still filling", async () => {
		// Created exclusively a moment ago but not yet written: a live acquirer.
		const lockPath = await writeRawLock("", 0)

		expect(await lockService.acquireTaskLock(taskId)).to.be.false
		expect(await fs.readFile(lockPath, "utf-8")).to.equal("")
	})

	it("cleanupOrphaned removes an abandoned unreadable lock", async () => {
		const lockPath = await writeRawLock("{not json", 60_000)

		await lockService.cleanupOrphaned()

		const remaining = await fs.access(lockPath).then(
			() => true,
			() => false,
		)
		expect(remaining).to.be.false
	})
})
