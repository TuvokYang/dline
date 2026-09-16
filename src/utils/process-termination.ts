/**
 * Utility for graceful process termination with SIGKILL fallback.
 *
 * Handles cross-platform process tree termination:
 * - Windows uses host-owned process discovery and descendant-first force termination
 * - POSIX sends SIGTERM first, then falls back to SIGKILL
 * - Every path waits for a bounded process-close boundary
 */

import type { ChildProcess } from "node:child_process"
import treeKill from "tree-kill"
import type { WindowsProcessInfo, WindowsProcessTreeProvider } from "@/integrations/terminal/process-tree"

export interface TerminateProcessTreeOptions {
	/** Process ID to terminate */
	pid: number
	/** Child process reference (for close event listening) */
	childProcess?: ChildProcess | null
	/** Function to check if process has already completed */
	isCompleted: () => boolean
	/** Timeout in ms before escalating to SIGKILL (default: 2000) */
	gracefulTimeoutMs?: number
	/** Timeout in ms to confirm process exit after SIGKILL (default: 2000) */
	forcefulTimeoutMs?: number
	/** Total Windows discovery, termination, and stream-close budget (default: 30000). */
	windowsTerminationTimeoutMs?: number
	/** Host-owned process discovery required for reliable Windows descendant termination. */
	windowsProcessTreeProvider?: WindowsProcessTreeProvider
}

/** Request one process-tree signal and wait until the platform kill command completes. */
function killProcessTree(pid: number, signal: "SIGTERM" | "SIGKILL", isCompleted: () => boolean): Promise<void> {
	return new Promise((resolve, reject) => {
		try {
			treeKill(pid, signal, (error) => {
				if (error && !isCompleted()) {
					reject(new Error(`Failed to send ${signal} to process tree ${pid}`, { cause: error }))
					return
				}
				resolve()
			})
		} catch (error) {
			if (isCompleted()) {
				resolve()
				return
			}
			reject(new Error(`Failed to send ${signal} to process tree ${pid}`, { cause: error }))
		}
	})
}

function isMissingProcessError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH"
}

function getProcessDepth(processInfo: WindowsProcessInfo, byPid: ReadonlyMap<number, WindowsProcessInfo>): number {
	let depth = 0
	let current = processInfo
	const visited = new Set<number>()
	while (current.ppid !== 0 && !visited.has(current.pid)) {
		visited.add(current.pid)
		const parent = byPid.get(current.ppid)
		if (!parent) break
		depth += 1
		current = parent
	}
	return depth
}

function orderWindowsProcessTree(processList: readonly WindowsProcessInfo[], rootPid: number): number[] {
	if (!processList.some((processInfo) => processInfo.pid === rootPid)) {
		throw new Error(`Windows process-tree provider did not return root PID ${rootPid}`)
	}
	const byPid = new Map(processList.map((processInfo) => [processInfo.pid, processInfo]))
	return [...processList]
		.sort((left, right) => getProcessDepth(right, byPid) - getProcessDepth(left, byPid))
		.map((processInfo) => processInfo.pid)
}

function isWindowsProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		if (isMissingProcessError(error)) return false
		throw error
	}
}

async function waitForWindowsProcessesToExit(processIds: readonly number[], timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (true) {
		if (processIds.every((pid) => !isWindowsProcessRunning(pid))) return true
		if (Date.now() >= deadline) return false
		await new Promise((resolve) => setTimeout(resolve, 25))
	}
}

function remainingTime(deadline: number): number {
	return Math.max(0, deadline - Date.now())
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	if (timeoutMs <= 0) return Promise.reject(new Error(message))
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
		operation.then(
			(value) => {
				clearTimeout(timeout)
				resolve(value)
			},
			(error) => {
				clearTimeout(timeout)
				reject(error)
			},
		)
	})
}

async function killWindowsProcessTree(
	pid: number,
	provider: WindowsProcessTreeProvider,
	isCompleted: () => boolean,
	deadline: number,
): Promise<void> {
	let processList: readonly WindowsProcessInfo[]
	try {
		processList = await withTimeout(
			provider.getProcessList(pid),
			remainingTime(deadline),
			`Timed out discovering Windows process tree ${pid}`,
		)
	} catch (error) {
		if (isCompleted()) return
		throw new Error(`Failed to discover Windows process tree ${pid}`, { cause: error })
	}

	const processIds = orderWindowsProcessTree(processList, pid)
	for (const processId of processIds) {
		try {
			process.kill(processId, "SIGKILL")
		} catch (error) {
			if (isMissingProcessError(error)) continue
			throw new Error(`Failed to terminate Windows process ${processId} in tree ${pid}`, { cause: error })
		}
	}

	if (await waitForWindowsProcessesToExit(processIds, remainingTime(deadline))) return
	const survivors = processIds.filter((processId) => isWindowsProcessRunning(processId))
	throw new Error(`Windows process tree ${pid} still has running processes: ${survivors.join(", ")}`)
}

/** Wait for the child close event so stdio and descendants cannot outlive a successful termination. */
function waitForProcessClose(
	childProcess: ChildProcess | null | undefined,
	isCompleted: () => boolean,
	timeoutMs: number,
): Promise<boolean> {
	if (isCompleted()) return Promise.resolve(true)

	return new Promise((resolve) => {
		let timeout: NodeJS.Timeout | undefined
		const finish = (completed: boolean) => {
			if (timeout) clearTimeout(timeout)
			childProcess?.off("close", handleClose)
			resolve(completed)
		}
		const handleClose = () => finish(true)

		childProcess?.once("close", handleClose)
		timeout = setTimeout(() => finish(isCompleted()), timeoutMs)
		if (isCompleted()) finish(true)
	})
}

/**
 * Terminates a process tree with graceful shutdown and SIGKILL fallback.
 *
 * Uses host-provided native discovery on Windows and tree-kill signals on POSIX.
 *
 * @param options Termination options
 */
export async function terminateProcessTree(options: TerminateProcessTreeOptions): Promise<void> {
	const {
		pid,
		childProcess,
		isCompleted,
		gracefulTimeoutMs = 2000,
		forcefulTimeoutMs = 2000,
		windowsTerminationTimeoutMs = 30_000,
	} = options

	if (process.platform === "win32") {
		if (!options.windowsProcessTreeProvider) {
			throw new Error(`Windows process-tree provider is not configured for PID ${pid}`)
		}
		const deadline = Date.now() + windowsTerminationTimeoutMs
		await killWindowsProcessTree(pid, options.windowsProcessTreeProvider, isCompleted, deadline)
		if (await waitForProcessClose(childProcess, isCompleted, remainingTime(deadline))) return
		throw new Error(`Windows process tree ${pid} exited but the root process did not close its streams`)
	}

	await killProcessTree(pid, "SIGTERM", isCompleted)
	if (await waitForProcessClose(childProcess, isCompleted, gracefulTimeoutMs)) return

	await killProcessTree(pid, "SIGKILL", isCompleted)
	if (await waitForProcessClose(childProcess, isCompleted, forcefulTimeoutMs)) return

	throw new Error(`Process tree ${pid} did not exit after SIGKILL`)
}
