/**
 * Unit tests for JSONL utilities (readJsonl, appendJsonl, writeJsonl, migration).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "should"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { appendJsonl, readJsonl, writeJsonl } from "../../jsonl/jsonl-utils"

const fsMock = vi.hoisted(() => ({
	rename: vi.fn<typeof import("fs/promises").rename>(),
	actualRename: undefined as typeof import("fs/promises").rename | undefined,
}))

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	fsMock.actualRename = actual.rename
	return { ...actual, default: { ...actual, rename: fsMock.rename } }
})

describe("jsonl-utils", () => {
	let tmpDir: string

	beforeEach(() => {
		fsMock.rename.mockReset()
		fsMock.rename.mockImplementation((sourcePath, destinationPath) => fsMock.actualRename!(sourcePath, destinationPath))
	})

	afterEach(async () => {
		if (tmpDir) {
			try {
				await fs.rm(tmpDir, { recursive: true, force: true })
			} catch {
				/* ignore */
			}
		}
	})

	async function mkTmpFile(name: string, content: string): Promise<string> {
		tmpDir = path.join(os.tmpdir(), `jsonl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
		await fs.mkdir(tmpDir, { recursive: true })
		const fp = path.join(tmpDir, name)
		await fs.writeFile(fp, content, "utf8")
		return fp
	}

	describe("readJsonl", () => {
		it("should return [] for non-existent file", async () => {
			const result = await readJsonl("/nonexistent/path/file.jsonl")
			result.should.deepEqual([])
		})

		it("should return [] for empty file", async () => {
			const fp = await mkTmpFile("empty.jsonl", "")
			const result = await readJsonl(fp)
			result.should.deepEqual([])
		})

		it("should return [] for whitespace-only file", async () => {
			const fp = await mkTmpFile("ws.jsonl", "  \n  \n")
			const result = await readJsonl(fp)
			result.should.deepEqual([])
		})

		it("should parse single JSONL line", async () => {
			const fp = await mkTmpFile("single.jsonl", '{"a":1}\n')
			const result = await readJsonl(fp)
			result.should.deepEqual([{ a: 1 }])
		})

		it("should parse multiple JSONL lines", async () => {
			const fp = await mkTmpFile("multi.jsonl", '{"a":1}\n{"b":2}\n{"c":3}\n')
			const result = await readJsonl(fp)
			result.should.deepEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
		})

		it("should skip empty lines in JSONL", async () => {
			const fp = await mkTmpFile("gaps.jsonl", '{"a":1}\n\n{"b":2}\n\n')
			const result = await readJsonl(fp)
			result.should.deepEqual([{ a: 1 }, { b: 2 }])
		})

		it("should parse legacy JSON array without overwriting original file", async () => {
			const fp = await mkTmpFile("legacy.json", '[{"x":1},{"y":2}]')
			const result = await readJsonl(fp)
			result.should.deepEqual([{ x: 1 }, { y: 2 }])

			// Verify original file is preserved (NOT auto-migrated to JSONL)
			const content = await fs.readFile(fp, "utf8")
			content.should.match(/^\[/)
			content.should.match(/\{"x":1\}/)
		})

		it("should handle empty JSON array", async () => {
			const fp = await mkTmpFile("empty-arr.json", "[]")
			const result = await readJsonl(fp)
			result.should.deepEqual([])
		})

		it("should handle JSON array with special chars", async () => {
			const fp = await mkTmpFile("special.json", JSON.stringify([{ text: "hello\nworld", emoji: "😀" }]))
			const result = await readJsonl(fp)
			result.should.deepEqual([{ text: "hello\nworld", emoji: "😀" }])
		})

		it("should handle corrupted JSON gracefully", async () => {
			const fp = await mkTmpFile("corrupt.json", "[{broken")
			const result = await readJsonl(fp)
			result.should.deepEqual([])
		})

		it("should skip malformed lines in JSONL", async () => {
			const fp = await mkTmpFile("bad-lines.jsonl", '{"ok":1}\n{broken\n{"ok":2}\n')
			const result = await readJsonl(fp)
			result.should.deepEqual([{ ok: 1 }, { ok: 2 }])
		})
	})

	describe("appendJsonl", () => {
		it("should append single entry to new file", async () => {
			const fp = path.join(tmpDir || ((tmpDir = path.join(os.tmpdir(), `jl-${Date.now()}`)) && tmpDir), "append.jsonl")
			await fs.mkdir(path.dirname(fp), { recursive: true })

			await appendJsonl(fp, { a: 1 })
			const result = await readJsonl(fp)
			result.should.deepEqual([{ a: 1 }])
		})

		it("should append multiple entries", async () => {
			tmpDir = path.join(os.tmpdir(), `jsonl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
			await fs.mkdir(tmpDir, { recursive: true })
			const fp = path.join(tmpDir, "append.jsonl")

			await appendJsonl(fp, [{ a: 1 }, { b: 2 }])
			const result = await readJsonl(fp)
			result.should.deepEqual([{ a: 1 }, { b: 2 }])
		})

		it("should append to existing file", async () => {
			tmpDir = path.join(os.tmpdir(), `jsonl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
			await fs.mkdir(tmpDir, { recursive: true })
			const fp = path.join(tmpDir, "append.jsonl")

			await appendJsonl(fp, { first: 1 })
			await appendJsonl(fp, { second: 2 })
			const result = await readJsonl(fp)
			result.should.deepEqual([{ first: 1 }, { second: 2 }])
		})
	})

	describe("writeJsonl", () => {
		it("should write full array as JSONL", async () => {
			tmpDir = path.join(os.tmpdir(), `jsonl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
			await fs.mkdir(tmpDir, { recursive: true })
			const fp = path.join(tmpDir, "write.jsonl")

			await writeJsonl(fp, [{ x: 1 }, { y: 2 }, { z: 3 }])
			const result = await readJsonl(fp)
			result.should.deepEqual([{ x: 1 }, { y: 2 }, { z: 3 }])
		})

		it("should write empty array as empty file", async () => {
			tmpDir = path.join(os.tmpdir(), `jsonl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
			await fs.mkdir(tmpDir, { recursive: true })
			const fp = path.join(tmpDir, "empty-write.jsonl")

			await writeJsonl(fp, [])
			const result = await readJsonl(fp)
			result.should.deepEqual([])
		})

		it("retries a transient Windows rename before replacing the JSONL file", async () => {
			tmpDir = path.join(os.tmpdir(), `jsonl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
			await fs.mkdir(tmpDir, { recursive: true })
			const fp = path.join(tmpDir, "retry-write.jsonl")
			let attempts = 0
			fsMock.rename.mockImplementation((sourcePath, destinationPath) => {
				attempts++
				if (attempts === 1) {
					return Promise.reject(
						Object.assign(new Error("file is temporarily locked"), {
							code: "EPERM",
							syscall: "rename",
							path: sourcePath,
							dest: destinationPath,
						}),
					)
				}
				return fsMock.actualRename!(sourcePath, destinationPath)
			})

			await expect(writeJsonl(fp, [{ ts: 1, text: "persisted" }])).resolves.toBeUndefined()
			expect(attempts).toBe(2)
			expect(await readJsonl(fp)).toEqual([{ ts: 1, text: "persisted" }])
		})

		it("keeps the previous file and removes its temp file when the rename fails", async () => {
			tmpDir = path.join(os.tmpdir(), `jsonl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
			await fs.mkdir(tmpDir, { recursive: true })
			const fp = path.join(tmpDir, "failed-write.jsonl")
			await writeJsonl(fp, [{ ts: 1, text: "previous" }])
			fsMock.rename.mockRejectedValue(Object.assign(new Error("disk full"), { code: "ENOSPC", syscall: "rename" }))

			await expect(writeJsonl(fp, [{ ts: 2, text: "lost" }])).rejects.toMatchObject({ code: "ENOSPC" })

			expect(await readJsonl(fp)).toEqual([{ ts: 1, text: "previous" }])
			expect(await fs.readdir(tmpDir)).toEqual(["failed-write.jsonl"])
		})
	})

	describe("round-trip", () => {
		it("should preserve data through write → read cycle", async () => {
			tmpDir = path.join(os.tmpdir(), `jsonl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
			await fs.mkdir(tmpDir, { recursive: true })
			const fp = path.join(tmpDir, "roundtrip.jsonl")

			const data = [
				{ ts: 1, type: "say", text: "hello" },
				{ ts: 2, type: "ask", text: "world" },
				{ ts: 3, type: "say", text: "foo\nbar" },
			]
			await writeJsonl(fp, data)
			const result = await readJsonl(fp)
			result.should.deepEqual(data)
		})

		it("should preserve data through append → read cycle", async () => {
			tmpDir = path.join(os.tmpdir(), `jsonl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
			await fs.mkdir(tmpDir, { recursive: true })
			const fp = path.join(tmpDir, "append-roundtrip.jsonl")

			await appendJsonl(fp, { ts: 1, text: "first" })
			await appendJsonl(fp, { ts: 2, text: "second" })
			const result = await readJsonl(fp)
			result.should.deepEqual([
				{ ts: 1, text: "first" },
				{ ts: 2, text: "second" },
			])
		})
	})
})
