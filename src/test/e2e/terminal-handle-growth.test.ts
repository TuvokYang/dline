import { expect, type Frame, type Locator, type Page } from "@playwright/test"
import { E2ETestHelper, e2e } from "./utils/helpers"

/**
 * Handle-growth control for BUGFIX-073.
 *
 * Each standalone command opens three OS handles for its child process: stdout,
 * stderr and the process itself. Before the fix a settled command kept all three
 * reachable for the lifetime of the task, so a long session accumulated
 * thousands of handles in the extension host. Counting handles before and after
 * a fixed number of commands is the only way to observe that from the outside:
 * a functional assertion passes either way.
 */

/**
 * Commands run before the baseline is taken.
 *
 * Starting a task is not free: it opens a log file, a history database and the
 * first child process. Measuring from before the task began would fold that
 * one-time cost into the result and make a per-command leak indistinguishable
 * from ordinary startup. Sampling after a warm-up batch means both samples see
 * a task that is already running, so only the measured batch is compared.
 */
const WARMUP_COMMAND_COUNT = 4

/** Commands whose handle cost the assertion actually measures. */
const MEASURED_COMMAND_COUNT = 8

const COMMAND_COUNT = WARMUP_COMMAND_COUNT + MEASURED_COMMAND_COUNT

/**
 * Handles the extension host may legitimately gain across the measured batch.
 *
 * The old behaviour retained three handles per command, so the measured batch
 * would have grown by about 24. The budget sits well below that and well above
 * the handful a live host adds for logs, sockets and file watchers, which keeps
 * it from passing the leak or failing on noise.
 */
const HANDLE_GROWTH_BUDGET = 12

/**
 * Read the handle count of the extension host that owns the given user data dir.
 *
 * Handles are a Windows-only counter; other platforms expose open file
 * descriptors instead, so the control is skipped rather than compared against a
 * number that means something different.
 */
