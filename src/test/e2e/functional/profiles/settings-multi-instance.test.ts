import { readFile } from "node:fs/promises"
import * as path from "node:path"
import { e2e } from "@e2e/utils/helpers"
import { MultiInstanceLauncher, type MultiInstanceSurface } from "@e2e/utils/multi-instance"
import { expect } from "@playwright/test"

interface StoredSettings {
	chatInputSendShortcut?: string
	terminalOutputLineLimit?: number
}

async function readSettings(dlineDir: string): Promise<StoredSettings> {
	return JSON.parse(await readFile(path.join(dlineDir, "data", "settings", "settings.json"), "utf8")) as StoredSettings
}

async function openSettings(surface: MultiInstanceSurface): Promise<void> {
	await surface.page.getByRole("button", { name: "Settings", exact: true }).click()
	await expect(surface.sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible({ timeout: 30_000 })
}

async function setShortcut(surface: MultiInstanceSurface, value: "enter" | "ctrlEnter" | "shiftEnter"): Promise<void> {
	await surface.sidebar.getByTestId("tab-general").click()
	const dropdown = surface.sidebar.locator("#chat-input-send-shortcut")
	const labels = { enter: "Enter", ctrlEnter: "Ctrl + Enter", shiftEnter: "Shift + Enter" } as const
	await dropdown.click()
	await surface.sidebar.getByRole("option", { name: labels[value], exact: true }).click()
	await expect.poll(() => dropdown.evaluate((element) => (element as HTMLSelectElement).value)).toBe(value)
}

async function setTerminalOutputLimit(surface: MultiInstanceSurface, value: string): Promise<void> {
	await surface.sidebar.getByTestId("tab-terminal").click()
	const slider = surface.sidebar.locator("#terminal-output-limit")
	await slider.evaluate((element) => {
		const input = element as HTMLElement & { __e2eChangeValues?: string[] }
		input.__e2eChangeValues = []
		input.addEventListener("change", () => {
			input.__e2eChangeValues?.push((input as unknown as HTMLInputElement).value)
		})
	})

	const { min, step } = await slider.evaluate((element) => {
		const input = element as HTMLInputElement
		return { min: Number(input.min), step: Number(input.step) }
	})
	const steps = (Number(value) - min) / step
	if (!Number.isSafeInteger(steps) || steps < 0) throw new Error(`Invalid terminal output limit test value: ${value}`)
	await slider.focus()
	await slider.press("Home")
	for (let index = 0; index < steps; index++) await slider.press("ArrowRight")
	await expect(slider).toHaveValue(value)
	await expect
		.poll(() =>
			slider.evaluate((element) => (element as HTMLElement & { __e2eChangeValues?: string[] }).__e2eChangeValues ?? []),
		)
		.toContain(value)
}

async function createLauncher(
	dlineDir: string,
	dlineDocsDir: string,
	extensionsDir: string,
	server: Parameters<typeof MultiInstanceLauncher>[0]["server"],
	testInfo: Parameters<typeof MultiInstanceLauncher>[0]["testInfo"],
	workspaceDir: string,
): Promise<MultiInstanceLauncher> {
	return new MultiInstanceLauncher({ dlineDir, dlineDocsDir, extensionsDir, server, testInfo, workspaceDir })
}

e2e(
	"Settings authoritative RED - a committed setting must converge to a second running VS Code instance",
	async ({ dlineDir, dlineDocsDir, extensionsDir, server, workspaceDir }, testInfo) => {
		e2e.setTimeout(240_000)
		const launcher = await createLauncher(dlineDir, dlineDocsDir, extensionsDir, server, testInfo, workspaceDir)
		try {
			const instanceA = await launcher.launch("instance-a")
			const instanceB = await launcher.launch("instance-b")
			await openSettings(instanceA)
			await openSettings(instanceB)
			await instanceB.sidebar.getByTestId("tab-general").click()
			await setShortcut(instanceA, "ctrlEnter")

			await expect
				.poll(async () => (await readSettings(dlineDir)).chatInputSendShortcut, {
					timeout: 10_000,
					message: "Instance A did not commit the setting to the shared disk before checking Instance B",
				})
				.toBe("ctrlEnter")

			// The authoritative RED is this assertion: Instance B has already been
			// initialized and must observe the committed external revision without restart.
			await expect
				.poll(
					() =>
						instanceB.sidebar
							.locator("#chat-input-send-shortcut")
							.evaluate((element) => (element as HTMLSelectElement).value),
					{
						timeout: 5_000,
					},
				)
				.toBe("ctrlEnter")
		} finally {
			await launcher.dispose()
		}
	},
)

e2e(
	"Settings authoritative RED - interleaved different-key edits must not lose either committed value",
	async ({ dlineDir, dlineDocsDir, extensionsDir, server, workspaceDir }, testInfo) => {
		e2e.setTimeout(240_000)
		const launcher = await createLauncher(dlineDir, dlineDocsDir, extensionsDir, server, testInfo, workspaceDir)
		try {
			const instanceA = await launcher.launch("instance-a")
			const instanceB = await launcher.launch("instance-b")
			await openSettings(instanceA)
			await openSettings(instanceB)

			// Both extension hosts loaded the same initial snapshot. Commit A first,
			// then let B mutate its stale in-memory snapshot through a different UI key.
			await setShortcut(instanceA, "ctrlEnter")
			await expect
				.poll(async () => (await readSettings(dlineDir)).chatInputSendShortcut, { timeout: 10_000 })
				.toBe("ctrlEnter")
			await setTerminalOutputLimit(instanceB, "900")
			await expect.poll(async () => (await readSettings(dlineDir)).terminalOutputLineLimit, { timeout: 10_000 }).toBe(900)

			const committed = await readSettings(dlineDir)
			// The authoritative RED is this assertion: a valid result must retain both
			// independent commits instead of replacing A with B's stale full-file write.
			expect(committed).toMatchObject({ chatInputSendShortcut: "ctrlEnter", terminalOutputLineLimit: 900 })
		} finally {
			await launcher.dispose()
		}
	},
)

e2e(
	"Settings authoritative RED - a successful UI update followed by immediate VS Code exit must survive restart",
	async ({ dlineDir, dlineDocsDir, extensionsDir, server, workspaceDir }, testInfo) => {
		e2e.setTimeout(240_000)
		const launcher = await createLauncher(dlineDir, dlineDocsDir, extensionsDir, server, testInfo, workspaceDir)
		try {
			const instanceA = await launcher.launch("instance-a")
			await openSettings(instanceA)
			await setShortcut(instanceA, "ctrlEnter")

			// Do not wait for the backend's two-second persistence debounce here. The
			// control has accepted the real user change, so close immediately to lock
			// the RPC-success-before-durable-commit contract.
			await instanceA.app.close()
			const instanceB = await launcher.launch("instance-b")
			await openSettings(instanceB)
			await instanceB.sidebar.getByTestId("tab-general").click()

			// The authoritative RED is this assertion: the restarted host must read the
			// value even though the first host exited before the debounce window elapsed.
			await expect
				.poll(
					() =>
						instanceB.sidebar
							.locator("#chat-input-send-shortcut")
							.evaluate((element) => (element as HTMLSelectElement).value),
					{
						timeout: 5_000,
					},
				)
				.toBe("ctrlEnter")
		} finally {
			await launcher.dispose()
		}
	},
)
