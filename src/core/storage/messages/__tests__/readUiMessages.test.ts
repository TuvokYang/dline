import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ClineMessage } from "@/shared/ExtensionMessage"
import { closeInstanceStoragesUnder, ensureInstanceLayout, InstanceDatabase } from "../../instance"
import { openUiMessageRows, UI_MESSAGE_WRITER } from "../openUiMessageRows"
import { readUiMessages } from "../readUiMessages"

function say(ts: number, text: string): ClineMessage {
	return { ts, type: "say", say: "text", text } as ClineMessage
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath)
		return true
	} catch {
		return false
	}
}

describe("readUiMessages", () => {
	let documentsRoot: string

	beforeEach(async () => {
		documentsRoot = await mkdtemp(path.join(os.tmpdir(), "dline-messages-read-"))
		vi.stubEnv("DLINE_DOCS_DIR", documentsRoot)
	})

	afterEach(async () => {
		await closeInstanceStoragesUnder(documentsRoot)
		vi.unstubAllEnvs()
		await rm(documentsRoot, { recursive: true, force: true })
	})

	it("returns an empty history and creates no database when nothing is stored", async () => {
		const layout = await ensureInstanceLayout({ taskId: "task-empty" })

		expect(await readUiMessages(layout.root)).toEqual([])
		expect(await exists(layout.database(InstanceDatabase.Messages))).toBe(false)
	})

	it("reads a legacy file in place without importing or renaming it", async () => {
		const layout = await ensureInstanceLayout({ taskId: "task-legacy" })
		const legacy = path.join(layout.root, "ui_messages.jsonl")
		const content = `${JSON.stringify(say(10, "old"))}\n${JSON.stringify(say(10, "new"))}\n${JSON.stringify(say(20, "b"))}\n`
		await writeFile(legacy, content)

		const messages = await readUiMessages(layout.root)

		expect(messages.map((message) => message.text)).toEqual(["new", "b"])
		expect(await readFile(legacy, "utf8")).toBe(content)
		expect(await exists(layout.database(InstanceDatabase.Messages))).toBe(false)
	})

	it("prefers stored rows over a leftover legacy file and never claims the writer", async () => {
		const layout = await ensureInstanceLayout({ taskId: "task-rows" })
		const writer = await openUiMessageRows(layout.root, UI_MESSAGE_WRITER)
		await writer.replaceAll([
			{ ordinal: 0, ts: 1, message: say(1, "stored a") },
			{ ordinal: 1, ts: 2, message: say(2, "stored b") },
		])
		await writeFile(path.join(layout.root, "ui_messages.jsonl"), `${JSON.stringify(say(9, "stale"))}\n`)

		const messages = await readUiMessages(layout.root)

		expect(messages.map((message) => message.text)).toEqual(["stored a", "stored b"])
		// The open writer keeps its claim: a read must not have taken or released it.
		await writer.insert([{ ordinal: 2, ts: 3, message: say(3, "stored c") }])
		expect((await readUiMessages(layout.root)).map((message) => message.text)).toEqual(["stored a", "stored b", "stored c"])
		await writer.close()
	})
})
