import fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
	backupPathOf,
	readJsonWithBackup,
	readJsonWithBackupSync,
	removeStaleAtomicTempFiles,
	writeFileAtomic,
	writeJsonAtomic,
	writeJsonAtomicSync,
} from "../atomic-file"

const fsMock = vi.hoisted(() => ({
	rename: vi.fn<typeof import("node:fs/promises").rename>(),
	renameSync: vi.fn<typeof import("node:fs").renameSync>(),
	actualRename: undefined as typeof import("node:fs/promises").rename | undefined,
	actualRenameSync: undefined as typeof import("node:fs").renameSync | undefined,
}))

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>()
	fsMock.actualRename = actual.rename
	return { ...actual, rename: fsMock.rename }
})

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>()
	fsMock.actualRenameSync = actual.renameSync
	return { ...actual, renameSync: fsMock.renameSync }
})

function errnoError(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`${code}: simulated`), { code })
}

function parseVersioned(value: unknown): { version: number } {
	if (typeof value !== "object" || value === null || typeof (value as { version?: unknown }).version !== "number") {
		throw new Error("not a versioned document")
	}
	return value as { version: number }
}

describe("atomic-file", () => {
	let directory: string
	let target: string

	beforeEach(async () => {
		directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "dline-atomic-file-"))
		target = path.join(directory, "state.json")
		fsMock.rename.mockReset()
		fsMock.rename.mockImplementation((source, destination) => fsMock.actualRename!(source, destination))
		fsMock.renameSync.mockReset()
		fsMock.renameSync.mockImplementation((source, destination) => fsMock.actualRenameSync!(source, destination))
	})

	afterEach(async () => {
		await fsPromises.rm(directory, { recursive: true, force: true })
	})

	async function directoryEntries(): Promise<string[]> {
		return (await fsPromises.readdir(directory)).sort()
	}

	it("writes JSON with two-space indentation and a trailing newline and leaves no temporary file", async () => {
		await writeJsonAtomic(target, { version: 1, nested: { ok: true } })

		expect(await fsPromises.readFile(target, "utf8")).toBe('{\n  "version": 1,\n  "nested": {\n    "ok": true\n  }\n}\n')
		expect(await directoryEntries()).toEqual(["state.json"])
	})

	it("creates missing parent directories", async () => {
		const nested = path.join(directory, "a", "b", "payload.bin")

		await writeFileAtomic(nested, new Uint8Array([1, 2, 3]))

		expect([...(await fsPromises.readFile(nested))]).toEqual([1, 2, 3])
	})

	it("retries a busy destination and publishes once the handle is released", async () => {
		fsMock.rename.mockRejectedValueOnce(errnoError("EBUSY")).mockRejectedValueOnce(errnoError("EPERM"))

		await writeJsonAtomic(target, { version: 2 })

		expect(fsMock.rename).toHaveBeenCalledTimes(3)
		expect(JSON.parse(await fsPromises.readFile(target, "utf8"))).toEqual({ version: 2 })
		expect(await directoryEntries()).toEqual(["state.json"])
	})

	it("throws the rename error after bounded retries, keeps the old file, and removes the temporary file", async () => {
		await writeJsonAtomic(target, { version: 1 })
		fsMock.rename.mockReset()
		fsMock.rename.mockRejectedValue(errnoError("EACCES"))

		await expect(writeJsonAtomic(target, { version: 2 })).rejects.toMatchObject({ code: "EACCES" })

		expect(fsMock.rename).toHaveBeenCalledTimes(5)
		expect(JSON.parse(await fsPromises.readFile(target, "utf8"))).toEqual({ version: 1 })
		expect(await directoryEntries()).toEqual(["state.json"])
	})

	it("does not retry errors that are not transient sharing violations", async () => {
		fsMock.rename.mockRejectedValueOnce(errnoError("ENOSPC"))

		await expect(writeJsonAtomic(target, { version: 1 })).rejects.toMatchObject({ code: "ENOSPC" })

		expect(fsMock.rename).toHaveBeenCalledTimes(1)
		expect(await directoryEntries()).toEqual([])
	})

	it("rotates the previous document to .bak when backup is enabled", async () => {
		await writeJsonAtomic(target, { version: 1 }, { backup: true })
		await writeJsonAtomic(target, { version: 2 }, { backup: true })

		expect(JSON.parse(await fsPromises.readFile(target, "utf8"))).toEqual({ version: 2 })
		expect(JSON.parse(await fsPromises.readFile(backupPathOf(target), "utf8"))).toEqual({ version: 1 })
		expect(await directoryEntries()).toEqual(["state.json", "state.json.bak"])
	})

	it("restores the rotated document when publishing the new one fails", async () => {
		await writeJsonAtomic(target, { version: 1 }, { backup: true })
		fsMock.rename.mockImplementation(async (source, destination) => {
			if (String(source).endsWith(".tmp")) throw errnoError("ENOSPC")
			return fsMock.actualRename!(source, destination)
		})

		await expect(writeJsonAtomic(target, { version: 2 }, { backup: true })).rejects.toMatchObject({ code: "ENOSPC" })

		expect(JSON.parse(await fsPromises.readFile(target, "utf8"))).toEqual({ version: 1 })
		expect(await directoryEntries()).toEqual(["state.json"])
	})

	it("reads the backup when the primary is missing, corrupt, or rejected by the parser", async () => {
		await fsPromises.writeFile(backupPathOf(target), '{ "version": 7 }\n')

		expect(await readJsonWithBackup(target, parseVersioned)).toMatchObject({ status: "backup", value: { version: 7 } })

		await fsPromises.writeFile(target, '{ "version": ')
		expect(await readJsonWithBackup(target, parseVersioned)).toMatchObject({ status: "backup", value: { version: 7 } })

		await fsPromises.writeFile(target, '{ "other": true }')
		expect(await readJsonWithBackup(target, parseVersioned)).toMatchObject({ status: "backup", value: { version: 7 } })

		await fsPromises.writeFile(target, '{ "version": 8 }')
		expect(await readJsonWithBackup(target, parseVersioned)).toEqual({ status: "primary", value: { version: 8 } })
	})

	it("reports missing when neither file exists and invalid when no candidate parses", async () => {
		expect(await readJsonWithBackup(target, parseVersioned)).toEqual({ status: "missing" })

		await fsPromises.writeFile(target, "not json")
		const result = await readJsonWithBackup(target, parseVersioned)
		expect(result.status).toBe("invalid")

		await fsPromises.rm(target)
		await fsPromises.writeFile(backupPathOf(target), "{}")
		expect((await readJsonWithBackup(target, parseVersioned)).status).toBe("invalid")
	})

	it("provides the same retry, backup, and fallback behavior synchronously", async () => {
		fsMock.renameSync.mockImplementationOnce(() => {
			throw errnoError("EBUSY")
		})

		writeJsonAtomicSync(target, { version: 1 }, { backup: true })
		writeJsonAtomicSync(target, { version: 2 }, { backup: true })

		expect(fsMock.renameSync.mock.calls.length).toBeGreaterThanOrEqual(3)
		expect(readJsonWithBackupSync(target, parseVersioned)).toEqual({ status: "primary", value: { version: 2 } })
		await fsPromises.writeFile(target, "{")
		expect(readJsonWithBackupSync(target, parseVersioned)).toMatchObject({ status: "backup", value: { version: 1 } })
		expect(await directoryEntries()).toEqual(["state.json", "state.json.bak"])
	})

	it("removes stale temporary files from current and legacy writers only", async () => {
		const names = [
			"state.json.123.0f8fad5b-d9cb-469f-a165-70867728950e.tmp",
			"settings.json.tmp.1790000000000.k3j9x2.json",
			"settings.json.tmp.1790000000000.0f8fad5b-d9cb-469f-a165-70867728950e.json",
			"state.json",
			"notes.tmp",
		]
		for (const name of names) await fsPromises.writeFile(path.join(directory, name), "x")

		await removeStaleAtomicTempFiles(directory, 60_000, Date.now() + 120_000)

		expect(await directoryEntries()).toEqual(["notes.tmp", "state.json"])
	})

	it("keeps temporary files younger than the stale threshold", async () => {
		const fresh = "state.json.123.0f8fad5b-d9cb-469f-a165-70867728950e.tmp"
		await fsPromises.writeFile(path.join(directory, fresh), "x")

		await removeStaleAtomicTempFiles(directory, 60_000)

		expect(await directoryEntries()).toEqual([fresh])
	})

	it.skipIf(process.platform === "win32")("publishes the requested permission bits", async () => {
		await writeJsonAtomic(target, { version: 1 }, { mode: 0o600 })

		expect((await fsPromises.stat(target)).mode & 0o777).toBe(0o600)
	})
})
