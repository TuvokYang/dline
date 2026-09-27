import * as fs from "node:fs"
import fsPromises from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ClineFileStorage } from "../ClineFileStorage"

const fsMock = vi.hoisted(() => ({
	renameSync: vi.fn<typeof import("node:fs").renameSync>(),
	actualRenameSync: undefined as typeof import("node:fs").renameSync | undefined,
}))

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>()
	fsMock.actualRenameSync = actual.renameSync
	return { ...actual, renameSync: fsMock.renameSync }
})

describe("ClineFileStorage", () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "dline-file-storage-"))
		fsMock.renameSync.mockReset()
		fsMock.renameSync.mockImplementation((sourcePath, destinationPath) =>
			fsMock.actualRenameSync!(sourcePath, destinationPath),
		)
	})

	afterEach(async () => {
		await fsPromises.rm(tempDir, { recursive: true, force: true })
	})

	it("retries transient Windows rename failures up to the third attempt", () => {
		const storagePath = path.join(tempDir, "api_keys.json")
		let attempts = 0
		fsMock.renameSync.mockImplementation((sourcePath, destinationPath) => {
			attempts++
			if (attempts < 3) {
				throw Object.assign(new Error("file is temporarily locked"), {
					code: "EPERM",
					syscall: "rename",
					path: sourcePath,
					dest: destinationPath,
				})
			}
			return fsMock.actualRenameSync!(sourcePath, destinationPath)
		})

		const storage = new ClineFileStorage<{ apiKey: string }>(storagePath, "ApiKeyStore")
		storage.setBatch({ profile: { apiKey: "secret" } })

		expect(attempts).toBe(3)
		expect(JSON.parse(fs.readFileSync(storagePath, "utf8"))).toEqual({ profile: { apiKey: "secret" } })
	})

	it("merges completed writes from another storage instance before persisting", () => {
		const storagePath = path.join(tempDir, "api_keys.json")
		const first = new ClineFileStorage<{ apiKey: string }>(storagePath, "FirstApiKeyStore")
		const second = new ClineFileStorage<{ apiKey: string }>(storagePath, "SecondApiKeyStore")

		first.setBatch({ first: { apiKey: "secret-1" } })
		second.setBatch({ second: { apiKey: "secret-2" } })

		expect(JSON.parse(fs.readFileSync(storagePath, "utf8"))).toEqual({
			first: { apiKey: "secret-1" },
			second: { apiKey: "secret-2" },
		})
		first.reload()
		expect(first.get("second")).toEqual({ apiKey: "secret-2" })
	})

	it("propagates permanent write failures without committing the in-memory value", () => {
		const storagePath = path.join(tempDir, "api_keys.json")
		const storage = new ClineFileStorage<{ apiKey: string }>(storagePath, "ApiKeyStore")
		const failure = Object.assign(new Error("destination is invalid"), {
			code: "EINVAL",
			syscall: "rename",
		})
		fsMock.renameSync.mockImplementation(() => {
			throw failure
		})

		expect(() => storage.setBatch({ profile: { apiKey: "secret" } })).toThrow(failure)
		expect(storage.get("profile")).toBeUndefined()
		expect(fs.existsSync(storagePath)).toBe(false)
	})

	it("stops after the bounded transient rename retries and preserves the original error", () => {
		const storagePath = path.join(tempDir, "api_keys.json")
		const storage = new ClineFileStorage<{ apiKey: string }>(storagePath, "ApiKeyStore")
		const failure = Object.assign(new Error("file remained locked"), {
			code: "EPERM",
			syscall: "rename",
		})
		fsMock.renameSync.mockImplementation(() => {
			throw failure
		})

		expect(() => storage.setBatch({ profile: { apiKey: "secret" } })).toThrow(failure)
		// One attempt plus the four retries of the shared atomic-file primitive.
		expect(fsMock.renameSync).toHaveBeenCalledTimes(5)
		expect(storage.get("profile")).toBeUndefined()
		expect(fs.existsSync(storagePath)).toBe(false)
	})

	it("commits asynchronous values only after the durable write succeeds", async () => {
		const storagePath = path.join(tempDir, "settings.json")
		const storage = new ClineFileStorage<string>(storagePath, "SettingsStore")

		const pendingWrite = storage.setBatchAsync({ theme: "dark" })

		expect(storage.get("theme")).toBeUndefined()
		await pendingWrite
		expect(storage.get("theme")).toBe("dark")
		expect(JSON.parse(await fsPromises.readFile(storagePath, "utf8"))).toEqual({ theme: "dark" })
	})

	it("serializes queued asynchronous writes without losing keys", async () => {
		const storagePath = path.join(tempDir, "settings.json")
		const storage = new ClineFileStorage<string>(storagePath, "SettingsStore")

		const firstWrite = storage.setBatchAsync({ theme: "dark" })
		const secondWrite = storage.setBatchAsync({ locale: "en" })
		await Promise.all([firstWrite, secondWrite])

		expect(JSON.parse(await fsPromises.readFile(storagePath, "utf8"))).toEqual({
			theme: "dark",
			locale: "en",
		})
	})

	it("continues asynchronous writes after an earlier durable failure", async () => {
		const blockedDirectory = path.join(tempDir, "blocked")
		await fsPromises.writeFile(blockedDirectory, "not a directory")
		const storagePath = path.join(blockedDirectory, "settings.json")
		const storage = new ClineFileStorage<string>(storagePath, "SettingsStore")

		await expect(storage.setBatchAsync({ theme: "dark" })).rejects.toThrow()
		expect(storage.get("theme")).toBeUndefined()

		await fsPromises.unlink(blockedDirectory)
		await fsPromises.mkdir(blockedDirectory)
		await storage.setBatchAsync({ locale: "en" })

		expect(storage.get("locale")).toBe("en")
		expect(JSON.parse(await fsPromises.readFile(storagePath, "utf8"))).toEqual({ locale: "en" })
	})
})
