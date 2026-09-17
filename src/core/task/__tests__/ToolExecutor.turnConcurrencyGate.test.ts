import type { ToolUse } from "@core/assistant-message"
import { ToolExecutor } from "@core/task/ToolExecutor"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"

/**
 * The verdict the approval policy would return for a tool.
 *
 * Paired tools answer with [inWorkspace, external]; single-scope tools answer
 * with a boolean. The gate must read each in the same shape its handler does.
 */
type ApprovalVerdict = boolean | [boolean, boolean]

/** The approval policy the gate consults, as the double provides it. */
interface ApproverDouble {
	shouldAutoApproveTool: (name: ClineDefaultTool) => ApprovalVerdict
	shouldAutoApproveToolWithPath: (name: ClineDefaultTool, path: string | undefined) => Promise<boolean>
}

/**
 * A ToolExecutor carrying only what the gate reads.
 *
 * `autoApprover` is private, so intersecting the class with a public field of
 * the same name collapses to `never`. The double is described structurally
 * instead, and the prototype method is reached through it.
 */
interface GateHarness {
	autoApprover: ApproverDouble
	isTurnFullyAutoApproved: (blocks: readonly ToolUse[]) => Promise<boolean>
}

/**
 * Build a harness around the real gate implementation.
 *
 * @param approver The approval policy to answer with.
 * @returns A harness whose gate is the production method.
 */
function createHarness(approver: ApproverDouble): GateHarness {
	const harness = Object.create(ToolExecutor.prototype) as GateHarness
	harness.autoApprover = approver
	return harness
}

/**
 * Ask the real gate whether a turn may run concurrently.
 *
 * The method is exercised on the prototype against a minimal approval double,
 * because the question under test is which policy the gate consults for each
 * tool — not how ToolExecutor is constructed. Mocking the gate itself, as the
 * turn-level tests must, cannot answer that.
 *
 * @param blocks The turn's tool blocks.
 * @param verdicts Approval verdict per tool name.
 * @param pathVerdicts Path-aware verdict per tool name, when it differs.
 * @returns Whether the gate considers the turn free of interactions.
 */
async function gateFor(
	blocks: ToolUse[],
	verdicts: Partial<Record<ClineDefaultTool, ApprovalVerdict>>,
	pathVerdicts: Partial<Record<ClineDefaultTool, boolean>> = {},
): Promise<boolean> {
	const harness = createHarness({
		shouldAutoApproveTool: (name) => verdicts[name] ?? false,
		shouldAutoApproveToolWithPath: async (name) => {
			const verdict = pathVerdicts[name] ?? verdicts[name] ?? false
			return Array.isArray(verdict) ? verdict[0] === true : verdict === true
		},
	})
	return harness.isTurnFullyAutoApproved(blocks)
}

/**
 * Build one finalized tool block.
 * @param name Tool identity.
 * @param params Parameters the assistant supplied.
 * @returns A complete block.
 */
function block(name: ClineDefaultTool, params: ToolUse["params"] = {}): ToolUse {
	return {
		type: "tool_use",
		function_id: `call-${name}`,
		dline_tid: `tid-${name}`,
		name,
		params,
		partial: false,
		ts: 1,
	}
}

