import { afterEach, describe, expect, it } from "vitest"
import {
	AMBIENT_RIPGREP_SCOPE,
	activeRipgrepProcesses,
	activeRipgrepProcessesForScope,
	getRipgrepCpuBudget,
	resetRipgrepCpuBudgetForTesting,
	resetRipgrepSlotsForTesting,
	ripgrepThreadArgs,
	TASK_CPU_BUDGET_RATIO,
	taskRipgrepScope,
	WORKSPACE_CPU_BUDGET_RATIO,
	withRipgrepSlot,
} from "../cpu-budget"

/** Defer resolution so a caller can observe the gate while work is in flight. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void
	const promise = new Promise<void>((r) => {
		resolve = r
	})
	return { promise, resolve }
}

/** Let every already-queued microtask run before asserting on gate state. */
async function settleMicrotasks(): Promise<void> {
	for (let i = 0; i < 8; i++) {
		await Promise.resolve()
	}
}

afterEach(() => {
	resetRipgrepCpuBudgetForTesting()
	resetRipgrepSlotsForTesting()
})

describe("ripgrep CPU budget", () => {
	// os.cpus() counts logical processors, so an SMT part already reports both
	// siblings per physical core: an 8C/16T CPU reports 16. Every expectation
	// below is stated in those logical-thread terms.
	it.each([
		{ logicalThreads: 16, taskBudgetThreads: 4, workspaceBudgetThreads: 8 },
		{ logicalThreads: 32, taskBudgetThreads: 9, workspaceBudgetThreads: 16 },
		{ logicalThreads: 24, taskBudgetThreads: 7, workspaceBudgetThreads: 12 },
		{ logicalThreads: 12, taskBudgetThreads: 3, workspaceBudgetThreads: 6 },
		{ logicalThreads: 8, taskBudgetThreads: 2, workspaceBudgetThreads: 4 },
	])("caps one task at 30% and the workspace at 50% of $logicalThreads logical threads", ({
		logicalThreads,
		taskBudgetThreads,
		workspaceBudgetThreads,
	}) => {
		resetRipgrepCpuBudgetForTesting(logicalThreads)

		const budget = getRipgrepCpuBudget()

		expect(budget.logicalThreads).toBe(logicalThreads)
		expect(budget.taskBudgetThreads).toBe(taskBudgetThreads)
		expect(budget.workspaceBudgetThreads).toBe(workspaceBudgetThreads)

		// The cap must hold on real thread cost, not just process count.
		expect(budget.threadsPerProcess * budget.maxProcessesPerTask).toBeLessThanOrEqual(
			Math.floor(logicalThreads * TASK_CPU_BUDGET_RATIO),
		)
		expect(budget.threadsPerProcess * budget.maxProcessesPerWorkspace).toBeLessThanOrEqual(
			Math.floor(logicalThreads * WORKSPACE_CPU_BUDGET_RATIO),
		)
	})

	it("never lets the workspace cap fall below a single task's allowance", () => {
		for (const logicalThreads of [1, 2, 3, 4, 6, 8, 16, 32, 64, 128]) {
			resetRipgrepCpuBudgetForTesting(logicalThreads)
			const budget = getRipgrepCpuBudget()

			expect(budget.workspaceBudgetThreads).toBeGreaterThanOrEqual(budget.taskBudgetThreads)
			expect(budget.maxProcessesPerWorkspace).toBeGreaterThanOrEqual(budget.maxProcessesPerTask)
		}
	})

	it("never drops below one thread and one process on a single-core machine", () => {
		resetRipgrepCpuBudgetForTesting(1)

		const budget = getRipgrepCpuBudget()

		expect(budget.threadsPerProcess).toBe(1)
		expect(budget.maxProcessesPerTask).toBe(1)
		expect(budget.maxProcessesPerWorkspace).toBe(1)
	})

	it("passes the per-process cap to ripgrep as --threads", () => {
		resetRipgrepCpuBudgetForTesting(16)

		expect(ripgrepThreadArgs()).toEqual(["--threads", String(getRipgrepCpuBudget().threadsPerProcess)])
	})

	it("maps a missing task id to the ambient scope", () => {
		expect(taskRipgrepScope(undefined)).toBe(AMBIENT_RIPGREP_SCOPE)
		expect(taskRipgrepScope("abc")).not.toBe(AMBIENT_RIPGREP_SCOPE)
		expect(taskRipgrepScope("abc")).toBe(taskRipgrepScope("abc"))
		expect(taskRipgrepScope("abc")).not.toBe(taskRipgrepScope("def"))
	})
})

