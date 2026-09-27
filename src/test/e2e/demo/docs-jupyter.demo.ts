import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { expect, type Locator, type Page } from "@playwright/test"
import { demo } from "./utils/demo-fixture"
import { dismissDemoNotifications } from "./utils/png-asset"
import { STEP_SETTLE_MS, WINDOW_RECORDING } from "./utils/recording-presets"

/**
 * Documentation GIFs for the Jupyter notebook commands (`assets/docs/ui/docs-jupyter-*`).
 *
 * The notebook opens in VS Code's built-in ipynb editor, which provides the
 * `jupyter-notebook` notebook type that gates Dline's notebook toolbar and cell actions.
 */

const NOTEBOOK_FILE = "sales-report.ipynb"
const GENERATE_PROMPT = "Add a cell that totals the sales amount per region."
const EXPLAIN_RESULT = "This cell opens sales.csv and loads every row into a list of dictionaries keyed by the CSV header."
const IMPROVE_PROMPT = "Report a clear message when sales.csv is missing."
const IMPROVE_RESULT = "Suggested change: wrap the read in try/except FileNotFoundError and print the missing path."
const GENERATE_RESULT = "Added a cell that totals the sales amount per region."

const LOAD_CELL = {
	cell_type: "code",
	execution_count: null,
	id: "load-sales",
	metadata: {},
	outputs: [],
	source: ["import csv\n", "\n", 'with open("sales.csv") as file:\n', "    rows = list(csv.DictReader(file))\n"],
}

const TOTALS_CELL = {
	cell_type: "code",
	execution_count: null,
	id: "totals-by-region",
	metadata: {},
	outputs: [],
	source: [
		"totals = {}\n",
		"for row in rows:\n",
		'    totals[row["region"]] = totals.get(row["region"], 0) + float(row["amount"])\n',
		"totals\n",
	],
}

function notebookJson(cells: object[]): string {
	return `${JSON.stringify(
		{
			cells,
			metadata: {
				kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
				language_info: { name: "python" },
			},
			nbformat: 4,
			nbformat_minor: 5,
		},
		null,
		1,
	)}\n`
}

async function openNotebook(page: Page, workspaceDir: string): Promise<void> {
	await writeFile(path.join(workspaceDir, NOTEBOOK_FILE), notebookJson([LOAD_CELL]), "utf8")
	await page.keyboard.press("ControlOrMeta+p")
	const quickInput = page.locator(".quick-input-widget input").last()
	await expect(quickInput).toBeVisible()
	await quickInput.fill(NOTEBOOK_FILE)
	const fileOption = page.locator(".quick-input-widget .monaco-list-row").filter({ hasText: NOTEBOOK_FILE }).first()
	await expect(fileOption).toBeVisible()
	await fileOption.click()
	await expect(notebookCells(page).first()).toBeVisible({ timeout: 30_000 })
}

function notebookCells(page: Page): Locator {
	return page.locator(".notebook-editor .code-cell-row")
}

/** The command quick pick accepts free text; Enter submits the typed prompt. */
async function submitCommandPrompt(page: Page, prompt: string): Promise<Locator> {
	const quickInput = page.locator(".quick-input-widget input").last()
	await expect(quickInput).toBeVisible()
	await quickInput.pressSequentially(prompt, { delay: 35 })
	await expect(page.locator(".quick-input-widget").getByText("Use this prompt", { exact: false })).toBeVisible()
	return quickInput
}

