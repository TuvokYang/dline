import { readdir } from "node:fs/promises"
import path from "node:path"
import type { WindowsProcessInfo, WindowsProcessTreeProvider } from "@/integrations/terminal/process-tree"

interface VscodeWindowsProcessTreeModule {
	getProcessList(rootPid: number, callback: (processList: readonly WindowsProcessInfo[] | undefined) => void): void
}

type ModuleLoader = (modulePath: string) => unknown
type DirectoryReader = (directory: string) => Promise<readonly { isDirectory(): boolean; name: string }[]>

const WINDOWS_PROCESS_TREE_MODULE_ID = ["@vscode", "windows-process-tree"].join("/")

function isWindowsProcessTreeModule(value: unknown): value is VscodeWindowsProcessTreeModule {
	return typeof value === "object" && value !== null && "getProcessList" in value && typeof value.getProcessList === "function"
}

/** Loads the native process-tree module shipped by the active VS Code host. */
export class VscodeWindowsProcessTreeProvider implements WindowsProcessTreeProvider {
	private modulePromise: Promise<VscodeWindowsProcessTreeModule> | undefined

	constructor(
		private readonly appRoot: string,
		private readonly execPath = process.execPath,
		private readonly loadModule: ModuleLoader = (modulePath) => require(modulePath),
		private readonly readDirectory: DirectoryReader = (directory) => readdir(directory, { withFileTypes: true }),
	) {}

	async getProcessList(rootPid: number): Promise<readonly WindowsProcessInfo[]> {
		const processTree = await this.loadProcessTreeModule()
		return new Promise((resolve, reject) => {
			try {
				processTree.getProcessList(rootPid, (processList) => {
					if (!processList) {
						reject(new Error(`VS Code process-tree provider could not find PID ${rootPid}`))
						return
					}
					resolve(processList)
				})
			} catch (error) {
				reject(new Error(`VS Code process-tree provider failed for PID ${rootPid}`, { cause: error }))
			}
		})
	}

	private loadProcessTreeModule(): Promise<VscodeWindowsProcessTreeModule> {
		this.modulePromise ??= this.resolveProcessTreeModule()
		return this.modulePromise
	}

	private async resolveProcessTreeModule(): Promise<VscodeWindowsProcessTreeModule> {
		let lastError: unknown
		for (const modulePath of await this.getModuleCandidates()) {
			try {
				const candidate = this.loadModule(modulePath)
				if (isWindowsProcessTreeModule(candidate)) return candidate
				lastError = new Error(`Module '${modulePath}' does not expose getProcessList()`)
			} catch (error) {
				lastError = error
			}
		}
		throw new Error("The active VS Code host does not expose @vscode/windows-process-tree", { cause: lastError })
	}

	private async getModuleCandidates(): Promise<string[]> {
		const appRoots = new Set([this.appRoot])
		try {
			for (const entry of await this.readDirectory(path.dirname(this.execPath))) {
				if (entry.isDirectory() && /^[a-f0-9]{8,}$/i.test(entry.name)) {
					appRoots.add(path.join(path.dirname(this.execPath), entry.name, "resources", "app"))
				}
			}
		} catch {
			// The explicit appRoot remains authoritative when sibling discovery is unavailable.
		}

		const candidates = [WINDOWS_PROCESS_TREE_MODULE_ID]
		for (const appRoot of appRoots) {
			candidates.push(
				path.join(appRoot, "node_modules.asar", "@vscode", "windows-process-tree"),
				path.join(appRoot, "node_modules", "@vscode", "windows-process-tree"),
				path.join(appRoot, "node_modules.asar.unpacked", "@vscode", "windows-process-tree"),
			)
		}
		return [...new Set(candidates)]
	}
}
