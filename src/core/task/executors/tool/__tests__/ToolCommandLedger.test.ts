import { describe, expect, it, vi } from "vitest"
import { ToolCommandHaltedError, ToolCommandLedger } from "../ToolCommandLedger"
import { createToolDomainRunner } from "../ToolDomainResources"
import { createDeniedSurface } from "../ToolDomainSurface"
import { ToolExecutionDomain } from "../ToolExecutionDomain"

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function createResources() {
	return { revertDiff: vi.fn(async () => undefined), cancelCommand: vi.fn(async () => undefined) }
}

/** A domain whose tool work is driven by the returned control handles. */
function createControllableDomain(ledger: ToolCommandLedger) {
	let settle: (() => void) | undefined
	let fail: ((error: Error) => void) | undefined
	const runner = createToolDomainRunner({
		resources: createResources(),
		execute: () =>
			new Promise<void>((resolve, reject) => {
				settle = resolve
				fail = reject
			}),
	})
	const domain = new ToolExecutionDomain({ runner, sink: ledger.sink, surface: createDeniedSurface("detached_domain") })
	return {
		domain,
		settle: () => settle?.(),
		fail: (error: Error) => fail?.(error),
	}
}

describe("ToolCommandLedger settlement", () => {
	it("keeps the caller waiting until the tool actually finishes", async () => {
		const ledger = new ToolCommandLedger()
		const { domain, settle } = createControllableDomain(ledger)

		const waiting = ledger.track("cmd-1")
		const observed: string[] = []
		void waiting.then(() => observed.push("settled"))
		domain.handle({ commandId: "cmd-1", dlineTid: "tid-1" })

		await flush()
		expect(observed).toEqual([])

		settle()
		await waiting
		expect(observed).toEqual(["settled"])
	})

	it("surfaces a tool failure as a rejection so the effect still fails", async () => {
		const ledger = new ToolCommandLedger()
		const { domain, fail } = createControllableDomain(ledger)

		const waiting = ledger.track("cmd-1")
		domain.handle({ commandId: "cmd-1", dlineTid: "tid-1" })
		fail(new Error("write refused"))

		await expect(waiting).rejects.toThrow("write refused")
		expect(ledger.pendingCount).toBe(0)
	})

	it("rethrows the original error so its identity and stack survive", async () => {
		// The old path awaited the tool directly, so TaskEffectError.cause was the
		// real error. Wrapping it in a fresh Error would silently drop the
		// subclass, stack and any custom fields diagnostics rely on.
		class ToolRefusedError extends Error {
			constructor(readonly path: string) {
				super("write refused")
				this.name = "ToolRefusedError"
			}
		}
		const ledger = new ToolCommandLedger()
		const { domain, fail } = createControllableDomain(ledger)
		const original = new ToolRefusedError("src/app.ts")

		const waiting = ledger.track("cmd-1")
		domain.handle({ commandId: "cmd-1", dlineTid: "tid-1" })
		fail(original)

		await expect(waiting).rejects.toBe(original)
	})

	it("releases every waiter when a stop never delivers its receipt", async () => {
		// A halt that exceeds its drain budget emits no receipt at all, so the
		// caller must be able to fail the waiters itself.
		const ledger = new ToolCommandLedger()
		const { domain } = createControllableDomain(ledger)

		const waiting = ledger.track("cmd-1")
		domain.handle({ commandId: "cmd-1", dlineTid: "tid-1" })
		await flush()

		ledger.releaseAll()

		await expect(waiting).rejects.toBeInstanceOf(ToolCommandHaltedError)
		expect(ledger.pendingCount).toBe(0)
	})

	it("rejects a command that arrives after the domain stopped", async () => {
		const ledger = new ToolCommandLedger()
		const { domain } = createControllableDomain(ledger)

		await domain.halt({ haltId: "halt-1", reason: "cancel" })

		const waiting = ledger.track("cmd-late")
		domain.handle({ commandId: "cmd-late", dlineTid: "tid-late" })

		await expect(waiting).rejects.toBeInstanceOf(ToolCommandHaltedError)
	})

	it("releases in-flight waiters when a halt drops their results", async () => {
		// Without this, a cancel would strand every pending block forever: the
		// domain deliberately drops pre-stop results, so no outcome event arrives.
		const ledger = new ToolCommandLedger()
		const { domain, settle } = createControllableDomain(ledger)

		const waiting = ledger.track("cmd-1")
		domain.handle({ commandId: "cmd-1", dlineTid: "tid-1" })

		const halted = domain.halt({ haltId: "halt-1", reason: "cancel" })
		settle()
		await halted

		await expect(waiting).rejects.toBeInstanceOf(ToolCommandHaltedError)
		expect(ledger.pendingCount).toBe(0)
	})

	it("settles each command independently when several are in flight", async () => {
		const ledger = new ToolCommandLedger()
		const settlers = new Map<string, () => void>()
		const runner = createToolDomainRunner({
			resources: createResources(),
			execute: (command) => new Promise<void>((resolve) => settlers.set(command.commandId, resolve)),
		})
		const domain = new ToolExecutionDomain({
			runner,
			sink: ledger.sink,
			surface: createDeniedSurface("detached_domain"),
		})

		const first = ledger.track("cmd-1")
		domain.handle({ commandId: "cmd-1", dlineTid: "tid-1", mode: "parallel" })
		const second = ledger.track("cmd-2")
		domain.handle({ commandId: "cmd-2", dlineTid: "tid-2", mode: "parallel" })

		await flush()
		expect(ledger.pendingCount).toBe(2)

		settlers.get("cmd-2")?.()
		await second
		expect(ledger.pendingCount).toBe(1)

		settlers.get("cmd-1")?.()
		await first
		expect(ledger.pendingCount).toBe(0)
	})

	it("refuses to track the same command twice", async () => {
		const ledger = new ToolCommandLedger()
		void ledger.track("cmd-1").catch(() => undefined)

		await expect(ledger.track("cmd-1")).rejects.toThrow("already being tracked")
	})
})
