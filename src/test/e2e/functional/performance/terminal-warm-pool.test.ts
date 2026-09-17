import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Page } from "@playwright/test"

interface TerminalPoolEvent {
	partition: string
	terminalId: number
	index: number
}

interface AcquireEvent extends TerminalPoolEvent {
	durationMs: number
}

interface TerminalAcquirePerfEvent {
	activityId: string
	terminalId: number
	/** Where the terminal came from; reported as a bounded metric dimension. */
	source: string
	durationMs: number
	index: number
}

function parseReadyEvents(output: string): TerminalPoolEvent[] {
	const events: WarmEvent[] = []
	for (const match of output.matchAll(
		/\[TerminalPool\] operation=warm partition=([a-f0-9]+) terminalId=(\d+) state=ready durationMs=\d+/g,
	)) {
		events.push({ partition: match[1], terminalId: Number(match[2]), index: match.index })
	}
	return events
}

function parseAcquireEvents(output: string): AcquireEvent[] {
	return [
		...output.matchAll(
			/\[TerminalPool\] operation=acquire partition=([a-f0-9]+) terminalId=(\d+) policy=reusable sameCwd=true durationMs=(\d+) readyAfter=[0-2]/g,
		),
	].map((match) => ({
		partition: match[1],
		terminalId: Number(match[2]),
		durationMs: Number(match[3]),
		index: match.index,
	}))
}

function parseReleaseEvents(output: string): TerminalPoolEvent[] {
	return [
		...output.matchAll(
			/\[TerminalPool\] operation=release partition=([a-f0-9]+) terminalId=(\d+) disposition=reusable durationMs=\d+ ready=[0-3]/g,
		),
	].map((match) => ({ partition: match[1], terminalId: Number(match[2]), index: match.index }))
}

function parseTerminalAcquirePerfEvents(output: string): TerminalAcquirePerfEvent[] {
	return [
		...output.matchAll(
			/\[TerminalPerf\] phase=terminal_acquired taskId=\S+ activityId=(\S+) terminalId=(\d+) source=(\S+) durationMs=(\d+) elapsedMs=\d+/g,
		),
	].map((match) => ({
		activityId: match[1],
		terminalId: Number(match[2]),
		source: match[3],
		durationMs: Number(match[4]),
		index: match.index,
	}))
}

