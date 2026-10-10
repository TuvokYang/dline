import { readFile } from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"

/**
 * chokidar removed glob support in v4. A glob path is no longer expanded: it is
 * taken literally, matches no real file, and the watcher silently reports
 * nothing. There is no error, no warning and no failed call — the only symptom
 * is an event that never arrives, which is why `task-history-control.ts` cost a
 * full E2E investigation before the cause was found.
 *
 * The compiler cannot catch this: a glob is a well-typed string. This gate
 * reads the extension sources and rejects a glob written directly into a
 * `chokidar.watch` path argument.
 *
 * Only literal text is judged. A variable, a `path.join(...)` call or any other
 * expression is accepted, because its value is not decidable here and the
 * callers that build paths that way are the normal case.
 */

const REPO_ROOT = path.resolve(__dirname, "../../..")

/** Glob metacharacters chokidar v4 no longer expands. */
const GLOB_METACHARACTERS = /[*?]|\[[^\]]*\]/

interface WatchCall {
    readonly file: string
    readonly line: number
    readonly pathArgument: string
}

/**
 * Read the first argument of every `chokidar.watch(...)` call in `source`.
 *
 * The argument is taken by scanning to its matching delimiter rather than with
 * a regular expression, so a nested call, an array or a multi-line argument is
 * captured whole instead of being truncated at the first comma.
 */
function findWatchCalls(file: string, source: string): WatchCall[] {
    const calls: WatchCall[] = []
    const marker = /(?:chokidar\s*\.\s*watch|(?<![\w.])watch)\s*\(/g

    for (let match = marker.exec(source); match !== null; match = marker.exec(source)) {
        // `watch(` alone appears in unrelated code, so an unqualified call only
        // counts when the file imports chokidar at all.
        if (!match[0].startsWith("chokidar") && !source.includes('from "chokidar"')) {
            continue
        }

        const argument = readFirstArgument(source, match.index + match[0].length)
        if (argument === undefined) {
            continue
        }

        calls.push({
            file,
            line: source.slice(0, match.index).split("\n").length,
            pathArgument: argument,
        })
    }

    return calls
}

/** Return the source text of the first argument starting at `start`. */
function readFirstArgument(source: string, start: number): string | undefined {
    let depth = 0
    let quote: string | undefined

    for (let index = start; index < source.length; index += 1) {
        const character = source[index]

        if (quote !== undefined) {
            if (character === "\\") {
                index += 1
            } else if (character === quote) {
                quote = undefined
            }
            continue
        }

        if (character === '"' || character === "'" || character === "`") {
            quote = character
            continue
        }
        if (character === "(" || character === "[" || character === "{") {
            depth += 1
            continue
        }
        if (character === ")" || character === "]" || character === "}") {
            if (depth === 0 && character === ")") {
                return source.slice(start, index)
            }
            depth -= 1
            continue
        }
        if (character === "," && depth === 0) {
            return source.slice(start, index)
        }
    }

    return undefined
}

/**
 * Collect the static text of every string literal in `expression`.
 *
 * A template interpolation is dropped: `${filePath}-wal` contributes `-wal`,
 * because the braces belong to the interpolation and the runtime value of
 * `filePath` is not a glob written by the author.
 */
function staticStringSegments(expression: string): string[] {
    const segments: string[] = []
    const literal = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`/g

    for (let match = literal.exec(expression); match !== null; match = literal.exec(expression)) {
        const raw = match[1] ?? match[2] ?? match[3] ?? ""
        segments.push(...raw.split(/\$\{[^}]*\}/))
    }

    return segments
}

async function extensionSourceFiles(): Promise<string[]> {
    const { globby } = await import("globby")
    return globby(["src/**/*.ts"], {
        cwd: REPO_ROOT,
        absolute: true,
        gitignore: true,
    })
}

describe("chokidar watch path gate", () => {
    it("finds the watch calls it is meant to guard", async () => {
        const files = await extensionSourceFiles()

        const calls: WatchCall[] = []
        for (const file of files) {
            const source = await readFile(file, "utf8")
            if (!source.includes("chokidar")) continue
            calls.push(...findWatchCalls(path.relative(REPO_ROOT, file).replaceAll("\\", "/"), source))
        }

        // A gate that matched nothing would pass forever without guarding
        // anything, so the known callers are asserted to be visible.
        const watchedFiles = new Set(calls.map((call) => call.file))
        expect(watchedFiles).toContain("src/core/storage/TaskHistory.ts")
        expect(watchedFiles).toContain("src/test/e2e-control/task-history-control.ts")
        expect(watchedFiles).toContain("src/services/mcp/McpHub.ts")
    })

    it("passes a literal path with no glob metacharacter", () => {
        const calls = findWatchCalls("sample.ts", 'chokidar.watch("tasks/history.db", {})')

        expect(calls).toHaveLength(1)
        expect(staticStringSegments(calls[0].pathArgument).some((s) => GLOB_METACHARACTERS.test(s))).toBe(false)
    })

    it("rejects a glob written into the path argument", () => {
        const calls = findWatchCalls("sample.ts", 'chokidar.watch("control/*.request.json", {})')

        expect(calls).toHaveLength(1)
        expect(staticStringSegments(calls[0].pathArgument).some((s) => GLOB_METACHARACTERS.test(s))).toBe(true)
    })

    /**
     * `${filePath}-wal` is a real caller in TaskHistory. Its braces belong to the
     * interpolation, not to brace expansion, and must not be read as a glob.
     */
    it("does not mistake a template interpolation for a glob", () => {
        const calls = findWatchCalls("sample.ts", "chokidar.watch([filePath, `${filePath}-wal`], {})")

        expect(calls).toHaveLength(1)
        expect(staticStringSegments(calls[0].pathArgument).some((s) => GLOB_METACHARACTERS.test(s))).toBe(false)
    })

    it("has no source that watches a glob path", async () => {
        const files = await extensionSourceFiles()

        const offenders: string[] = []
        for (const file of files) {
            const relative = path.relative(REPO_ROOT, file).replaceAll("\\", "/")
            if (relative === "src/core/__tests__/ChokidarWatchPathGate.test.ts") continue

            const source = await readFile(file, "utf8")
            if (!source.includes("chokidar")) continue

            for (const call of findWatchCalls(relative, source)) {
                const offending = staticStringSegments(call.pathArgument).filter((segment) => GLOB_METACHARACTERS.test(segment))
                if (offending.length > 0) {
                    offenders.push(`${call.file}:${call.line} watches ${offending.join(", ")}`)
                }
            }
        }

        expect(offenders).toEqual([])
    })
})
