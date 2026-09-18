import { readdir, readFile } from "node:fs/promises"
import * as path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

/**
 * Production traces (tasks 1788021574485 and 1788057524023) each recorded one interrupted
 * assistant message holding thousands of `redacted_thinking` blocks — 5.28 MB and 2.99 MB
 * respectively. Compaction then failed terminally, because a single logical turn cannot be split.
 *
 * The Responses API streams one reasoning item as an in-progress `response.output_item.added`
 * snapshot whose `encrypted_content` may still be incomplete, followed by the authoritative
 * `response.output_item.done` item. Recording every snapshot as a separate block persists the same
 * reasoning item many times over.
 *
 * This test streams a realistic snapshot/done sequence and asserts that each reasoning item is
 * persisted exactly once, carrying the authoritative payload.
 */

const ENCRYPTED_REASONING_ITEM_COUNT = 12
const ENCRYPTED_REASONING_SNAPSHOTS_PER_ITEM = 20
const ENCRYPTED_REASONING_CHUNK_SIZE = 1_292

async function selectProfile(sidebar: Frame, profileName: string): Promise<void> {
	const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
	if ((await modelSwitcher.innerText()).trim() === profileName) return
	await modelSwitcher.click()
	await expect(sidebar.getByText("Available Models", { exact: true })).toBeVisible()
	const profileOption = sidebar.getByRole("option").filter({ has: sidebar.getByText(profileName, { exact: true }) })
	await expect(profileOption).toHaveCount(1)
	await profileOption.click()
	await expect(modelSwitcher).toHaveText(profileName)
	await expect(sidebar.getByText("Available Models", { exact: true })).not.toBeVisible()
}

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

async function onlyTaskId(dlineDocsDir: string): Promise<string> {
	const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true })
	const taskIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
	if (taskIds.length !== 1 || !taskIds[0]) {
		throw new Error(`Expected exactly one persisted task, found ${taskIds.length}`)
	}
	return taskIds[0]
}

interface RedactedBlock {
	readonly type: string
	readonly data?: string
	readonly provider_metadata?: { response_id?: string }
}

interface PersistedAssistantBlockStats {
	readonly maxRedactedBlocksInOneMessage: number
	readonly maxMessageBytes: number
	readonly distinctResponseIds: number
	readonly duplicatedResponseIds: number
	readonly truncatedPayloads: number
}

function readAssistantBlockStats(apiHistory: string, expectedPayload: string): PersistedAssistantBlockStats {
	let maxRedactedBlocksInOneMessage = 0
	let maxMessageBytes = 0
	let distinctResponseIds = 0
	let duplicatedResponseIds = 0
	let truncatedPayloads = 0

	for (const line of apiHistory.split("\n")) {
		if (!line.trim()) continue
		const message = JSON.parse(line) as { role?: string; content?: unknown }
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue

		const redactedBlocks = message.content.filter(
			(block): block is RedactedBlock =>
				typeof block === "object" && block !== null && (block as { type?: unknown }).type === "redacted_thinking",
		)
		if (redactedBlocks.length > maxRedactedBlocksInOneMessage) {
			maxRedactedBlocksInOneMessage = redactedBlocks.length
			const responseIds = redactedBlocks.map((block) => block.provider_metadata?.response_id ?? "unknown")
			distinctResponseIds = new Set(responseIds).size
			duplicatedResponseIds = responseIds.length - distinctResponseIds
			truncatedPayloads = redactedBlocks.filter((block) => block.data !== expectedPayload).length
		}
		maxMessageBytes = Math.max(maxMessageBytes, Buffer.byteLength(line, "utf8"))
	}

	return {
		maxRedactedBlocksInOneMessage,
		maxMessageBytes,
		distinctResponseIds,
		duplicatedResponseIds,
		truncatedPayloads,
	}
}

e2e(
	"Reasoning persistence - one interrupted Responses turn must not persist unbounded encrypted reasoning blocks",
	async ({ dlineDocsDir, helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(240_000)
		await helper.signin(sidebar)
		await selectProfile(sidebar, E2E_PROFILE_NAMES.mockOpenAiResponses)
		server.resetOpenAiMock()

		const streamingMarker = "E2E_ENCRYPTED_REASONING_STREAMING"
		const expectedPayload = "E".repeat(ENCRYPTED_REASONING_CHUNK_SIZE)
		server.enqueueResponses("openai-compatible-responses", {
			type: "tool",
			id: "call_encrypted_reasoning_never_delivered",
			name: "attempt_completion",
			arguments: { result: "E2E_ENCRYPTED_REASONING_TOOL_MUST_NOT_RENDER" },
			reasoning: streamingMarker,
			encryptedReasoningItemCount: ENCRYPTED_REASONING_ITEM_COUNT,
			encryptedReasoningChunkSize: ENCRYPTED_REASONING_CHUNK_SIZE,
			encryptedReasoningSnapshotsPerItem: ENCRYPTED_REASONING_SNAPSHOTS_PER_ITEM,
			// Hold the stream open so the test can cancel while reasoning is still in flight,
			// exactly as the production trace was interrupted.
			afterEncryptedReasoningHoldMs: 60_000,
		})

		await sendTask(sidebar, "E2E_ENCRYPTED_REASONING_TASK")
		await expect(sidebar.getByText(streamingMarker, { exact: false })).toHaveCount(1, { timeout: 60_000 })
		await expect.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 60_000 }).toBe(1)

		const taskFooter = sidebar.getByRole("contentinfo")
		const cancelButton = taskFooter.getByText("Cancel", { exact: true })
		await expect(cancelButton).toBeVisible({ timeout: 30_000 })
		await cancelButton.click()
		await expect(taskFooter.getByText("Resume", { exact: true })).toBeVisible({ timeout: 60_000 })

		const taskId = await onlyTaskId(dlineDocsDir)
		const apiPath = path.join(dlineDocsDir, "tasks", taskId, "api_conversation_history.jsonl")
		await expect
			.poll(async () => (await readFile(apiPath, "utf8")).includes("Response interrupted by user"), { timeout: 60_000 })
			.toBe(true)
		// Allow any trailing durable write to settle before measuring the persisted record.
		await expect
			.poll(async () => readAssistantBlockStats(await readFile(apiPath, "utf8"), expectedPayload).maxMessageBytes, {
				timeout: 15_000,
			})
			.toBeGreaterThan(0)

		const stats = readAssistantBlockStats(await readFile(apiPath, "utf8"), expectedPayload)

		// Each reasoning item must be persisted exactly once, with its authoritative payload.
		expect(stats.duplicatedResponseIds).toBe(0)
		expect(stats.truncatedPayloads).toBe(0)
		expect(stats.maxRedactedBlocksInOneMessage).toBe(ENCRYPTED_REASONING_ITEM_COUNT)
		expect(stats.distinctResponseIds).toBe(ENCRYPTED_REASONING_ITEM_COUNT)

		// The persisted message must not scale with the number of in-progress snapshots.
		expect(stats.maxMessageBytes).toBeLessThan(ENCRYPTED_REASONING_ITEM_COUNT * ENCRYPTED_REASONING_CHUNK_SIZE * 2)

		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		void page
	},
)
