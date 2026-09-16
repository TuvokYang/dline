import { normalizeWorkspaceRelativeInputPath } from "@core/workspace/utils/normalizeWorkspaceRelativeInputPath"
import { Logger } from "@shared/services/Logger"
import { fileExistsAtPath } from "@utils/fs"
import chokidar, { FSWatcher } from "chokidar"
import fs from "fs/promises"
import ignore, { Ignore } from "ignore"
import path from "path"
import { IGNORE_PERMISSIONS, type IgnorePermission, parsePermissionRules, withAdditionalRules } from "./permission-rules"

export { IGNORE_PERMISSIONS, type IgnorePermission } from "./permission-rules"

export const LOCK_TEXT_SYMBOL = "\u{1F512}"

/**
 * Which rule sources compose a decision.
 *
 * - `git`: only `.gitignore`, so checkpoints keep the same visibility as the
 *   user's real repository.
 * - `agent`: the workspace rules the agent must obey, resolved per permission.
 *
 * The operation being attempted is a separate question, answered by
 * {@link IgnorePermission}. Folding the two into one enum previously made
 * "not tracked by git" mean "the agent may not open it".
 */
export type IgnoreScope = "git" | "agent"

/** Workspace file holding agent-scoped rules, in `.gitignore` syntax. */
export const AGENT_IGNORE_FILE = ".agentignore"

/**
 * Accepted agent rule filenames, in precedence order.
 *
 * Only the first file that exists contributes rules, so a workspace using an
 * older name keeps working while a migrated one does not silently re-apply the
 * file it replaced.
 */
const AGENT_IGNORE_FILENAMES = [AGENT_IGNORE_FILE, ".dlineignore", ".clineignore"] as const

const GIT_IGNORE_FILE = ".gitignore"

/**
 * Directories never worth traversing, regardless of any ignore file.
 *
 * This is a floor, not a policy: it exists so a workspace without ignore files
 * still avoids the traversals that reliably dominate discovery cost. Everything
 * else must come from `.gitignore` / `.agentignore`.
 */
const BUILTIN_IGNORED_DIRECTORIES = [".git", "node_modules", "dist", "build", "out", "tmp"] as const

/** The floor as rule text, applied only to the scan permission. */
const BUILTIN_SCAN_RULES = BUILTIN_IGNORED_DIRECTORIES.map((directory) => `${directory}/`).join("\n")

/**
 * The repository directory is readable for diagnostics but never writable.
 *
 * Reading `.git/HEAD` is a legitimate way to answer a question about the
 * checkout; rewriting anything inside it would corrupt the user's repository in
 * a way no checkpoint can undo.
 */
const BUILTIN_WRITE_RULES = ".git/"

const INCLUDE_DIRECTIVE = "!include "

/**
 * The built-in floor expressed as glob patterns.
 *
 * Exported so scanners that run before any {@link IgnoreController} is available
 * still share this single list instead of redeclaring their own.
 */
export function builtinIgnoreGlobPatterns(): string[] {
	return BUILTIN_IGNORED_DIRECTORIES.map((directory) => `**/${directory}/**`)
}

/**
 * Translate `.gitignore` syntax into glob exclusion patterns.
 *
 * Negations are dropped because a glob ignore list cannot express re-inclusion.
 * Exported so every scanner shares one translation instead of reimplementing it.
 */
export function gitignoreToGlobPatterns(content: string): string[] {
	const patterns: string[] = []
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim()
		if (!line || line.startsWith("#") || line.startsWith("!")) continue
		const normalized = line.endsWith("/") ? line.slice(0, -1) : line
		if (!normalized) continue
		const anchored = normalized.startsWith("/")
		const body = anchored ? normalized.slice(1) : normalized
		if (!body) continue
		if (anchored) {
			patterns.push(body, `${body}/**`)
		} else {
			patterns.push(`**/${body}`, `**/${body}/**`)
		}
	}
	return patterns
}

/**
 * Read one directory's `.gitignore` and translate it into glob patterns.
 *
 * Recursive scanners call this for each directory they actually enter, which
 * keeps nested repository rules effective without the upfront full-tree read
 * that exhausted V8 on workspaces holding many nested repositories.
 */
