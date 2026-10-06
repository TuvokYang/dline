import fs from "fs/promises"
import os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const showMessage = vi.fn()
vi.mock("@/hosts/host-provider", () => ({
	HostProvider: { window: { showMessage: (...args: unknown[]) => showMessage(...args) } },
}))

import { DlineRuntimeFileManager } from "@/services/runtime-files/DlineRuntimeFileManager"
import { stageAttachmentBytes, validateAttachmentPath } from "../process-files"

describe("attachment staging", () => {
	let workDir: string

	beforeEach(async () => {
		showMessage.mockClear()
		workDir = await fs.mkdtemp(path.join(os.tmpdir(), "dline-attach-"))
	})

	afterEach(async () => {
		await fs.rm(workDir, { recursive: true, force: true })
	})

	it("stages dropped bytes under the managed temp area and keeps the original file name", async () => {
		const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])

		const stagedPath = await stageAttachmentBytes("Quarterly Report.pdf", bytes)

		expect(stagedPath).toBeDefined()
		expect(path.basename(stagedPath as string)).toBe("Quarterly Report.pdf")
		expect(DlineRuntimeFileManager.isManagedPath(stagedPath as string)).toBe(true)
		expect(new Uint8Array(await fs.readFile(stagedPath as string))).toEqual(bytes)
		await fs.rm(path.dirname(stagedPath as string), { recursive: true, force: true })
	})

	it("stages a file of any other type when its content is text", async () => {
		const bytes = new TextEncoder().encode("fn main() {}\n")

		const stagedPath = await stageAttachmentBytes("main.rs", bytes)

		expect(path.basename(stagedPath as string)).toBe("main.rs")
		expect(new Uint8Array(await fs.readFile(stagedPath as string))).toEqual(bytes)
		expect(showMessage).not.toHaveBeenCalled()
		await fs.rm(path.dirname(stagedPath as string), { recursive: true, force: true })
	})

	it("rejects binary content read as text and oversized PDFs without writing anything", async () => {
		expect(await stageAttachmentBytes("tool.exe", new Uint8Array(4))).toBeUndefined()
		const oversized = { byteLength: 50 * 1000 * 1000 + 1 } as Uint8Array
		expect(await stageAttachmentBytes("big.pdf", oversized)).toBeUndefined()

		expect(showMessage).toHaveBeenCalledTimes(2)
		expect(showMessage.mock.calls[0][0].message).toContain("Not a text file: tool.exe")
		expect(showMessage.mock.calls[1][0].message).toContain("50MB")
	})

	it.each([
		"..\\..\\evil.pdf",
		"../../evil.pdf",
	])("strips directory components from the dropped name %s on every host", async (droppedName) => {
		const stagedPath = await stageAttachmentBytes(droppedName, new Uint8Array(1))

		expect(path.basename(stagedPath as string)).toBe("evil.pdf")
		expect(DlineRuntimeFileManager.isManagedPath(stagedPath as string)).toBe(true)
		await fs.rm(path.dirname(stagedPath as string), { recursive: true, force: true })
	})

	it("validates on-disk attachments by kind, size, and text content", async () => {
		const pdfPath = path.join(workDir, "a.pdf")
		await fs.writeFile(pdfPath, "%PDF-1.4")
		const sourcePath = path.join(workDir, "lib.rs")
		await fs.writeFile(sourcePath, "pub fn answer() -> u32 { 42 }\n")
		const blobPath = path.join(workDir, "blob.dat")
		await fs.writeFile(blobPath, Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0x00]))

		expect(await validateAttachmentPath(pdfPath)).toBe(pdfPath)
		expect(await validateAttachmentPath(sourcePath)).toBe(sourcePath)
		expect(await validateAttachmentPath(blobPath)).toBeUndefined()
		expect(await validateAttachmentPath(path.join(workDir, "missing.pdf"))).toBeUndefined()
		expect(await validateAttachmentPath(workDir)).toBeUndefined()
		expect(showMessage.mock.calls.some(([request]) => request.message.includes("Not a text file: blob.dat"))).toBe(true)
	})
})