async function readExtensionHostHandleCount(pid: number): Promise<number | undefined> {
	if (process.platform !== "win32") return undefined
	const { execFile } = await import("node:child_process")
	const { promisify } = await import("node:util")
	const run = promisify(execFile)
	const { stdout } = await run("powershell.exe", [
		"-NoProfile",
		"-Command",
		`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).HandleCount`,
	])
	// PowerShell suppresses the missing-process error, so an exited host yields an
	// empty string. Number("") is 0, which would read as a real handle count and
	// turn a vanished host into a trivially passing measurement.
	const text = stdout.trim()
	if (text.length === 0) return undefined
	const parsed = Number(text)
	return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Read the handle count once it stops moving.
 *
 * A command's handles are released when its child exits, which lags the tool
 * result, and a live host also opens and closes handles on its own. Sampling
 * once would capture whichever moment the test happened to reach, so both the
 * baseline and the final reading wait for consecutive samples to agree and
 * compare two settled numbers instead.
 */
async function settleHandleCount(pid: number): Promise<number | undefined> {
	const requiredStableSamples = 3
	const maximumSamples = 30
	let previous: number | undefined
	let stableSamples = 0
	for (let sample = 0; sample < maximumSamples; sample++) {
		const current = await readExtensionHostHandleCount(pid)
		if (current === undefined) return undefined
		stableSamples = current === previous ? stableSamples + 1 : 0
		if (stableSamples + 1 >= requiredStableSamples) return current
		previous = current
		await new Promise((resolve) => setTimeout(resolve, 500))
	}
	// Never settled. Returning the last reading would compare an arbitrary
	// moment of a moving count, so the measurement is reported as unusable.
	return undefined
}

/** Point the extension at the standalone runner, which is the path BUGFIX-073 fixed. */
async function selectBackgroundExecTerminalMode(page: Page, sidebar: Frame): Promise<void> {
	await page.getByRole("button", { name: "Settings", exact: true }).click()
	await expect(sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible({ timeout: 30_000 })
	await sidebar.getByTestId("tab-terminal").click()

	const dropdown: Locator = sidebar.locator("#terminal-execution-mode")
	await dropdown.click()
	await sidebar.getByRole("option", { name: "Background Exec", exact: true }).click()
	await expect.poll(() => dropdown.evaluate((element) => (element as HTMLSelectElement).value)).toBe("backgroundExec")

	await sidebar.getByRole("button", { name: "Done", exact: true }).click()
	await expect(sidebar.getByTestId("chat-input")).toBeVisible()
}

/** One process of the VS Code instance, reduced to the fields that identify it. */
interface InstanceProcess {
	pid: number
	parentPid: number
	/** Raw `pid parent name type sub-type debug-flag` line, kept for failure diagnostics. */
	description: string
	isNodeUtility: boolean
	hasDebugPort: boolean
}

/** Read every running process, reduced to the fields this control reasons about. */
async function readProcessTable(): Promise<InstanceProcess[]> {
	const { execFile } = await import("node:child_process")
	const { promisify } = await import("node:util")
	const run = promisify(execFile)
	const { stdout } = await run(
		"powershell.exe",
		[
			"-NoProfile",
			"-Command",
			`Get-CimInstance Win32_Process | ForEach-Object { $c = [string]$_.CommandLine; $type = if ($c -match '--type=([^ ]+)') { $Matches[1] } else { 'main' }; $sub = if ($c -match '--utility-sub-type=([^ ]+)') { $Matches[1] } else { '-' }; $dbg = if ($c -match '--inspect-port') { 'debug' } else { '-' }; "$($_.ProcessId) $($_.ParentProcessId) $($_.Name) $type $sub $dbg" }`,
		],
		{ maxBuffer: 16 * 1024 * 1024 },
	)
	return stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((description) => {
			const [rawPid, rawParentPid] = description.split(" ")
			return {
				pid: Number(rawPid),
				parentPid: Number(rawParentPid),
				description,
				isNodeUtility: description.includes("node.mojom.NodeService"),
				hasDebugPort: description.endsWith(" debug"),
			}
		})
		.filter((entry) => Number.isFinite(entry.pid) && entry.pid > 0 && Number.isFinite(entry.parentPid))
}

/**
 * Collect every descendant of this test's launched process.
 *
 * Playwright reports the pid it spawned, which on Windows is a launcher whose
 * only child is the real VS Code main process, so the extension host sits a
 * generation below the direct children. Walking the whole subtree keeps the
 * lookup correct regardless of how many launcher levels a platform inserts,
 * while still excluding the instances of other workers.
 */
async function readInstanceProcesses(launchedPid: number): Promise<InstanceProcess[]> {
	const table = await readProcessTable()
	const childrenByParent = new Map<number, InstanceProcess[]>()
	for (const entry of table) {
		const siblings = childrenByParent.get(entry.parentPid)
		if (siblings) siblings.push(entry)
		else childrenByParent.set(entry.parentPid, [entry])
	}

	const descendants: InstanceProcess[] = []
	const visited = new Set<number>([launchedPid])
	const queue = [launchedPid]
	while (queue.length > 0) {
		const parentPid = queue.shift() as number
		for (const child of childrenByParent.get(parentPid) ?? []) {
			if (visited.has(child.pid)) continue
			visited.add(child.pid)
			descendants.push(child)
			queue.push(child.pid)
		}
	}
	return descendants
}

/**
 * Find the extension host process that belongs to this test's VS Code instance.
 *
 * Neither the user data dir nor the extensions dir reaches the extension host
 * command line, so the host cannot be matched by path. What does identify it is
 * its shape: VS Code runs it as a Node utility process and always gives it a
 * debug port, which the other Node utilities do not receive. Restricting the
 * search to children of this instance's own main process keeps the parallel
 * instances of other workers out of the result.
 *
 * Exactly one match is required. Several matches would mean the shape no longer
 * identifies the host, and returning one of them would silently measure an
 * arbitrary process.
 */
function selectExtensionHostPid(instanceProcesses: readonly InstanceProcess[]): number | undefined {
	const hosts = instanceProcesses.filter((entry) => entry.isNodeUtility && entry.hasDebugPort)
	return hosts.length === 1 ? hosts[0].pid : undefined
}

/**
 * Script one batch of echo commands followed by a completion.
 *
 * Each response declares the previous call's expected output, so the mock only
 * serves the next response once the previous command returned the text it was
 * told to echo. The trailing completion ends the turn, which parks the task and
 * gives the test a point where no command is running.
 */
function createCommandBatch(scope: string, commandCount: number) {
	const responses = []
	for (let index = 1; index <= commandCount; index++) {
		responses.push({
			type: "tool" as const,
			id: `call_${scope}_${index}`,
			name: "execute_command",
			arguments: {
				command: `echo BUGFIX073_${scope.toUpperCase()}_${index}`,
				workdirectory: ".",
				requires_approval: false,
				synchronous: true,
				timeout: 60,
			},
			...(index > 1
				? {
						expectedToolResults: [
							{
								callId: `call_${scope}_${index - 1}`,
								contentIncludes: [`BUGFIX073_${scope.toUpperCase()}_${index - 1}`],
							},
						],
					}
				: {}),
		})
	}
	responses.push({
		type: "tool" as const,
		id: `call_${scope}_completion`,
		name: "attempt_completion",
		arguments: { result: `E2E_TERMINAL_HANDLE_${scope.toUpperCase()}_COMPLETE` },
		expectedToolResults: [
			{
				callId: `call_${scope}_${commandCount}`,
				contentIncludes: [`BUGFIX073_${scope.toUpperCase()}_${commandCount}`],
			},
		],
	})
	return responses
}

e2e(
	"Terminal handle growth - repeated commands do not accumulate child process handles",
	async ({ app, helper, page, sidebar, server, userDataDir }) => {
		e2e.setTimeout(300_000)
		await helper.signin(sidebar)

		// The leak this control guards lives in the standalone runner, which only
		// executes commands when the terminal mode selects it. Left at its product
		// default the commands would run through the VS Code terminal instead, and
		// the measurement would report a path the fix never touched.
		await selectBackgroundExecTerminalMode(page, sidebar)

		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(...createCommandBatch("warmup", WARMUP_COMMAND_COUNT))

		const launchedPid = app.process().pid
		const instanceProcesses = process.platform === "win32" && launchedPid ? await readInstanceProcesses(launchedPid) : []
		const extensionHostPid = selectExtensionHostPid(instanceProcesses)

		const input = sidebar.getByTestId("chat-input")
		await input.fill("Warm up the terminal runner before handle accounting.")
		await sidebar.getByTestId("send-button").click()

		// The warm-up turn ends in a completion, so reaching its request count means
		// every warm-up command has finished and the task is parked. Sampling here
		// keeps one-time task startup behind both readings, and keeps the measured
		// commands from running while the baseline is still settling.
		const warmupRequestCount = WARMUP_COMMAND_COUNT + 1
		await expect.poll(() => server.openAiRequestCount, { timeout: 180_000 }).toBe(warmupRequestCount)
		const baseline = extensionHostPid ? await settleHandleCount(extensionHostPid) : undefined

		server.enqueueOpenAiResponses(...createCommandBatch("measured", MEASURED_COMMAND_COUNT))
		await input.fill("Run the measured verification commands for terminal handle accounting.")
		await sidebar.getByTestId("send-button").click()

		const totalRequestCount = warmupRequestCount + MEASURED_COMMAND_COUNT + 1
		await expect.poll(() => server.openAiRequestCount, { timeout: 180_000 }).toBe(totalRequestCount)

		// A consumption is recorded even when its declared contract fails, so the
		// request count alone would accept a run whose commands returned the wrong
		// output. The completion text is not read from the DOM because the message
		// list virtualizes and this task produces more rows than fit on screen.
		const contractErrors = server
			.getMockConsumptions("openai-compatible-chat")
			.map((consumption) => consumption.contractError)
			.filter(Boolean)
		expect(contractErrors, "scripted command contracts failed").toEqual([])

		if (process.platform !== "win32") {
			// Only Windows exposes a handle counter; elsewhere the functional half
			// of the control still ran and the comparison is explicitly skipped.
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/Error fetching OpenRouter models:.*Network Error/])
			return
		}

		// On Windows a missing pid or counter means the control never measured
		// anything, which must fail rather than pass as a silent skip. The observed
		// processes are reported with the failure so the next reader can tell a
		// changed process shape from a lookup that never ran.
		const observedProcesses = instanceProcesses.map((entry) => entry.description).join("\n")
		expect(
			extensionHostPid,
			`extension host pid could not be resolved below ${launchedPid}:\n${observedProcesses || "<none>"}`,
		).toBeDefined()
		expect(baseline, "baseline extension host handle count never settled").toBeDefined()
		if (baseline === undefined || extensionHostPid === undefined) return

		const observed = await settleHandleCount(extensionHostPid)
		expect(observed, "final extension host handle count never settled").toBeDefined()
		if (observed === undefined) return

		expect(
			observed - baseline,
			`handles grew by ${observed - baseline} across ${MEASURED_COMMAND_COUNT} commands`,
		).toBeLessThanOrEqual(HANDLE_GROWTH_BUDGET)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/Error fetching OpenRouter models:.*Network Error/])
	},
)
