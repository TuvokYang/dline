import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TextEditor, Uri } from "vscode"
import { DIFF_VIEW_URI_SCHEME, VscodeDiffViewProvider } from "../VscodeDiffViewProvider"

const host = vi.hoisted(() => {
    const activeListeners = new Set<(editor: unknown) => void>()
    const visibleListeners = new Set<(editors: unknown[]) => void>()
    class TabInputText {
        constructor(public uri: { fsPath: string }) {}
    }
    class TabInputTextDiff {
        constructor(
            public original: { scheme: string },
            public modified: { fsPath: string },
        ) {}
    }
    return {
        activeListeners,
        visibleListeners,
        TabInputText,
        TabInputTextDiff,
        window: {
            visibleTextEditors: [] as unknown[],
            tabGroups: { all: [] as Array<{ tabs: unknown[] }>, close: vi.fn().mockResolvedValue(true) },
            onDidChangeActiveTextEditor: (listener: (editor: unknown) => void) => {
                activeListeners.add(listener)
                return { dispose: () => activeListeners.delete(listener) }
            },
            onDidChangeVisibleTextEditors: (listener: (editors: unknown[]) => void) => {
                visibleListeners.add(listener)
                return { dispose: () => visibleListeners.delete(listener) }
            },
        },
        commands: { executeCommand: vi.fn() },
    }
})

vi.mock("vscode", () => ({
    ...host,
    Uri: {
        file: (fsPath: string) => ({ fsPath, scheme: "file" }),
        parse: (value: string) => ({ with: (changes: object) => ({ value, ...changes }) }),
    },
}))
vi.mock("@/hosts/vscode/DecorationController", () => ({
    DecorationController: class {
        addLines() {}
    },
}))
vi.mock("@/registry", () => ({ ExtensionRegistryInfo: { diffUriScheme: "dline-diff" } }))

class TestDiff extends VscodeDiffViewProvider {
    constructor(file: string) {
        super()
        this.absolutePath = file
        this.editType = "create"
    }

    readText() {
        return this.getDocumentText()
    }

    closeViews() {
        return this.closeAllDiffViews()
    }
}

function createEditor(file: string, text: string): TextEditor {
    return { document: { uri: { fsPath: file }, lineCount: 1, getText: () => text } } as TextEditor
}

function showEditors(editors: TextEditor[]) {
    host.window.visibleTextEditors = editors
    for (const listener of host.visibleListeners) listener(editors)
}

function openResult(provider: TestDiff) {
    return provider.openDiffEditor().then(
        () => provider.readText(),
        (error: unknown) => error,
    )
}

beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    host.activeListeners.clear()
    host.visibleListeners.clear()
    host.window.visibleTextEditors = []
    host.window.tabGroups.all = []
    host.commands.executeCommand.mockResolvedValue(undefined)
})

afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
})

