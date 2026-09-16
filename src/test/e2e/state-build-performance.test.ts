import { appendFile, readdir, readFile } from "node:fs/promises"
import * as path from "node:path"
import { expect, type Frame } from "@playwright/test"
import { E2ETestHelper, e2e } from "./utils/helpers"

const TASK_TEXT = "E2E_STATE_BUILD_PERF_TASK"
const TURN_1_DONE = "E2E_STATE_BUILD_PERF_TURN_1_DONE"

// Conversation-intensity tiers: cumulative API request pairs appended to
// ui_messages.jsonl. Doubling message volume must not push state building
// into quadratic territory (the log shows 900-2500ms per push at scale).
// The tiers go beyond the vitest 8K baseline because the full buildState path
// (combineCommandSequences + combineApiRequests + api metrics + serialization)
// needs ~32K pairs to reach the ~500ms pathological cost of the field logs.
const TIER_PAIRS = [4_000, 16_000, 32_000]

e2e.use({ stateBuildTimingLogs: true })

interface TierSample {
	tier: number
	pairs: number
	durationsMs: number[]
	maxMs: number
}

const STATE_BUILD_LOG_PATTERN =
	/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) \[debug\] \[StateUpdate\] build timing: taskId=(\d+), buildMs=(\d+), activeTasks=\d+$/

/** Extract getStateToPostToWebview durations logged at or after sinceMs for one task. */
function parseStateBuildDurations(output: string, taskId: string, sinceMs: number): number[] {
	const durations: number[] = []
	for (const line of output.split(/\r?\n/)) {
		const match = STATE_BUILD_LOG_PATTERN.exec(line)
		if (!match) continue
		if (match[2] !== taskId) continue
		const timestampMs = new Date(match[1]!.replace(" ", "T")).getTime()
		if (timestampMs < sinceMs) continue
		durations.push(Number(match[3]))
	}
	return durations
}

/** Append N api_req_started/api_req_finished pairs with unique timestamps. */
async function appendApiRequestPairs(dlineDocsDir: string, taskId: string, pairCount: number): Promise<void> {
	const messagesPath = path.join(dlineDocsDir, "tasks", taskId, "ui_messages.jsonl")
	const persisted = await readFile(messagesPath, "utf8")
	let maxTs = 0
	for (const line of persisted.split(/\r?\n/)) {
		if (!line.trim()) continue
		const message = JSON.parse(line) as { ts?: unknown }
		if (typeof message.ts === "number") maxTs = Math.max(maxTs, message.ts)
	}
	const lines: string[] = []
	for (let i = 0; i < pairCount; i++) {
		const ts = maxTs + i * 2 + 1
		// Realistic message payloads: the field logs show ~226KB per 1000 messages,
		// i.e. each api_req_started/finished pair carries tokens, cost, model and
		// request metadata comparable to the persisted production shape.
		lines.push(
			JSON.stringify({
				ts,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					requestId: `req_${ts}`,
					modelId: "dline-e2e-model",
					provider: "openai",
					tokensIn: 3312,
					tokensOut: 217,
					cacheReads: 123456,
					cost: 0.018179,
					mode: "act",
				}),
			}),
		)
		lines.push(
			JSON.stringify({
				ts: ts + 1,
				type: "say",
				say: "api_req_finished",
				text: JSON.stringify({
					requestId: `req_${ts}`,
					cost: 0.018179,
					totalTokensIn: 3312,
					totalTokensOut: 217,
				}),
			}),
		)
	}
	const separator = persisted.length > 0 && !persisted.endsWith("\n") ? "\n" : ""
	await appendFile(messagesPath, `${separator}${lines.join("\n")}\n`, "utf8")
}

async function closeCurrentTask(sidebar: Frame): Promise<void> {
	const closeButton = sidebar.getByRole("button", { name: "Close Task", exact: true })
	await expect(closeButton).toBeVisible()
	await closeButton.click()
	await expect(sidebar.getByTestId("chat-input")).toBeVisible()
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
}

