import { describe, expect, it, vi } from "vitest"
import { createDeniedSurface, requireUserFacing, SurfaceDeniedError, type UserFacingSurface } from "../ToolDomainSurface"
import {
	type HaltOrder,
	type ToolDomainEvent,
	type ToolDomainRunner,
	ToolExecutionDomain,
	type ToolRunCommand,
} from "../ToolExecutionDomain"

/** A runner whose every block can be settled by the test at will. */
function createControllableRunner() {
	const gates = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
	const released: HaltOrder[] = []
	let releaseCount = 0

	const runner: ToolDomainRunner = {
		runBlock: (command) =>
			new Promise<void>((resolve, reject) => {
				gates.set(command.dlineTid, { resolve, reject })
			}),
		release: async (order) => {
			releaseCount += 1
			released.push(order)
		},
	}

	return {
		runner,
		released,
		get releaseCount() {
			return releaseCount
		},
		settle(dlineTid: string) {
			gates.get(dlineTid)?.resolve()
		},
		fail(dlineTid: string, message: string) {
			gates.get(dlineTid)?.reject(new Error(message))
		},
		isPending(dlineTid: string) {
			return gates.has(dlineTid)
		},
	}
}

function createSink() {
	const events: ToolDomainEvent[] = []
	return { events, sink: { emit: (event: ToolDomainEvent) => void events.push(event) } }
}

function userFacingSurface(): UserFacingSurface {
	return {
		kind: "user_facing",
		ask: async () => undefined,
		say: async () => undefined,
		openInteraction: async () => undefined,
		diff: () => ({}),
	}
}

function command(dlineTid: string, overrides: Partial<ToolRunCommand> = {}): ToolRunCommand {
	return { commandId: `cmd-${dlineTid}`, turnId: "turn-1", dlineTid, mode: "parallel", ...overrides }
}

