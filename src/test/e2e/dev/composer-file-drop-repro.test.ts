import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { e2e } from "@e2e/utils/helpers"
import { expect } from "@playwright/test"

/**
 * BUGFIX-122 reproduction of the native file paths into the composer that synthetic events cannot
 * cover. A real Ctrl+V travels through VS Code's Webview paste forwarding, so this case puts a file on
 * the Windows clipboard and records what the paste event actually carries.
 *
 * Native OS and Explorer drags cannot be automated: VS Code only lets them into a Webview while Shift
 * is held. The synthetic drop cases live in functional/chat/chat-input-file-drop.test.ts.
 *
 * Windows only. The test overwrites the system clipboard, so it is never part of a required gate.
 */

const MINIMAL_PDF = "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"

e2e("BUGFIX-122 repro - real OS clipboard file paste", async ({ helper, page, sidebar, workspaceDir }) => {
	e2e.skip(process.platform !== "win32", "Set-Clipboard -Path is Windows only")
	e2e.setTimeout(120_000)
	await helper.signin(sidebar)
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeVisible()

	const pdfPath = path.join(workspaceDir, "clipboard-paste-report.pdf")
	fs.writeFileSync(pdfPath, MINIMAL_PDF)
	execFileSync("powershell.exe", ["-NoProfile", "-Command", `Set-Clipboard -Path '${pdfPath.replace(/'/g, "''")}'`])

	await input.evaluate((element) => {
		const record: Record<string, unknown> = {}
		;(window as unknown as { __bugfix122Paste?: Record<string, unknown> }).__bugfix122Paste = record
		element.addEventListener(
			"paste",
			(event) => {
				const data = (event as ClipboardEvent).clipboardData
				record.types = Array.from(data?.types ?? [])
				record.items = Array.from(data?.items ?? []).map((item) => `${item.kind}:${item.type}`)
				record.files = Array.from(data?.files ?? []).map((file) => `${file.name}:${file.type}:${file.size}`)
				record.text = data?.getData("text").slice(0, 300)
				record.uriList = data?.getData("text/uri-list").slice(0, 300)
			},
			{ capture: true },
		)
	})
	await input.click()
	await page.keyboard.press("Control+V")
	await page.waitForTimeout(3_000)
	const observation = await input.evaluate(
		() => (window as unknown as { __bugfix122Paste?: Record<string, unknown> }).__bugfix122Paste,
	)
	console.log(`[BUGFIX-122] clipboard paste observation ${JSON.stringify(observation)}`)
	console.log(`[BUGFIX-122] input value after paste ${JSON.stringify(await input.inputValue())}`)
	await expect(sidebar.getByTitle("clipboard-paste-report.pdf")).toBeVisible({ timeout: 15_000 })
	fs.rmSync(pdfPath, { force: true })
})
