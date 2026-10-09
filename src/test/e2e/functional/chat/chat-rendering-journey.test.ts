import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Page } from "@playwright/test"

/**
 * Chat rendering journey.
 *
 * Each stage used to launch its own VS Code. They share no state beyond the
 * window itself, so one launch walks through all of them: every stage resets
 * the mock provider and starts from a closed task, and the stage that throws an
 * uncaught Webview error runs last so it cannot disturb the others.
 */

/** Display formula that exercises the base, ams, and color TeX packages together. */
const RENDERABLE_FORMULA = String.raw`\textcolor{teal}{\int_{0}^{\infty}} e^{-x^{2}}\,dx = \frac{\sqrt{\pi}}{2}`
/** Unbalanced braces so MathJax rejects the source and the block falls back to raw TeX. */
const BROKEN_FORMULA = String.raw`\frac{1}{`
const WEBVIEW_ERROR_MARKER = "E2E_WEBVIEW_UNCAUGHT_REPORTED"
/** The model catalog is fetched from the real network, which this suite does not stub. */
const UNRELATED_CATALOG_ERRORS = [/Error fetching OpenRouter models/]

/** Enable one auto-approve action so the tools run without an approval prompt. */
async function setAutoApproveAction(sidebar: Frame, label: string, enabled: boolean): Promise<void> {
	await sidebar.getByLabel("Open auto-approve settings").click()
	const checkbox = sidebar.locator("vscode-checkbox").filter({ hasText: label })
	await expect(checkbox).toHaveCount(1)
	const isChecked = () => checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))
	if ((await isChecked()) !== enabled) {
		await sidebar.getByText(label, { exact: true }).click()
	}
	await expect.poll(isChecked).toBe(enabled)
	await sidebar.getByLabel("Close auto-approve settings").click()
}

async function selectProfile(sidebar: Frame, profileName: string): Promise<void> {
	const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
	if ((await modelSwitcher.innerText()).trim() === profileName) return

	await modelSwitcher.click()
	const profileOption = sidebar.getByRole("option").filter({ has: sidebar.getByText(profileName, { exact: true }) })
	await expect(profileOption).toHaveCount(1)
	await profileOption.click()
	await expect(modelSwitcher).toHaveText(profileName)
}

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

/** Return to the empty chat so the next stage starts its own task. */
async function closeCurrentTask(sidebar: Frame): Promise<void> {
	const closeButton = sidebar.getByRole("button", { name: "Close Task", exact: true })
	await expect(closeButton).toBeVisible()
	await closeButton.click()
	await expect(sidebar.getByTestId("chat-input")).toBeVisible()
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
}

async function reacquireSidebar(page: Page, helper: E2ETestHelper): Promise<Frame> {
	helper.clearCachedFrame()
	const sidebar = await helper.getSidebar(page)
	await expect(sidebar.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 })
	await expect(sidebar.getByTestId("hydration-pending")).toHaveCount(0)
	await expect(sidebar.getByTestId("hydration-failed")).toHaveCount(0)
	return sidebar
}

async function hideAndRevealSidebar(page: Page, helper: E2ETestHelper): Promise<Frame> {
	const dlineTab = page.getByRole("tab", { name: /Dline/ })
	await page.keyboard.press("ControlOrMeta+B")
	await expect(dlineTab).toHaveAttribute("aria-expanded", "false")
	await page.keyboard.press("ControlOrMeta+B")
	await E2ETestHelper.openClineSidebar(page)
	return reacquireSidebar(page, helper)
}

