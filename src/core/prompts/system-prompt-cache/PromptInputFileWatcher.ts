import path from "node:path"
import { Logger } from "@shared/services/Logger"
import chokidar, { type ChokidarOptions, type FSWatcher } from "chokidar"
import { markPerfPhase, recordPerfPhase } from "@/services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "@/services/telemetry/instrumentation/perf-domains"

export interface PromptInputFileWatcherDeps {
	readonly taskId?: string
	readonly cwd: string
	readonly globalRulesDirectory: string
	readonly workflowDirectories: readonly string[]
	readonly skillDirectories: readonly string[]
	readonly subagentDirectories: readonly string[]
	readonly invalidate: () => void
	/**
	 * Workspace exclusion rules, normally backed by the agent scope of `IgnoreController`.
	 *
	 * The watcher traverses `cwd` recursively, so an unpruned subtree costs one
	 * descriptor and one event stream per file in the workspace. Callers must
	 * supply the real rules; the default only keeps unit tests self-contained.
	 */
	readonly shouldIgnoreDirectory?: (absolutePath: string) => boolean
	readonly watch?: (paths: readonly string[], options: ChokidarOptions) => FSWatcher
}

function isWithin(parent: string, candidate: string): boolean {
	const relative = path.relative(parent, candidate)
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function normalizedParts(parent: string, candidate: string): string[] | undefined {
	if (!isWithin(parent, candidate)) return undefined
	const relative = path.relative(parent, candidate)
	if (!relative) return []
	return relative.split(path.sep).filter(Boolean)
}

function resolveUnique(paths: readonly string[]): string[] {
	return Array.from(new Set(paths.map((candidate) => path.resolve(candidate))))
}

function resolveE2EReadinessDelayMs(): number {
	if (process.env.E2E_TEST !== "true") return 0
	const configured = process.env.DLINE_E2E_PROMPT_WATCHER_READY_DELAY_MS?.trim()
	if (!configured) return 0
	if (!/^\d+$/.test(configured) || Number(configured) > 60_000) {
		throw new Error(`Invalid DLINE_E2E_PROMPT_WATCHER_READY_DELAY_MS: ${configured}`)
	}
	return Number(configured)
}

type PromptInputKind = "rule" | "workflow" | "skill" | "subagent"
type PromptInputEvent = "add" | "change" | "unlink"

/** Watch local files whose canonical discovery projection can affect a frozen prompt or tool snapshot. */
export class PromptInputFileWatcher {
	private readonly taskId: string
	private readonly cwd: string
	private readonly globalRulesDirectory: string
	private readonly workflowDirectories: readonly string[]
	private readonly skillDirectories: readonly string[]
	private readonly subagentDirectories: readonly string[]
	private readonly protectedDirectories: readonly string[]
	private readonly watchRoots: readonly string[]
	private readonly invalidate: () => void
	private readonly isIgnoredDirectory: (absolutePath: string) => boolean
	private readonly watch: (paths: readonly string[], options: ChokidarOptions) => FSWatcher
	private watcher?: FSWatcher
	private readiness?: Promise<void>
	private settleReadiness?: (outcome: "success" | "degraded" | "superseded") => void
	private readinessDelayTimer?: NodeJS.Timeout
	private disposed = false
	private eventLogTimer?: NodeJS.Timeout
	private totalRelevantEvents = 0
	private pendingEventCounts: Record<PromptInputKind, number> = { rule: 0, workflow: 0, skill: 0, subagent: 0 }
	private pendingEventTypes: Record<PromptInputEvent, number> = { add: 0, change: 0, unlink: 0 }

	constructor(deps: PromptInputFileWatcherDeps) {
		this.taskId = deps.taskId ?? "unknown"
		this.cwd = path.resolve(deps.cwd)
		this.globalRulesDirectory = path.resolve(deps.globalRulesDirectory)
		this.workflowDirectories = resolveUnique(deps.workflowDirectories)
		this.skillDirectories = resolveUnique(deps.skillDirectories)
		this.subagentDirectories = resolveUnique(deps.subagentDirectories)
		this.protectedDirectories = resolveUnique([
			this.globalRulesDirectory,
			path.join(this.cwd, ".agents", "rules"),
			path.join(this.cwd, ".cursor", "rules"),
			...this.workflowDirectories,
			...this.skillDirectories,
			...this.subagentDirectories,
		])
		this.watchRoots = resolveUnique([
			this.cwd,
			this.globalRulesDirectory,
			...this.workflowDirectories,
			...this.skillDirectories,
			...this.subagentDirectories,
		])
		this.invalidate = deps.invalidate
		this.isIgnoredDirectory = deps.shouldIgnoreDirectory ?? (() => false)
		this.watch = deps.watch ?? ((paths, options) => chokidar.watch([...paths], options))
	}

	async start(): Promise<void> {
		if (this.disposed) return
		if (this.watcher) return this.readiness
		const readinessDelayMs = resolveE2EReadinessDelayMs()
		const startedAt = performance.now()
		markPerfPhase(
			PerfDomain.PromptInputWatcher,
			"start",
			{
				roots: this.watchRoots.length,
				protectedRoots: this.protectedDirectories.length,
				includesWorkspaceRoot: this.watchRoots.includes(this.cwd),
			},
			{ taskId: this.taskId },
		)
		// The human-readable mirror is retained because E2E asserts on this exact line
		// to count how many underlying watchers a multi-task window creates.
		Logger.debug(
			`[PromptInputWatcherPerf] phase=start taskId=${this.taskId} roots=${this.watchRoots.length} protectedRoots=${this.protectedDirectories.length} includesWorkspaceRoot=${this.watchRoots.includes(this.cwd)}`,
		)
		let resolveReadiness!: () => void
		this.readiness = new Promise<void>((resolve) => {
			resolveReadiness = resolve
		})
		let readinessSettled = false
		const settleReadiness = (outcome: "success" | "degraded" | "superseded") => {
			if (readinessSettled) return
			readinessSettled = true
			this.settleReadiness = undefined
			if (this.readinessDelayTimer) {
				clearTimeout(this.readinessDelayTimer)
				this.readinessDelayTimer = undefined
			}
			recordPerfPhase(
				PerfDomain.PromptInputWatcher,
				"ready",
				performance.now() - startedAt,
				{ roots: this.watchRoots.length, outcome },
				{ taskId: this.taskId },
			)
			if (Logger.isDebugEnabled()) {
				Logger.debug(
					`[PromptInputWatcherPerf] phase=ready taskId=${this.taskId} durationMs=${Math.round(performance.now() - startedAt)} roots=${this.watchRoots.length} outcome=${outcome}`,
				)
			}
			resolveReadiness()
		}
		const settleSuccessfulReadiness = () => {
			if (readinessSettled || this.readinessDelayTimer) return
			if (readinessDelayMs === 0) {
				settleReadiness("success")
				return
			}
			this.readinessDelayTimer = setTimeout(() => {
				this.readinessDelayTimer = undefined
				settleReadiness("success")
			}, readinessDelayMs)
			this.readinessDelayTimer.unref?.()
		}
		this.settleReadiness = settleReadiness
		const watcher = this.watch(this.watchRoots, {
			persistent: true,
			ignoreInitial: true,
			atomic: true,
			awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
			ignored: (candidate, stats) => stats?.isDirectory() === true && this.shouldIgnoreDirectory(candidate),
		})
		this.watcher = watcher
		const handle = (event: PromptInputEvent, candidate: unknown) => {
			if (this.disposed || typeof candidate !== "string") return
			const kind = this.getPromptInputKind(candidate)
			if (!kind) return
			this.recordEvent(event, kind)
			this.invalidate()
		}
		watcher
			.on("add", (candidate) => handle("add", candidate))
			.on("change", (candidate) => handle("change", candidate))
			.on("unlink", (candidate) => handle("unlink", candidate))
			.on("ready", settleSuccessfulReadiness)
			.on("error", (error) => {
				Logger.error("[PromptInputFileWatcher] Failed to watch prompt-visible inputs:", error)
				settleReadiness("degraded")
			})
		return this.readiness
	}

	async dispose(): Promise<void> {
		if (this.disposed) return
		const startedAt = performance.now()
		this.disposed = true
		this.settleReadiness?.("superseded")
		if (this.eventLogTimer) {
			clearTimeout(this.eventLogTimer)
			this.eventLogTimer = undefined
			this.logPendingEvents()
		}
		const watcher = this.watcher
		this.watcher = undefined
		if (watcher) await watcher.close()
		recordPerfPhase(
			PerfDomain.PromptInputWatcher,
			"dispose",
			performance.now() - startedAt,
			{ totalEvents: this.totalRelevantEvents },
			{ taskId: this.taskId },
		)
		if (Logger.isDebugEnabled()) {
			Logger.debug(
				`[PromptInputWatcherPerf] phase=dispose taskId=${this.taskId} durationMs=${Math.round(performance.now() - startedAt)} totalEvents=${this.totalRelevantEvents}`,
			)
		}
	}

	private recordEvent(event: PromptInputEvent, kind: PromptInputKind): void {
		this.totalRelevantEvents++
		this.pendingEventTypes[event]++
		this.pendingEventCounts[kind]++
		if (this.eventLogTimer) return
		this.eventLogTimer = setTimeout(() => {
			this.eventLogTimer = undefined
			this.logPendingEvents()
		}, 250)
		this.eventLogTimer.unref?.()
	}

	private logPendingEvents(): void {
		const batchEvents = Object.values(this.pendingEventTypes).reduce((total, count) => total + count, 0)
		if (batchEvents === 0) return
		markPerfPhase(
			PerfDomain.PromptInputWatcher,
			"event_batch",
			{
				events: batchEvents,
				totalEvents: this.totalRelevantEvents,
				add: this.pendingEventTypes.add,
				change: this.pendingEventTypes.change,
				unlink: this.pendingEventTypes.unlink,
				rules: this.pendingEventCounts.rule,
				workflows: this.pendingEventCounts.workflow,
				skills: this.pendingEventCounts.skill,
				subagents: this.pendingEventCounts.subagent,
			},
			{ taskId: this.taskId },
		)
		if (Logger.isDebugEnabled()) {
			Logger.debug(
				`[PromptInputWatcherPerf] phase=event_batch taskId=${this.taskId} events=${batchEvents} totalEvents=${this.totalRelevantEvents} add=${this.pendingEventTypes.add} change=${this.pendingEventTypes.change} unlink=${this.pendingEventTypes.unlink} rules=${this.pendingEventCounts.rule} workflows=${this.pendingEventCounts.workflow} skills=${this.pendingEventCounts.skill} subagents=${this.pendingEventCounts.subagent}`,
			)
		}
		this.pendingEventCounts = { rule: 0, workflow: 0, skill: 0, subagent: 0 }
		this.pendingEventTypes = { add: 0, change: 0, unlink: 0 }
	}

	/**
	 * Prune a directory unless it contains inputs this watcher must observe.
	 *
	 * Protected directories win over the workspace rules: rule, workflow, skill
	 * and subagent roots stay watched even when a broad pattern would exclude them.
	 */
	private shouldIgnoreDirectory(candidate: string): boolean {
		const resolved = path.resolve(candidate)
		if (this.protectedDirectories.some((directory) => isWithin(directory, resolved) || isWithin(resolved, directory))) {
			return false
		}
		return this.isIgnoredDirectory(resolved)
	}

	private getPromptInputKind(candidate: string): PromptInputKind | undefined {
		const resolved = path.resolve(candidate)
		if (this.isRuleInput(resolved)) return "rule"
		if (this.isWorkflowInput(resolved)) return "workflow"
		if (this.isSkillInput(resolved)) return "skill"
		if (this.isSubagentInput(resolved)) return "subagent"
		return undefined
	}

	private isRuleInput(candidate: string): boolean {
		if (isWithin(this.globalRulesDirectory, candidate)) return true
		if (!isWithin(this.cwd, candidate)) return false
		const normalized = path.relative(this.cwd, candidate).split(path.sep).join("/").toLowerCase()
		if (normalized === ".cursorrules" || normalized === ".windsurfrules") return true
		if (normalized.startsWith(".agents/rules/")) return true
		if (normalized.startsWith(".cursor/rules/") && normalized.endsWith(".mdc")) return true
		return path.basename(candidate).toLowerCase() === "agents.md"
	}

	private isWorkflowInput(candidate: string): boolean {
		if (!/\.(md|mdx)$/i.test(candidate)) return false
		return this.workflowDirectories.some((directory) => isWithin(directory, candidate))
	}

	private isSkillInput(candidate: string): boolean {
		if (path.basename(candidate).toLowerCase() !== "skill.md") return false
		return this.skillDirectories.some((directory) => normalizedParts(directory, candidate)?.length === 2)
	}

	private isSubagentInput(candidate: string): boolean {
		if (!/\.(yaml|yml)$/i.test(candidate)) return false
		return this.subagentDirectories.some((directory) => normalizedParts(directory, candidate)?.length === 1)
	}
}
