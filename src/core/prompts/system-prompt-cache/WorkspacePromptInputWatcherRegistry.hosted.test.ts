import { EventEmitter } from "node:events"
import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { VscodeWorkspaceTreeWatch } from "@/hosts/vscode/VscodeWorkspaceTreeWatch"
import { type PathWatcher, watchPaths } from "@/services/file-watch/watchPaths"
import { WorkspacePromptInputWatcherRegistry } from "./WorkspacePromptInputWatcherRegistry"

const editor = vi.hoisted(() => ({ root: "", createWatcher: vi.fn() }))
vi.mock("vscode", () => ({
    Uri: { file: (fsPath: string) => ({ scheme: "file", fsPath }) },
    RelativePattern: class {
        constructor(
            readonly baseUri: { fsPath: string },
            readonly pattern: string,
        ) {}
    },
    workspace: {
        get workspaceFolders() {
            return [{ uri: { scheme: "file", fsPath: editor.root } }]
        },
        createFileSystemWatcher: editor.createWatcher,
    },
}))

type EditorEvent = "created" | "changed" | "deleted"
type EditorListener = (uri: { fsPath: string }) => void

/** Only the editor event source is simulated; routing, filtering and settling are real. */
class EditorWatcher {
    private readonly listeners = new Map<EditorEvent, Set<EditorListener>>()
    disposed = false

    private subscribe(event: EditorEvent, listener: EditorListener) {
        let listeners = this.listeners.get(event)
        if (!listeners) {
            listeners = new Set()
            this.listeners.set(event, listeners)
        }
        listeners.add(listener)
        return { dispose: () => listeners.delete(listener) }
    }

    onDidCreate(listener: EditorListener) {
        return this.subscribe("created", listener)
    }

    onDidChange(listener: EditorListener) {
        return this.subscribe("changed", listener)
    }

    onDidDelete(listener: EditorListener) {
        return this.subscribe("deleted", listener)
    }

    fire(event: EditorEvent, fsPath: string): void {
        for (const listener of this.listeners.get(event) ?? []) listener({ fsPath })
    }

    dispose(): void {
        this.disposed = true
        this.listeners.clear()
    }
}

class MemoryFallback extends EventEmitter implements PathWatcher {
    closed = false

    constructor() {
        super()
        setImmediate(() => this.emit("ready"))
    }

    add(): this {
        return this
    }

    unwatch(): this {
        return this
    }

    async close(): Promise<void> {
        this.closed = true
        this.removeAllListeners()
    }
}

