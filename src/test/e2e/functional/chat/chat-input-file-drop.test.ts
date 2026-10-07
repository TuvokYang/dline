import * as fs from "node:fs"
import * as path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Locator } from "@playwright/test"
import { URI } from "vscode-uri"

/**
 * Drops reach the composer as DOM drag events once VS Code lets the drag into the Webview (Shift held).
 * These cases dispatch the same events VS Code delivers, so they cover the Webview handler, the
 * FileService RPCs, host staging and validation, and the rendered attachment chip end to end.
 */

const MINIMAL_PDF = "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"

interface DroppedFile {
	name: string
	type: string
	text: string
}

async function dispatchDrop(input: Locator, files: DroppedFile[], resourceUris: string[]): Promise<boolean> {
	return input.evaluate(
		(element, payload) => {
			const transfer = new DataTransfer()
			for (const file of payload.files) {
				transfer.items.add(new File([file.text], file.name, { type: file.type }))
			}
			if (payload.resourceUris.length > 0) {
				// VS Code Explorer drags carry these string payloads instead of File objects.
				transfer.setData("ResourceURLs", JSON.stringify(payload.resourceUris))
				transfer.setData("application/vnd.code.uri-list", payload.resourceUris.join("\n"))
				transfer.setData("text/plain", payload.resourceUris.join("\n"))
			}
			for (const type of ["dragenter", "dragover"]) {
				element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }))
			}
			return element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }))
		},
		{ files, resourceUris },
	)
}

e2e("Chat input - files dropped from the OS file manager become attachments", async ({ helper, sidebar, userDataDir }) => {
	e2e.setTimeout(120_000)
	await helper.signin(sidebar)
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeVisible()

	const dropReturned = await dispatchDrop(
		input,
		[
			{ name: "os-drop-report.pdf", type: "application/pdf", text: MINIMAL_PDF },
			{ name: "os-drop-notes.txt", type: "text/plain", text: "os drop notes" },
			{ name: "os-drop-main.rs", type: "", text: "fn main() {}\n" },
		],
		[],
	)

	expect(dropReturned).toBe(false)
	await expect(sidebar.getByTitle("os-drop-report.pdf")).toBeVisible({ timeout: 15_000 })
	await expect(sidebar.getByTitle("os-drop-notes.txt")).toBeVisible({ timeout: 15_000 })
	await expect(sidebar.getByTitle("os-drop-main.rs")).toBeVisible({ timeout: 15_000 })
	await expect(input).toHaveValue("")
	await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
})

e2e(
	"Chat input - Explorer drops attach binary documents and mention source files",
	async ({ helper, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(120_000)
		await helper.signin(sidebar)
		const input = sidebar.getByTestId("chat-input")
		await expect(input).toBeVisible()

		const pdfPath = path.join(workspaceDir, "explorer-drop-report.pdf")
		const sourcePath = path.join(workspaceDir, "explorer-drop-source.ts")
		fs.writeFileSync(pdfPath, MINIMAL_PDF)
		fs.writeFileSync(sourcePath, "export const explorerDrop = 1\n")
		try {
			expect(await dispatchDrop(input, [], [URI.file(pdfPath).toString()])).toBe(false)
			await expect(sidebar.getByTitle("explorer-drop-report.pdf")).toBeVisible({ timeout: 15_000 })
			await expect(input).toHaveValue("")

			expect(await dispatchDrop(input, [], [URI.file(sourcePath).toString()])).toBe(false)
			await expect(input).toHaveValue(/@\/explorer-drop-source\.ts/, { timeout: 15_000 })
			await expect(sidebar.getByTitle("explorer-drop-source.ts")).toHaveCount(0)
		} finally {
			fs.rmSync(pdfPath, { force: true })
			fs.rmSync(sourcePath, { force: true })
		}
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)
