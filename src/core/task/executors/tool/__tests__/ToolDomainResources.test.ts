import { describe, expect, it, vi } from "vitest"
import { createToolDomainRunner, type OwnedToolResources } from "../ToolDomainResources"
import { createDeniedSurface } from "../ToolDomainSurface"
import { type ToolDomainEvent, ToolExecutionDomain } from "../ToolExecutionDomain"

function createResources(overrides: Partial<OwnedToolResources> = {}) {
	const revertDiff = vi.fn(async () => undefined)
	const cancelCommand = vi.fn(async () => undefined)
	return { revertDiff, cancelCommand, ...overrides } as OwnedToolResources & {
		revertDiff: ReturnType<typeof vi.fn>
		cancelCommand: ReturnType<typeof vi.fn>
	}
}

describe("tool domain resource release", () => {
	it("reverts the diff and cancels the command on a stop", async () => {
		const resources = createResources()
		const runner = createToolDomainRunner({ resources, execute: async () => undefined })

		await runner.release({ haltId: "halt-1", reason: "cancel" })

		expect(resources.revertDiff).toHaveBeenCalledTimes(1)
		expect(resources.cancelCommand).toHaveBeenCalledTimes(1)
	})

	it("resets exactly once per stop even when cancel is requested repeatedly", async () => {
		const resources = createResources()
		const events: ToolDomainEvent[] = []
		const domain = new ToolExecutionDomain({
			runner: createToolDomainRunner({ resources, execute: async () => undefined }),
			sink: { emit: (event) => void events.push(event) },
			surface: createDeniedSurface("detached_domain"),
		})

		const order = { haltId: "halt-1", reason: "cancel" } as const
		await Promise.all([domain.halt(order), domain.halt(order), domain.halt(order)])

		// The previous design spread this duty across the abort, interrupt,
		// terminate and provider-retry paths, where a double call reverted twice.
		expect(resources.revertDiff).toHaveBeenCalledTimes(1)
		expect(resources.cancelCommand).toHaveBeenCalledTimes(1)
		expect(events.filter((event) => event.kind === "tool.halted")).toHaveLength(1)
	})

	it("still cancels the command when reverting the diff fails", async () => {
		const resources = createResources({
			revertDiff: vi.fn(async () => {
				throw new Error("diff handle gone")
			}),
		})
		const runner = createToolDomainRunner({ resources, execute: async () => undefined })

		await runner.release({ haltId: "halt-1", reason: "terminate" })

		// One stuck handle must not strand the other resource open.
		expect(resources.cancelCommand).toHaveBeenCalledTimes(1)
	})

	it("reports a release failure without rethrowing, so the receipt still arrives", async () => {
		const failure = new Error("diff handle gone")
		const resources = createResources({
			revertDiff: vi.fn(async () => {
				throw failure
			}),
		})
		const onReleaseError = vi.fn()
		const events: ToolDomainEvent[] = []
		const domain = new ToolExecutionDomain({
			runner: createToolDomainRunner({ resources, execute: async () => undefined, onReleaseError }),
			sink: { emit: (event) => void events.push(event) },
			surface: createDeniedSurface("detached_domain"),
		})

		await domain.halt({ haltId: "halt-1", reason: "terminate" })

		expect(onReleaseError).toHaveBeenCalledWith(failure, expect.objectContaining({ haltId: "halt-1" }))
		expect(events).toEqual([{ kind: "tool.halted", haltId: "halt-1" }])
	})

	it("routes block execution to the injected executor", async () => {
		const execute = vi.fn(async () => undefined)
		const runner = createToolDomainRunner({ resources: createResources(), execute })

		await runner.runBlock({ commandId: "cmd-1", dlineTid: "tid-a", turnId: "turn-1", mode: "serial" })

		expect(execute).toHaveBeenCalledWith(expect.objectContaining({ dlineTid: "tid-a", mode: "serial" }))
	})
})
