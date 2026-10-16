import type { Stats } from "node:fs"
import path from "node:path"
import type { ChokidarOptions, FSWatcher } from "chokidar"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PromptInputFileWatcherDeps } from "./PromptInputFileWatcher"
import { WorkspacePromptInputWatcherRegistry } from "./WorkspacePromptInputWatcherRegistry"

class FakeWatcher {
    private readonly listeners = new Map<string, Array<(value: unknown) => void>>()
    readonly close = vi.fn().mockResolvedValue(undefined)
    readonly add = vi.fn()
    readonly unwatch = vi.fn().mockResolvedValue(undefined)

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

type Roots = Pick<
    PromptInputFileWatcherDeps,
    "globalRulesDirectory" | "workflowDirectories" | "skillDirectories" | "subagentDirectories"
>

function createRoots(cwd: string): Roots {
    return {
        globalRulesDirectory: path.resolve("e:/documents/dline/rules"),
        workflowDirectories: [path.join(cwd, ".agents", "workflows")],
        skillDirectories: [path.join(cwd, ".agents", "skills")],
        subagentDirectories: [path.join(cwd, ".agents", "subagents")],
    }
}

describe("WorkspacePromptInputWatcherRegistry", () => {
    const workspaceA = path.resolve("e:/workspace/project-a")
    const workspaceB = path.resolve("e:/workspace/project-b")

    let watchers: FakeWatcher[]
    let watchOptions: ChokidarOptions[]
    let watch: ReturnType<typeof vi.fn<(paths: readonly string[], options: ChokidarOptions) => FSWatcher>>
    let registry: WorkspacePromptInputWatcherRegistry

    /**
     * Exercise the traversal filter chokidar was configured with.
     *
     * The filter only consults the ignore rules for directories, so the probe
     * has to supply directory stats the way chokidar does during a walk.
     */
    function invokeIgnored(absolutePath: string): boolean {
        const ignored = watchOptions[0]?.ignored
        if (typeof ignored !== "function") throw new Error("expected a function-based chokidar ignore filter")
        const directoryStats = { isDirectory: () => true } as unknown as Stats
        return Boolean(ignored(absolutePath, directoryStats))
    }

    beforeEach(() => {
        watchers = []
        watchOptions = []
        watch = vi.fn((_paths: readonly string[], options: ChokidarOptions) => {
            const created = new FakeWatcher()
            watchers.push(created)
            watchOptions.push(options)
            return created as unknown as FSWatcher
        })
        registry = new WorkspacePromptInputWatcherRegistry({ watch })
    })

    it("returns immediately while exposing the shared underlying readiness", async () => {
        const subscription = await registry.subscribe({
            taskId: "task-1",
            cwd: workspaceA,
            ...createRoots(workspaceA),
            invalidate: vi.fn(),
        })
        let ready = false
        void subscription.ready.then(() => {
            ready = true
        })

        await Promise.resolve()
        expect(ready).toBe(false)
        watchers[0].emit("ready", undefined)
        await subscription.ready
        expect(ready).toBe(true)
    })

    it("creates a single underlying watcher for concurrent tasks in one workspace", async () => {
        const first = await registry.subscribe({
            taskId: "task-1",
            cwd: workspaceA,
            ...createRoots(workspaceA),
            invalidate: vi.fn(),
        })
        const second = await registry.subscribe({
            taskId: "task-2",
            cwd: workspaceA,
            ...createRoots(workspaceA),
            invalidate: vi.fn(),
        })

        expect(watch).toHaveBeenCalledTimes(1)
        expect(first).not.toBe(second)
    })

    it("deduplicates concurrent subscriptions racing on the same workspace", async () => {
        const [first, second] = await Promise.all([
            registry.subscribe({ taskId: "task-1", cwd: workspaceA, ...createRoots(workspaceA), invalidate: vi.fn() }),
            registry.subscribe({ taskId: "task-2", cwd: workspaceA, ...createRoots(workspaceA), invalidate: vi.fn() }),
        ])

        expect(watch).toHaveBeenCalledTimes(1)
        expect(first).not.toBe(second)
    })

    it("keeps separate watchers for different workspaces", async () => {
        await registry.subscribe({ taskId: "task-1", cwd: workspaceA, ...createRoots(workspaceA), invalidate: vi.fn() })
        await registry.subscribe({ taskId: "task-2", cwd: workspaceB, ...createRoots(workspaceB), invalidate: vi.fn() })

        expect(watch).toHaveBeenCalledTimes(2)
    })

    it("fans a single filesystem event out to every subscriber of the workspace", async () => {
        const firstInvalidate = vi.fn()
        const secondInvalidate = vi.fn()
        await registry.subscribe({ taskId: "task-1", cwd: workspaceA, ...createRoots(workspaceA), invalidate: firstInvalidate })
        await registry.subscribe({ taskId: "task-2", cwd: workspaceA, ...createRoots(workspaceA), invalidate: secondInvalidate })

        watchers[0].emit("change", path.join(workspaceA, ".agents", "rules", "local.md"))

        expect(firstInvalidate).toHaveBeenCalledTimes(1)
        expect(secondInvalidate).toHaveBeenCalledTimes(1)
        expect(firstInvalidate.mock.calls[0]?.[0]).toBe(secondInvalidate.mock.calls[0]?.[0])
    })

    it("stops notifying a released subscriber while the remaining one keeps receiving events", async () => {
        const firstInvalidate = vi.fn()
        const secondInvalidate = vi.fn()
        const first = await registry.subscribe({
            taskId: "task-1",
            cwd: workspaceA,
            ...createRoots(workspaceA),
            invalidate: firstInvalidate,
        })
        await registry.subscribe({ taskId: "task-2", cwd: workspaceA, ...createRoots(workspaceA), invalidate: secondInvalidate })

        await first.dispose()
        watchers[0].emit("change", path.join(workspaceA, ".agents", "rules", "local.md"))

        expect(firstInvalidate).not.toHaveBeenCalled()
        expect(secondInvalidate).toHaveBeenCalledTimes(1)
        expect(watchers[0].close).not.toHaveBeenCalled()
    })

    it("keeps the process-owned watcher warm after the last subscriber releases", async () => {
        const first = await registry.subscribe({
            taskId: "task-1",
            cwd: workspaceA,
            ...createRoots(workspaceA),
            invalidate: vi.fn(),
        })
        const second = await registry.subscribe({
            taskId: "task-2",
            cwd: workspaceA,
            ...createRoots(workspaceA),
            invalidate: vi.fn(),
        })

        await first.dispose()
        await second.dispose()
        expect(watchers[0].close).not.toHaveBeenCalled()

        await registry.disposeAll()
        expect(watchers[0].close).toHaveBeenCalledTimes(1)
    })

    it("ignores repeated dispose calls from the same subscriber", async () => {
        const first = await registry.subscribe({
            taskId: "task-1",
            cwd: workspaceA,
            ...createRoots(workspaceA),
            invalidate: vi.fn(),
        })
        await registry.subscribe({ taskId: "task-2", cwd: workspaceA, ...createRoots(workspaceA), invalidate: vi.fn() })

        await first.dispose()
        await first.dispose()

        expect(watchers[0].close).not.toHaveBeenCalled()
    })

    it("reuses the warm watcher after the workspace temporarily has no subscribers", async () => {
        const first = await registry.subscribe({
            taskId: "task-1",
            cwd: workspaceA,
            ...createRoots(workspaceA),
            invalidate: vi.fn(),
        })
        await first.dispose()

        await registry.subscribe({ taskId: "task-2", cwd: workspaceA, ...createRoots(workspaceA), invalidate: vi.fn() })

        expect(watch).toHaveBeenCalledTimes(1)
    })

    it("routes dynamically tracked child AGENTS changes only to subscribers of that exact scope", async () => {
        const childAgents = path.join(workspaceA, "packages", "app", "AGENTS.md")
        const firstInvalidate = vi.fn()
        const secondInvalidate = vi.fn()
        const first = await registry.subscribe({
            taskId: "task-1",
            cwd: workspaceA,
            ...createRoots(workspaceA),
            invalidate: firstInvalidate,
        })
        await registry.subscribe({
            taskId: "task-2",
            cwd: workspaceA,
            ...createRoots(workspaceA),
            invalidate: secondInvalidate,
        })

        await first.trackExact([childAgents])
        expect(watchers[0].add).toHaveBeenCalledWith([childAgents])
        watchers[0].emit("change", childAgents)

        expect(firstInvalidate).toHaveBeenCalledOnce()
        expect(secondInvalidate).not.toHaveBeenCalled()

        await first.untrackExact([childAgents])
        expect(watchers[0].unwatch).toHaveBeenCalledWith([childAgents])
    })

    it("does not invalidate subscribers for paths outside prompt inputs", async () => {
        const invalidate = vi.fn()
        await registry.subscribe({ taskId: "task-1", cwd: workspaceA, ...createRoots(workspaceA), invalidate })

        watchers[0].emit("change", path.join(workspaceA, "src", "index.ts"))

        expect(invalidate).not.toHaveBeenCalled()
    })

    it("separates entries when the prompt input roots differ inside the same cwd", async () => {
        const baseRoots = createRoots(workspaceA)
        await registry.subscribe({ taskId: "task-1", cwd: workspaceA, ...baseRoots, invalidate: vi.fn() })
        await registry.subscribe({
            taskId: "task-2",
            cwd: workspaceA,
            ...baseRoots,
            globalRulesDirectory: path.resolve("e:/documents/dline-alt/rules"),
            invalidate: vi.fn(),
        })

        expect(watch).toHaveBeenCalledTimes(2)
    })

    it("keeps notifying the remaining subscribers when one invalidation callback throws", async () => {
        const failing = vi.fn(() => {
            throw new Error("subscriber exploded")
        })
        const healthy = vi.fn()
        await registry.subscribe({ taskId: "task-1", cwd: workspaceA, ...createRoots(workspaceA), invalidate: failing })
        await registry.subscribe({ taskId: "task-2", cwd: workspaceA, ...createRoots(workspaceA), invalidate: healthy })

        watchers[0].emit("change", path.join(workspaceA, ".agents", "rules", "local.md"))

        expect(failing).toHaveBeenCalledTimes(1)
        expect(healthy).toHaveBeenCalledTimes(1)
    })

    it("uses the workspace root only as a pruned bootstrap for capability directories", async () => {
        const unrelated = path.join(workspaceA, "packages")
        await registry.subscribe({
            taskId: "task-1",
            cwd: workspaceA,
            ...createRoots(workspaceA),
            invalidate: vi.fn(),
            shouldIgnoreDirectory: () => false,
        })

        expect(watch.mock.calls[0]?.[0]).toContain(workspaceA)
        expect(invokeIgnored(unrelated)).toBe(true)
        expect(invokeIgnored(path.join(workspaceA, ".agents"))).toBe(false)
    })

    it("keeps an exact scoped input's ancestors traversable only while it is tracked", async () => {
        const contested = path.join(workspaceA, "packages")
        const childAgents = path.join(contested, "app", "AGENTS.md")
        const subscription = await registry.subscribe({
            taskId: "task-1",
            cwd: workspaceA,
            ...createRoots(workspaceA),
            invalidate: vi.fn(),
        })

        await subscription.trackExact([childAgents])
        expect(invokeIgnored(contested)).toBe(false)

        await subscription.untrackExact([childAgents])
        expect(invokeIgnored(contested)).toBe(true)
    })

    it("prunes unrelated workspace directories even without subscriber ignore rules", async () => {
        const contested = path.join(workspaceA, "packages")
        await registry.subscribe({ taskId: "task-1", cwd: workspaceA, ...createRoots(workspaceA), invalidate: vi.fn() })

        expect(invokeIgnored(contested)).toBe(true)
    })
})
