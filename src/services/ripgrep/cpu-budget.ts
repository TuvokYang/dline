import * as os from "node:os"

/**
 * Shared CPU budget for every ripgrep process this extension host spawns.
 *
 * ripgrep defaults `--threads` to the number of logical CPUs, so a single
 * `rg --files` walk saturates the machine. The picker fires one walk per
 * workspace root and the search tool adds more on top, which is what makes
 * `rg.exe` sit at 100% CPU during ordinary editing.
 *
 * Two limits apply at once, because one task must stay bounded on its own and
 * several concurrent tasks must not add up to the whole machine:
 *
 * - a single task may use at most {@link TASK_CPU_BUDGET_RATIO} of the logical
 *   threads;
 * - all tasks in this workspace host together may use at most
 *   {@link WORKSPACE_CPU_BUDGET_RATIO}.
 *
 * Both are enforced as `threadsPerProcess * concurrentProcesses`, so the cap
 * covers the real cost rather than only the number of processes.
 */

/** Share of the machine's logical threads a single task may use. */
export const TASK_CPU_BUDGET_RATIO = 0.3

/** Share of the machine's logical threads all tasks together may use. */
export const WORKSPACE_CPU_BUDGET_RATIO = 0.5

/**
 * Resolved budget for the current machine.
 *
 * Every field is at least 1 so a single-core or unreported-CPU machine still
 * makes progress, and the workspace cap is never below the task cap — one task
 * alone must always be able to spend its full allowance.
 */
export interface RipgrepCpuBudget {
	/** Logical threads reported by the OS, including SMT/Hyper-Threading siblings. */
	readonly logicalThreads: number
	/** Value passed to ripgrep's `--threads` flag. */
	readonly threadsPerProcess: number
	/** Threads a single task may use across its concurrent processes. */
	readonly taskBudgetThreads: number
	/** Concurrent ripgrep processes allowed within one task. */
	readonly maxProcessesPerTask: number
	/** Threads all tasks together may use. */
	readonly workspaceBudgetThreads: number
	/** Concurrent ripgrep processes allowed across all tasks. */
	readonly maxProcessesPerWorkspace: number
}

/**
 * Logical thread count for the current machine.
 *
 * `os.cpus()` enumerates logical processors, so on an SMT/Hyper-Threading CPU
 * this already counts both siblings of each physical core — an 8C/16T part
 * reports 16. The ratios are deliberately expressed against that number because
 * it is what the OS scheduler, ripgrep and Task Manager all use, so "30% of
 * threads" means the same thing in every one of them.
 *
 * Some containers and virtualised hosts report an empty array; treat that as a
 * single thread rather than dividing by zero.
 */
function detectLogicalThreads(): number {
	const reported = os.cpus()?.length ?? 0
	return reported > 0 ? reported : 1
}

/**
 * Threads per process, chosen so a task can still run roots in parallel.
 *
 * Wider processes finish an individual walk sooner, but a workspace with
 * several roots benefits more from walking them concurrently. Two threads is
 * the compromise: it keeps one walk from degenerating into a fully serial
 * traversal while leaving room for a second process once the budget allows.
 */
function planThreadsPerProcess(taskBudgetThreads: number): number {
	return taskBudgetThreads >= 2 ? 2 : 1
}

function planBudget(logicalThreads: number): RipgrepCpuBudget {
	const taskBudgetThreads = Math.max(1, Math.floor(logicalThreads * TASK_CPU_BUDGET_RATIO))
	// A single task must never be throttled below its own allowance, even when
	// rounding pushes the workspace share under it on a very small machine.
	const workspaceBudgetThreads = Math.max(taskBudgetThreads, Math.floor(logicalThreads * WORKSPACE_CPU_BUDGET_RATIO))

	const threadsPerProcess = planThreadsPerProcess(taskBudgetThreads)

	return {
		logicalThreads,
		threadsPerProcess,
		taskBudgetThreads,
		maxProcessesPerTask: Math.max(1, Math.floor(taskBudgetThreads / threadsPerProcess)),
		workspaceBudgetThreads,
		maxProcessesPerWorkspace: Math.max(1, Math.floor(workspaceBudgetThreads / threadsPerProcess)),
	}
}

let cachedBudget: RipgrepCpuBudget | undefined

/** Resolved budget for this process; the CPU topology cannot change at runtime. */
export function getRipgrepCpuBudget(): RipgrepCpuBudget {
	if (!cachedBudget) {
		cachedBudget = planBudget(detectLogicalThreads())
	}
	return cachedBudget
}

/** Test seam: recompute the budget, optionally against a forced thread count. */
export function resetRipgrepCpuBudgetForTesting(logicalThreads?: number): void {
	cachedBudget = logicalThreads === undefined ? undefined : planBudget(Math.max(1, logicalThreads))
}

/**
 * ripgrep arguments that pin a process to its share of the budget.
 *
 * Callers spread these into their own argument list. Kept separate from the
 * slot gate so argument construction stays synchronous and testable.
 */