describe("diff editor ownership", () => {
    it("opens a visible diff without requiring an active-editor event", async () => {
        host.commands.executeCommand.mockImplementation(async (_command: string, _original: Uri, modified: Uri) => {
            showEditors([createEditor(modified.fsPath, "ready without focus")])
        })
        const result = openResult(new TestDiff("/workspace/a.txt"))
        await vi.advanceTimersByTimeAsync(0)
        expect(vi.getTimerCount()).toBe(0)
        await expect(result).resolves.toBe("ready without focus")
        expect(host.activeListeners.size).toBe(0)
        expect(host.visibleListeners.size).toBe(0)
        expect(vi.getTimerCount()).toBe(0)
    })

    it("finds an editor already visible when the diff command finishes", async () => {
        host.commands.executeCommand.mockImplementation(async (_command: string, _original: Uri, modified: Uri) => {
            host.window.visibleTextEditors = [createEditor(modified.fsPath, "already visible")]
        })
        const result = openResult(new TestDiff("/workspace/a.txt"))
        await vi.advanceTimersByTimeAsync(10_000)
        await expect(result).resolves.toBe("already visible")
    })

    it("keeps concurrent diff results attached to their own modified document", async () => {
        const first = new TestDiff("/workspace/a.txt")
        const second = new TestDiff("/workspace/b.txt")
        const results = [openResult(first), openResult(second)]
        await vi.advanceTimersByTimeAsync(0)
        showEditors([createEditor("/workspace/b.txt", "B"), createEditor("/workspace/a.txt", "A")])
        await vi.advanceTimersByTimeAsync(10_000)
        await expect(Promise.all(results)).resolves.toEqual(["A", "B"])
        expect(host.visibleListeners.size).toBe(0)
        expect(vi.getTimerCount()).toBe(0)
    })

    it("retains a revealed editor when another diff replaces its visible slot before command completion", async () => {
        let finish: (() => void) | undefined
        host.commands.executeCommand.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve
                }),
        )
        const result = openResult(new TestDiff("/workspace/a.txt"))
        showEditors([createEditor("/workspace/a.txt", "A revealed first")])
        showEditors([createEditor("/workspace/b.txt", "B now visible")])
        finish?.()
        await vi.advanceTimersByTimeAsync(10_000)
        await expect(result).resolves.toBe("A revealed first")
    })

    it("does not reuse a revealed document that was closed before the command finished", async () => {
        let finish: (() => void) | undefined
        host.commands.executeCommand.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve
                }),
        )
        const result = openResult(new TestDiff("/workspace/a.txt"))
        const editor = createEditor("/workspace/a.txt", "closed")
        showEditors([editor])
        Object.defineProperty(editor.document, "isClosed", { value: true })
        showEditors([])
        finish?.()
        await vi.advanceTimersByTimeAsync(10_000)
        await expect(result).resolves.toBeInstanceOf(Error)
        expect(host.visibleListeners.size).toBe(0)
    })

    it("retains the original timeout and releases its observer when no editor appears", async () => {
        const result = openResult(new TestDiff("/workspace/missing.txt"))
        await vi.advanceTimersByTimeAsync(10_000)
        await expect(result).resolves.toBeInstanceOf(Error)
        expect(host.visibleListeners.size).toBe(0)
        expect(host.activeListeners.size).toBe(0)
        expect(vi.getTimerCount()).toBe(0)
    })

    it("propagates a diff command failure and immediately releases its observer and timer", async () => {
        const failure = new Error("Diff command rejected")
        host.commands.executeCommand.mockRejectedValue(failure)
        const result = openResult(new TestDiff("/workspace/a.txt"))
        await vi.advanceTimersByTimeAsync(0)
        await expect(result).resolves.toBe(failure)
        expect(host.visibleListeners.size).toBe(0)
        expect(vi.getTimerCount()).toBe(0)
    })

    it("does not let an unrelated visible document satisfy the open request", async () => {
        const result = openResult(new TestDiff("/workspace/a.txt"))
        await vi.advanceTimersByTimeAsync(0)
        showEditors([createEditor("/workspace/b.txt", "B")])
        await vi.advanceTimersByTimeAsync(9_999)
        expect(host.visibleListeners.size).toBe(1)
        await vi.advanceTimersByTimeAsync(1)
        await expect(result).resolves.toBeInstanceOf(Error)
        expect(host.visibleListeners.size).toBe(0)
    })

    it("closes only clean diff tabs belonging to this edit", async () => {
        const tab = (file: string, dirty = false, scheme = DIFF_VIEW_URI_SCHEME) => ({
            input: new host.TabInputTextDiff({ scheme }, { fsPath: file }),
            isDirty: dirty,
        })
        const owned = tab("/workspace/a.txt")
        const other = tab("/workspace/b.txt")
        const dirty = tab("/workspace/a.txt", true)
        const foreign = tab("/workspace/a.txt", false, "git")
        const tabs = [owned, other, dirty, foreign]
        host.window.tabGroups.all = [{ tabs }]
        host.window.tabGroups.close.mockImplementation(async (closed: unknown) => {
            tabs.splice(tabs.indexOf(closed as typeof owned), 1)
            return true
        })
        await new TestDiff("/workspace/a.txt").closeViews()
        expect(tabs).toEqual([other, dirty, foreign])
    })
})