export async function readDirectoryGlobPatterns(directoryPath: string): Promise<string[]> {
	try {
		const content = await fs.readFile(path.join(directoryPath, GIT_IGNORE_FILE), "utf8")
		return gitignoreToGlobPatterns(content)
	} catch {
		return []
	}
}

interface ScopeState {
	instance: Ignore
	/** Raw rules text, or undefined when no rule file contributed content. */
	content: string | undefined
	/** Directory names taken from directory-only patterns, for fast watcher pruning. */
	directoryNames: Set<string>
}

function createScopeState(): ScopeState {
	return { instance: ignore(), content: undefined, directoryNames: new Set() }
}

/**
 * Collect directory names from rules that can only match directories.
 *
 * Only unanchored, wildcard-free directory patterns (`tmp/`, `out/`) are usable
 * as a name-based prune set. Anchored or wildcard patterns stay with the `ignore`
 * instance, which evaluates them against full relative paths.
 */
function collectDirectoryNames(content: string): Set<string> {
	const names = new Set<string>()
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim()
		if (!line || line.startsWith("#") || line.startsWith("!")) continue
		if (!line.endsWith("/")) continue
		const candidate = line.slice(0, -1)
		if (!candidate || candidate.includes("/") || candidate.includes("*") || candidate.includes("?")) continue
		names.add(candidate.toLowerCase())
	}
	return names
}

/**
 * Single source of truth for every path-exclusion decision in the workspace.
 *
 * One instance is owned per workspace by the Controller. Before this existed,
 * discovery (`listFiles`), checkpoints, tool access and prompt-input watching each
 * carried their own rules; the watcher in particular hardcoded a short directory
 * list and therefore kept re-scanning directories that discovery could never
 * return, turning every write under an ignored directory into wasted work.
 */
/**
 * Why a path is excluded from a scan.
 *
 * The two reasons carry different authority. `pruned` is a cost decision: the
 * repository does not track the path, or it is generated output, so walking it
 * wastes time. `agent-restricted` is a permission decision the workspace stated
 * in `.agentignore`. A caller may deliberately descend into a pruned path, but
 * an agent restriction must hold however the path is reached.
 */
export type ScanExclusion = "pruned" | "agent-restricted"

export class IgnoreController {
	private readonly cwd: string
	/** Repository rules, used by checkpoints. */
	private readonly gitScope: ScopeState = createScopeState()
	/**
	 * Agent rules without the repository rules or the built-in floor.
	 *
	 * Kept apart from `permissions.scan` so a deliberate descent can drop the
	 * cost-driven pruning while the workspace's own restrictions still apply.
	 */
	private readonly agentScanScope: ScopeState = createScopeState()
	/** Agent rules, compiled once per permission. */
	private readonly permissions: Record<IgnorePermission, ScopeState> = {
		read: createScopeState(),
		write: createScopeState(),
		execute: createScopeState(),
		scan: createScopeState(),
	}
	private readonly changeListeners = new Set<(scope: IgnoreScope) => void>()
	private watcher?: FSWatcher
	private disposed = false
	/** Serializes reloads so a burst of watcher events cannot interleave writes. */
	private reloadQueue: Promise<void> = Promise.resolve()

	constructor(cwd: string) {
		this.cwd = path.resolve(cwd)
	}

	/**
	 * Load the workspace rules once, without watching for later edits.
	 *
	 * For callers that only need a snapshot at one point in time, such as writing
	 * the shadow git exclude file, and would otherwise leak a watcher.
	 */
	static async loadSnapshot(cwd: string): Promise<IgnoreController> {
		const controller = new IgnoreController(cwd)
		await controller.reload()
		return controller
	}

	/** Load every rule file and begin watching them. Call once before use. */
	async initialize(): Promise<void> {
		if (this.disposed) return
		this.setupWatcher()
		await this.reload()
	}

	/**
	 * Raw rules text governing one permission, or undefined when nothing applies.
	 *
	 * Callers that hand rules to an external process (`rg --ignore-file`) use this;
	 * an undefined result means "no rules", not "allow nothing".
	 */
	getIgnoreContent(permission: IgnorePermission): string | undefined {
		return this.permissions[permission].content
	}

