import { expect, type Frame } from "@playwright/test"
import type { ClineApiServerMock } from "../../fixtures/server"

/**
 * Parallel subagent review scripted against the mock provider.
 *
 * Shared by the marketplace recording and the documentation recording so both
 * show the same three child tasks with staggered completions.
 */
export const PARENT_TASK = "Review three release tracks in parallel and summarize the findings."
export const PARENT_RESULT = "Parallel review complete: interface, mock coverage, and release timing are ready."
export const SUBAGENT_ITEMS = [
	{
		task: "Check interface readiness.",
		context: "Read the safe workspace overview.",
		tool: "read_file",
		arguments: { path: "README.md" },
		resultMarker: "# Test Workspace",
		result: "Interface review complete.",
		delayMs: 13_000,
	},
	{
		task: "Check mock coverage.",
		context: "Read the safe workspace page.",
		tool: "read_file",
		arguments: { path: "index.html" },
		resultMarker: "<title>Test Workspace</title>",
		result: "Mock coverage review complete.",
		delayMs: 14_500,
	},
	{
		task: "Check release timing.",
		context: "List the safe workspace root.",
		tool: "list_files",
		arguments: { path: ".", recursive: false },
		resultMarker: "README.md",
		result: "Release timing review complete.",
		delayMs: 16_000,
	},
] as const

/** One parent call, one tool call per child, one delayed completion per child, then the parent completion. */
const REQUESTS_BEFORE_CHILD_COMPLETIONS = 1 + 2 * SUBAGENT_ITEMS.length

export function enqueueSubagentReview(server: ClineApiServerMock): void {
	server.resetOpenAiMock()
	server.enqueueOpenAiResponses(
		{
			type: "tool",
			id: "call_r5_use_subagents",
			name: "use_subagents",
			arguments: {
				subagents: SUBAGENT_ITEMS.map((item) => ({ task: item.task, context: item.context })),
				timeout: 120,
			},
			expectedRequestIncludes: [PARENT_TASK],
		},
		...SUBAGENT_ITEMS.map((item, index) => ({
			type: "tool" as const,
			id: `call_r5_child_read_${index + 1}`,
			name: item.tool,
			arguments: item.arguments,
			reasoning: `Reviewing release track ${index + 1}.`,
			usage: { inputTokens: 700 + index * 100, outputTokens: 70 + index * 10 },
			matchRequestContract: true,
			expectedRequestIncludes: [item.task, item.context],
			expectedToolResultCount: 0,
			requireCompleteToolPairing: true,
		})),
		...SUBAGENT_ITEMS.map((item, index) => ({
			type: "tool" as const,
			id: `call_r5_child_complete_${index + 1}`,
			name: "attempt_completion",
			arguments: { result: item.result },
			reasoning: `Release track ${index + 1} is ready.`,
			usage: { inputTokens: 900 + index * 100, outputTokens: 90 + index * 10 },
			delayMs: item.delayMs,
			matchRequestContract: true,
			expectedRequestIncludes: [item.task, item.context],
			expectedToolResultCount: 1,
			expectedToolResults: [
				{
					callId: `call_r5_child_read_${index + 1}`,
					contentIncludes: item.resultMarker,
				},
			],
			requireCompleteToolPairing: true,
		})),
		{
			type: "tool",
			id: "call_r5_parent_complete",
			name: "attempt_completion",
			arguments: { result: PARENT_RESULT },
			matchRequestContract: true,
			expectedToolResultCount: 1,
			expectedToolResults: [
				{
					callId: "call_r5_use_subagents",
					contentIncludes: [
						"Subagent results:",
						"Total: 3",
						"Succeeded: 3",
						...SUBAGENT_ITEMS.map((item) => item.result),
					],
				},
			],
			requireCompleteToolPairing: true,
		},
	)
}

/**
 * Send the parent task, approve the delegation when asked, and wait until every
 * child is waiting on its delayed completion so the recording starts mid-run.
 */
export async function startSubagentReview(sidebar: Frame, server: ClineApiServerMock): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await input.fill(PARENT_TASK)
	await input.press("Enter")
	await expect(input).toHaveValue("")

	const approveButton = sidebar.getByText("Approve", { exact: true })
	const firstChildTask = sidebar.getByText(SUBAGENT_ITEMS[0].task, { exact: true }).last()
	await expect(approveButton.or(firstChildTask)).toBeVisible({ timeout: 60_000 })
	if (await approveButton.isVisible()) await approveButton.click()
	await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(REQUESTS_BEFORE_CHILD_COMPLETIONS)
}
