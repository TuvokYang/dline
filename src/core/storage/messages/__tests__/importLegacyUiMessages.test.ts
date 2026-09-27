import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { UiMessage } from "@/shared/ExtensionMessage"
import { closeInstanceStoragesUnder, ensureInstanceLayout, InstanceDatabase, openInstanceStorage } from "../../instance"
import { importLegacyUiMessages, MIGRATED_SUFFIX } from "../importLegacyUiMessages"
import { UiMessageRowStore } from "../UiMessageRowStore"

function say(ts: number, text: string, extra: Partial<UiMessage> = {}): UiMessage {
	return { ts, type: "say", say: "text", text, ...extra } as UiMessage
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath)
		return true
	} catch {
		return false
	}
}

describe("importLegacyUiMessages", () => {
	let documentsRoot: string

	beforeEach(async () => {
		documentsRoot = await mkdtemp(path.join(os.tmpdir(), "dline-messages-import-"))
		vi.stubEnv("DLINE_DOCS_DIR", documentsRoot)
	})

	afterEach(async () => {
		await closeInstanceStoragesUnder(documentsRoot)
		vi.unstubAllEnvs()
		await rm(documentsRoot, { recursive: true, force: true })
	})

	async function openInstance(taskId: string) {
		const layout = await ensureInstanceLayout({ taskId })
		const storage = openInstanceStorage(layout.root)
		const database = await storage.openDatabase(InstanceDatabase.Messages, "ui-message-projection")
		return { root: layout.root, store: await UiMessageRowStore.open(database, () => storage.close()) }
	}

	async function storedTimestamps(store: UiMessageRowStore): Promise<number[]> {
		return (await store.query()).records.map((record) => record.ts)
	}

	it("imports the JSONL history, keeps the last write per timestamp, and renames the file", async () => {
		const { root, store } = await openInstance("task-jsonl")
		const legacy = path.join(root, "ui_messages.jsonl")
		const lines = [
			JSON.stringify(say(100, "a")),
			JSON.stringify(say(200, "b", { partial: true })),
			"{not json",
			JSON.stringify(say(0, "zero timestamp")),
			JSON.stringify({ ts: 250, text: "no type" }),
			JSON.stringify(say(300, "c", { images: ["data:image/png;base64,AAA"] })),
			JSON.stringify(say(200, "b final")),
		]
		await writeFile(legacy, `${lines.join("\n")}\n`)

		await importLegacyUiMessages(root, store)

		const { records } = await store.query()
		expect(records.map((record) => record.ordinal)).toEqual([0, 1, 2])
		expect(records.map((record) => record.ts)).toEqual([100, 300, 200])
		expect(records[1].message.images).toEqual(["data:image/png;base64,AAA"])
		expect(records[2].message).toEqual(say(200, "b final"))
		expect(await exists(legacy)).toBe(false)
		expect(await readFile(`${legacy}${MIGRATED_SUFFIX}`, "utf8")).toContain('"b final"')
		await store.close()
	})

	it("imports the legacy JSON array format", async () => {
		const { root, store } = await openInstance("task-json-array")
		const legacy = path.join(root, "ui_messages.json")
		await writeFile(legacy, JSON.stringify([say(10, "first"), say(20, "second")], null, 2))

		await importLegacyUiMessages(root, store)

		expect(await storedTimestamps(store)).toEqual([10, 20])
		expect(await exists(legacy)).toBe(false)
		expect(await exists(`${legacy}${MIGRATED_SUFFIX}`)).toBe(true)
		await store.close()
	})

	it("only renames a leftover file whose messages the database already holds", async () => {
		const { root, store } = await openInstance("task-leftover")
		const legacy = path.join(root, "ui_messages.jsonl")
		await writeFile(legacy, `${JSON.stringify(say(10, "stale text"))}\n${JSON.stringify(say(20, "b"))}\n`)
		await store.replaceAll([
			{ ordinal: 0, ts: 10, message: say(10, "newer text") },
			{ ordinal: 1, ts: 20, message: say(20, "b") },
		])

		await importLegacyUiMessages(root, store)

		const { records } = await store.query()
		expect(records[0].message.text).toBe("newer text")
		expect(await exists(legacy)).toBe(false)
		expect(await exists(`${legacy}${MIGRATED_SUFFIX}`)).toBe(true)
		await store.close()
	})

	it("keeps a leftover file that disagrees with the database and leaves the rows alone", async () => {
		const { root, store } = await openInstance("task-disagree")
		const legacy = path.join(root, "ui_messages.jsonl")
		await writeFile(legacy, `${JSON.stringify(say(10, "a"))}\n${JSON.stringify(say(30, "c"))}\n`)
		await store.replaceAll([{ ordinal: 0, ts: 10, message: say(10, "a") }])

		await importLegacyUiMessages(root, store)

		expect(await storedTimestamps(store)).toEqual([10])
		expect(await exists(legacy)).toBe(true)
		expect(await exists(`${legacy}${MIGRATED_SUFFIX}`)).toBe(false)
		await store.close()
	})

	it("does nothing when no legacy file exists", async () => {
		const { root, store } = await openInstance("task-fresh")

		await importLegacyUiMessages(root, store)

		expect(await storedTimestamps(store)).toEqual([])
		await store.close()
	})
})