	/** Raw repository rules, for callers that mirror git's own visibility. */
	getRepositoryContent(): string | undefined {
		return this.gitScope.content
	}

	/**
	 * Scan rules stated by the workspace itself, without pruning.
	 *
	 * Excludes the repository rules and the built-in directory floor, so a
	 * caller that deliberately descends into an ignored tree still honours what
	 * `.agentignore` forbids.
	 */
	getAgentScanContent(): string | undefined {
		return this.agentScanScope.content
	}

	/**
	 * Report whether a path may be scanned, and if not, on whose authority.
	 *
	 * Returns undefined when scanning is allowed. Callers use the reason to
	 * decide between descending anyway and refusing: only `pruned` is a cost
	 * decision the caller is entitled to override.
	 */
	describeScanExclusion(targetPath: string, baseDir: string = this.cwd): ScanExclusion | undefined {
		const resolved = path.resolve(baseDir, targetPath)
		// The agent rules are checked first: when both apply, the permission
		// decision is the one the caller must not override.
		if (!this.matches(this.agentScanScope, resolved, baseDir, true)) return "agent-restricted"
		if (!this.matches(this.permissions.scan, resolved, baseDir, true)) return "pruned"
		return undefined
	}

	/** Report whether one operation is allowed on a file. */
	validateAccess(filePath: string, permission: IgnorePermission = "read", baseDir: string = this.cwd): boolean {
		return this.matches(this.permissions[permission], filePath, baseDir, false)
	}

	/** Report whether one operation is allowed on a directory. */
	validateDirectoryAccess(directoryPath: string, permission: IgnorePermission = "read", baseDir: string = this.cwd): boolean {
		return this.matches(this.permissions[permission], directoryPath, baseDir, true)
	}

	/** Report whether the repository tracks a path, for checkpoint callers. */
	validateRepositoryAccess(filePath: string, baseDir: string = this.cwd): boolean {
		return this.matches(this.gitScope, filePath, baseDir, false)
	}

	/**
	 * Synchronous directory prune predicate for recursive watchers and scanners.
	 *
	 * Deliberately free of I/O: watcher predicates run for every traversed entry,
	 * so this only consults already-loaded rules. Pruning is a scan decision, so
	 * this never consults the read, write or execute permissions.
	 */
	shouldIgnoreDirectory(absolutePath: string): boolean {
		const resolved = path.resolve(absolutePath)
		if (resolved === this.cwd) return false
		const name = path.basename(resolved).toLowerCase()
		if (this.permissions.scan.directoryNames.has(name)) return true
		return !this.validateDirectoryAccess(resolved, "scan")
	}

	/** Evaluate one path against one compiled rule set. */
	private matches(state: ScopeState, inputPath: string, baseDir: string, asDirectory: boolean): boolean {
		const relativePath = this.toRelative(inputPath, baseDir)
		if (relativePath === undefined) return true
		if (!state.content) return true
		try {
			const candidate = asDirectory && !relativePath.endsWith("/") ? `${relativePath}/` : relativePath
			return !state.instance.ignores(candidate)
		} catch {
			return true
		}
	}

	/** Terminal command guard: returns the first unreadable path an argument opens. */
	validateCommand(command: string, workdirectory: string = this.cwd): string | undefined {
		if (!this.permissions.read.content) return undefined

		const parts = command.trim().split(/\s+/)
		const baseCommand = parts[0]?.toLowerCase()
		if (!baseCommand) return undefined

		const fileReadingCommands = [
			// Unix commands
			"cat",
			"less",
			"more",
			"head",
			"tail",
			"grep",
			"awk",
			"sed",
			// PowerShell commands and aliases
			"get-content",
			"gc",
			"type",
			"select-string",
			"sls",
		]
		if (!fileReadingCommands.includes(baseCommand)) return undefined

		for (let i = 1; i < parts.length; i++) {
			const argument = parts[i]
			// Skip command flags/options (both Unix and PowerShell style)
			if (argument.startsWith("-") || argument.startsWith("/")) continue
			// Ignore PowerShell parameter names
			if (argument.includes(":")) continue
			// The command opens the file, so this is a read even though the tool
			// being guarded is command execution.
			if (!this.validateAccess(argument, "read", workdirectory)) return argument
		}
		return undefined
	}

