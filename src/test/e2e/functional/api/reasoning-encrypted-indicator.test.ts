import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

/**
 * Encrypted reasoning (Responses API `encrypted_content`) carries no renderable text, so the
 * streaming UI guard used to skip it entirely: the user saw a completely idle chat while the
 * model was actively reasoning.
 *
 * The row must therefore animate on encrypted-only reasoning, never reveal the opaque payload,
 * and disappear once the turn produces real content — a contentless "Thinking" row must not
 * survive as an artifact.
 */

const ENCRYPTED_REASONING_ITEM_COUNT = 3
const ENCRYPTED_REASONING_SNAPSHOTS_PER_ITEM = 8
const ENCRYPTED_REASONING_CHUNK_SIZE = 1_292
const ENCRYPTED_PAYLOAD_PREFIX = "EEEEEEEEEEEEEEEE"

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

async function setAutoApproveAction(sidebar: Frame, label: string): Promise<void> {
	await sidebar.getByLabel("Open auto-approve settings").click()
	const checkbox = sidebar.locator("vscode-checkbox").filter({ hasText: label })
	await expect(checkbox).toHaveCount(1)
	const isChecked = () => checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))
	if (!(await isChecked())) await sidebar.getByText(label, { exact: true }).click()
	await expect.poll(isChecked).toBe(true)
	await sidebar.getByLabel("Close auto-approve settings").click()
}

e2e(
	"Reasoning indicator - encrypted-only reasoning animates without revealing its payload",
	async ({ helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(240_000)
		await helper.signin(sidebar)
		await selectProfile(sidebar, E2E_PROFILE_NAMES.mockOpenAiResponses)
		await setAutoApproveAction(sidebar, "Edit project files")
		server.resetOpenAiMock()

		// No `reasoning` field: the turn streams encrypted reasoning only, which is
		// exactly the shape that used to render nothing at all.
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_encrypted_write_one",
				name: "write_to_file",
				arguments: { path: "encrypted-checkpoint-one.txt", content: "one\n" },
				encryptedReasoningItemCount: ENCRYPTED_REASONING_ITEM_COUNT,
				encryptedReasoningChunkSize: ENCRYPTED_REASONING_CHUNK_SIZE,
				encryptedReasoningSnapshotsPerItem: ENCRYPTED_REASONING_SNAPSHOTS_PER_ITEM,
				// Hold the stream open so the indicator can be observed while reasoning is in flight.
				afterEncryptedReasoningHoldMs: 20_000,
			},
			{
				type: "tool",
				id: "call_encrypted_write_two",
				name: "write_to_file",
				arguments: { path: "encrypted-checkpoint-two.txt", content: "two\n" },
				expectedToolResults: [{ callId: "call_encrypted_write_one", contentIncludes: "successfully saved" }],
			},
			{
				type: "tool",
				id: "call_encrypted_indicator",
				name: "attempt_completion",
				arguments: { result: "E2E_ENCRYPTED_INDICATOR_DONE" },
				expectedToolResults: [{ callId: "call_encrypted_write_two", contentIncludes: "successfully saved" }],
			},
		)

		await sendTask(sidebar, "E2E_ENCRYPTED_INDICATOR_TASK")

		// The activity row must appear even though no reasoning text exists.
		const thinkingRow = sidebar.getByText("Thinking", { exact: true })
		await expect(thinkingRow).toBeVisible({ timeout: 60_000 })
		// It must animate, which is the whole point of showing a contentless row.
		await expect(thinkingRow).toHaveClass(/animate-shimmer/)

		// The opaque payload must never reach the DOM.
		await expect(sidebar.locator("body")).not.toContainText(ENCRYPTED_PAYLOAD_PREFIX)

		// Once the turn produces real content, the contentless row must not linger.
		await expect(sidebar.getByText("E2E_ENCRYPTED_INDICATOR_DONE", { exact: false }).first()).toBeVisible({
			timeout: 120_000,
		})
		await expect(thinkingRow).toHaveCount(0, { timeout: 60_000 })
		await expect(sidebar.getByText("Thinking", { exact: true })).toHaveCount(0)
		// Both writes commit durable restore points, but one user turn must expose
		// only its initial restore baseline instead of one checkpoint row per edit.
		await expect(sidebar.getByText("Checkpoint", { exact: true })).toHaveCount(1)

		const consumptions = server.getMockConsumptions("openai-compatible-responses")
		expect(consumptions.map((consumption) => consumption.contractError)).toEqual([undefined, undefined, undefined])
		expect(consumptions.map((consumption) => consumption.toolName)).toEqual([
			"write_to_file",
			"write_to_file",
			"attempt_completion",
		])

		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		void page
	},
)
