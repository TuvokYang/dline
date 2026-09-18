import { describe, expect, it } from "vitest"
import { BoundedGate, GateAbortError, type GatePermit } from "../BoundedGate"

/** Resolve after the microtask queue drains, so pending admissions settle. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

describe("BoundedGate", () => {
	describe("admission bound", () => {
		it("admits at most the configured number of concurrent holders", async () => {
			const gate = new BoundedGate({ limit: 2 })

			const first = await gate.acquire()
			const second = await gate.acquire()
			expect(gate.state.running).toBe(2)

			let thirdAdmitted = false
			const third = gate.acquire().then((permit) => {
				thirdAdmitted = true
				return permit
			})

			await flush()
			expect(thirdAdmitted).toBe(false)
			expect(gate.state).toEqual({ running: 2, queued: 1, limit: 2 })

			first.release()
			await expect(third).resolves.toBeDefined()
			expect(gate.state.running).toBe(2)

			second.release()
			;(await third).release()
			expect(gate.state.running).toBe(0)
		})

		it("reports waiting work as queued rather than running", async () => {
			const gate = new BoundedGate({ limit: 1 })
			const held = await gate.acquire()

			const waiting = gate.acquire()
			await flush()

			expect(gate.state.running).toBe(1)
			expect(gate.state.queued).toBe(1)

			held.release()
			;(await waiting).release()
			expect(gate.state).toEqual({ running: 0, queued: 0, limit: 1 })
		})

		it("does not deadlock when a holder throws", async () => {
			const gate = new BoundedGate({ limit: 1 })

			await expect(
				gate.run(async () => {
					throw new Error("handler failed")
				}),
			).rejects.toThrow("handler failed")

			expect(gate.state.running).toBe(0)
			await expect(gate.run(async () => "recovered")).resolves.toBe("recovered")
		})

		it("keeps two independently constructed gates from sharing capacity", async () => {
			const toolGate = new BoundedGate({ limit: 1, name: "tool" })
			const subagentGate = new BoundedGate({ limit: 1, name: "subagent" })

			const toolPermit = await toolGate.acquire()
			// Saturating one pool must not make the other refuse work; that is
			// the whole reason the limits are separate settings.
			const subagentPermit = await subagentGate.acquire()

			expect(toolGate.state.running).toBe(1)
			expect(subagentGate.state.running).toBe(1)

			toolPermit.release()
			expect(subagentGate.state.running).toBe(1)
			subagentPermit.release()
		})

		it("admits nobody when the limit is zero", async () => {
			const gate = new BoundedGate({ limit: 0 })
			let admitted = false
			void gate.acquire().then(() => {
				admitted = true
			})

			await flush()
			expect(admitted).toBe(false)
			expect(gate.state.queued).toBe(1)
		})
	})

	describe("permit release", () => {
		it("releases only when the admitted work has stopped", async () => {
			const gate = new BoundedGate({ limit: 1 })

			// A runner that returns while its abandoned work continues. Releasing
			// on the returned promise would report free capacity that the still
			// running work is holding.
			let stopWork: () => void = () => {}
			const workStopped = new Promise<void>((resolve) => {
				stopWork = resolve
			})

			const permit = await gate.acquire()
			const runnerReturned = Promise.resolve("abandoned")
			await runnerReturned

			expect(gate.state.running).toBe(1)

			let replacementAdmitted = false
			void gate.acquire().then(() => {
				replacementAdmitted = true
			})
			await flush()
			expect(replacementAdmitted).toBe(false)

			stopWork()
			await workStopped
			permit.release()

			await flush()
			expect(replacementAdmitted).toBe(true)
		})

		it("ignores a repeated release so capacity is not double counted", async () => {
			const gate = new BoundedGate({ limit: 2 })
			const permit = await gate.acquire()

			permit.release()
			permit.release()
			permit.release()

			expect(gate.state.running).toBe(0)
		})

		it("releases the permit when run() settles", async () => {
			const gate = new BoundedGate({ limit: 1 })
			await gate.run(async () => {
				expect(gate.state.running).toBe(1)
			})
			expect(gate.state.running).toBe(0)
		})
	})

	describe("dynamic limit", () => {
		it("admits queued work on a raise without an unrelated completion", async () => {
			let limit = 1
			const gate = new BoundedGate({ limit: () => limit })

			const held = await gate.acquire()
			let secondAdmitted = false
			void gate.acquire().then(() => {
				secondAdmitted = true
			})

			await flush()
			expect(secondAdmitted).toBe(false)

			limit = 2
			gate.notifyLimitChanged()
			await flush()

			// Nothing completed; the raise alone admitted the waiter.
			expect(secondAdmitted).toBe(true)
			expect(gate.state.running).toBe(2)
			held.release()
		})

		it("stops new admission on a lower limit without aborting running work", async () => {
			let limit = 3
			const gate = new BoundedGate({ limit: () => limit })

			const permits: GatePermit[] = [await gate.acquire(), await gate.acquire(), await gate.acquire()]
			expect(gate.state.running).toBe(3)

			limit = 1
			gate.notifyLimitChanged()

			// Running work keeps its permit; its side effects have begun.
			expect(gate.state.running).toBe(3)

			let admittedAfterDrop = false
			void gate.acquire().then(() => {
				admittedAfterDrop = true
			})

			permits[0].release()
			await flush()
			expect(admittedAfterDrop).toBe(false)
			expect(gate.state.running).toBe(2)

			permits[1].release()
			permits[2].release()
			await flush()
			// Admission resumes only once running work falls below the new limit.
			expect(admittedAfterDrop).toBe(true)
		})

		it("admits queued holders in arrival order", async () => {
			const gate = new BoundedGate({ limit: 1 })
			const held = await gate.acquire()
			const admitted: string[] = []

			const waiters = ["first", "second", "third"].map((label) =>
				gate.acquire().then((permit) => {
					admitted.push(label)
					return permit
				}),
			)

			await flush()
			held.release()

			for (const waiter of waiters) {
				const permit = await waiter
				permit.release()
			}

			// A steady arrival stream cannot starve the oldest waiter.
			expect(admitted).toEqual(["first", "second", "third"])
		})

		it("does not let a new arrival take capacity an older waiter is owed", async () => {
			let limit = 1
			const gate = new BoundedGate({ limit: () => limit })
			const held = await gate.acquire()

			const order: string[] = []
			const older = gate.acquire().then((permit) => {
				order.push("older")
				return permit
			})
			await flush()

			// The limit rises, but nothing drains the queue yet — this models a
			// setting change observed by a new caller before the owner of the
			// setting notifies the gate.
			limit = 2
			const newcomer = gate.acquire().then((permit) => {
				order.push("newcomer")
				return permit
			})
			await flush()

			// The older waiter is admitted first; the newcomer queues behind it
			// rather than consuming the slot that just appeared.
			expect(order).toEqual(["older"])

			held.release()
			await flush()
			expect(order).toEqual(["older", "newcomer"])
			;(await older).release()
			;(await newcomer).release()
		})

		it("admits a queued waiter when capacity already exists at arrival", async () => {
			// Queue-first must not become wait-forever: a waiter enqueued while
			// free capacity exists has to be drained immediately.
			let limit = 1
			const gate = new BoundedGate({ limit: () => limit })
			const held = await gate.acquire()

			const first = gate.acquire()
			await flush()
			expect(gate.state.queued).toBe(1)

			limit = 3
			const second = gate.acquire()

			await expect(first).resolves.toBeDefined()
			await expect(second).resolves.toBeDefined()
			expect(gate.state.queued).toBe(0)
			held.release()
			;(await first).release()
			;(await second).release()
		})

		it("treats a non-finite limit as zero rather than unbounded", async () => {
			const gate = new BoundedGate({ limit: () => Number.NaN })
			expect(gate.limit).toBe(0)

			let admitted = false
			void gate.acquire().then(() => {
				admitted = true
			})
			await flush()
			expect(admitted).toBe(false)
		})
	})

	describe("withheld capacity", () => {
		it("lowers the effective limit while abandoned work is still running", async () => {
			const gate = new BoundedGate({ limit: 2 })
			let stopAbandoned = () => {}
			const abandoned = new Promise<void>((resolve) => {
				stopAbandoned = resolve
			})

			gate.withholdCapacity(abandoned)
			expect(gate.limit).toBe(1)

			const held = await gate.acquire()
			let secondAdmitted = false
			void gate.acquire().then(() => {
				secondAdmitted = true
			})
			await flush()

			// The second acquire must stay queued: the configured limit is 2 but one
			// slot is still owned by work that never stopped.
			expect(secondAdmitted).toBe(false)
			expect(gate.state.queued).toBe(1)
			held.release()
			stopAbandoned()
		})

		it("restores capacity and admits the waiter once the withheld work settles", async () => {
			const gate = new BoundedGate({ limit: 1 })
			let stopAbandoned = () => {}
			const abandoned = new Promise<void>((resolve) => {
				stopAbandoned = resolve
			})

			gate.withholdCapacity(abandoned)
			expect(gate.limit).toBe(0)

			const waiting = gate.acquire()
			await flush()
			expect(gate.state.queued).toBe(1)

			stopAbandoned()
			const permit = await waiting
			expect(gate.limit).toBe(1)
			expect(gate.state.queued).toBe(0)
			permit.release()
		})

		it("restores capacity when the withheld work rejects", async () => {
			const gate = new BoundedGate({ limit: 1 })
			let failAbandoned = (_reason: unknown) => {}
			const abandoned = new Promise<void>((_resolve, reject) => {
				failAbandoned = reject
			})

			gate.withholdCapacity(abandoned)
			const waiting = gate.acquire()
			await flush()
			expect(gate.state.queued).toBe(1)

			failAbandoned(new Error("tool crashed after abandonment"))
			const permit = await waiting
			expect(gate.limit).toBe(1)
			permit.release()
		})

		it("never reports a negative limit when more slots are withheld than configured", async () => {
			const gate = new BoundedGate({ limit: 1 })
			gate.withholdCapacity(new Promise<void>(() => {}))
			gate.withholdCapacity(new Promise<void>(() => {}))

			expect(gate.limit).toBe(0)

			let admitted = false
			void gate.acquire().then(() => {
				admitted = true
			})
			await flush()
			expect(admitted).toBe(false)
		})
	})

	describe("cancellation", () => {
		it("rejects a waiter whose signal fires before admission", async () => {
			const gate = new BoundedGate({ limit: 1, name: "tool" })
			const held = await gate.acquire()

			const controller = new AbortController()
			const waiting = gate.acquire(controller.signal)

			await flush()
			expect(gate.state.queued).toBe(1)

			controller.abort()
			await expect(waiting).rejects.toBeInstanceOf(GateAbortError)
			expect(gate.state.queued).toBe(0)

			held.release()
			expect(gate.state.running).toBe(0)
		})

		it("rejects immediately when the signal is already aborted", async () => {
			const gate = new BoundedGate({ limit: 4 })
			const controller = new AbortController()
			controller.abort()

			await expect(gate.acquire(controller.signal)).rejects.toBeInstanceOf(GateAbortError)
			expect(gate.state.running).toBe(0)
		})

		it("does not revoke a permit already granted when the signal fires", async () => {
			const gate = new BoundedGate({ limit: 1 })
			const controller = new AbortController()
			const permit = await gate.acquire(controller.signal)

			controller.abort()
			await flush()

			// The gate bounds admission; stopping running work is the caller's
			// own mechanism, not the gate's.
			expect(gate.state.running).toBe(1)
			permit.release()
			expect(gate.state.running).toBe(0)
		})

		it("keeps admitting later waiters after an earlier one aborts", async () => {
			const gate = new BoundedGate({ limit: 1 })
			const held = await gate.acquire()

			const controller = new AbortController()
			const abandoned = gate.acquire(controller.signal)
			const surviving = gate.acquire()

			await flush()
			controller.abort()
			await expect(abandoned).rejects.toBeInstanceOf(GateAbortError)

			held.release()
			const permit = await surviving
			expect(gate.state.running).toBe(1)
			permit.release()
		})
	})
})