export function ripgrepThreadArgs(): readonly string[] {
	return ["--threads", String(getRipgrepCpuBudget().threadsPerProcess)]
}

/**
 * Accounting scope a ripgrep process is charged to.
 *
 * Distinct from `IgnoreScope`, which selects a rule source: this only answers
 * "whose CPU allowance pays for this process". Work belonging to a task is
 * charged to that task; work without one — the `@` mention picker runs before
 * any task exists — shares a single ambient scope, so an idle window with
 * several panels still cannot exceed one task's allowance.
 */
export type RipgrepBudgetScope = string

/** Scope used when the caller is not running inside a task. */
export const AMBIENT_RIPGREP_SCOPE: RipgrepBudgetScope = "workspace:ambient"

/** Budget scope for one task, keyed by its task id. */
export function taskRipgrepScope(taskId: string | undefined): RipgrepBudgetScope {
	return taskId ? `task:${taskId}` : AMBIENT_RIPGREP_SCOPE
}

/** Waiters queued behind a busy scope, released FIFO. */
type RipgrepWaiter = () => void

interface ScopeState {
	active: number
	readonly waiters: RipgrepWaiter[]
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Ripgrep slot wait aborted")
}

function waitForSlot(waiters: RipgrepWaiter[], grant: () => void, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) {
		return Promise.reject(abortReason(signal))
	}

	return new Promise<void>((resolve, reject) => {
		let settled = false
		const cleanup = () => signal?.removeEventListener("abort", handleAbort)
		const waiter = () => {
			if (settled) return
			settled = true
			cleanup()
			grant()
			resolve()
		}
		const handleAbort = () => {
			if (settled) return
			settled = true
			const index = waiters.indexOf(waiter)
			if (index >= 0) waiters.splice(index, 1)
			cleanup()
			reject(abortReason(signal!))
		}

		waiters.push(waiter)
		signal?.addEventListener("abort", handleAbort, { once: true })
		if (signal?.aborted) handleAbort()
	})
}

const scopes = new Map<RipgrepBudgetScope, ScopeState>()
const workspaceWaiters: RipgrepWaiter[] = []
let workspaceActive = 0

/** Processes currently running across all scopes. Exposed for tests. */
export function activeRipgrepProcesses(): number {
	return workspaceActive
}

/** Processes currently running for one scope. Exposed for tests. */
export function activeRipgrepProcessesForScope(scope: RipgrepBudgetScope): number {
	return scopes.get(scope)?.active ?? 0
}

/**
 * Run `spawnAndWait` while holding both a task slot and a workspace slot.
 *
 * The slots are held until the returned promise settles, so callers must not
 * resolve before the child process has exited or been killed — otherwise a new
 * process could start while the old one is still burning CPU.
 *
 * Acquisition order is always task-then-workspace. A uniform order is what
 * keeps the two gates deadlock-free; releasing happens in the reverse order.
 */
export async function withRipgrepSlot<T>(
	scope: RipgrepBudgetScope,
	spawnAndWait: () => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	await acquireScopeSlot(scope, signal)
	try {
		await acquireWorkspaceSlot(signal)
	} catch (error) {
		releaseScopeSlot(scope)
		throw error
	}

	try {
		if (signal?.aborted) throw abortReason(signal)
		return await spawnAndWait()
	} finally {
		releaseWorkspaceSlot()
		releaseScopeSlot(scope)
	}
}

function acquireScopeSlot(scope: RipgrepBudgetScope, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(abortReason(signal))
	const { maxProcessesPerTask } = getRipgrepCpuBudget()
	let state = scopes.get(scope)
	if (!state) {
		state = { active: 0, waiters: [] }
		scopes.set(scope, state)
	}

	if (state.active < maxProcessesPerTask) {
		state.active++
		return Promise.resolve()
	}

	return waitForSlot(
		state.waiters,
		() => {
			state.active++
		},
		signal,
	)
}

function releaseScopeSlot(scope: RipgrepBudgetScope): void {
	const state = scopes.get(scope)
	if (!state) {
		return
	}

	state.active = Math.max(0, state.active - 1)
	const next = state.waiters.shift()
	if (next) {
		next()
		return
	}
	// Drop idle scopes so finished tasks do not accumulate empty entries.
	if (state.active === 0) {
		scopes.delete(scope)
	}
}

function acquireWorkspaceSlot(signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(abortReason(signal))
	const { maxProcessesPerWorkspace } = getRipgrepCpuBudget()
	if (workspaceActive < maxProcessesPerWorkspace) {
		workspaceActive++
		return Promise.resolve()
	}

	return waitForSlot(
		workspaceWaiters,
		() => {
			workspaceActive++
		},
		signal,
	)
}

function releaseWorkspaceSlot(): void {
	workspaceActive = Math.max(0, workspaceActive - 1)
	workspaceWaiters.shift()?.()
}

/** Test seam: drop queued waiters and reset every in-flight count. */
export function resetRipgrepSlotsForTesting(): void {
	scopes.clear()
	workspaceWaiters.length = 0
	workspaceActive = 0
}
