import { describe, expect, it } from "vitest"
import { ToolDurationScope } from "../tool-duration-scope"

/**
 * Guard for how the executor installs wait exclusion around tool callbacks.
 *
 * The wrappers live where the tool config is assembled, so every handler gets
 * the behavior without opting in. This reproduces that wiring against a scope
 * held in the same way the executor holds it, which is what keeps the guarantee
 * from silently depending on any one handler.
 */

interface Wiring {
	ask: (waitMs: number) => Promise<string>
	executeCommandTool: (waitMs: number) => Promise<string>
	work: (ms: number) => void
	read: () => ReturnType<ToolDurationScope["read"]>
}

/**
 * Mirror the executor's callback wrapping over a deterministic clock.
 *
 * The scope is read through a holder rather than captured directly, matching
 * the executor's field: a wrapper created once must follow whichever execution
 * is currently active.
 */
function createWiring(): Wiring {
	let now = 0
	const clock = () => now
	const holder: { scope: ToolDurationScope | undefined } = { scope: undefined }
	holder.scope = new ToolDurationScope(clock)

	const rawAsk = async (waitMs: number) => {
		now += waitMs
		return "approved"
	}
	const rawExecuteCommandTool = async (waitMs: number) => {
		now += waitMs
		return "command-output"
	}

	return {
		ask: (waitMs) => (holder.scope ? holder.scope.excludeWait("approval", () => rawAsk(waitMs)) : rawAsk(waitMs)),
		executeCommandTool: (waitMs) =>
			holder.scope
				? holder.scope.excludeWait("command", () => rawExecuteCommandTool(waitMs))
				: rawExecuteCommandTool(waitMs),
		work: (ms) => {
			now += ms
		},
		read: () => {
			if (!holder.scope) throw new Error("scope missing")
			return holder.scope.read()
		},
	}
}

describe("tool duration wiring", () => {
	it("excludes an approval taken through the tool callback", async () => {
		const wiring = createWiring()

		wiring.work(15)
		await expect(wiring.ask(120_000)).resolves.toBe("approved")
		wiring.work(25)

		const totals = wiring.read()
		// Two minutes of a human deciding must not be reported as tool work.
		expect(totals.elapsedMs).toBe(120_040)
		expect(totals.activeMs).toBe(40)
		expect(totals.approvalWaitMs).toBe(120_000)
	})

	it("excludes a command run through the tool callback", async () => {
		const wiring = createWiring()

		wiring.work(10)
		await expect(wiring.executeCommandTool(45_000)).resolves.toBe("command-output")
		wiring.work(10)

		const totals = wiring.read()
		expect(totals.elapsedMs).toBe(45_020)
		// A long build belongs to the workspace, not to the tool.
		expect(totals.activeMs).toBe(20)
		expect(totals.commandWaitMs).toBe(45_000)
	})

	it("excludes an approval and a command taken in the same execution", async () => {
		const wiring = createWiring()

		wiring.work(8)
		await wiring.ask(60_000)
		wiring.work(4)
		await wiring.executeCommandTool(20_000)
		wiring.work(8)

		const totals = wiring.read()
		expect(totals.elapsedMs).toBe(80_020)
		expect(totals.activeMs).toBe(20)
		expect(totals.approvalWaitMs).toBe(60_000)
		expect(totals.commandWaitMs).toBe(20_000)
	})
})