describe("ripgrep concurrency gates", () => {
	it("keeps a single task within its own 30% allowance", async () => {
		// 32 logical threads -> task budget 9, workspace budget 16, 2 threads each.
		resetRipgrepCpuBudgetForTesting(32)
		resetRipgrepSlotsForTesting()
		const { maxProcessesPerTask, maxProcessesPerWorkspace } = getRipgrepCpuBudget()
		expect(maxProcessesPerTask).toBeLessThan(maxProcessesPerWorkspace)

		const scope = taskRipgrepScope("task-1")
		const gates = Array.from({ length: maxProcessesPerTask + 4 }, () => deferred())
		const runs = gates.map((gate) => withRipgrepSlot(scope, () => gate.promise))

		await settleMicrotasks()
		// The workspace still has room, but the task cap must bind first.
		expect(activeRipgrepProcessesForScope(scope)).toBe(maxProcessesPerTask)

		for (const gate of gates) {
			gate.resolve()
		}
		await Promise.all(runs)

		expect(activeRipgrepProcessesForScope(scope)).toBe(0)
		expect(activeRipgrepProcesses()).toBe(0)
	})

	it("keeps several tasks together within the workspace 50% allowance", async () => {
		resetRipgrepCpuBudgetForTesting(32)
		resetRipgrepSlotsForTesting()
		const { maxProcessesPerTask, maxProcessesPerWorkspace } = getRipgrepCpuBudget()

		// Enough tasks that their individual allowances would overshoot the
		// workspace cap if only the per-task gate existed.
		const taskCount = Math.ceil(maxProcessesPerWorkspace / maxProcessesPerTask) + 2
		expect(taskCount * maxProcessesPerTask).toBeGreaterThan(maxProcessesPerWorkspace)

		const gates: Array<{ promise: Promise<void>; resolve: () => void }> = []
		const runs: Array<Promise<void>> = []
		for (let task = 0; task < taskCount; task++) {
			const scope = taskRipgrepScope(`task-${task}`)
			for (let i = 0; i < maxProcessesPerTask; i++) {
				const gate = deferred()
				gates.push(gate)
				runs.push(withRipgrepSlot(scope, () => gate.promise))
			}
		}

		await settleMicrotasks()
		expect(activeRipgrepProcesses()).toBe(maxProcessesPerWorkspace)

		for (const gate of gates) {
			gate.resolve()
		}
		await Promise.all(runs)

		expect(activeRipgrepProcesses()).toBe(0)
	})

	it("releases both slots when the work rejects", async () => {
		resetRipgrepCpuBudgetForTesting(16)
		resetRipgrepSlotsForTesting()
		const scope = taskRipgrepScope("task-1")

		await expect(
			withRipgrepSlot(scope, async () => {
				throw new Error("rg exited with code 2")
			}),
		).rejects.toThrow("rg exited with code 2")

		expect(activeRipgrepProcessesForScope(scope)).toBe(0)
		expect(activeRipgrepProcesses()).toBe(0)
	})

	it("removes an aborted queued caller before it can start", async () => {
		resetRipgrepCpuBudgetForTesting(4) // task budget 1 -> one process at a time
		resetRipgrepSlotsForTesting()
		const scope = taskRipgrepScope("task-1")
		const first = deferred()
		const firstRun = withRipgrepSlot(scope, () => first.promise)
		await settleMicrotasks()

		const controller = new AbortController()
		const timeoutError = new Error("search timed out")
		let queuedRan = false
		const queuedRun = withRipgrepSlot(
			scope,
			async () => {
				queuedRan = true
			},
			controller.signal,
		)
		const queuedOutcome = queuedRun.catch((error: unknown) => error)
		await settleMicrotasks()

		controller.abort(timeoutError)
		expect(await queuedOutcome).toBe(timeoutError)
		first.resolve()
		await firstRun
		await settleMicrotasks()

		expect(queuedRan).toBe(false)
		expect(activeRipgrepProcessesForScope(scope)).toBe(0)
		expect(activeRipgrepProcesses()).toBe(0)
	})

	it("admits a queued caller as soon as a slot frees up", async () => {
		resetRipgrepCpuBudgetForTesting(4) // task budget 1 -> one process at a time
		resetRipgrepSlotsForTesting()
		expect(getRipgrepCpuBudget().maxProcessesPerTask).toBe(1)

		const scope = taskRipgrepScope("task-1")
		const order: string[] = []
		const first = deferred()

		const firstRun = withRipgrepSlot(scope, async () => {
			order.push("first:start")
			await first.promise
			order.push("first:end")
		})
		const secondRun = withRipgrepSlot(scope, async () => {
			order.push("second:start")
		})

		await settleMicrotasks()
		expect(order).toEqual(["first:start"])

		first.resolve()
		await Promise.all([firstRun, secondRun])

		expect(order).toEqual(["first:start", "first:end", "second:start"])
		expect(activeRipgrepProcesses()).toBe(0)
	})

	it("does not let one saturated task block another task's first process", async () => {
		resetRipgrepCpuBudgetForTesting(32)
		resetRipgrepSlotsForTesting()
		const { maxProcessesPerTask } = getRipgrepCpuBudget()

		const busy = taskRipgrepScope("busy")
		const busyGates = Array.from({ length: maxProcessesPerTask }, () => deferred())
		const busyRuns = busyGates.map((gate) => withRipgrepSlot(busy, () => gate.promise))

		await settleMicrotasks()

		const other = taskRipgrepScope("other")
		let otherRan = false
		const otherRun = withRipgrepSlot(other, async () => {
			otherRan = true
		})

		await settleMicrotasks()
		expect(otherRan).toBe(true)

		for (const gate of busyGates) {
			gate.resolve()
		}
		await Promise.all([...busyRuns, otherRun])
		expect(activeRipgrepProcesses()).toBe(0)
	})
})
