import { mkdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import type { MockApiConsumption } from "@e2e/fixtures/server"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import {
	createLargeRealProjectFixture,
	inspectLargeRealProjectGit,
	LARGE_PROJECT_RULE_MARKER,
	LARGE_PROJECT_SKILL_MARKER,
	LARGE_PROJECT_SUBAGENT_MARKER,
	LARGE_PROJECT_TOTAL_TRACKED_FILES,
	type LargeRealProjectFixture,
} from "@e2e/utils/large-real-project-fixture"
import { expect, type Frame } from "@playwright/test"

const TASK_TEXT = "E2E_LARGE_REAL_PROJECT_PERFORMANCE_TASK"
const FOLLOW_UP_TEXT = "E2E_LARGE_REAL_PROJECT_FOLLOW_UP"
const COMPLETION_TEXT = "E2E_LARGE_REAL_PROJECT_DONE"
const FOLLOW_UP_COMPLETION_TEXT = "E2E_LARGE_REAL_PROJECT_FOLLOW_UP_DONE"
const CHILD_COMPLETION_TEXT = "E2E_LARGE_REAL_PROJECT_CHILD_DONE"
const TOOL_ROUND_TRIP_BUDGET_MS = 10_000
const SUBAGENT_ROUND_TRIP_BUDGET_MS = 20_000
const FOLLOW_UP_REQUEST_BUDGET_MS = 10_000
const LOG_TIMESTAMP = String.raw`(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})`
const TASK_LOCK_PATTERN = new RegExp(`^${LOG_TIMESTAMP} \\[debug\\] \\[Task \\d+\\] Task lock acquired$`)
const TERMINAL_WARM_PATTERN = new RegExp(
	`^${LOG_TIMESTAMP} \\[debug\\] \\[TerminalPool\\] operation=ensureWarm .* durationMs=(\\d+)`,
)
const CHECKPOINT_TRACKER_PATTERN = new RegExp(`^${LOG_TIMESTAMP} \\[info\\] Creating new CheckpointTracker for task \\d+$`)
const BASELINE_START_PATTERN = new RegExp(
	`^${LOG_TIMESTAMP} \\[info\\] \\[Task \\d+\\] Starting checkpoint add operation \\(baseline\\)\\.\\.\\.$`,
)
const BASELINE_COMPLETE_PATTERN = new RegExp(`^${LOG_TIMESTAMP} \\[debug\\] Checkpoint add operation completed in (\\d+)ms$`)
const SHADOW_READY_PATTERN = new RegExp(`^${LOG_TIMESTAMP} \\[warn\\] Shadow git initialization completed$`)
const LOAD_CONTEXT_PATTERN = new RegExp(`^${LOG_TIMESTAMP} \\[debug\\] \\[Task \\d+\\] loadContext timing: total=(\\d+)ms`)
const FIRST_REQUEST_PATTERN = new RegExp(`^${LOG_TIMESTAMP} \\[info\\] \\[Task \\d+\\] sending API request`)

interface TimingSample {
	budgetMs: number
	durationMs: number
	fromRequestIndex: number
	name: string
	toRequestIndex: number
}

interface LogMoment {
	atMs: number
	match: RegExpExecArray
}

interface StartupBreakdown {
	baselineCompleteToShadowReadyMs?: number
	baselineStageMs?: number
	checkpointTrackerToBaselineStartMs?: number
	firstRequestLogAtMs?: number
	loadContextDurationMs?: number
	reportedBaselineDurationMs?: number
	shadowReadyToFirstRequestMs?: number
	submitToTaskLockMs?: number
	taskLockToCheckpointTrackerMs?: number
	taskLockToFirstRequestMs?: number
	terminalWarmDurationMs?: number
}

interface LargeProjectPerformanceReport {
	anomalies: string[]
	fixture: LargeRealProjectFixture
	requestBytes: number[]
	requestToolNames: Array<string | undefined>
	startup: StartupBreakdown
	timings: TimingSample[]
}

function requestText(consumption: MockApiConsumption): string {
	return JSON.stringify(consumption.requestBody)
}

function parseLogTimestamp(raw: string): number {
	return new Date(raw.replace(" ", "T")).getTime()
}

function findLogMoment(output: string, pattern: RegExp, sinceMs: number): LogMoment | undefined {
	for (const line of output.split(/\r?\n/u)) {
		const match = pattern.exec(line)
		if (!match?.[1]) continue
		const atMs = parseLogTimestamp(match[1])
		if (atMs < sinceMs) continue
		return { atMs, match }
	}
	return undefined
}

function elapsed(later?: LogMoment, earlier?: LogMoment): number | undefined {
	return later && earlier ? later.atMs - earlier.atMs : undefined
}

function buildStartupBreakdown(output: string, submittedAtMs: number, firstRequestReceivedAtMs: number): StartupBreakdown {
	const sinceMs = submittedAtMs - 1_000
	const taskLock = findLogMoment(output, TASK_LOCK_PATTERN, sinceMs)
	const terminalWarm = findLogMoment(output, TERMINAL_WARM_PATTERN, sinceMs)
	const checkpointTracker = findLogMoment(output, CHECKPOINT_TRACKER_PATTERN, sinceMs)
	const baselineStart = findLogMoment(output, BASELINE_START_PATTERN, sinceMs)
	const baselineComplete = findLogMoment(output, BASELINE_COMPLETE_PATTERN, sinceMs)
	const shadowReady = findLogMoment(output, SHADOW_READY_PATTERN, sinceMs)
	const loadContext = findLogMoment(output, LOAD_CONTEXT_PATTERN, sinceMs)
	const firstRequestLog = findLogMoment(output, FIRST_REQUEST_PATTERN, sinceMs)
	return {
		baselineCompleteToShadowReadyMs: elapsed(shadowReady, baselineComplete),
		baselineStageMs: elapsed(baselineComplete, baselineStart),
		checkpointTrackerToBaselineStartMs: elapsed(baselineStart, checkpointTracker),
		firstRequestLogAtMs: firstRequestLog?.atMs,
		loadContextDurationMs: loadContext?.match[2] ? Number(loadContext.match[2]) : undefined,
		reportedBaselineDurationMs: baselineComplete?.match[2] ? Number(baselineComplete.match[2]) : undefined,
		shadowReadyToFirstRequestMs: shadowReady ? firstRequestReceivedAtMs - shadowReady.atMs : undefined,
		submitToTaskLockMs: taskLock ? taskLock.atMs - submittedAtMs : undefined,
		taskLockToCheckpointTrackerMs: elapsed(checkpointTracker, taskLock),
		taskLockToFirstRequestMs: taskLock ? firstRequestReceivedAtMs - taskLock.atMs : undefined,
		terminalWarmDurationMs: terminalWarm?.match[2] ? Number(terminalWarm.match[2]) : undefined,
	}
}

function timing(
	consumptions: readonly MockApiConsumption[],
	name: string,
	fromRequestIndex: number,
	toRequestIndex: number,
	budgetMs: number,
): TimingSample {
	const from = consumptions[fromRequestIndex]
	const to = consumptions[toRequestIndex]
	if (!from || !to) {
		throw new Error(`Cannot measure ${name}: missing request ${fromRequestIndex} or ${toRequestIndex}`)
	}
	return {
		budgetMs,
		durationMs: to.receivedAtMs - from.receivedAtMs,
		fromRequestIndex,
		name,
		toRequestIndex,
	}
}

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

async function enableSubagents(dlineDir: string): Promise<void> {
	const settingsPath = path.join(dlineDir, "data", "settings", "settings.json")
	const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown> & {
		values?: Record<string, unknown>
	}
	settings.subagentsEnabled = true
	settings.values = { ...(settings.values ?? {}), subagentsEnabled: true }
	await mkdir(path.dirname(settingsPath), { recursive: true })
	await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8")
}

async function sendTask(sidebar: Frame, text: string): Promise<number> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled()
	await input.fill(text)
	const submittedAtMs = Date.now()
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
	return submittedAtMs
}