/** Let the microtask queue drain so settled promises reach their handlers. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("ToolExecutionDomain command contract", () => {
	it("returns from handle before the block settles", async () => {
		const { runner, isPending } = createControllableRunner()
		const { events, sink } = createSink()
		const domain = new ToolExecutionDomain({ runner, sink, surface: userFacingSurface() })

		domain.handle(command("tid-a"))

		// handle is synchronous: the block is still running and nothing was emitted.
		expect(isPending("tid-a")).toBe(true)
		expect(events).toEqual([])
		expect(domain.inFlightCount).toBe(1)
	})

	it("reports a completed block as an event carrying its causal identity", async () => {
		const controllable = createControllableRunner()
		const { events, sink } = createSink()
		const domain = new ToolExecutionDomain({ runner: controllable.runner, sink, surface: userFacingSurface() })

		domain.handle(command("tid-a"))
		controllable.settle("tid-a")
		await flush()

		expect(events).toEqual([{ kind: "tool.block_result", commandId: "cmd-tid-a", turnId: "turn-1", dlineTid: "tid-a" }])
		expect(domain.inFlightCount).toBe(0)
	})

	it("reports a thrown block as a failure event rather than letting it escape", async () => {
		const controllable = createControllableRunner()
		const { events, sink } = createSink()
		const domain = new ToolExecutionDomain({ runner: controllable.runner, sink, surface: userFacingSurface() })

		domain.handle(command("tid-a"))
		controllable.fail("tid-a", "disk offline")
		await flush()

		expect(events).toEqual([
			{
				kind: "tool.block_failed",
				commandId: "cmd-tid-a",
				turnId: "turn-1",
				dlineTid: "tid-a",
				message: "disk offline",
				// The original error travels with the event so the runtime can
				// reject with it and keep the stack the direct call once had.
				cause: expect.any(Error),
			},
		])
		expect((events[0] as { cause?: Error }).cause?.message).toBe("disk offline")
	})

	it("carries the reducer's scheduling decision instead of deriving it", async () => {
		const controllable = createControllableRunner()
		const { sink } = createSink()
		const runBlock = vi.spyOn(controllable.runner, "runBlock")
		const domain = new ToolExecutionDomain({ runner: controllable.runner, sink, surface: userFacingSurface() })

		domain.handle(command("tid-a", { mode: "serial" }))

		expect(runBlock).toHaveBeenCalledWith(expect.objectContaining({ mode: "serial", turnId: "turn-1" }))
	})

	it("accepts a batch of blocks concurrently when the reducer dispatched one", async () => {
		const controllable = createControllableRunner()
		const { events, sink } = createSink()
		const domain = new ToolExecutionDomain({ runner: controllable.runner, sink, surface: userFacingSurface() })

		domain.handle(command("tid-a"))
		domain.handle(command("tid-b"))
		domain.handle(command("tid-c"))

		expect(domain.inFlightCount).toBe(3)

		// Completion order need not match dispatch order.
		controllable.settle("tid-c")
		controllable.settle("tid-a")
		await flush()

		expect(events.map((event) => "dlineTid" in event && event.dlineTid)).toEqual(["tid-c", "tid-a"])
	})
})

describe("ToolExecutionDomain halt contract", () => {
	it("emits the receipt only after in-flight work has drained", async () => {
		const controllable = createControllableRunner()
		const { events, sink } = createSink()
		const domain = new ToolExecutionDomain({ runner: controllable.runner, sink, surface: userFacingSurface() })

		domain.handle(command("tid-a"))
		const halted = domain.halt({ haltId: "halt-1", reason: "cancel" })

		// Still draining: no receipt yet.
		expect(events.some((event) => event.kind === "tool.halted")).toBe(false)

		controllable.settle("tid-a")
		await halted

		expect(events.at(-1)).toEqual({ kind: "tool.halted", haltId: "halt-1" })
	})

	it("drops a result produced before the stop so a halted turn cannot be resurrected", async () => {
		const controllable = createControllableRunner()
		const { events, sink } = createSink()
		const domain = new ToolExecutionDomain({ runner: controllable.runner, sink, surface: userFacingSurface() })

		domain.handle(command("tid-a"))
		const halted = domain.halt({ haltId: "halt-1", reason: "cancel" })
		controllable.settle("tid-a")
		await halted

		expect(events.filter((event) => event.kind === "tool.block_result")).toEqual([])
		expect(events).toEqual([{ kind: "tool.halted", haltId: "halt-1" }])
	})

	it("refuses a command that arrives after the stop", async () => {
		const controllable = createControllableRunner()
		const { events, sink } = createSink()
		const domain = new ToolExecutionDomain({ runner: controllable.runner, sink, surface: userFacingSurface() })

		await domain.halt({ haltId: "halt-1", reason: "cancel" })
		events.length = 0

		domain.handle(command("tid-late"))

		expect(events).toEqual([{ kind: "tool.rejected", commandId: "cmd-tid-late", dlineTid: "tid-late", reason: "halted" }])
		expect(domain.inFlightCount).toBe(0)
	})

	it("releases owned resources exactly once even when cancel is repeated", async () => {
		const controllable = createControllableRunner()
		const { sink } = createSink()
		const domain = new ToolExecutionDomain({ runner: controllable.runner, sink, surface: userFacingSurface() })

		const order: HaltOrder = { haltId: "halt-1", reason: "cancel" }
		await domain.halt(order)
		await domain.halt(order)
		await domain.halt(order)

		// This is the single-disposer guarantee that used to depend on six
		// scattered reset call sites staying correct by hand.
		expect(controllable.releaseCount).toBe(1)
	})

	it("releases again for a genuinely new stop generation", async () => {
		const controllable = createControllableRunner()
		const { sink } = createSink()
		const domain = new ToolExecutionDomain({ runner: controllable.runner, sink, surface: userFacingSurface() })

		await domain.halt({ haltId: "halt-1", reason: "cancel" })
		domain.rearm()
		await domain.halt({ haltId: "halt-2", reason: "terminate" })

		expect(controllable.releaseCount).toBe(2)
		expect(controllable.released.map((order) => order.reason)).toEqual(["cancel", "terminate"])
	})

	it("accepts work again after re-arming", async () => {
		const controllable = createControllableRunner()
		const { events, sink } = createSink()
		const domain = new ToolExecutionDomain({ runner: controllable.runner, sink, surface: userFacingSurface() })

		await domain.halt({ haltId: "halt-1", reason: "cancel" })
		domain.rearm()
		events.length = 0

		domain.handle(command("tid-next"))
		controllable.settle("tid-next")
		await flush()

		expect(events).toEqual([{ kind: "tool.block_result", commandId: "cmd-tid-next", turnId: "turn-1", dlineTid: "tid-next" }])
	})

	it("still emits the receipt when releasing resources throws", async () => {
		const controllable = createControllableRunner()
		const { events, sink } = createSink()
		vi.spyOn(controllable.runner, "release").mockRejectedValueOnce(new Error("handle already gone"))
		const domain = new ToolExecutionDomain({ runner: controllable.runner, sink, surface: userFacingSurface() })

		// A failed release must not strand the runtime waiting for a receipt.
		await expect(domain.halt({ haltId: "halt-1", reason: "terminate" })).rejects.toThrow("handle already gone")
		expect(events).toEqual([{ kind: "tool.halted", haltId: "halt-1" }])
	})
})

describe("ToolExecutionDomain rearm generation", () => {
	it("ignores a rearm naming a stop that a later one superseded", async () => {
		// Two stops can overlap: a user cancel and a checkpoint restore each halt
		// the domain. If the first caller's rearm cleared the barrier
		// unconditionally, the second stop would admit work it meant to refuse.
		const { events, sink } = createSink()
		const controllable = createControllableRunner()
		const domain = new ToolExecutionDomain({ runner: controllable.runner, sink, surface: userFacingSurface() })

		await domain.halt({ haltId: "halt-1", reason: "cancel" })
		const second = domain.halt({ haltId: "halt-2", reason: "terminate" })

		domain.rearm("halt-1")

		domain.handle(command("tid-late"))
		await flush()
		expect(events).toContainEqual(
			expect.objectContaining({ kind: "tool.rejected", commandId: "cmd-tid-late", reason: "halted" }),
		)

		await second
		domain.rearm("halt-2")
		domain.handle(command("tid-next"))
		controllable.settle("tid-next")
		await flush()
		expect(events).toContainEqual(expect.objectContaining({ kind: "tool.block_result", commandId: "cmd-tid-next" }))
	})
})

describe("ToolExecutionDomain surface capability", () => {
	it("marks an assembly without a surface as headless", () => {
		const controllable = createControllableRunner()
		const { sink } = createSink()

		const denied = new ToolExecutionDomain({
			runner: controllable.runner,
			sink,
			surface: createDeniedSurface("subagent_execution"),
		})
		const userFacing = new ToolExecutionDomain({ runner: controllable.runner, sink, surface: userFacingSurface() })

		expect(denied.isHeadless).toBe(true)
		expect(userFacing.isHeadless).toBe(false)
	})

	it("denies every UI capability by class rather than by enumerated override", () => {
		const surface = createDeniedSurface("subagent_execution")

		// The point is that no capability exists to be called, so a handler that
		// later acquires a UI need still cannot reach the main task.
		for (const capability of ["ask", "say", "openInteraction", "diff"]) {
			expect(() => requireUserFacing(surface, capability)).toThrow(SurfaceDeniedError)
		}
	})

	it("names the denied capability and reason so the failure is diagnosable", () => {
		const surface = createDeniedSurface("subagent_execution")

		try {
			requireUserFacing(surface, "ask")
			expect.unreachable("a denied surface must not yield a user-facing capability")
		} catch (error) {
			expect(error).toBeInstanceOf(SurfaceDeniedError)
			expect((error as SurfaceDeniedError).capability).toBe("ask")
			expect((error as SurfaceDeniedError).reason).toBe("subagent_execution")
		}
	})

	it("still executes tools when the surface is denied", async () => {
		const controllable = createControllableRunner()
		const { events, sink } = createSink()
		const domain = new ToolExecutionDomain({
			runner: controllable.runner,
			sink,
			surface: createDeniedSurface("subagent_execution"),
		})

		// Denying the UI must not disable the work itself: a subagent still writes.
		domain.handle(command("tid-a"))
		controllable.settle("tid-a")
		await flush()

		expect(events).toEqual([{ kind: "tool.block_result", commandId: "cmd-tid-a", turnId: "turn-1", dlineTid: "tid-a" }])
	})
})