demo(
	"docs jupyter generate cell",
	async ({ finishRecording, focusCamera, helper, page, pace, registerRecording, server, sidebar, workspaceDir }) => {
		demo.setTimeout(180_000)
		await helper.signin(sidebar)
		await openNotebook(page, workspaceDir)
		await dismissDemoNotifications(page)

		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_docs_jupyter_write",
				name: "write_to_file",
				arguments: { path: NOTEBOOK_FILE, content: notebookJson([LOAD_CELL, TOTALS_CELL]) },
				expectedRequestIncludes: [GENERATE_PROMPT, "load-sales"],
			},
			{
				type: "tool",
				id: "call_docs_jupyter_complete",
				name: "attempt_completion",
				arguments: { result: GENERATE_RESULT },
				expectedToolResults: [{ callId: "call_docs_jupyter_write", contentIncludes: "successfully saved" }],
			},
		)

		await registerRecording("docs-jupyter-generate-cell", WINDOW_RECORDING)
		const firstCell = notebookCells(page).first()
		await focusCamera(firstCell, STEP_SETTLE_MS)
		await firstCell.click()
		const generate = page.getByRole("button", { name: "Generate Jupyter Cell with Dline", exact: true }).first()
		await expect(generate).toBeVisible()
		await focusCamera(generate, STEP_SETTLE_MS)
		await generate.click()

		const quickInput = await submitCommandPrompt(page, GENERATE_PROMPT)
		await focusCamera(page.locator(".quick-input-widget"), 0)
		await pace(600)
		await quickInput.press("Enter")

		const approve = sidebar.getByText("Approve", { exact: true })
		await expect(approve).toBeVisible({ timeout: 60_000 })
		// The proposed notebook JSON opens as a diff; frame it together with the approval controls.
		await focusCamera([approve, page.locator(".part.editor")], STEP_SETTLE_MS)
		await pace(1_200)
		await focusCamera(approve, 0)
		await approve.click()

		await expect
			.poll(async () => (await readFile(path.join(workspaceDir, NOTEBOOK_FILE), "utf8")).includes("totals-by-region"), {
				timeout: 30_000,
			})
			.toBe(true)
		const completion = sidebar.getByText(GENERATE_RESULT, { exact: false }).last()
		await expect(completion).toBeVisible({ timeout: 60_000 })
		await focusCamera(completion, 0)
		await pace(1_400)
		await finishRecording()
	},
)

demo(
	"docs jupyter explain improve",
	async ({ finishRecording, focusCamera, helper, page, pace, registerRecording, server, sidebar, workspaceDir }) => {
		demo.setTimeout(180_000)
		await helper.signin(sidebar)
		await openNotebook(page, workspaceDir)
		await dismissDemoNotifications(page)

		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_docs_jupyter_explain",
				name: "attempt_completion",
				arguments: { result: EXPLAIN_RESULT },
				expectedRequestIncludes: ["Explain the following code", "load-sales"],
			},
			{
				type: "tool",
				id: "call_docs_jupyter_improve",
				name: "attempt_completion",
				arguments: { result: IMPROVE_RESULT },
				expectedRequestIncludes: [IMPROVE_PROMPT],
			},
		)

		await registerRecording("docs-jupyter-explain-improve", WINDOW_RECORDING)
		const firstCell = notebookCells(page).first()
		await focusCamera(firstCell, STEP_SETTLE_MS)
		await firstCell.click()
		const explain = page.getByRole("button", { name: "Explain Jupyter Cell with Dline", exact: true }).first()
		await expect(explain).toBeVisible()
		await focusCamera(explain, STEP_SETTLE_MS)
		await explain.click()

		const explanation = sidebar.getByText(EXPLAIN_RESULT, { exact: false }).last()
		await expect(explanation).toBeVisible({ timeout: 60_000 })
		await focusCamera(explanation, 0)
		await pace(1_400)

		// Improve continues the open task when one is listening; a completed task does not
		// accept new input, so close it and let Improve start its own task.
		const closeTask = sidebar.locator('[aria-label="Close Task"]')
		await focusCamera(closeTask, STEP_SETTLE_MS)
		await closeTask.click()
		await expect(sidebar.getByTestId("chat-input")).toHaveValue("")
		await expect(explanation).toBeHidden({ timeout: 30_000 })

		await firstCell.click()
		const improve = page.getByRole("button", { name: "Improve Jupyter Cell with Dline", exact: true }).first()
		await expect(improve).toBeVisible()
		await focusCamera(improve, STEP_SETTLE_MS)
		await improve.click()
		const quickInput = await submitCommandPrompt(page, IMPROVE_PROMPT)
		await focusCamera(page.locator(".quick-input-widget"), 0)
		await pace(500)
		await quickInput.press("Enter")

		const suggestion = sidebar.getByText(IMPROVE_RESULT, { exact: false }).last()
		await expect(suggestion).toBeVisible({ timeout: 60_000 })
		await focusCamera(suggestion, 0)
		await pace(1_400)
		await finishRecording()
	},
)
