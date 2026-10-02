import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { classifyPreviousSession, RuntimeSessionLedger, type RuntimeSessionLedgerDocument } from "./session-ledger"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))))

function document(overrides: Partial<RuntimeSessionLedgerDocument> = {}): RuntimeSessionLedgerDocument {
	return { schemaVersion: 1, sessionId: "previous", pid: 123, startedAt: 100, heartbeatAt: 200, ...overrides }
}

describe("classifyPreviousSession", () => {
	it("uses conservative fixed outcomes", () => {
		expect(
			classifyPreviousSession({ document: document({ deactivationCompletedAt: 250 }), now: 300, processAlive: false }),
		).toEqual({
			outcome: "deactivation_completed",
			ageMs: 50,
		})
		expect(classifyPreviousSession({ document: document(), now: 300, processAlive: true }).outcome).toBe("still_active")
		expect(classifyPreviousSession({ document: document(), now: 300, processAlive: false }).outcome).toBe("unclean_inferred")
		expect(classifyPreviousSession({ document: document(), now: 100_000, processAlive: undefined }).outcome).toBe(
			"stale_unknown",
		)
	})
})

describe("RuntimeSessionLedger", () => {
	it("reconciles corrupt and unclean previous sessions then marks clean deactivation", async () => {
		const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-ledger-"))
		roots.push(dataDir)
		const directory = path.join(dataDir, "runtime", "session-ledgers")
		await fs.mkdir(directory, { recursive: true })
		await fs.writeFile(path.join(directory, "bad.json"), "{", "utf8")
		await fs.writeFile(path.join(directory, "old.json"), JSON.stringify(document()), "utf8")
		let now = 1_000
		const ledger = new RuntimeSessionLedger({
			dataDir,
			sessionId: "current",
			now: () => now,
			pid: 999,
			processAlive: () => false,
			heartbeatIntervalMs: 0x7fffffff,
		})

		const results = await ledger.startAndReconcile()
		expect(results.map((result) => result.outcome).sort()).toEqual(["corrupt", "unclean_inferred"])
		const claimed = await ledger.claimReconciliationsForReporting()
		expect(claimed.map((result) => result.outcome).sort()).toEqual(["corrupt", "unclean_inferred"])
		await Promise.all(claimed.map((result) => result.commit()))
		expect(JSON.parse(await fs.readFile(path.join(directory, "old.json"), "utf8")).reconciliationReportedAt).toBe(1_000)
		await expect(fs.access(path.join(directory, "bad.json"))).rejects.toThrow()

		now = 2_000
		await ledger.complete()
		const saved = JSON.parse(await fs.readFile(path.join(directory, "current.json"), "utf8"))
		expect(saved.deactivationCompletedAt).toBe(2_000)
		expect(saved.stage).toBe("deactivation_completed")
		expect(Object.keys(saved).sort()).toEqual([
			"deactivationCompletedAt",
			"heartbeatAt",
			"pid",
			"schemaVersion",
			"sessionId",
			"stage",
			"startedAt",
		])
	})

	it("does not acknowledge active or indeterminate sessions as terminal", async () => {
		const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-ledger-"))
		roots.push(dataDir)
		const directory = path.join(dataDir, "runtime", "session-ledgers")
		await fs.mkdir(directory, { recursive: true })
		await fs.writeFile(path.join(directory, "active.json"), JSON.stringify(document({ heartbeatAt: 240 })), "utf8")
		const ledger = new RuntimeSessionLedger({
			dataDir,
			sessionId: "current",
			now: () => 250,
			pid: 999,
			processAlive: () => true,
			heartbeatIntervalMs: 0x7fffffff,
		})

		expect(await ledger.startAndReconcile()).toEqual([{ outcome: "still_active", ageMs: 10 }])
		const claimed = await ledger.claimReconciliationsForReporting()
		expect(claimed.map(({ outcome, ageMs }) => ({ outcome, ageMs }))).toEqual([{ outcome: "still_active", ageMs: 10 }])
		await Promise.all(claimed.map((result) => result.commit()))
		expect(
			JSON.parse(await fs.readFile(path.join(directory, "active.json"), "utf8")).reconciliationReportedAt,
		).toBeUndefined()
		await ledger.complete()
	})

	it("infers an unclean previous session after an abrupt child-process termination", async () => {
		const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-ledger-crash-"))
		roots.push(dataDir)
		const directory = path.join(dataDir, "runtime", "session-ledgers")
		const childScript = [
			'const fs = require("node:fs")',
			'const path = require("node:path")',
			"const directory = process.argv[1]",
			"fs.mkdirSync(directory, { recursive: true })",
			"fs.writeFileSync(path.join(directory, 'abrupt.json'), JSON.stringify({ schemaVersion: 1, sessionId: 'abrupt', pid: process.pid, startedAt: 100, heartbeatAt: 200 }), { encoding: 'utf8', mode: 0o600 })",
			"process.kill(process.pid, 'SIGKILL')",
		].join(";")
		const child = spawn(process.execPath, ["-e", childScript, directory], { stdio: "ignore" })
		await new Promise<void>((resolve, reject) => {
			child.once("error", reject)
			child.once("exit", () => resolve())
		})

		const ledger = new RuntimeSessionLedger({
			dataDir,
			sessionId: "relaunch",
			now: () => 1_000,
			pid: 999,
			processAlive: () => false,
			heartbeatIntervalMs: 0x7fffffff,
		})
		expect(await ledger.startAndReconcile()).toContainEqual({ outcome: "unclean_inferred", ageMs: 800 })
		await ledger.complete()
	})

	it("allows only one concurrent process to claim a terminal reconciliation", async () => {
		const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-ledger-"))
		roots.push(dataDir)
		const directory = path.join(dataDir, "runtime", "session-ledgers")
		await fs.mkdir(directory, { recursive: true })
		await fs.writeFile(path.join(directory, "previous.json"), JSON.stringify(document()), "utf8")
		const processAlive = (pid: number) => pid !== 123
		const first = new RuntimeSessionLedger({
			dataDir,
			sessionId: "current-a",
			now: () => 1_000,
			pid: 901,
			processAlive,
			heartbeatIntervalMs: 0x7fffffff,
		})
		const second = new RuntimeSessionLedger({
			dataDir,
			sessionId: "current-b",
			now: () => 1_000,
			pid: 902,
			processAlive,
			heartbeatIntervalMs: 0x7fffffff,
		})
		await Promise.all([first.startAndReconcile(), second.startAndReconcile()])

		const claims = await Promise.all([first.claimReconciliationsForReporting(), second.claimReconciliationsForReporting()])
		expect(claims.flat().map(({ outcome, ageMs }) => ({ outcome, ageMs }))).toEqual([
			{ outcome: "unclean_inferred", ageMs: 800 },
		])
		await Promise.all(claims.flat().map((result) => result.commit()))
		await Promise.all([first.complete(), second.complete()])
	})

	it("replays an uncommitted claim after the owning process is gone", async () => {
		const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-ledger-"))
		roots.push(dataDir)
		const directory = path.join(dataDir, "runtime", "session-ledgers")
		await fs.mkdir(directory, { recursive: true })
		await fs.writeFile(path.join(directory, "previous.json"), JSON.stringify(document()), "utf8")
		const first = new RuntimeSessionLedger({
			dataDir,
			sessionId: "current-a",
			now: () => 1_000,
			pid: 901,
			processAlive: () => false,
			heartbeatIntervalMs: 0x7fffffff,
		})
		await first.startAndReconcile()
		const abandoned = await first.claimReconciliationsForReporting()
		expect(abandoned.map(({ outcome, ageMs }) => ({ outcome, ageMs }))).toContainEqual({
			outcome: "unclean_inferred",
			ageMs: 800,
		})

		const second = new RuntimeSessionLedger({
			dataDir,
			sessionId: "current-b",
			now: () => 2_000,
			pid: 902,
			processAlive: () => false,
			heartbeatIntervalMs: 0x7fffffff,
		})
		const reconciled = await second.startAndReconcile()
		expect(reconciled).toContainEqual({ outcome: "unclean_inferred", ageMs: 1_800 })
		const replayed = await second.claimReconciliationsForReporting()
		await Promise.all(replayed.map((result) => result.commit()))
		await Promise.all([first.complete(), second.complete()])
	})

	it("recovers the write queue after a transient persistence failure", async () => {
		const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-ledger-"))
		roots.push(dataDir)
		let attempts = 0
		const writeDocument = async (filePath: string, value: RuntimeSessionLedgerDocument) => {
			attempts++
			if (attempts === 1) throw new Error("transient write failure")
			await fs.writeFile(filePath, JSON.stringify(value), { encoding: "utf8", mode: 0o600 })
		}
		const ledger = new RuntimeSessionLedger({
			dataDir,
			sessionId: "current",
			pid: 999,
			processAlive: () => false,
			heartbeatIntervalMs: 0x7fffffff,
			writeDocument,
		})

		await expect(ledger.startAndReconcile()).rejects.toThrow("transient write failure")
		await expect(ledger.markStage("retry")).resolves.toBeUndefined()
		await expect(ledger.complete()).resolves.toBeUndefined()
		expect(attempts).toBeGreaterThanOrEqual(3)
	})

	it("retries a terminal claim after a transient acknowledgment failure", async () => {
		const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-ledger-"))
		roots.push(dataDir)
		const directory = path.join(dataDir, "runtime", "session-ledgers")
		await fs.mkdir(directory, { recursive: true })
		await fs.writeFile(path.join(directory, "previous.json"), JSON.stringify(document()), "utf8")
		let writes = 0
		const writeDocument = async (filePath: string, value: RuntimeSessionLedgerDocument) => {
			writes++
			if (writes === 2) throw new Error("acknowledgment failed")
			await fs.writeFile(filePath, JSON.stringify(value), { encoding: "utf8", mode: 0o600 })
		}
		const ledger = new RuntimeSessionLedger({
			dataDir,
			sessionId: "current",
			now: () => 1_000,
			pid: 999,
			processAlive: () => false,
			heartbeatIntervalMs: 0x7fffffff,
			writeDocument,
		})
		await ledger.startAndReconcile()

		const firstClaim = await ledger.claimReconciliationsForReporting()
		expect(firstClaim.map(({ outcome, ageMs }) => ({ outcome, ageMs }))).toEqual([
			{ outcome: "unclean_inferred", ageMs: 800 },
		])
		await expect(firstClaim[0]?.commit()).rejects.toThrow("acknowledgment failed")

		const retryClaim = await ledger.claimReconciliationsForReporting()
		expect(retryClaim.map(({ outcome, ageMs }) => ({ outcome, ageMs }))).toEqual([
			{ outcome: "unclean_inferred", ageMs: 800 },
		])
		await retryClaim[0]?.commit()
		expect(await ledger.claimReconciliationsForReporting()).toEqual([])
		await ledger.complete()
	})

	it("retries completion after a transient write failure", async () => {
		const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-ledger-"))
		roots.push(dataDir)
		let writes = 0
		const writeDocument = async (filePath: string, value: RuntimeSessionLedgerDocument) => {
			writes++
			if (writes === 2) throw new Error("completion failed")
			await fs.writeFile(filePath, JSON.stringify(value), { encoding: "utf8", mode: 0o600 })
		}
		const ledger = new RuntimeSessionLedger({
			dataDir,
			sessionId: "current",
			pid: 999,
			processAlive: () => false,
			heartbeatIntervalMs: 0x7fffffff,
			writeDocument,
		})
		await ledger.startAndReconcile()

		await expect(ledger.complete()).rejects.toThrow("completion failed")
		await expect(ledger.complete()).resolves.toBeUndefined()
	})

	it("retains unreported evidence while pruning only acknowledged ledgers", async () => {
		const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-ledger-"))
		roots.push(dataDir)
		const directory = path.join(dataDir, "runtime", "session-ledgers")
		await fs.mkdir(directory, { recursive: true })
		for (let index = 0; index < 24; index++) {
			await fs.writeFile(
				path.join(directory, `reported-${index}.json`),
				JSON.stringify(document({ sessionId: `reported-${index}`, reconciliationReportedAt: 300 + index })),
				"utf8",
			)
		}
		await fs.writeFile(path.join(directory, "pending.json"), JSON.stringify(document({ sessionId: "pending" })), "utf8")
		await fs.writeFile(
			path.join(directory, "active.json"),
			JSON.stringify(document({ sessionId: "active", pid: 321, heartbeatAt: 990 })),
			"utf8",
		)
		const ledger = new RuntimeSessionLedger({
			dataDir,
			sessionId: "current",
			now: () => 1_000,
			pid: 999,
			processAlive: (pid) => (pid === 321 ? true : false),
			heartbeatIntervalMs: 0x7fffffff,
		})

		await ledger.startAndReconcile()
		await expect(fs.access(path.join(directory, "pending.json"))).resolves.toBeUndefined()
		await expect(fs.access(path.join(directory, "active.json"))).resolves.toBeUndefined()
		const remaining = (await fs.readdir(directory)).filter((name) => name.endsWith(".json"))
		expect(remaining).toHaveLength(20)
		await ledger.complete()
	})

	it("bounds long-term unreported ledgers and records an aggregate retention summary", async () => {
		const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-ledger-"))
		roots.push(dataDir)
		const directory = path.join(dataDir, "runtime", "session-ledgers")
		await fs.mkdir(directory, { recursive: true })
		for (let index = 0; index < 24; index++) {
			await fs.writeFile(
				path.join(directory, `pending-${index}.json`),
				JSON.stringify(document({ sessionId: `pending-${index}` })),
				"utf8",
			)
		}
		const ledger = new RuntimeSessionLedger({
			dataDir,
			sessionId: "current",
			now: () => 1_000,
			pid: 999,
			processAlive: () => false,
			heartbeatIntervalMs: 0x7fffffff,
		})

		await ledger.startAndReconcile()
		const remaining = (await fs.readdir(directory)).filter((name) => name.endsWith(".json"))
		expect(remaining).toHaveLength(20)
		expect(JSON.parse(await fs.readFile(path.join(directory, ".retention-summary"), "utf8"))).toMatchObject({
			schemaVersion: 1,
			droppedUnreportedCount: 5,
		})
		await ledger.complete()
	})

	it("classifies semantically invalid documents as corrupt without probing their pid", async () => {
		const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-ledger-"))
		roots.push(dataDir)
		const directory = path.join(dataDir, "runtime", "session-ledgers")
		await fs.mkdir(directory, { recursive: true })
		await fs.writeFile(path.join(directory, "invalid.json"), JSON.stringify(document({ pid: 0, heartbeatAt: -1 })), "utf8")
		const processAlive = () => {
			throw new Error("must not probe invalid pid")
		}
		const ledger = new RuntimeSessionLedger({
			dataDir,
			sessionId: "current",
			pid: 999,
			processAlive,
			heartbeatIntervalMs: 0x7fffffff,
		})

		expect(await ledger.startAndReconcile()).toEqual([{ outcome: "corrupt" }])
		await ledger.complete()
	})

	it("skips terminal ledgers that were already admitted to telemetry", async () => {
		const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-ledger-"))
		roots.push(dataDir)
		const directory = path.join(dataDir, "runtime", "session-ledgers")
		await fs.mkdir(directory, { recursive: true })
		await fs.writeFile(
			path.join(directory, "reported.json"),
			JSON.stringify(document({ deactivationCompletedAt: 220, reconciliationReportedAt: 230 })),
			"utf8",
		)
		const ledger = new RuntimeSessionLedger({
			dataDir,
			sessionId: "current",
			now: () => 300,
			pid: 999,
			processAlive: () => false,
			heartbeatIntervalMs: 0x7fffffff,
		})

		expect(await ledger.startAndReconcile()).toEqual([])
		await ledger.complete()
	})
})
