/**
 * Unit tests for FileLock — filesystem-based mutual exclusion for JSONL files.
 */
import { afterEach, describe, it, vi } from "vitest"
import "should"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { FileLock } from "../../jsonl/FileLock"

describe("FileLock", () => {
    let tmpDir: string
    const lock = new FileLock()

    afterEach(async () => {
        vi.restoreAllMocks()
        if (tmpDir) {
            try {
                await fs.rm(tmpDir, { recursive: true, force: true })
            } catch {
                /* ignore */
            }
        }
    })

    async function mkTmpDir(): Promise<string> {
        const dir = path.join(os.tmpdir(), `filelock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        await fs.mkdir(dir, { recursive: true })
        tmpDir = dir
        return dir
    }

    it("should acquire and release a lock successfully", async () => {
        const dir = await mkTmpDir()
        const jsonlPath = path.join(dir, "test.jsonl")
        const lockPath = `${jsonlPath}.lck`

        await lock.acquire(jsonlPath)

        // Verify .lck file exists
        const lckExists = await fs
            .stat(lockPath)
            .then(() => true)
            .catch(() => false)
        lckExists.should.be.true()

        // Verify .lck file content
        const raw = await fs.readFile(lockPath, "utf8")
        const payload = JSON.parse(raw)
        payload.pid.should.equal(process.pid)
        payload.ts.should.be.within(Date.now() - 5000, Date.now())

        await lock.release(jsonlPath)

        // Verify .lck file is removed
        const lckGone = await fs
            .stat(lockPath)
            .then(() => false)
            .catch(() => true)
        lckGone.should.be.true()
    })

    it("should retry a transient unlink failure when releasing the owned lock", async () => {
        const dir = await mkTmpDir()
        const jsonlPath = path.join(dir, "release-retry.jsonl")
        const lockPath = `${jsonlPath}.lck`
        await lock.acquire(jsonlPath)
        const originalUnlink = fs.unlink.bind(fs)
        const transientError = Object.assign(new Error("lock file is temporarily busy"), { code: "EPERM" })
        const unlinkSpy = vi.spyOn(fs, "unlink").mockRejectedValueOnce(transientError).mockImplementation(originalUnlink)

        await lock.release(jsonlPath)

        unlinkSpy.mock.calls.length.should.equal(2)
        const lockStillExists = await fs
            .stat(lockPath)
            .then(() => true)
            .catch(() => false)
        lockStillExists.should.equal(false)
    })

    it("should release silently when lock was never acquired", async () => {
        const dir = await mkTmpDir()
        const jsonlPath = path.join(dir, "nonexistent.jsonl")

        // Should not throw
        await lock.release(jsonlPath)
    })

    it("should execute fn inside withLock and release afterwards", async () => {
        const dir = await mkTmpDir()
        const jsonlPath = path.join(dir, "withlock.jsonl")

        let executed = false
        const result = await lock.withLock(jsonlPath, async () => {
            executed = true
            return "done"
        })

        executed.should.be.true()
        result.should.equal("done")

        // Lock should be released after withLock
        const lockPath = `${jsonlPath}.lck`
        const lckGone = await fs
            .stat(lockPath)
            .then(() => false)
            .catch(() => true)
        lckGone.should.be.true()
    })

    it("should release lock even if fn throws", async () => {
        const dir = await mkTmpDir()
        const jsonlPath = path.join(dir, "throw.jsonl")

        try {
            await lock.withLock(jsonlPath, async () => {
                throw new Error("test error")
            })
        } catch (e: any) {
            e.message.should.equal("test error")
        }

        // Lock should be released even after exception
        const lockPath = `${jsonlPath}.lck`
        const lckGone = await fs
            .stat(lockPath)
            .then(() => false)
            .catch(() => true)
        lckGone.should.be.true()
    })

    it("should prevent concurrent acquisitions (mutual exclusion)", async () => {
        const dir = await mkTmpDir()
        const jsonlPath = path.join(dir, "concurrent.jsonl")

        // First acquisition should succeed
        await lock.acquire(jsonlPath)

        // Second acquisition should fail (held by same process)
        try {
            await lock.acquire(jsonlPath)
            // If we reach here the test should fail
            throw new Error("Expected acquire to throw")
        } catch (e: any) {
            e.message.should.match(/Failed to acquire lock/)
        }

        await lock.release(jsonlPath)
    })

    it("should serialize independent lock instances in the same process", async () => {
        const dir = await mkTmpDir()
        const jsonlPath = path.join(dir, "independent-instances.jsonl")
        const left = new FileLock()
        const right = new FileLock()
        let activeCriticalSections = 0
        let maxActiveCriticalSections = 0
        let releaseLeft!: () => void
        let markLeftEntered!: () => void
        const leftEntered = new Promise<void>((resolve) => {
            markLeftEntered = resolve
        })
        const leftGate = new Promise<void>((resolve) => {
            releaseLeft = resolve
        })

        const leftWork = left.withLock(jsonlPath, async () => {
            activeCriticalSections++
            maxActiveCriticalSections = Math.max(maxActiveCriticalSections, activeCriticalSections)
            markLeftEntered()
            await leftGate
            activeCriticalSections--
        })
        await leftEntered
        const rightWork = right.withLock(jsonlPath, async () => {
            activeCriticalSections++
            maxActiveCriticalSections = Math.max(maxActiveCriticalSections, activeCriticalSections)
            activeCriticalSections--
        })
        await new Promise((resolve) => setTimeout(resolve, 150))
        maxActiveCriticalSections.should.equal(1)

        releaseLeft()
        await Promise.all([leftWork, rightWork])
        maxActiveCriticalSections.should.equal(1)
    })

    it("should not break an old lock while its owner process is still alive", async () => {
        const dir = await mkTmpDir()
        const jsonlPath = path.join(dir, "old-live-owner.jsonl")
        const lockPath = `${jsonlPath}.lck`
        await fs.writeFile(
            lockPath,
            JSON.stringify({ pid: process.pid, ownerId: "still-alive", ts: Date.now() - 15_000 }),
            "utf8",
        )
        const oldTime = new Date(Date.now() - 15_000)
        await fs.utimes(lockPath, oldTime, oldTime)

        const contender = new FileLock()
        await contender.acquire(jsonlPath).should.be.rejectedWith(/Failed to acquire lock/)
        const payload = JSON.parse(await fs.readFile(lockPath, "utf8"))
        payload.ownerId.should.equal("still-alive")
    })

    it("should break an old legacy lock without owner identity even when its pid is still alive", async () => {
        const dir = await mkTmpDir()
        const jsonlPath = path.join(dir, "legacy-live-pid.jsonl")
        const lockPath = `${jsonlPath}.lck`
        await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() - 15_000 }), "utf8")
        const oldTime = new Date(Date.now() - 15_000)
        await fs.utimes(lockPath, oldTime, oldTime)

        const upgradedLock = new FileLock()
        await upgradedLock.acquire(jsonlPath)
        const payload = JSON.parse(await fs.readFile(lockPath, "utf8"))
        payload.ownerId.should.be.type("string")
        await upgradedLock.release(jsonlPath)
    })

    it("should break stale locks (older than 10s)", async () => {
        const dir = await mkTmpDir()
        const jsonlPath = path.join(dir, "stale.jsonl")
        const lockPath = `${jsonlPath}.lck`

        // Create a lock file with an old timestamp (simulating a crashed process)
        const stalePayload = { pid: 99999, ts: Date.now() - 15_000 }
        await fs.writeFile(lockPath, JSON.stringify(stalePayload), "utf8")

        // Set mtime to 15s ago so isLockActive detects it as stale
        const oldTime = new Date(Date.now() - 15_000)
        await fs.utimes(lockPath, oldTime, oldTime)

        // Acquisition should break the stale lock and succeed
        await lock.acquire(jsonlPath)

        // Verify new lock has our pid
        const raw = await fs.readFile(lockPath, "utf8")
        const payload = JSON.parse(raw)
        payload.pid.should.equal(process.pid)

        await lock.release(jsonlPath)
    })
})