describe("ToolExecutor.isTurnFullyAutoApproved", () => {
	it("admits a turn of auto-approved reads", async () => {
		const approved = await gateFor(
			[block(ClineDefaultTool.LIST_FILES, { path: "src" }), block(ClineDefaultTool.SEARCH, { path: "src" })],
			{ [ClineDefaultTool.LIST_FILES]: [true, false], [ClineDefaultTool.SEARCH]: [true, false] },
		)

		expect(approved).toBe(true)
	})

	it("admits subagents whose handler reads only the in-workspace verdict", async () => {
		// The subagent handler checks the tuple's first element alone. A gate
		// demanding both halves would keep the parallel fan-out serial, which
		// is the behaviour this whole workstream exists to provide.
		const approved = await gateFor(
			[block(ClineDefaultTool.USE_SUBAGENTS, { prompt: "a" }), block(ClineDefaultTool.USE_SUBAGENT, { task: "b" })],
			{ [ClineDefaultTool.USE_SUBAGENTS]: [true, false], [ClineDefaultTool.USE_SUBAGENT]: [true, false] },
		)

		expect(approved).toBe(true)
	})

	it("admits MCP, browser, web and image tools on their single-scope verdict", async () => {
		const tools = [
			ClineDefaultTool.MCP_USE,
			ClineDefaultTool.MCP_ACCESS,
			ClineDefaultTool.BROWSER,
			ClineDefaultTool.WEB_FETCH,
			ClineDefaultTool.WEB_SEARCH,
			ClineDefaultTool.GENERATE_IMAGE,
		]

		for (const tool of tools) {
			expect(await gateFor([block(tool)], { [tool]: true }), `${tool} approved`).toBe(true)
			expect(await gateFor([block(tool)], { [tool]: false }), `${tool} refused`).toBe(false)
		}
	})

	it("refuses tools whose handler presents its own card even when approval passes", async () => {
		// These are the dangerous ones. `shouldAutoApproveTool` returns true for
		// them precisely so the handler runs far enough to open its interaction,
		// so an approval-based gate would wave them straight into the pool and
		// the card would then be answered against a stale revision.
		const selfPresenting = [
			ClineDefaultTool.SPAWN_TASK,
			ClineDefaultTool.REPORT_BUG,
			ClineDefaultTool.STATUS_UPDATE,
			ClineDefaultTool.CHANGE_TODO_LIST,
			ClineDefaultTool.TODO,
		]

		for (const tool of selfPresenting) {
			const approved = await gateFor([block(ClineDefaultTool.LIST_FILES, { path: "src" }), block(tool)], {
				[ClineDefaultTool.LIST_FILES]: [true, false],
				[tool]: true,
			})

			expect(approved, `${tool} must not be pooled`).toBe(false)
		}
	})

	it("refuses commands, whose approval also depends on the working directory", async () => {
		// execute_command carries no path, and its handler opens a card for an
		// external workdirectory regardless of the command verdict. Until the
		// gate can answer that, a turn containing one stays serial.
		const approved = await gateFor([block(ClineDefaultTool.BASH, { command: "ls", requires_approval: "false" })], {
			[ClineDefaultTool.BASH]: [true, true],
		})

		expect(approved).toBe(false)
	})

	it("refuses turn-ending tools, which always hand control back", async () => {
		for (const tool of [ClineDefaultTool.ATTEMPT, ClineDefaultTool.ASK, ClineDefaultTool.MAKE_PLAN]) {
			expect(await gateFor([block(tool)], { [tool]: true }), `${tool} must not be pooled`).toBe(false)
		}
	})

	it("refuses a turn when any single block could ask", async () => {
		const approved = await gateFor(
			[
				block(ClineDefaultTool.LIST_FILES, { path: "src" }),
				block(ClineDefaultTool.FILE_EDIT, { path: "src/a.ts" }),
				block(ClineDefaultTool.SEARCH, { path: "src" }),
			],
			{
				[ClineDefaultTool.LIST_FILES]: [true, false],
				[ClineDefaultTool.SEARCH]: [true, false],
				[ClineDefaultTool.FILE_EDIT]: [false, false],
			},
		)

		expect(approved).toBe(false)
	})

	it("reads the file writers' path from either parameter name", async () => {
		// Standard declares `absolutePath` for write_to_file while the XML
		// projection uses `path`. Consulting only one leaves the other with no
		// path, which the approval policy reads as "outside the workspace".
		const seen: Array<string | undefined> = []
		const harness = createHarness({
			shouldAutoApproveTool: () => true,
			shouldAutoApproveToolWithPath: async (_name, path) => {
				seen.push(path)
				return true
			},
		})

		await harness.isTurnFullyAutoApproved([
			block(ClineDefaultTool.FILE_NEW, { absolutePath: "src/new.ts", content: "x" }),
			block(ClineDefaultTool.FILE_EDIT, { path: "src/edit.ts", diff: "y" }),
		])

		expect(seen).toEqual(["src/new.ts", "src/edit.ts"])
	})
})
