import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { expect, type Frame, type Page } from "@playwright/test"
import { E2ETestHelper, e2e } from "./utils/helpers"

/**
 * WS-017 RTD-004 — the runtime diagnostics pipeline as the user actually meets it.
 *
 * Unit tests cover each part in isolation. What only a launched extension can
 * show is that the parts are connected: that activation installs a pipeline on
 * the same bus the extension's own producers record into, that consent decides
 * whether anything is written, and that the Settings export reaches that
 * pipeline through the gRPC route.
 *
 * The session journal is the oracle. It is the durable local sink, so its
 * presence and contents are direct evidence of what the running extension
 * measured — no collector fixture required, and no reliance on log text that
 * a refactor could rename.
 */

/** Where `RuntimeTelemetryLifecycle` writes session journals under the data dir. */
function journalDirectory(dlineDir: string): string {
	return path.join(dlineDir, "data", "telemetry", "sessions")
}

/** Where the Settings export writes diagnostic archives. */
function diagnosticsDirectory(dlineDir: string): string {
	return path.join(dlineDir, "data", "diagnostics")
}

function exportedBundles(dlineDir: string): string[] {
	const directory = diagnosticsDirectory(dlineDir)
	if (!existsSync(directory)) return []
	return readdirSync(directory).filter((name) => name.endsWith(".zip"))
}

function journalFiles(dlineDir: string): string[] {
	const directory = journalDirectory(dlineDir)
	if (!existsSync(directory)) return []
	return readdirSync(directory).filter((name) => name.endsWith(".jsonl"))
}

/**
 * Event names recorded across every journal of this run.
 *
 * Journal lines are OTLP log records, so the event name is the record `body`
 * rather than a private `name` field. Reading it through the standard shape is
 * also what proves the file is the format a `filelog` receiver can ingest.
 */
function journaledEventNames(dlineDir: string): string[] {
	const directory = journalDirectory(dlineDir)
	return journalFiles(dlineDir).flatMap((name) =>
		readFileSync(path.join(directory, name), "utf8")
			.split(/\r?\n/)
			.filter((line) => line.trim().length > 0)
			.map((line) => {
				try {
					const record = JSON.parse(line) as { body?: { stringValue?: unknown } }
					return String(record.body?.stringValue ?? "")
				} catch {
					return ""
				}
			})
			.filter((eventName) => eventName.length > 0),
	)
}

async function openSettings(page: Page, sidebar: Frame): Promise<void> {
	await page.getByRole("button", { name: "Settings", exact: true }).click()
	// Settings can take several seconds when the extension host is still busy.
	await expect(sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible({ timeout: 30_000 })
}

function diagnosticsConsentCheckbox(sidebar: Frame) {
	// Runtime diagnostics follow the error consent, not product analytics consent.
	return sidebar.getByTestId("error-reporting-setting-checkbox")
}

/** The persisted consent value, or undefined before it has been written. */
function persistedErrorReportingSetting(dlineDir: string): string | undefined {
	const settingsPath = path.join(dlineDir, "data", "settings", "settings.json")
	if (!existsSync(settingsPath)) return undefined
	return (JSON.parse(readFileSync(settingsPath, "utf8")) as { errorReportingSetting?: string }).errorReportingSetting
}

/**
 * Tick the error-reporting consent and wait for it to be persisted.
 *
 * The checkbox is checked only for an explicit `enabled`, so an undecided
 * profile starts unchecked and a single click opts in.
 */
async function grantDiagnosticsConsent(dlineDir: string, sidebar: Frame): Promise<void> {
	const checkbox = diagnosticsConsentCheckbox(sidebar)
	await checkbox.click()
	await expect(checkbox).toBeChecked()
	await expect.poll(() => persistedErrorReportingSetting(dlineDir), { timeout: 15_000 }).toBe("enabled")
}

e2e(
	"Runtime diagnostics stay silent until consent, then journal what the extension measures",
	async ({ dlineDir, helper, page, sidebar, userDataDir }, testInfo) => {
		e2e.setTimeout(240_000)
		await helper.signin(sidebar)
		await openSettings(page, sidebar)
		// Consent and the export button share the About tab: the switch decides
		// what the bundle may contain, so both are reached the same way.
		await sidebar.getByTestId("tab-about").click()

		// The consent gate: an undecided or declined user produces no journal,
		// even though activation already installed the pipeline and producers
		// have been recording since startup.
		await expect(diagnosticsConsentCheckbox(sidebar)).toBeVisible()
		expect(
			journalFiles(dlineDir),
			`Expected no session journal before consent, found ${journalFiles(dlineDir).join(", ")}`,
		).toHaveLength(0)

		// With no pipeline running there is nothing to export, so the control
		// is absent rather than present-and-failing: offering it would advertise
		// diagnostics the extension is not permitted to collect.
		await expect(sidebar.getByRole("button", { name: "Export diagnostic bundle", exact: true })).toHaveCount(0)

		expect(
			exportedBundles(dlineDir),
			`Expected no archive before consent, found ${exportedBundles(dlineDir).join(", ")}`,
		).toHaveLength(0)

		// Opting in starts the sinks.
		await grantDiagnosticsConsent(dlineDir, sidebar)

		// A journal appears while the session is still running. This is the
		// property that matters: the lifecycle drains the process-wide bus its
		// producers record into on its own schedule, so an investigation can
		// read what the extension measured without first closing the window.
		//
		// The assertion deliberately does not name an event. Which producer
		// records first after consent is a startup timing detail, and
		// `activation.*` in particular is emitted before the lifecycle starts,
		// so a disabled service drops it and it never reaches a journal.
		await expect.poll(() => journalFiles(dlineDir).length, { timeout: 60_000 }).toBeGreaterThan(0)
		await expect.poll(() => journaledEventNames(dlineDir).length, { timeout: 60_000 }).toBeGreaterThan(0)

		// Consent also reveals the export. Reading the archive off disk rather
		// than trusting the success message is what proves the gRPC route
		// reached the exporter.
		const exportButton = sidebar.getByRole("button", { name: "Export diagnostic bundle", exact: true })
		await expect(exportButton).toBeVisible({ timeout: 30_000 })
		await exportButton.click()

		const written = sidebar.getByTestId("diagnostic-bundle-written")
		await expect(written).toBeVisible({ timeout: 60_000 })
		await expect(written).toContainText(diagnosticsDirectory(dlineDir))

		const bundles = exportedBundles(dlineDir)
		expect(bundles, "Expected an archive under the diagnostics directory").toHaveLength(1)
		const archivePath = path.join(diagnosticsDirectory(dlineDir), bundles[0])
		expect(statSync(archivePath).size, "Archive must not be empty").toBeGreaterThan(0)

		const screenshotPath = testInfo.outputPath("runtime-telemetry.png")
		await page.screenshot({ path: screenshotPath, fullPage: false, timeout: 5_000 }).catch(() => undefined)
		if (existsSync(screenshotPath)) {
			await testInfo.attach("runtime-telemetry.png", { path: screenshotPath, contentType: "image/png" })
		}

		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)