	/** Keep only the paths one operation is allowed to touch. */
	filterPaths(paths: string[], permission: IgnorePermission = "scan"): string[] {
		try {
			return paths.filter((candidate) => this.validateAccess(candidate, permission))
		} catch (error) {
			Logger.error("[IgnoreController] Failed to filter paths:", error)
			return [] // Fail closed for security
		}
	}

	/**
	 * Exclusion patterns for glob-based scanners.
	 *
	 * Negated rules are dropped because a glob ignore list cannot express
	 * re-inclusion; scanners must re-check survivors with {@link validateAccess}
	 * when exact fidelity matters.
	 */
	toGlobPatterns(): string[] {
		const patterns = new Set<string>()
		const content = this.permissions.scan.content
		if (!content) return [...patterns]

		for (const pattern of gitignoreToGlobPatterns(content)) {
			patterns.add(pattern)
		}
		return [...patterns]
	}

	/** Scan rules in `.gitignore` syntax, for callers that drive an external tool. */
	toGitignoreContent(): string {
		return this.permissions.scan.content ?? ""
	}

	/**
	 * Repository rules plus the built-in floor, in `.gitignore` syntax.
	 *
	 * Checkpoints mirror what the repository itself does not track, so agent
	 * permissions must not leak in: an agent rule restricts what the agent may
	 * touch, not what the workspace considers untracked.
	 */
	toRepositoryGitignoreContent(): string {
		const repositoryRules = this.gitScope.content
		return repositoryRules ? `${BUILTIN_SCAN_RULES}\n${repositoryRules}` : BUILTIN_SCAN_RULES
	}

	/** Subscribe to committed rule changes. Returns an unsubscribe function. */
	onDidChange(listener: (scope: IgnoreScope) => void): () => void {
		this.changeListeners.add(listener)
		return () => this.changeListeners.delete(listener)
	}

	async dispose(): Promise<void> {
		if (this.disposed) return
		this.disposed = true
		const watcher = this.watcher
		this.watcher = undefined
		this.changeListeners.clear()
		if (watcher) await watcher.close()
		await this.reloadQueue.catch(() => undefined)
	}

	/**
	 * Resolve an input path to a cwd-relative POSIX path.
	 *
	 * Returns undefined for anything outside the workspace: those paths carry no
	 * workspace rules, and callers treat them as allowed.
	 */
	private toRelative(inputPath: string, baseDir: string): string | undefined {
		try {
			const normalized = normalizeWorkspaceRelativeInputPath(inputPath)
			const absolutePath = path.resolve(baseDir, normalized)
			const relativePath = path.relative(this.cwd, absolutePath).toPosix()
			if (!relativePath || relativePath.startsWith("../")) return undefined
			return relativePath
		} catch {
			return undefined
		}
	}

	private setupWatcher(): void {
		const watchedFiles = [GIT_IGNORE_FILE, ...AGENT_IGNORE_FILENAMES].map((name) => path.join(this.cwd, name))

		this.watcher = chokidar.watch(watchedFiles, {
			persistent: true,
			ignoreInitial: true,
			atomic: true,
			awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 100 },
		})