async function openTerminalSettings(page: Page, sidebar: Frame): Promise<void> {
	await page.getByRole("button", { name: "Settings", exact: true }).click()
	await expect(sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible({ timeout: 30_000 })
	await sidebar.getByTestId("tab-terminal").click()
	await expect(
		sidebar.getByText(
			"When enabled, Dline reuses healthy prewarmed terminals across commands and working directories. When disabled, each command consumes a fresh prewarmed terminal.",
			{ exact: true },
		),
	).toBeVisible()
}

async function setShellIntegrationTimeout(sidebar: Frame, seconds: string): Promise<void> {
	const input = sidebar
		.getByText("Shell integration timeout (seconds)", { exact: true })
		.locator("..")
		.locator("vscode-text-field input")
	await input.fill(seconds)
	await input.blur()
	await sidebar.getByRole("button", { name: "Done", exact: true }).click()
	await expect(sidebar.getByTestId("chat-input")).toBeVisible()
}

e2e(
	"Terminal warm pool - reuses ready terminals across three consecutive foreground commands",
	async ({ helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(240_000)
		await helper.signin(sidebar)
		await openTerminalSettings(page, sidebar)
		await setShellIntegrationTimeout(sidebar, "15")

		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_terminal_warm_pool_1",
				name: "execute_command",
				arguments: {
					command: "echo WS024_COMMAND_1",
					workdirectory: ".",
					requires_approval: true,
					synchronous: true,
					timeout: 60,
				},
			},
			{
				type: "tool",
				id: "call_terminal_warm_pool_2",
				name: "execute_command",
				arguments: {
					command: "echo WS024_COMMAND_2",
					workdirectory: ".",
					requires_approval: true,
					synchronous: true,
					timeout: 60,
				},
				expectedToolResults: [
					{
						callId: "call_terminal_warm_pool_1",
						contentIncludes: ["WS024_COMMAND_1"],
					},
				],
			},
			{
				type: "tool",
				id: "call_terminal_warm_pool_3",
				name: "execute_command",
				arguments: {
					command: "echo WS024_COMMAND_3",
					workdirectory: ".",
					requires_approval: true,
					synchronous: true,
					timeout: 60,
				},
				expectedToolResults: [
					{
						callId: "call_terminal_warm_pool_2",
						contentIncludes: ["WS024_COMMAND_2"],
					},
				],
			},
			{
				type: "tool",
				id: "call_terminal_warm_pool_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_TERMINAL_WARM_POOL_COMPLETE" },
				expectedToolResults: [
					{
						callId: "call_terminal_warm_pool_3",
						contentIncludes: ["WS024_COMMAND_3"],
					},
				],
			},
		)

		const input = sidebar.getByTestId("chat-input")
		await input.fill("Run three consecutive foreground terminal warm-pool verification commands.")
		await sidebar.getByTestId("send-button").click()
		await expect(sidebar.getByText("Approve", { exact: true }).last()).toBeVisible({ timeout: 60_000 })
		await expect
			.poll(
				async () => {
					const output = await E2ETestHelper.readDlineOutput(userDataDir)
					const readyEvents = parseReadyEvents(output)
					return readyEvents.some(
						(event) =>
							readyEvents.filter((candidate) => candidate.partition === event.partition).length >= 3 &&
							new RegExp(
								`\\[TerminalPool\\] operation=ensureWarm partition=${event.partition} target=3 durationMs=\\d+ ready=3 warming=0`,
							).test(output),
					)
				},
				{ timeout: 70_000 },
			)
			.toBe(true)
		for (let commandNumber = 1; commandNumber <= 3; commandNumber++) {
			const approveButton = sidebar.getByText("Approve", { exact: true }).last()
			await expect(approveButton).toBeVisible({ timeout: 60_000 })
			await expect(approveButton).toBeEnabled({ timeout: 60_000 })
			await approveButton.click()
			await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(commandNumber + 1)
		}
		await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(4)

		await expect
			.poll(
				async () => {
					const currentOutput = await E2ETestHelper.readDlineOutput(userDataDir)
					return (
						parseAcquireEvents(currentOutput).length >= 3 &&
						parseReleaseEvents(currentOutput).length >= 3 &&
						parseTerminalAcquirePerfEvents(currentOutput).length >= 3
					)
				},
				{ timeout: 30_000 },
			)
			.toBe(true)

		const output = await E2ETestHelper.readDlineOutput(userDataDir)
		const acquires = parseAcquireEvents(output).slice(-3)
		const releases = parseReleaseEvents(output)
		const perfAcquires = parseTerminalAcquirePerfEvents(output).slice(-3)
		const partition = acquires[0]?.partition

		expect(acquires).toHaveLength(3)
		expect(new Set(acquires.map((event) => event.partition))).toEqual(new Set([partition]))
		expect(acquires.every((event) => event.durationMs <= 500)).toBe(true)
		expect(perfAcquires.map((event) => event.terminalId)).toEqual(acquires.map((event) => event.terminalId))
		expect(perfAcquires.slice(1).every((event) => event.durationMs <= 500)).toBe(true)
		// Every command here is served by the pool, so the reported source has
		// to say so. Without it the acquisition metric mixes warm hits with
		// cold starts and its percentiles stop meaning anything.
		expect(perfAcquires.map((event) => event.source)).toEqual(["warm_pool", "warm_pool", "warm_pool"])
		expect(
			acquires
				.slice(1)
				.some((event) =>
					acquires.some(
						(prior) =>
							prior.index < event.index &&
							prior.terminalId === event.terminalId &&
							releases.some(
								(release) =>
									release.terminalId === prior.terminalId &&
									release.index > prior.index &&
									release.index < event.index,
							),
					),
				),
		).toBe(true)
		for (const acquire of acquires) {
			expect(
				releases.some(
					(release) =>
						release.partition === acquire.partition &&
						release.terminalId === acquire.terminalId &&
						release.index > acquire.index,
				),
			).toBe(true)
		}
		expect(parseReadyEvents(output).filter((event) => event.partition === partition).length).toBeGreaterThanOrEqual(3)
		expect(output).not.toContain("[TerminalPool] operation=fallback")
		expect(output).not.toContain("[TerminalPerf] phase=capability_failure")
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/Error fetching OpenRouter models:.*Network Error/])
	},
)
