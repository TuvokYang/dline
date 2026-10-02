import path from "node:path"
import type { ChokidarOptions, FSWatcher } from "chokidar"
import { afterEach, describe, expect, it, vi } from "vitest"
import { PromptInputFileWatcher } from "./PromptInputFileWatcher"

class FakeWatcher {
	private readonly listeners = new Map<string, Array<(value: unknown) => void>>()
	readonly close = vi.fn().mockResolvedValue(undefined)

	on(event: string, listener: (value: unknown) => void): this {
		const existing = this.listeners.get(event) ?? []
		existing.push(listener)
		this.listeners.set(event, existing)
		return this
	}

	emit(event: string, value: unknown): void {
		for (const listener of this.listeners.get(event) ?? []) listener(value)
	}
}

function createFixture(overrides: { shouldIgnoreDirectory?: (absolutePath: string) => boolean; autoReady?: boolean } = {}) {
	const cwd = path.resolve("e:/workspace/project")
	const roots = {
		globalRulesDirectory: path.resolve("e:/documents/dline/rules"),
		workflowDirectories: [
			path.join(cwd, ".agents", "workflows"),
			path.join(cwd, ".clinerules", "workflows"),
			path.resolve("e:/documents/dline/workflows"),
		],
		skillDirectories: [
			path.join(cwd, ".clinerules", "skills"),
			path.join(cwd, ".cline", "skills"),
			path.join(cwd, ".claude", "skills"),
			path.join(cwd, ".agents", "skills"),
			path.resolve("e:/documents/dline/skills"),
		],
		subagentDirectories: [path.join(cwd, ".agents", "subagents"), path.resolve("e:/documents/dline/subagents")],
	}
	const watcher = new FakeWatcher()
	const invalidate = vi.fn()
	const watch = vi.fn((_paths: readonly string[], _options: ChokidarOptions) => {
		if (overrides.autoReady !== false) queueMicrotask(() => watcher.emit("ready", undefined))
		return watcher as unknown as FSWatcher
	})
	const inputWatcher = new PromptInputFileWatcher({
		cwd,
		...roots,
		invalidate,
		watch,
		...(overrides.shouldIgnoreDirectory ? { shouldIgnoreDirectory: overrides.shouldIgnoreDirectory } : {}),
	})
	return { cwd, roots, watcher, invalidate, watch, inputWatcher }
}