		const scheduleReload = () => {
			void this.reload().catch((error) => Logger.error("[IgnoreController] Failed to reload ignore rules:", error))
		}
		this.watcher
			.on("add", scheduleReload)
			.on("change", scheduleReload)
			.on("unlink", scheduleReload)
			.on("error", (error) => Logger.error("[IgnoreController] Watcher error:", error))
	}

	/** Rebuild both scopes from disk, serialized against concurrent reloads. */
	private reload(): Promise<void> {
		const run = this.reloadQueue.then(() => this.reloadNow())
		this.reloadQueue = run.catch(() => undefined)
		return run
	}

	private async reloadNow(): Promise<void> {
		if (this.disposed) return
		const startedAt = performance.now()

		const gitContent = await this.readRuleFile(GIT_IGNORE_FILE)

		// Only the highest-precedence agent file contributes: reading several would
		// re-apply rules the workspace believes it replaced.
		let agentRules: string | undefined
		for (const fileName of AGENT_IGNORE_FILENAMES) {
			agentRules = await this.readRuleFile(fileName)
			if (agentRules === undefined) continue
			if (fileName !== AGENT_IGNORE_FILE) {
				Logger.debug(`[IgnoreController] Using ${fileName}; ${AGENT_IGNORE_FILE} is the preferred name.`)
			}
			break
		}

		// Each permission gets its own compiled rules. Repository rules and the
		// built-in floor only restrict scanning: not tracking a path, or it being
		// generated output, says nothing about whether opening it is allowed.
		let rules = parsePermissionRules(agentRules)
		// Captured before pruning is layered in: this is what the workspace
		// itself forbids, which a deliberate descent must still respect.
		const agentScanRules = rules.scan
		rules = withAdditionalRules(rules, "scan", gitContent)
		rules = withAdditionalRules(rules, "scan", BUILTIN_SCAN_RULES)
		rules = withAdditionalRules(rules, "write", BUILTIN_WRITE_RULES)

		let agentChanged = false
		for (const permission of IGNORE_PERMISSIONS) {
			if (this.applyRules(this.permissions[permission], rules[permission])) agentChanged = true
		}
		if (this.applyRules(this.agentScanScope, agentScanRules)) agentChanged = true
		const gitChanged = this.applyRules(this.gitScope, gitContent)

		const changed: IgnoreScope[] = []
		if (gitChanged) changed.push("git")
		if (agentChanged) changed.push("agent")

		if (changed.length > 0) {
			Logger.debug(
				`[IgnoreController] Reloaded ${changed.join(", ")} in ${Math.round(performance.now() - startedAt)}ms ` +
					`(git=${gitContent ? "present" : "absent"}, agent=${agentRules ? "present" : "absent"})`,
			)
			for (const scope of changed) this.notify(scope)
		}
	}

	/** Replace one rule set's compiled rules. Returns whether the content changed. */
	private applyRules(state: ScopeState, content: string | undefined): boolean {
		const normalized = content ? content : undefined
		if (state.content === normalized) return false
		const instance = ignore()
		if (normalized) instance.add(normalized)
		state.instance = instance
		state.content = normalized
		state.directoryNames = normalized ? collectDirectoryNames(normalized) : new Set()
		return true
	}

	private notify(scope: IgnoreScope): void {
		for (const listener of this.changeListeners) {
			try {
				listener(scope)
			} catch (error) {
				Logger.error("[IgnoreController] Change listener failed:", error)
			}
		}
	}

	/** Read one rule file, expanding `!include` directives. Undefined when absent. */
	private async readRuleFile(fileName: string): Promise<string | undefined> {
		const filePath = path.join(this.cwd, fileName)
		try {
			if (!(await fileExistsAtPath(filePath))) return undefined
			const content = await fs.readFile(filePath, "utf8")
			// A rule file always protects itself, matching prior behavior.
			const withSelf = `${content}\n${fileName}`
			if (!content.includes(INCLUDE_DIRECTIVE)) return withSelf
			return `${await this.expandIncludes(content)}\n${fileName}`
		} catch (error) {
			Logger.error(`[IgnoreController] Failed to read ${fileName}:`, error)
			return undefined
		}
	}

	/** Inline `!include <file>` targets, dropping directives whose target is missing. */
	private async expandIncludes(content: string): Promise<string> {
		const lines = content.split(/\r?\n/)
		const expanded: string[] = []
		for (const line of lines) {
			const trimmed = line.trim()
			if (!trimmed.startsWith(INCLUDE_DIRECTIVE)) {
				expanded.push(line)
				continue
			}
			const includePath = trimmed.slice(INCLUDE_DIRECTIVE.length).trim()
			const resolved = path.join(this.cwd, includePath)
			try {
				if (!(await fileExistsAtPath(resolved))) {
					Logger.debug(`[IgnoreController] Included file not found: ${resolved}`)
					continue
				}
				expanded.push(await fs.readFile(resolved, "utf8"))
			} catch (error) {
				Logger.error(`[IgnoreController] Failed to read included file ${resolved}:`, error)
			}
		}
		return expanded.join("\n")
	}
}
