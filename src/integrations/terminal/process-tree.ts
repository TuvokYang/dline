export interface WindowsProcessInfo {
	readonly pid: number
	readonly ppid: number
	readonly name: string
}

/** Host-owned Windows process discovery used by command lifecycle termination. */
export interface WindowsProcessTreeProvider {
	getProcessList(rootPid: number): Promise<readonly WindowsProcessInfo[]>
}
