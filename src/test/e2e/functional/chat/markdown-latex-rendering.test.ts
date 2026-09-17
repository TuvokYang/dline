import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

/** Display formula that exercises the base, ams, and color TeX packages together. */
const RENDERABLE_FORMULA = String.raw`\textcolor{teal}{\int_{0}^{\infty}} e^{-x^{2}}\,dx = \frac{\sqrt{\pi}}{2}`
/** Unbalanced braces so MathJax rejects the source and the block falls back to raw TeX. */
const BROKEN_FORMULA = String.raw`\frac{1}{`

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

e2e(
	"Markdown latex code blocks are typeset by MathJax and keep their raw TeX source copyable",
	async ({ app, helper, page, server, sidebar, userDataDir }, testInfo) => {
		e2e.setTimeout(150_000)
		await helper.signin(sidebar)
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

		// The model catalog is fetched from the real network, which this suite does not
		// stub; the failure is unrelated to markdown rendering.
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/Error fetching OpenRouter models/])
	},
)
