import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect } from "@playwright/test"

e2e(
	"Command output - expanded output is capped at 80vh and remains scrollable",
	async ({ helper, server, sidebar, userDataDir }, testInfo) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
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
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)