describe("workspace prompt inputs through the VS Code host adapter", () => {
    const cwd = path.resolve("tmp/virtual-prompt-input-host/workspace")
    const globalRulesDirectory = path.resolve("tmp/virtual-prompt-input-host/global/rules")
    const rule = path.join(cwd, ".agents", "rules", "local.md")
    const roots = {
        cwd,
        globalRulesDirectory,
        workflowDirectories: [path.join(cwd, ".agents", "workflows")],
        skillDirectories: [path.join(cwd, ".agents", "skills")],
        subagentDirectories: [path.join(cwd, ".agents", "subagents")] as const,
    }
    let registry: WorkspacePromptInputWatcherRegistry
    let source: EditorWatcher
    let fallback: MemoryFallback
    let fallbackPaths: string[]
    let present: Map<string, "file" | "directory">

    beforeEach(() => {
        vi.useFakeTimers()
        editor.root = cwd
        source = new EditorWatcher()
        editor.createWatcher.mockReset().mockReturnValue(source)
        present = new Map([[rule, "file"]])
        vi.spyOn(fs.promises, "stat").mockImplementation(async (candidate) => {
            const kind = present.get(String(candidate))
            if (!kind) throw Object.assign(new Error("Virtual file does not exist"), { code: "ENOENT" })
            return { isDirectory: () => kind === "directory", isFile: () => kind === "file" } as fs.Stats
        })
        const host = new VscodeWorkspaceTreeWatch()
        registry = new WorkspacePromptInputWatcherRegistry({
            watch: (paths, options) =>
                watchPaths(paths, options, {
                    host,
                    fallback: (paths) => {
                        fallbackPaths = [...paths]
                        fallback = new MemoryFallback()
                        return fallback
                    },
                }),
        })
    })

    afterEach(async () => {
        await registry.disposeAll()
        vi.clearAllTimers()
        vi.restoreAllMocks()
        vi.useRealTimers()
    })

    async function subscribe(invalidate = vi.fn()) {
        const subscription = await registry.subscribe({ ...roots, invalidate, shouldIgnoreDirectory: () => true })
        await vi.advanceTimersByTimeAsync(0)
        await subscription.ready
        return { subscription, invalidate }
    }

    it("delivers one settled Rules change despite broad directory ignores, without scanning the workspace", async () => {
        const { invalidate } = await subscribe()
        source.fire("changed", rule)
        await vi.advanceTimersByTimeAsync(200)
        source.fire("changed", rule)
        await vi.advanceTimersByTimeAsync(299)
        expect(invalidate).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(invalidate.mock.calls).toEqual([[{ absolutePath: rule, event: "change", kind: "rule" }]])
        expect(fs.promises.stat).toHaveBeenCalledTimes(2)
        expect(fs.promises.stat).toHaveBeenNthCalledWith(1, rule)
        expect(fs.promises.stat).toHaveBeenNthCalledWith(2, rule)
        expect(editor.createWatcher).toHaveBeenCalledExactlyOnceWith({ baseUri: { scheme: "file", fsPath: cwd }, pattern: "**" })
        expect(fallbackPaths).toEqual([globalRulesDirectory])
    })

    it("reuses the host watch after task replacement and routes global fallback changes to the current subscriber", async () => {
        const first = await subscribe()
        await first.subscription.dispose()
        const second = await subscribe()
        source.fire("changed", rule)
        await vi.advanceTimersByTimeAsync(300)
        const globalRule = path.join(globalRulesDirectory, "global.md")
        fallback.emit("change", globalRule)
        expect(first.invalidate).not.toHaveBeenCalled()
        expect(second.invalidate.mock.calls).toEqual([
            [{ absolutePath: rule, event: "change", kind: "rule" }],
            [{ absolutePath: globalRule, event: "change", kind: "rule" }],
        ])
        expect(editor.createWatcher).toHaveBeenCalledOnce()
        await registry.disposeAll()
        expect(source.disposed).toBe(true)
        expect(fallback.closed).toBe(true)
        source.fire("changed", rule)
        fallback.emit("change", globalRule)
        await vi.advanceTimersByTimeAsync(500)
        expect(second.invalidate).toHaveBeenCalledTimes(2)
    })

    it("invalidates Subagents when the host coalesces creation to the capability directory", async () => {
        const { invalidate } = await subscribe()
        const directory = roots.subagentDirectories[0]
        present.set(directory, "directory")
        source.fire("created", directory)
        await vi.advanceTimersByTimeAsync(299)
        expect(invalidate).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(invalidate.mock.calls).toEqual([[{ absolutePath: directory, event: "add", kind: "subagent" }]])
    })

    it("invalidates every affected source when creation is coalesced to their common parent", async () => {
        const { invalidate } = await subscribe()
        const directory = path.join(cwd, ".agents")
        present.set(directory, "directory")
        source.fire("created", directory)
        await vi.advanceTimersByTimeAsync(300)
        expect(invalidate.mock.calls.map(([change]) => change).sort((a, b) => a.kind.localeCompare(b.kind))).toEqual(
            ["rule", "skill", "subagent", "workflow"].map((kind) => ({ absolutePath: directory, event: "add", kind })),
        )
    })

    it("coalesces repeated creation events without delaying them for unrelated directories", async () => {
        const { invalidate } = await subscribe()
        const directory = roots.subagentDirectories[0]
        present.set(directory, "directory")
        source.fire("created", directory)
        await vi.advanceTimersByTimeAsync(100)
        source.fire("created", directory)
        await vi.advanceTimersByTimeAsync(100)
        const unrelatedDirectory = path.join(cwd, "src")
        present.set(unrelatedDirectory, "directory")
        source.fire("created", unrelatedDirectory)
        await vi.advanceTimersByTimeAsync(199)
        expect(invalidate).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(invalidate.mock.calls).toEqual([[{ absolutePath: directory, event: "add", kind: "subagent" }]])
        await vi.advanceTimersByTimeAsync(500)
        expect(invalidate).toHaveBeenCalledOnce()
    })

    it("does not publish a pending directory invalidation after all monitors are disposed", async () => {
        const { invalidate } = await subscribe()
        const directory = roots.subagentDirectories[0]
        present.set(directory, "directory")
        source.fire("created", directory)
        await vi.advanceTimersByTimeAsync(100)
        await registry.disposeAll()
        await vi.advanceTimersByTimeAsync(500)
        expect(invalidate).not.toHaveBeenCalled()
    })

    it("tracks a newly created Rules directory but cancels its file's pending add when the file is deleted", async () => {
        present.clear()
        const { invalidate } = await subscribe()
        const directory = path.dirname(rule)
        present.set(directory, "directory")
        source.fire("created", directory)
        present.set(rule, "file")
        source.fire("created", rule)
        await vi.advanceTimersByTimeAsync(100)
        expect(invalidate).not.toHaveBeenCalled()
        present.delete(rule)
        source.fire("deleted", rule)
        expect(invalidate.mock.calls).toEqual([[{ absolutePath: rule, event: "unlink", kind: "rule" }]])
        await vi.advanceTimersByTimeAsync(500)
        expect(invalidate.mock.calls).toEqual([
            [{ absolutePath: rule, event: "unlink", kind: "rule" }],
            [{ absolutePath: directory, event: "add", kind: "rule" }],
        ])
        expect(fs.promises.stat).toHaveBeenCalledTimes(2)
    })
})