e2e(
	"Chat rendering journey - tool rows, command output, sidebar rebind, LaTeX and Webview error reporting",
	async ({ app, helper, page, server, sidebar: initialSidebar, userDataDir }, testInfo) => {
		e2e.setTimeout(600_000)
		let sidebar = initialSidebar
		await helper.signin(sidebar)

		await e2e.step("WS-061 tool group rows show their target, scope and scale with a full-path tooltip", async () => {
			await setAutoApproveAction(sidebar, "Read project files", true)
			server.resetOpenAiMock()

			const completionMarker = "E2E_TOOL_GROUP_ROWS_DONE"
			server.enqueueOpenAiResponses(
				{
					type: "tools",
					tools: [
						{ id: "call_group_read", name: "read_file", arguments: { path: "README.md" } },
						{
							id: "call_group_search",
							name: "search_files",
							arguments: { path: ".", regex: "Test|Workspace|extension|testing|coverage" },
						},
					],
				},
				{
					type: "tool",
					id: "call_group_completion",
					name: "attempt_completion",
					arguments: { result: completionMarker },
				},
			)

			await sendTask(sidebar, "Read the project README and search the workspace for a few terms.")
			await expect(sidebar.getByText(completionMarker, { exact: false }).last()).toBeVisible({ timeout: 90_000 })

			// The visible row exposes the complete search target through its accessible name;
			// responsive fitting of the button text is covered by the component-level width tests.
			const searchRow = sidebar.getByRole("button", {
				name: /^"Test \| Workspace \| extension \| testing \| coverage" in workspace\/ \(\d+\+? matches · \d+ files?\)$/,
			})
			await expect(searchRow).toBeVisible({ timeout: 30_000 })
			await expect(searchRow).toHaveAttribute(
				"aria-label",
				/^"Test \| Workspace \| extension \| testing \| coverage" in workspace\/ \(\d+\+? matches · \d+ files?\)$/,
			)

			// The read row exposes its complete target through the visible button's accessible name.
			await expect(sidebar.getByRole("button", { name: /^README\.md · lines \d+-\d+$/ })).toBeVisible()

			// Hovering a row reveals the untruncated text.
			await searchRow.hover()
			const tooltip = sidebar.locator('[data-slot="tooltip-content"]')
			await expect(tooltip.first()).toBeVisible({ timeout: 10_000 })
			await expect(tooltip.first()).toContainText('"Test | Workspace | extension | testing | coverage"')

			const screenshotPath = testInfo.outputPath("tool-group-rows.png")
			await page.screenshot({ path: screenshotPath, fullPage: false })
			await testInfo.attach("tool-group-rows.png", { path: screenshotPath, contentType: "image/png" })

			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, UNRELATED_CATALOG_ERRORS)
			await closeCurrentTask(sidebar)
		})

		await e2e.step("expanded command output is capped at 80vh and remains scrollable", async () => {
			server.resetOpenAiMock()

			const outputPrefix = "E2E_COMMAND_LAYOUT_LINE_"
			const prefixCodePoints = [...outputPrefix].map((character) => character.codePointAt(0)).join(",")
			const command = `node -e "const p=String.fromCodePoint(${prefixCodePoints}); for(let i=0;i<220;i++) console.log(p+i)"`
			server.enqueueOpenAiResponses(
				{
					type: "tool",
					id: "call_command_layout",
					name: "execute_command",
					arguments: {
						command,
						workdirectory: ".",
						requires_approval: true,
						synchronous: true,
						timeout: 60,
					},
				},
				{
					type: "tool",
					id: "call_command_layout_completion",
					name: "attempt_completion",
					arguments: { result: "E2E_COMMAND_LAYOUT_COMPLETE" },
					expectedToolResults: [
						{
							callId: "call_command_layout",
							contentIncludes: ["Command executed successfully", outputPrefix],
						},
					],
				},
			)

			const input = sidebar.getByTestId("chat-input")
			await input.fill("Run a command with enough output to verify the expanded layout.")
			await sidebar.getByTestId("send-button").click()
			const approveButton = sidebar.getByText("Approve", { exact: true })
			await expect(approveButton).toBeVisible({ timeout: 60_000 })
			await approveButton.click()

			await expect(sidebar.getByText("E2E_COMMAND_LAYOUT_COMPLETE", { exact: false }).last()).toBeVisible({
				timeout: 90_000,
			})
			await expect.poll(() => server.openAiRequestCount).toBe(2)
			const commandRow = sidebar.getByTestId("command-card").last()
			const collapsedCommand = commandRow.getByRole("button", { name: command, exact: true })
			await expect(collapsedCommand).toBeVisible()
			await collapsedCommand.click()

			const expandedCommandRow = sidebar.getByTestId("command-card").last()
			const outputScroll = expandedCommandRow.getByTestId("command-output-scroll")
			await expect(outputScroll).toBeVisible()
			await expect(expandedCommandRow.getByTestId("expand-handle")).toBeVisible()

			const collapsedMetrics = await outputScroll.evaluate((element) => ({
				className: element.className,
				maxHeight: getComputedStyle(element).maxHeight,
				overflowY: getComputedStyle(element).overflowY,
				clientHeight: element.clientHeight,
				scrollHeight: element.scrollHeight,
				viewportHeight: window.innerHeight,
			}))
			expect(collapsedMetrics.className).toContain("max-h-[120px]")
			expect(collapsedMetrics.overflowY).toBe("auto")
			expect(collapsedMetrics.scrollHeight).toBeGreaterThan(collapsedMetrics.clientHeight)

			await expandedCommandRow.getByTestId("expand-handle").click()
			await expect.poll(() => outputScroll.getAttribute("class")).toContain("max-h-[80vh]")
			const expandedMetrics = await outputScroll.evaluate((element) => ({
				className: element.className,
				maxHeight: getComputedStyle(element).maxHeight,
				overflowY: getComputedStyle(element).overflowY,
				clientHeight: element.clientHeight,
				scrollHeight: element.scrollHeight,
				viewportHeight: window.innerHeight,
			}))
			expect(expandedMetrics.className).toContain("max-h-[80vh]")
			expect(expandedMetrics.overflowY).toBe("auto")
			expect(expandedMetrics.scrollHeight).toBeGreaterThan(expandedMetrics.clientHeight)
			expect(Number.parseFloat(expandedMetrics.maxHeight)).toBeCloseTo(expandedMetrics.viewportHeight * 0.8, 0)
			expect(await outputScroll.getByText(`${outputPrefix}0`, { exact: false }).count()).toBeGreaterThan(0)

			const screenshotPath = testInfo.outputPath("command-output-expanded.png")
			await expandedCommandRow.screenshot({ path: screenshotPath })
			await testInfo.attach("command-output-expanded", { path: screenshotPath, contentType: "image/png" })
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, UNRELATED_CATALOG_ERRORS)
			await closeCurrentTask(sidebar)
		})

		await e2e.step("repeated sidebar hide and reveal preserves hydration and interaction", async () => {
			server.resetOpenAiMock()
			server.enqueueOpenAiResponses({
				type: "tool",
				id: "call_sidebar_rebind_first",
				name: "attempt_completion",
				arguments: { result: "E2E_SIDEBAR_REBIND_FIRST" },
			})
			server.enqueueOpenAiResponses({
				type: "tool",
				id: "call_sidebar_rebind_second",
				name: "attempt_completion",
				arguments: { result: "E2E_SIDEBAR_REBIND_SECOND" },
			})

			const input = sidebar.getByTestId("chat-input")
			await input.fill("Complete the first sidebar generation.")
			await sidebar.getByTestId("send-button").click()
			await expect(sidebar.getByText("E2E_SIDEBAR_REBIND_FIRST", { exact: true })).toBeVisible({ timeout: 60_000 })

			for (let iteration = 0; iteration < 3; iteration++) {
				sidebar = await hideAndRevealSidebar(page, helper)
				await expect(sidebar.getByText("E2E_SIDEBAR_REBIND_FIRST", { exact: true })).toBeVisible({ timeout: 30_000 })
			}

			const reboundInput = sidebar.getByTestId("chat-input")
			await reboundInput.fill("Complete after the sidebar view is rebound.")
			await sidebar.getByTestId("send-button").click()
			await expect(sidebar.getByText("E2E_SIDEBAR_REBIND_SECOND", { exact: true })).toBeVisible({ timeout: 60_000 })

			sidebar = await hideAndRevealSidebar(page, helper)
			await expect(sidebar.getByText("E2E_SIDEBAR_REBIND_SECOND", { exact: true })).toBeVisible({ timeout: 30_000 })
			await expect(sidebar.getByTestId("chat-input")).toBeEnabled()

			expect(server.getRequestCount("openai-compatible-chat")).toBe(2)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, UNRELATED_CATALOG_ERRORS)
			await closeCurrentTask(sidebar)
		})

		await e2e.step("LaTeX code blocks are typeset by MathJax and keep their raw TeX source copyable", async () => {
			await selectProfile(sidebar, E2E_PROFILE_NAMES.mockOpenAiResponses)

			const taskText = "Show one latex formula, one broken formula, and one shell snippet."
			const completionMarker = "E2E_LATEX_RENDERING_DONE"
			const shellMarker = "echo E2E_LATEX_PLAIN_CODE"
			const answer = [
				"Gaussian integral:",
				"",
				"```latex",
				RENDERABLE_FORMULA,
				"```",
				"",
				"Broken source:",
				"",
				"```math",
				BROKEN_FORMULA,
				"```",
				"",
				"Unrelated snippet:",
				"",
				"```bash",
				shellMarker,
				"```",
			].join("\n")

			server.resetOpenAiMock()
			server.enqueueResponses(
				"openai-compatible-responses",
				{ type: "message", text: answer },
				{
					type: "tool",
					id: "call_latex_rendering_completion",
					name: "attempt_completion",
					arguments: { result: completionMarker },
				},
			)

			await sendTask(sidebar, taskText)
			await expect(sidebar.getByText(completionMarker, { exact: false }).last()).toBeVisible({ timeout: 90_000 })

			// The renderable block is typeset into an inline SVG by MathJax.
			const renderedBlock = sidebar.getByTestId("latex-block").first()
			await expect(renderedBlock).toBeVisible({ timeout: 30_000 })
			const renderedSvg = renderedBlock.locator("svg").first()
			await expect(renderedSvg).toBeVisible({ timeout: 30_000 })
			const renderedBox = await renderedSvg.boundingBox()
			expect(renderedBox?.width ?? 0).toBeGreaterThan(0)
			expect(renderedBox?.height ?? 0).toBeGreaterThan(0)
			// SVG output must not pull web fonts: glyphs are vector paths.
			expect(await renderedSvg.locator("path").count()).toBeGreaterThan(0)
			// The color package renders \textcolor as a real fill instead of dropping it.
			const fills = await renderedSvg
				.locator("[fill]")
				.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("fill") ?? "").filter(Boolean))
			expect(fills.some((fill) => fill.toLowerCase().includes("teal"))).toBe(true)
			// The raw source is preserved for assistive tech and for copying.
			await expect(renderedBlock).toHaveAttribute("aria-label", RENDERABLE_FORMULA)

			// The broken block degrades to its raw TeX instead of rendering an empty area.
			// Its typeset container stays in the DOM but hidden, so only one block is visible.
			const failedBlock = sidebar.getByTestId("latex-block-error").first()
			await expect(failedBlock).toBeVisible({ timeout: 30_000 })
			await expect(failedBlock).toHaveText(BROKEN_FORMULA)
			await expect(sidebar.getByTestId("latex-block-error")).toHaveCount(1)
			await expect(sidebar.getByTestId("latex-block")).toHaveCount(2)
			expect(await sidebar.getByTestId("latex-block").nth(1).isVisible()).toBe(false)

			// Copying yields the raw TeX source, not the rendered SVG, in both states.
			const readClipboard = () => app.evaluate(({ clipboard }) => clipboard.readText())
			const copyButtons = sidebar.getByRole("button", { name: "Copy LaTeX source" })
			await expect(copyButtons).toHaveCount(2)

			await copyButtons.first().click()
			await expect.poll(readClipboard, { timeout: 10_000 }).toBe(RENDERABLE_FORMULA)

			await copyButtons.nth(1).click()
			await expect.poll(readClipboard, { timeout: 10_000 }).toBe(BROKEN_FORMULA)

			// A non-math fenced block keeps the ordinary highlighted <pre> rendering.
			const shellCode = sidebar.locator("pre code.language-bash").filter({ hasText: shellMarker })
			await expect(shellCode).toHaveCount(1)
			await expect(shellCode).toBeVisible()

			const screenshotPath = testInfo.outputPath("latex-rendering.png")
			await page.screenshot({ path: screenshotPath, fullPage: false })
			await testInfo.attach("latex-rendering.png", { path: screenshotPath, contentType: "image/png" })

			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, UNRELATED_CATALOG_ERRORS)
		})

		// BUGFIX-097: a Webview failure must reach the extension log. The render boundary is
		// pinned by the Webview component tests; only a launched extension shows that an
		// uncaught Webview error crosses the ProtoBus route into the Dline output.
		await e2e.step("an uncaught Webview error is reported to the extension log", async () => {
			// Thrown from a timer so it escapes every React boundary and reaches the
			// window-level handler, which is the path a blank panel leaves behind.
			await sidebar.evaluate((message) => {
				setTimeout(() => {
					throw new Error(message)
				}, 0)
			}, WEBVIEW_ERROR_MARKER)

			await expect
				.poll(
					() =>
						(E2ETestHelper.readDlineOutputIfPresent(userDataDir) ?? "")
							.split(/\r?\n/)
							.find((line) => line.includes("[Webview] uncaught error")) ?? "",
					{ timeout: 30_000 },
				)
				.toContain("[Webview] uncaught error")
			expect(E2ETestHelper.readDlineOutputIfPresent(userDataDir) ?? "").toContain(WEBVIEW_ERROR_MARKER)

			// The panel keeps working: reporting must not take the Webview down with it.
			await expect(sidebar.getByTestId("chat-input")).toBeEnabled()
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [
				...UNRELATED_CATALOG_ERRORS,
				/\[Webview\] uncaught error/,
				new RegExp(WEBVIEW_ERROR_MARKER),
			])
		})
	},
)
