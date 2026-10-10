import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Count how often the WASM runtime and each grammar are actually initialized.
 *
 * `web-tree-sitter` is mocked because the real module loads binary grammars
 * from disk; the defect under test is the call pattern, not the grammar.
 */
const initCalls = { runtime: 0, languages: [] as string[] }
let runtimeInitGate: Promise<void> = Promise.resolve()

vi.mock("web-tree-sitter", () => {
    class FakeQuery {}
    class FakeLanguage {
        query(): FakeQuery {
            return new FakeQuery()
        }
    }
    class FakeParser {
        static async init(): Promise<void> {
            initCalls.runtime += 1
            await runtimeInitGate
        }
        static Language = {
            async load(wasmPath: string): Promise<FakeLanguage> {
                initCalls.languages.push(wasmPath)
                return new FakeLanguage()
            },
        }
        setLanguage(): void {}
    }
    return { default: FakeParser }
})

describe("loadRequiredLanguageParsers under concurrency", () => {
    beforeEach(() => {
        initCalls.runtime = 0
        initCalls.languages = []
        runtimeInitGate = Promise.resolve()
        vi.resetModules()
    })

    // Several subagents call list_code_definition_names at the same time. The
    // guard was a plain boolean set only after `await Parser.init()` resolved, so
    // every concurrent caller passed the check and re-entered the WASM runtime
    // initialization, which is not re-entrant.
    it("initializes the WASM runtime exactly once for concurrent callers", async () => {
        let releaseInit: () => void = () => undefined
        runtimeInitGate = new Promise<void>((resolve) => {
            releaseInit = resolve
        })
        const { loadRequiredLanguageParsers } = await import("../languageParser")

        const pending = Promise.all([
            loadRequiredLanguageParsers(["a.ts"]),
            loadRequiredLanguageParsers(["b.ts"]),
            loadRequiredLanguageParsers(["c.ts"]),
            loadRequiredLanguageParsers(["d.ts"]),
        ])
        releaseInit()
        await pending

        expect(initCalls.runtime).toBe(1)
    })

    // Each concurrent caller also reloaded and recompiled the same grammar.
    it("loads each grammar exactly once for concurrent callers", async () => {
        let releaseInit: () => void = () => undefined
        runtimeInitGate = new Promise<void>((resolve) => {
            releaseInit = resolve
        })
        const { loadRequiredLanguageParsers } = await import("../languageParser")

        const pending = Promise.all([
            loadRequiredLanguageParsers(["a.ts"]),
            loadRequiredLanguageParsers(["b.ts"]),
            loadRequiredLanguageParsers(["c.ts"]),
        ])
        releaseInit()
        await pending

        const typescriptLoads = initCalls.languages.filter((wasmPath) => wasmPath.includes("typescript"))
        expect(typescriptLoads).toHaveLength(1)
    })

    it("reuses the cached grammar across sequential calls", async () => {
        const { loadRequiredLanguageParsers } = await import("../languageParser")

        await loadRequiredLanguageParsers(["a.ts"])
        await loadRequiredLanguageParsers(["b.ts"])

        expect(initCalls.runtime).toBe(1)
        expect(initCalls.languages.filter((wasmPath) => wasmPath.includes("typescript"))).toHaveLength(1)
    })

    it("still returns a parser for every requested extension", async () => {
        const { loadRequiredLanguageParsers } = await import("../languageParser")

        const parsers = await loadRequiredLanguageParsers(["a.ts", "b.py", "c.tsx"])

        expect(Object.keys(parsers).sort()).toEqual(["py", "ts", "tsx"])
    })

    // A failed initialization must not poison later attempts: the cached promise
    // has to be cleared so a retry can genuinely re-initialize.
    it("allows a retry after the runtime initialization fails", async () => {
        runtimeInitGate = Promise.reject(new Error("wasm init failed"))
        // Prevent an unhandled rejection warning before the module consumes it.
        runtimeInitGate.catch(() => undefined)
        const { loadRequiredLanguageParsers } = await import("../languageParser")

        await expect(loadRequiredLanguageParsers(["a.ts"])).rejects.toThrow("wasm init failed")

        runtimeInitGate = Promise.resolve()
        await expect(loadRequiredLanguageParsers(["a.ts"])).resolves.toBeDefined()
        expect(initCalls.runtime).toBe(2)
    })
})