function detectAnomalies(timings: readonly TimingSample[]): string[] {
	return timings
		.filter((sample) => sample.durationMs >= sample.budgetMs)
		.map((sample) => `${sample.name}=${sample.durationMs}ms exceeded ${sample.budgetMs}ms`)
}

e2e(
	"Large real project - Rules, Skill, Subagent, Git and 1000 files keep Task and tool round trips responsive",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(300_000)
		const fixture = await createLargeRealProjectFixture(workspaceDir, {
			subagentProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
		})
		await enableSubagents(dlineDir)

		const app = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			await E2ETestHelper.openClineSidebar(page)
			const sidebar = await helper.getSidebar(page)
			await helper.signin(sidebar)
			await setAutoApproveAction(sidebar, "Read project files", true)

			server.resetOpenAiMock()
			server.enqueueOpenAiResponses(
				{
					type: "tool",
					id: "call_large_project_load_skill",
					name: "load_skill",
					arguments: { name: fixture.skillName },
					expectedRequestIncludes: [
						TASK_TEXT,
						LARGE_PROJECT_RULE_MARKER,
						fixture.skillName,
						fixture.subagentName,
						fixture.gitCommitHash,
						"latestGitCommitHash",
					],
					expectedRequestExcludes: [LARGE_PROJECT_SKILL_MARKER],
				},
				{
					type: "tool",
					id: "call_large_project_read",
					name: "read_file",
					arguments: { path: fixture.targetFilePath },
					expectedToolResults: [
						{
							callId: "call_large_project_load_skill",
							contentIncludes: [
								LARGE_PROJECT_SKILL_MARKER,
								`Do not call load_skill again for '${fixture.skillName}'.`,
							],
						},
					],
					expectedRequestIncludes: [LARGE_PROJECT_SKILL_MARKER],
				},
				{
					type: "tool",
					id: "call_large_project_subagent",
					name: "use_subagent",
					arguments: {
						agent_name: fixture.subagentName,
						task: `Verify ${fixture.targetFilePath}`,
						context: `Read ${fixture.targetFilePath} and return ${fixture.targetMarker}.`,
						timeout: 120,
					},
					expectedToolResults: [{ callId: "call_large_project_read", contentIncludes: fixture.targetMarker }],
				},
			)
			server.enqueueResponses(
				"openai-compatible-responses",
				{
					type: "tool",
					id: "call_large_project_child_load_skill",
					name: "load_skill",
					arguments: { name: fixture.skillName },
					expectedRequestIncludes: [LARGE_PROJECT_SUBAGENT_MARKER, fixture.skillName, fixture.targetFilePath],
					expectedRequestExcludes: [LARGE_PROJECT_SKILL_MARKER],
				},
				{
					type: "tool",
					id: "call_large_project_child_read",
					name: "read_file",
					arguments: { path: fixture.targetFilePath },
					expectedToolResults: [
						{
							callId: "call_large_project_child_load_skill",
							contentIncludes: LARGE_PROJECT_SKILL_MARKER,
						},
					],
				},
				{
					type: "tool",
					id: "call_large_project_child_complete",
					name: "attempt_completion",
					arguments: { result: `${CHILD_COMPLETION_TEXT}: ${fixture.targetMarker}` },
					expectedToolResults: [{ callId: "call_large_project_child_read", contentIncludes: fixture.targetMarker }],
				},
			)
			server.enqueueOpenAiResponses(
				{
					type: "tool",
					id: "call_large_project_complete",
					name: "attempt_completion",
					arguments: { result: COMPLETION_TEXT },
					expectedToolResults: [
						{
							callId: "call_large_project_subagent",
							contentIncludes: [CHILD_COMPLETION_TEXT, fixture.targetMarker],
						},
					],
				},
				{
					type: "tool",
					id: "call_large_project_follow_up_complete",
					name: "attempt_completion",
					arguments: { result: FOLLOW_UP_COMPLETION_TEXT },
					expectedRequestIncludes: [FOLLOW_UP_TEXT, COMPLETION_TEXT, fixture.targetMarker],
				},
			)

			const firstSubmittedAtMs = await sendTask(sidebar, TASK_TEXT)
			await expect
				.poll(() => server.getRequestCount("openai-compatible-chat"), {
					timeout: 120_000,
					message: "large-project Task did not reach the first Provider request within 120000ms",
				})
				.toBeGreaterThanOrEqual(1)
			const firstRequest = server.getMockConsumptions("openai-compatible-chat")[0]
			if (!firstRequest) throw new Error("Large-project Task reached the Provider without a recorded consumption")
			const firstRequestLatencyMs = firstRequest.receivedAtMs - firstSubmittedAtMs
			expect(
				firstRequestLatencyMs,
				`task-submit-to-first-provider-request must stay under ${TOOL_ROUND_TRIP_BUDGET_MS}ms`,
			).toBeLessThan(TOOL_ROUND_TRIP_BUDGET_MS)
			await expect(sidebar.getByText(COMPLETION_TEXT, { exact: false }).last()).toBeVisible({ timeout: 120_000 })
			await expect.poll(() => server.getRequestCount("openai-compatible-chat"), { timeout: 120_000 }).toBe(4)
			await expect.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 120_000 }).toBe(3)

			const firstTurnConsumptions = server.getMockConsumptions("openai-compatible-chat")
			const childConsumptions = server.getMockConsumptions("openai-compatible-responses")
			const firstTurnTimings: TimingSample[] = [
				{
					budgetMs: TOOL_ROUND_TRIP_BUDGET_MS,
					durationMs: firstRequestLatencyMs,
					fromRequestIndex: -1,
					name: "task-submit-to-first-provider-request",
					toRequestIndex: 0,
				},
				timing(firstTurnConsumptions, "load-skill-round-trip", 0, 1, TOOL_ROUND_TRIP_BUDGET_MS),
				timing(firstTurnConsumptions, "read-file-round-trip", 1, 2, TOOL_ROUND_TRIP_BUDGET_MS),
				timing(firstTurnConsumptions, "subagent-round-trip", 2, 3, SUBAGENT_ROUND_TRIP_BUDGET_MS),
				timing(childConsumptions, "subagent-load-skill-round-trip", 0, 1, TOOL_ROUND_TRIP_BUDGET_MS),
				timing(childConsumptions, "subagent-read-file-round-trip", 1, 2, TOOL_ROUND_TRIP_BUDGET_MS),
			]

			const followUpSubmittedAtMs = await sendTask(sidebar, FOLLOW_UP_TEXT)
			await expect(sidebar.getByText(FOLLOW_UP_COMPLETION_TEXT, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(5)
			const allParentConsumptions = server.getMockConsumptions("openai-compatible-chat")
			const followUpRequest = allParentConsumptions[4]!
			const followUpTiming: TimingSample = {
				budgetMs: FOLLOW_UP_REQUEST_BUDGET_MS,
				durationMs: followUpRequest.receivedAtMs - followUpSubmittedAtMs,
				fromRequestIndex: -1,
				name: "follow-up-submit-to-provider-request",
				toRequestIndex: 4,
			}
			const timings = [...firstTurnTimings, followUpTiming]
			const anomalies = detectAnomalies(timings)
			const gitAfterTask = await inspectLargeRealProjectGit(workspaceDir)
			const dlineOutput = E2ETestHelper.readDlineOutputIfPresent(userDataDir) ?? ""
			const startup = buildStartupBreakdown(dlineOutput, firstSubmittedAtMs, firstTurnConsumptions[0]!.receivedAtMs)

			const report: LargeProjectPerformanceReport = {
				anomalies,
				fixture,
				requestBytes: [...allParentConsumptions, ...childConsumptions].map((consumption) =>
					Buffer.byteLength(requestText(consumption), "utf8"),
				),
				requestToolNames: [...allParentConsumptions, ...childConsumptions].map((consumption) => consumption.toolName),
				startup,
				timings,
			}
			console.log(`[large-real-project-performance] ${JSON.stringify(report)}`)
			const reportPath = e2e.info().outputPath("large-real-project-performance.json")
			await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
			await e2e.info().attach("large-real-project-performance.json", {
				path: reportPath,
				contentType: "application/json",
			})

			expect(fixture.trackedFileCount).toBe(LARGE_PROJECT_TOTAL_TRACKED_FILES)
			expect(fixture.gitStatus).toBe("")
			expect(gitAfterTask).toEqual({
				commitHash: fixture.gitCommitHash,
				status: "",
				trackedFileCount: LARGE_PROJECT_TOTAL_TRACKED_FILES,
			})
			expect(firstTurnConsumptions.map((entry) => entry.toolName)).toEqual([
				"load_skill",
				"read_file",
				"use_subagent",
				"attempt_completion",
			])
			expect(childConsumptions.map((entry) => entry.toolName)).toEqual(["load_skill", "read_file", "attempt_completion"])
			expect(allParentConsumptions[4]?.toolName).toBe("attempt_completion")
			expect([...allParentConsumptions, ...childConsumptions].every((entry) => entry.contractError === undefined)).toBe(
				true,
			)
			await expect(sidebar.getByTestId("chat-input")).toBeEnabled()
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
			expect(anomalies, `Unexpected latency anomalies: ${anomalies.join("; ")}`).toEqual([])
			for (const sample of timings) {
				expect(sample.durationMs, `${sample.name} must stay under ${sample.budgetMs}ms`).toBeLessThan(sample.budgetMs)
			}
		} finally {
			await app.close()
		}
	},
)
