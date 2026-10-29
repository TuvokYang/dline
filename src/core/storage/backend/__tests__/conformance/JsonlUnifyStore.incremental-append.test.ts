import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { openBufferedJsonlStore } from "../../jsonl/JsonlUnifyStore"

interface Item {
    ts: number
    value: string
}

describe("buffered JSONL incremental append", () => {
    it("appends one durable row without reading or rewriting the committed JSONL", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-jsonl-append-only-"))
        const filePath = path.join(root, "items.jsonl")
        try {
            await fs.writeFile(filePath, `${JSON.stringify({ ts: 1, value: "seed" })}\n`, "utf8")
            const store = await openBufferedJsonlStore<Item>(filePath, {
                schemaId: "incremental-append-test",
                flushIntervalMs: 60_000,
                acceptInitialItem: (item) => item.ts > 0,
            })
            const readSpy = vi.spyOn(fs, "readFile")
            const writeSpy = vi.spyOn(fs, "writeFile")
            try {
                await store.append({ ts: 2, value: "appended" })
                await store.flush()
                const dataReads = readSpy.mock.calls.filter(([target]) => path.resolve(String(target)) === path.resolve(filePath))
                expect(dataReads).toHaveLength(0)
                expect(writeSpy).not.toHaveBeenCalled()
                expect(await fs.readFile(filePath, "utf8")).toBe(
                    `${JSON.stringify({ ts: 1, value: "seed" })}\n${JSON.stringify({ ts: 2, value: "appended" })}\n`,
                )
            } finally {
                readSpy.mockRestore()
                writeSpy.mockRestore()
                await store.close()
            }
        } finally {
            await fs.rm(root, { recursive: true, force: true })
        }
    })

    it("commits a dirty tail and final durable row with append-only I/O", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-jsonl-durable-tail-"))
        const filePath = path.join(root, "items.jsonl")
        try {
            await fs.writeFile(filePath, `${JSON.stringify({ ts: 1, value: "seed" })}\n`, "utf8")
            const store = await openBufferedJsonlStore<Item>(filePath, {
                schemaId: "durable-tail-test",
                flushIntervalMs: 60_000,
                acceptInitialItem: (item) => item.ts > 0,
            })
            const readSpy = vi.spyOn(fs, "readFile")
            const writeSpy = vi.spyOn(fs, "writeFile")
            try {
                await store.append({ ts: 2, value: "dirty-tail" })
                await store.appendDurable({ ts: 3, value: "final" })
                const dataReads = readSpy.mock.calls.filter(([target]) => path.resolve(String(target)) === path.resolve(filePath))
                expect(dataReads).toHaveLength(0)
                expect(writeSpy).not.toHaveBeenCalled()
                expect(await fs.readFile(filePath, "utf8")).toBe(
                    `${JSON.stringify({ ts: 1, value: "seed" })}\n${JSON.stringify({ ts: 2, value: "dirty-tail" })}\n${JSON.stringify({ ts: 3, value: "final" })}\n`,
                )
            } finally {
                readSpy.mockRestore()
                writeSpy.mockRestore()
                await store.close()
            }
        } finally {
            await fs.rm(root, { recursive: true, force: true })
        }
    })

    it("truncates a durable tail without reading or rewriting the retained JSONL prefix", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-jsonl-tail-truncate-"))
        const filePath = path.join(root, "items.jsonl")
        try {
            const retained = [
                { ts: 1, value: "one" },
                { ts: 2, value: "two" },
            ]
            const removed = [
                { ts: 3, value: "three" },
                { ts: 4, value: "four" },
            ]
            await fs.writeFile(filePath, `${[...retained, ...removed].map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8")
            const store = await openBufferedJsonlStore<Item>(filePath, {
                schemaId: "tail-truncate-test",
                flushIntervalMs: 60_000,
                acceptInitialItem: (item) => item.ts > 0,
            })
            const readSpy = vi.spyOn(fs, "readFile")
            const writeSpy = vi.spyOn(fs, "writeFile")
            try {
                await store.truncateAt(retained.length)
                const dataReads = readSpy.mock.calls.filter(([target]) => path.resolve(String(target)) === path.resolve(filePath))
                expect(dataReads).toHaveLength(0)
                expect(writeSpy).not.toHaveBeenCalled()
                expect(await fs.readFile(filePath, "utf8")).toBe(`${retained.map((item) => JSON.stringify(item)).join("\n")}\n`)
                expect(store.getAll()).toEqual(retained)
            } finally {
                readSpy.mockRestore()
                writeSpy.mockRestore()
                await store.close()
            }
        } finally {
            await fs.rm(root, { recursive: true, force: true })
        }
    })

    it("rejects a durable append over structural dirtiness without full-file I/O", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-jsonl-durable-structural-"))
        const filePath = path.join(root, "items.jsonl")
        try {
            const seed = `${JSON.stringify({ ts: 1, value: "seed" })}\n`
            await fs.writeFile(filePath, seed, "utf8")
            const store = await openBufferedJsonlStore<Item>(filePath, {
                schemaId: "durable-structural-test",
                flushIntervalMs: 60_000,
                acceptInitialItem: (item) => item.ts > 0,
            })
            const readSpy = vi.spyOn(fs, "readFile")
            const writeSpy = vi.spyOn(fs, "writeFile")
            try {
                await store.stagePatchAt(0, { value: "patched" })
                await expect(store.appendDurable({ ts: 2, value: "final" })).rejects.toThrow(/clean or append-only buffer/)
                const dataReads = readSpy.mock.calls.filter(([target]) => path.resolve(String(target)) === path.resolve(filePath))
                expect(dataReads).toHaveLength(0)
                expect(writeSpy).not.toHaveBeenCalled()
                expect(await fs.readFile(filePath, "utf8")).toBe(seed)
            } finally {
                readSpy.mockRestore()
                writeSpy.mockRestore()
                await store.reload(true)
                await store.close()
            }
        } finally {
            await fs.rm(root, { recursive: true, force: true })
        }
    })

    it("commits a staged rewrite before the durable row that follows it", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-jsonl-durable-after-rewrite-"))
        const filePath = path.join(root, "items.jsonl")
        try {
            await fs.writeFile(filePath, `${JSON.stringify({ ts: 1, value: "seed" })}\n`, "utf8")
            const store = await openBufferedJsonlStore<Item>(filePath, {
                schemaId: "durable-after-rewrite-test",
                flushIntervalMs: 60_000,
                acceptInitialItem: (item) => item.ts > 0,
            })
            try {
                await store.stagePatchAt(0, { value: "patched" })
                await expect(store.commitPendingAndAppendDurable({ ts: 2, value: "final" })).resolves.toEqual({
                    ts: 2,
                    value: "final",
                })
                expect(await fs.readFile(filePath, "utf8")).toBe(
                    `${JSON.stringify({ ts: 1, value: "patched" })}\n${JSON.stringify({ ts: 2, value: "final" })}\n`,
                )
                expect(store.getAll()).toEqual([
                    { ts: 1, value: "patched" },
                    { ts: 2, value: "final" },
                ])
            } finally {
                await store.close()
            }
        } finally {
            await fs.rm(root, { recursive: true, force: true })
        }
    })

    it("keeps the append-only commit when only appends are staged before the durable row", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-jsonl-durable-after-tail-"))
        const filePath = path.join(root, "items.jsonl")
        try {
            await fs.writeFile(filePath, `${JSON.stringify({ ts: 1, value: "seed" })}\n`, "utf8")
            const store = await openBufferedJsonlStore<Item>(filePath, {
                schemaId: "durable-after-tail-test",
                flushIntervalMs: 60_000,
                acceptInitialItem: (item) => item.ts > 0,
            })
            const readSpy = vi.spyOn(fs, "readFile")
            const writeSpy = vi.spyOn(fs, "writeFile")
            try {
                await store.append({ ts: 2, value: "dirty-tail" })
                await store.commitPendingAndAppendDurable({ ts: 3, value: "final" })
                const dataReads = readSpy.mock.calls.filter(([target]) => path.resolve(String(target)) === path.resolve(filePath))
                expect(dataReads).toHaveLength(0)
                expect(writeSpy).not.toHaveBeenCalled()
            } finally {
                readSpy.mockRestore()
                writeSpy.mockRestore()
                await store.close()
            }
            expect(await fs.readFile(filePath, "utf8")).toBe(
                `${JSON.stringify({ ts: 1, value: "seed" })}\n${JSON.stringify({ ts: 2, value: "dirty-tail" })}\n${JSON.stringify({ ts: 3, value: "final" })}\n`,
            )
        } finally {
            await fs.rm(root, { recursive: true, force: true })
        }
    })
})
