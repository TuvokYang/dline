import { readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect } from "@playwright/test"

const TARGET_FILE = "e2e-line-match.ts"

const ORIGINAL = [
	"export function alpha(value: number): number {",
	"  const doubled = value * 2",
	"  const tripled = value * 3",
	"  return doubled + tripled",
	"}",
	"",
	"export function beta(): string {",
	'  return "beta"',
	"}",
	"",
].join("\n")

const EXPECTED = [
	"export function alpha(value: number): number {",
	"  return value * 5",
	"}",
	"",
	"export function beta(): string {",
	'  return "beta"',
	"}",
	"",
].join("\n")

/** A SEARCH head given only as a line prefix, a SKIP range, and a one-line tail. */
const PREFIX_SKIP_DIFF = [
	"------- SEARCH",
	"export function alpha",
	"....... SKIP",
	"}",
	"=======",
	"export function alpha(value: number): number {",
	"  return value * 5",
	"}",
	"+++++++ REPLACE",
].join("\n")

/** A leading-indentation prefix that now starts two lines, one per function. */
const AMBIGUOUS_DIFF = ["------- SEARCH", "  return", "=======", "  return 0", "+++++++ REPLACE"].join("\n")

e2e(
	"replace_in_file applies a line-prefix SKIP range and rejects an ambiguous SEARCH block",
	async ({ helper, server, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		const filePath = path.join(workspaceDir, TARGET_FILE)
		await writeFile(filePath, ORIGINAL, "utf8")
		const readTarget = () =>
			readFile(filePath, "utf8")
				.then((text) => text.replaceAll("\r\n", "\n"))
				.catch(() => "")

		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_prefix_skip",
				name: "replace_in_file",
				arguments: { path: TARGET_FILE, diff: PREFIX_SKIP_DIFF },
			},
			{
				type: "tool",
				id: "call_ambiguous",
				name: "replace_in_file",
				arguments: { path: TARGET_FILE, diff: AMBIGUOUS_DIFF },
				expectedToolResults: [
					{
						callId: "call_prefix_skip",
						contentIncludes: [
							"successfully replaced",
							"replaced original lines 1-5, including 3 lines inside the SKIP range",
						],
					},
				],
			},
			{
				type: "tool",
				id: "call_line_match_done",
				name: "attempt_completion",
				arguments: { result: "E2E_LINE_MATCH_OK" },
				expectedToolResults: [
					{
						callId: "call_ambiguous",
						contentIncludes: ["SEARCH content matches 2 locations", "starting at lines 2, 6"],
					},
				],
			},
		)

		const input = sidebar.getByTestId("chat-input")
		await input.fill("Shorten alpha, then try an ambiguous edit.")
		await sidebar.getByTestId("send-button").click()

		const approveButton = sidebar.getByText("Approve", { exact: true })
		await expect(approveButton).toBeVisible({ timeout: 60_000 })
		await approveButton.click()
		await expect.poll(readTarget, { timeout: 30_000 }).toBe(EXPECTED)

		// Matching runs after admission, so the ambiguous edit is approved too and
		// must still be rejected without touching the file.
		await expect.poll(() => server.getMockConsumptions().length, { timeout: 60_000 }).toBeGreaterThanOrEqual(2)
		await expect(approveButton).toBeVisible({ timeout: 60_000 })
		await approveButton.click()

		await expect(sidebar.getByText("E2E_LINE_MATCH_OK", { exact: false }).first()).toBeVisible({ timeout: 60_000 })

		// The ambiguous block must leave the file exactly as the first edit wrote it.
		expect(await readTarget()).toBe(EXPECTED)
		const consumptions = server.getMockConsumptions()
		expect(consumptions.map((entry) => entry.toolName)).toEqual(["replace_in_file", "replace_in_file", "attempt_completion"])
		expect(consumptions.every((entry) => entry.contractError === undefined)).toBe(true)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)
