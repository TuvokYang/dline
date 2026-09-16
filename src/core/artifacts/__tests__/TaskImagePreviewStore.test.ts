import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { TaskImagePreviewStore } from "../TaskImagePreviewStore"

const PNG_1X1_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="

describe("TaskImagePreviewStore", () => {
	let tempDirectory: string
	let taskDirectory: string

	beforeEach(async () => {
		tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dline-image-preview-"))
		taskDirectory = path.join(tempDirectory, "tasks", "task-1")
	})

	afterEach(async () => {
		await fs.rm(tempDirectory, { recursive: true, force: true })
	})

	it("stores request previews under task tmp, clears stale startup files, and removes request files", async () => {
		const previewRoot = path.join(taskDirectory, "tmp", "image-previews")
		const stalePath = path.join(previewRoot, "stale.png")
		await fs.mkdir(previewRoot, { recursive: true })
		await fs.writeFile(stalePath, "stale")

		const store = new TaskImagePreviewStore(taskDirectory)
		const staleBuffer = Buffer.from(PNG_1X1_BASE64, "base64")
		const staleId = `image-preview:sha256:${createHash("sha256").update(staleBuffer).digest("hex")}`
		await fs.writeFile(path.join(previewRoot, `${staleId.slice("image-preview:sha256:".length)}.png`), staleBuffer)
		await expect(store.readPreview(staleId)).rejects.toThrow()
		const preview = await store.persistPreview("request-1", 1, PNG_1X1_BASE64)
		const repeatedBytesPreview = await store.persistPreview("request-1", 2, PNG_1X1_BASE64)
		const resolved = await store.readPreview(preview.id)
		const repeatedBytesResolved = await store.readPreview(repeatedBytesPreview.id)

		expect(preview).toMatchObject({ mimeType: "image/png", width: 1, height: 1, sequence: 1 })
		expect(repeatedBytesPreview).toMatchObject({ mimeType: "image/png", width: 1, height: 1, sequence: 2 })
		expect(repeatedBytesPreview.id).toBe(preview.id)
		expect(path.relative(taskDirectory, resolved.absolutePath).split(path.sep).join("/")).toMatch(
			/^tmp\/image-previews\/[a-f0-9]{64}$/,
		)
		expect(Buffer.from(resolved.bytes).toString("base64")).toBe(PNG_1X1_BASE64)
		await expect(fs.access(stalePath)).rejects.toThrow()

		await store.clearRequest("request-1")
		await expect(fs.access(resolved.absolutePath)).rejects.toThrow()
		await expect(fs.access(repeatedBytesResolved.absolutePath)).rejects.toThrow()
	})
})