async function reopenTask(sidebar: Frame, taskText: string): Promise<void> {
	const historyTask = sidebar.getByText(taskText, { exact: true }).last()
	await expect(historyTask).toBeVisible({ timeout: 30_000 })
	await historyTask.click()
	await expect(sidebar.getByText(taskText, { exact: true }).first()).toBeVisible()
}

e2e(
	"State build performance - getStateToPostToWebview stays bounded as conversation intensity grows",
	async ({ dlineDocsDir, helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)

		// Create one real task so the directory structure and task history are canonical.
		server.resetOpenAiMock()
		server.enqueueResponses(
			"openai-compatible-chat",
			{
				type: "message",
				text: TURN_1_DONE,
			},
			// The mock provider emits one user turn and one assistant turn per submit;
			// keep the queue stocked so the second request never hits a 500.
			{
				type: "message",
				text: TURN_1_DONE,
			},
		)
		await sidebar.getByTestId("chat-input").fill(TASK_TEXT)
		await sidebar.getByTestId("send-button").click()
		await expect(sidebar.getByText(TURN_1_DONE, { exact: false }).last()).toBeVisible({ timeout: 60_000 })

		const taskId = await E2ETestHelper.waitForValue(async () => {
			const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true })
			const ids = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
			return ids.length === 1 ? ids[0] : undefined
		}, 30_000)
		if (!taskId) throw new Error("E2E state-build task directory was not created")

		// Grow the conversation in tiers: close, append API request pairs, reopen.
		// Each reopen reloads ui_messages.jsonl from disk and rebuilds extension state,
		// which is where the per-message cost shows up in the Dline Output log.
		const samples: TierSample[] = []
		let appendedPairs = 0
		for (const tierPairs of TIER_PAIRS) {
			await closeCurrentTask(sidebar)
			await appendApiRequestPairs(dlineDocsDir, taskId, tierPairs - appendedPairs)
			appendedPairs = tierPairs

			// Reopening a task resumes the conversation, which can trigger an extra
			// API request; stock the queue so it never hits a 500.
			server.enqueueResponses(
				"openai-compatible-chat",
				{ type: "message", text: TURN_1_DONE },
				{ type: "message", text: TURN_1_DONE },
			)

			const sinceMs = Date.now()
			await reopenTask(sidebar, TASK_TEXT)
			// This test enables the E2E-only state-build timing mirror, so every
			// completed build is logged without changing the production 100ms slow
			// operation threshold. Requiring a real sample prevents a vacuous pass.
			const durationsMs = await E2ETestHelper.waitForValue(async () => {
				const output = E2ETestHelper.readDlineOutputIfPresent(userDataDir)
				if (!output) return undefined
				const parsed = parseStateBuildDurations(output, taskId, sinceMs)
				return parsed.length > 0 ? parsed : undefined
			}, 15_000)
			samples.push({
				tier: samples.length + 1,
				pairs: tierPairs,
				durationsMs,
				maxMs: durationsMs.length > 0 ? Math.max(...durationsMs) : 0,
			})
		}

		await e2e.info().attach("state-build-durations.json", {
			body: Buffer.from(JSON.stringify(samples, null, 2), "utf8"),
			contentType: "application/json",
		})

		const last = samples.at(-1)!
		// GREEN contract: even at the largest tier, every observed state build
		// stays under the ~500ms pathological bar seen in the field (900-2500ms).
		// The pre-fix code exceeded 500ms here (measured 1794ms).
		expect(last.maxMs, `largest tier (${last.pairs} pairs) must stay under 500ms per state build`).toBeLessThan(500)
		for (const sample of samples) {
			expect(sample.durationsMs.length, `tier ${sample.pairs} pairs must produce state build samples`).toBeGreaterThan(0)
			expect(sample.maxMs, `tier ${sample.pairs} pairs must stay under 500ms per state build`).toBeLessThan(500)
		}
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [
			/e2e_mock_queue_exhausted/i,
			/No scripted E2E response remains/i,
			/Dline instance aborted/i,
		])
	},
)