describe("PromptInputFileWatcher", () => {
	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllEnvs()
	})

	it("waits for the first ready event and ignores duplicate ready events", async () => {
		const fixture = createFixture({ autoReady: false })
		let settled = false
		const starting = fixture.inputWatcher.start().then(() => {
			settled = true
		})

		await Promise.resolve()
		expect(settled).toBe(false)
		fixture.watcher.emit("ready", undefined)
		await starting
		expect(settled).toBe(true)
		fixture.watcher.emit("ready", undefined)
		expect(fixture.watch).toHaveBeenCalledOnce()
	})

	it("delays successful readiness only when the E2E gate is configured", async () => {
		vi.useFakeTimers()
		vi.stubEnv("E2E_TEST", "true")
		vi.stubEnv("DLINE_E2E_PROMPT_WATCHER_READY_DELAY_MS", "2500")
		const fixture = createFixture({ autoReady: false })
		let settled = false
		const starting = fixture.inputWatcher.start().then(() => {
			settled = true
		})

		fixture.watcher.emit("ready", undefined)
		await vi.advanceTimersByTimeAsync(2_499)
		expect(settled).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		await starting
		expect(settled).toBe(true)
	})

	it("lets disposal supersede a configured E2E readiness delay", async () => {
		vi.useFakeTimers()
		vi.stubEnv("E2E_TEST", "true")
		vi.stubEnv("DLINE_E2E_PROMPT_WATCHER_READY_DELAY_MS", "2500")
		const fixture = createFixture({ autoReady: false })
		const starting = fixture.inputWatcher.start()

		fixture.watcher.emit("ready", undefined)
		await fixture.inputWatcher.dispose()

		await expect(starting).resolves.toBeUndefined()
		expect(fixture.watcher.close).toHaveBeenCalledOnce()
	})

	it("settles readiness as degraded on a pre-ready watcher error", async () => {
		const fixture = createFixture({ autoReady: false })
		const starting = fixture.inputWatcher.start()

		fixture.watcher.emit("error", new Error("watch failed"))

		await expect(starting).resolves.toBeUndefined()
	})

	it("invalidates canonical Rules, Workflow, Skill, and Subagent file inputs", async () => {
		const fixture = createFixture()
		await fixture.inputWatcher.start()

		const visiblePaths = [
			path.join(fixture.roots.globalRulesDirectory, "build", "nested-rule.md"),
			path.join(fixture.cwd, ".agents", "rules", "local.md"),
			path.join(fixture.cwd, ".cursor", "rules", "local.mdc"),
			path.join(fixture.cwd, ".cursorrules"),
			path.join(fixture.cwd, ".windsurfrules"),
			path.join(fixture.cwd, "AGENTS.md"),
			path.join(fixture.roots.workflowDirectories[0], "nested", "workflow.md"),
			path.join(fixture.roots.workflowDirectories[1], "legacy.mdx"),
			path.join(fixture.roots.workflowDirectories[2], "global.md"),
			path.join(fixture.roots.skillDirectories[0], "project-skill", "SKILL.md"),
			path.join(fixture.roots.skillDirectories[4], "global-skill", "SKILL.md"),
			path.join(fixture.roots.subagentDirectories[0], "project-agent.yaml"),
			path.join(fixture.roots.subagentDirectories[1], "global-agent.yml"),
		]
		for (const filePath of visiblePaths) fixture.watcher.emit("change", filePath)

		expect(fixture.invalidate).toHaveBeenCalledTimes(visiblePaths.length)
		expect(fixture.watch).toHaveBeenCalledOnce()
		expect(fixture.watch.mock.calls[0]?.[0]).toEqual(
			expect.arrayContaining([
				path.join(fixture.cwd, "AGENTS.md"),
				path.join(fixture.cwd, ".cursorrules"),
				path.join(fixture.cwd, ".windsurfrules"),
				path.join(fixture.cwd, ".agents", "rules"),
				path.join(fixture.cwd, ".cursor", "rules"),
				fixture.roots.globalRulesDirectory,
				...fixture.roots.workflowDirectories,
				...fixture.roots.skillDirectories,
				...fixture.roots.subagentDirectories,
			]),
		)
		expect(fixture.watch.mock.calls[0]?.[0]).not.toContain(fixture.cwd)
	})

	it("rejects files that canonical capability discovery cannot expose", async () => {
		const fixture = createFixture()
		await fixture.inputWatcher.start()

		for (const filePath of [
			path.join(fixture.cwd, "src", "index.ts"),
			path.join(fixture.cwd, "packages", "app", "AGENTS.md"),
			path.join(fixture.roots.workflowDirectories[0], "workflow.txt"),
			path.join(fixture.roots.skillDirectories[0], "SKILL.md"),
			path.join(fixture.roots.skillDirectories[0], "skill", "nested", "SKILL.md"),
			path.join(fixture.roots.skillDirectories[0], "skill", "README.md"),
			path.join(fixture.roots.subagentDirectories[0], "nested", "agent.yaml"),
			path.join(fixture.roots.subagentDirectories[0], "agent.md"),
		]) {
			fixture.watcher.emit("change", filePath)
		}

		expect(fixture.invalidate).not.toHaveBeenCalled()
	})

	it("prunes directories through the injected workspace rules without hiding capability roots", async () => {
		const excluded = new Set<string>()
		const fixture = createFixture({
			shouldIgnoreDirectory: (candidate) => {
				excluded.add(candidate)
				return path.basename(candidate) === "node_modules" || path.basename(candidate) === "dist"
			},
		})
		await fixture.inputWatcher.start()

		const options = fixture.watch.mock.calls[0]?.[1]
		expect(typeof options?.ignored).toBe("function")
		const ignored = options?.ignored as (candidate: string, stats?: { isDirectory(): boolean }) => boolean

		// The workspace rules decide which directories are pruned.
		expect(ignored(path.join(fixture.cwd, "node_modules"), { isDirectory: () => true })).toBe(true)
		expect(ignored(path.join(fixture.cwd, "dist"), { isDirectory: () => true })).toBe(true)
		expect(ignored(path.join(fixture.cwd, "src"), { isDirectory: () => true })).toBe(false)

		// Capability roots stay watched and never reach the workspace rules.
		excluded.clear()
		expect(ignored(fixture.roots.workflowDirectories[0], { isDirectory: () => true })).toBe(false)
		expect(excluded.size).toBe(0)

		// Files are matched by the input predicate, not by directory pruning.
		expect(ignored(path.join(fixture.cwd, "node_modules", "AGENTS.md"), { isDirectory: () => false })).toBe(false)
	})

	it("watches every directory when no workspace rules are supplied", async () => {
		const fixture = createFixture()
		await fixture.inputWatcher.start()

		const options = fixture.watch.mock.calls[0]?.[1]
		const ignored = options?.ignored as (candidate: string, stats?: { isDirectory(): boolean }) => boolean

		expect(ignored(path.join(fixture.cwd, "node_modules"), { isDirectory: () => true })).toBe(false)
	})

	it("continues forwarding prompt input changes after a watcher error", async () => {
		const fixture = createFixture()
		await fixture.inputWatcher.start()

		fixture.watcher.emit("error", new Error("watch failed"))
		fixture.watcher.emit("change", path.join(fixture.cwd, ".agents", "rules", "local.md"))

		expect(fixture.invalidate).toHaveBeenCalledOnce()
	})

	it("forwards add, change, and unlink then stops after disposal", async () => {
		const fixture = createFixture()
		const workflowPath = path.join(fixture.roots.workflowDirectories[0], "workflow.md")
		await fixture.inputWatcher.start()

		fixture.watcher.emit("add", workflowPath)
		fixture.watcher.emit("change", workflowPath)
		fixture.watcher.emit("unlink", workflowPath)
		await fixture.inputWatcher.dispose()
		fixture.watcher.emit("change", workflowPath)

		expect(fixture.invalidate).toHaveBeenCalledTimes(3)
		expect(fixture.watcher.close).toHaveBeenCalledOnce()
	})
})
