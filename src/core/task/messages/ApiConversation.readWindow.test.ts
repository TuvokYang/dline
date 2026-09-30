import type { ClineStorageMessage } from "@shared/messages"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiConversation } from "@/core/storage/ApiConversation"

const io = vi.hoisted(() => ({ open: vi.fn(), readJsonl: vi.fn() }))
vi.mock("node:fs/promises", () => ({ default: { open: io.open } }))
vi.mock("@utils/fs", () => ({ fileExistsAtPath: vi.fn(async () => true) }))
vi.mock("@/core/storage/disk", () => ({
	ensureTaskDirectoryExists: vi.fn(async () => "fixture/task-1"),
	getDlineDocumentsPath: vi.fn(async () => "fixture"),
	GlobalFileNames: { apiConversationHistory: "api_conversation_history.jsonl" },
}))
vi.mock("@/core/storage/backend/jsonl/jsonl-utils", () => ({ readJsonl: io.readJsonl }))

function handleFor(text: string, onRead?: (position: number) => void) {
	const bytes = Buffer.from(text, "utf8")
	const handle = {
		stat: vi.fn(async () => ({ size: bytes.length })),
		read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
			onRead?.(position)
			const bytesRead = Math.max(0, Math.min(length, bytes.length - position))
			bytes.copy(buffer, offset, position, position + bytesRead)
			return { bytesRead, buffer }
		}),
		close: vi.fn(async () => undefined),
	}
	io.open.mockResolvedValueOnce(handle)
	return handle
}

beforeEach(() => {
	io.open.mockReset()
	io.readJsonl.mockReset()
})

describe("ApiConversation.readWindow", () => {
	it("keeps only the recovery suffix and exact selected anchors across chunk boundaries", async () => {
		const history: ClineStorageMessage[] = Array.from({ length: 150 }, (_, index) => ({
			ts: index + 1,
			role: index % 2 === 0 ? "user" : "assistant",
			content: `${index}: ${"上下文🙂".repeat(200)}`,
		}))
		const handle = handleFor(history.map((message) => JSON.stringify(message)).join("\n"))
		const window = await ApiConversation.readWindow("task-1", { tailStartIndex: 148, requiredIndices: [1, 7] })
		expect(window.historyLength).toBe(150)
		expect(window.tailStartIndex).toBe(148)
		expect(window.tail).toEqual(history.slice(148))
		expect(window.getAt(1)).toEqual(history[1])
		expect(window.getAt(7)).toEqual(history[7])
		expect(window.getAt(149)).toEqual(history[149])
		expect(window.getAt(0)).toBeUndefined()
		expect(window.completeHistory).toBeUndefined()
		expect(io.readJsonl).not.toHaveBeenCalled()
		expect(io.open).toHaveBeenCalledWith(expect.any(String), "r")
		expect(handle.close).toHaveBeenCalledOnce()
	})

	it("preserves JSONL malformed-line recovery, BOM and CRLF semantics", async () => {
		const rows: ClineStorageMessage[] = [
			{ ts: 1, role: "user", content: "first" },
			{ ts: 2, role: "assistant", content: "second" },
		]
		const handle = handleFor(`\uFEFF${JSON.stringify(rows[0])}\r\ninvalid-json\r\n\r\n${JSON.stringify(rows[1])}`)
		const result = await ApiConversation.readWindow("task-1", { tailStartIndex: 0 })
		expect(result.historyLength).toBe(2)
		expect(result.tail).toEqual(rows)
		expect(handle.close).toHaveBeenCalledOnce()
	})

	it("uses full compatibility normalization only for legacy identities", async () => {
		const legacy = [
			{ ts: 1, role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "read_file", input: {} }] },
			{ ts: 2, role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "result" }] },
		]
		const handle = handleFor(JSON.stringify(legacy))
		io.readJsonl.mockResolvedValueOnce(legacy)
		const result = await ApiConversation.readWindow("task-1", { tailStartIndex: 1, requiredIndices: [0] })
		expect(result.historyLength).toBe(2)
		expect(result.completeHistory).toHaveLength(2)
		expect(result.getAt(0)?.content).toEqual([
			expect.objectContaining({ type: "tool_use", function_id: "call-1", dline_tid: "legacy_tid_call-1" }),
		])
		expect(result.tail[0]?.content).toEqual([
			expect.objectContaining({
				type: "tool_result",
				function_id: "call-1",
				dline_tid: "legacy_tid_call-1",
				content: "result",
			}),
		])
		expect(handle.close).toHaveBeenCalledOnce()
	})

	it("returns an empty read window for a missing conversation without creating it", async () => {
		io.open.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }))
		const result = await ApiConversation.readWindow("task-1", { tailStartIndex: 0 })
		expect(result.historyLength).toBe(0)
		expect(result.tail).toEqual([])
		expect(result.getAt(0)).toBeUndefined()
		expect(io.open).toHaveBeenCalledWith(expect.any(String), "r")
	})

	it("closes its read handle when cancellation interrupts the scan", async () => {
		const abort = new AbortController()
		const row = JSON.stringify({ ts: 1, role: "user", content: "x".repeat(90_000) })
		const handle = handleFor(row, (position) => {
			if (position > 0) abort.abort()
		})
		await expect(ApiConversation.readWindow("task-1", { tailStartIndex: 0, signal: abort.signal })).rejects.toThrow()
		expect(handle.close).toHaveBeenCalledOnce()
	})
})
