import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
// @ts-expect-error -- the archive command is plain ESM without type declarations.
import { appendHistory } from "../../scripts/append-history.mjs"
import { listHistoryVersions, readChangelog } from "../../scripts/changelog.mjs"
import { parseChangelog } from "../../scripts/changelog-parser.mjs"

/**
 * Real-file behavior tests: the oracle is the input bodies, parsed output,
 * complete byte/directory trees and subprocess exit status, not generated prose.
 * Injected fs operations forward to real disk, except at deterministic failure
 * boundaries that cannot be reproduced reliably with permissions on Windows.
 * Fixtures and subprocess scratch state stay inside the repository's tmp area.
 */
const PROJECT_ROOT = process.cwd()
const CLI = path.join(PROJECT_ROOT, "scripts", "append-history.mjs")
const LANGUAGES = ["english", "chinese"] as const
type Language = (typeof LANGUAGES)[number]
const CURRENT = { english: "docs/changelog/CHANGELOG_en.md", chinese: "CHANGELOG.md" }
const HISTORY = { english: "docs/changelog/history.en.md", chinese: "docs/changelog/history.zh-CN.md" }
const GUARD = "docs/changelog/.history-lock"
const VERSION = "0.14.1"
const BODIES = {
    english:
        "### Fixed\n\n- English release fix with [details](../../README.md).\n\n```markdown\n## [9.9.9]\n- This is a sample, not another release.\n```",
    chinese:
        "### Fixed\n\n- 中文发布修复，保留 [详情](../../README_zh.md)。\n\n~~~markdown\n## [9.9.9]\n- 这是示例，不是其它版本。\n~~~",
}
const PROTECTED = [
    ...Object.values(CURRENT),
    "package.json",
    "package-lock.json",
    "docs/whats-new/WHATS_NEW.md",
    "docs/whats-new/WHATS_NEW_en.md",
    "docs/changelog/current.en.md",
    "docs/changelog/current.zh-CN.md",
]
let root = ""

function write(relativePath: string, contents: string): void {
    const absolute = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, contents, "utf8")
}

function read(relativePath: string): string {
    return fs.readFileSync(path.join(root, relativePath), "utf8")
}

function exists(relativePath: string): boolean {
    return fs.existsSync(path.join(root, relativePath))
}

/** Include empty directories and exact file bytes so guard/temp creation is visible. */
function tree(): Record<string, string> {
    const entries: Record<string, string> = {}
    const visit = (directory: string) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const absolute = path.join(directory, entry.name)
            const relative = path.relative(root, absolute).split(path.sep).join("/")
            if (entry.isDirectory()) {
                entries[`${relative}/`] = "directory"
                visit(absolute)
            } else {
                entries[relative] = fs.readFileSync(absolute).toString("hex")
            }
        }
    }
    visit(root)
    return entries
}

function source(version: string, body: string): string {
    return `# Changelog\n\n## [${version}]\n\n${body}\n`
}

function oldBody(language: Language, version: string): string {
    const note = language === "english" ? "Earlier English notes" : "早期中文说明"
    return `### Added\n\n- ${note} ${version}.  \n  Continuation.\n\n\`\`\`\`markdown\n## [8.8.8]\n\`\`\`\nNested fence sample.\n\`\`\`\`\n\n- Last paragraph of ${version}.`
}

function historySource(language: Language, versions: string[]): string {
    return `# Maintained history\n\n${versions.map((version) => `## [${version}]\n\n${oldBody(language, version)}\n`).join("\n")}`
}

function createRoot(versions: string[] = []): void {
    write(CURRENT.english, `\uFEFFEnglish maintenance notes\r\n\r\n${source(VERSION, BODIES.english).replaceAll("\n", "\r\n")}`)
    write(CURRENT.chinese, `中文维护说明\n\n${source(VERSION, BODIES.chinese)}`)
    // Deliberately unrelated versions: append must never infer from a manifest,
    // highlights, or the obsolete current-source paths.
    write("package.json", '{"name":"fixture","version":"3.2.1"}\r\n')
    write("package-lock.json", '{"version":"3.2.1"}\n')
    write("docs/whats-new/WHATS_NEW.md", "## 3.2.1\n\n- 中文精选。\n")
    write("docs/whats-new/WHATS_NEW_en.md", "## 3.2.1\n\n- English highlights.\n")
    write("docs/changelog/current.en.md", source("7.7.7", "- Obsolete English path."))
    write("docs/changelog/current.zh-CN.md", source("7.7.7", "- 过时中文路径。"))
    if (versions.length > 0) {
        for (const language of LANGUAGES) {
            const contents = historySource(language, versions)
            write(HISTORY[language], language === "english" ? `\uFEFF${contents.replaceAll("\n", "\r\n")}` : contents)
        }
    }
}

function archive(options: Record<string, unknown> = {}) {
    return appendHistory({ root, version: VERSION, ...options })
}

function injectedFs(overrides: Record<string, unknown>): Record<string, unknown> {
    return { ...fs, ...overrides }
}

function expectProtected(before: Record<string, string>): void {
    const after = tree()
    for (const relativePath of PROTECTED) expect(after[relativePath], relativePath).toBe(before[relativePath])
}

function expectClean(): void {
    expect(exists(GUARD)).toBe(false)
    for (const sourcePath of Object.values(HISTORY)) expect(exists(`${sourcePath}.tmp`)).toBe(false)
    expect(exists("docs/changelog/history")).toBe(false)
}

function expectHistory(versions: string[]): void {
    for (const language of LANGUAGES) {
        const parsed = parseChangelog(read(HISTORY[language])).sections
        expect(parsed.map((section) => section.version)).toEqual(versions)
        expect(parsed.map((section) => section.body)).toEqual(
            versions.map((version) => (version === VERSION ? BODIES[language] : oldBody(language, version))),
        )
        for (const version of versions) {
            const notes = readChangelog({ root, version, source: "history" })
            expect(notes[language].body).toBe(version === VERSION ? BODIES[language] : oldBody(language, version))
            expect(notes[language].sourcePath).toBe(HISTORY[language])
        }
    }
}

function runCli(args: string[]) {
    return spawnSync(process.execPath, [CLI, "--root", root, ...args], {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
    })
}

beforeEach(() => {
    const scratch = path.join(PROJECT_ROOT, "tmp")
    fs.mkdirSync(scratch, { recursive: true })
    root = fs.mkdtempSync(path.join(scratch, "append-history-"))
})

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})

describe("appendHistory: per-language full-body history", () => {
    it("creates only two history files, keeps languages independent and leaves every current byte intact", () => {
        createRoot()
        const before = tree()

        const result = archive()

        expect(result.action).toBe("created")
        expect(result.historyPaths).toEqual(HISTORY)
        expect(result.written).toEqual(Object.values(HISTORY))
        expectHistory([VERSION])
        const after = tree()
        expect(
            Object.keys(after)
                .filter((entry) => !(entry in before))
                .sort(),
        ).toEqual(Object.values(HISTORY).sort())
        expectProtected(before)
        // A source link, language concatenation or extra title would contaminate
        // the release body and fail the exact independent body assertions above.
        expectClean()
    })

    it("prepends rather than sorts and retains every older full body, including fences and continuations", () => {
        createRoot(["0.12.0", "0.14.0"])
        const before = tree()

        archive()

        expectHistory([VERSION, "0.12.0", "0.14.0"])
        expect(listHistoryVersions({ root })).toEqual([VERSION, "0.14.0", "0.12.0"])
        expectProtected(before)
        expectClean()
    })

    it("leaves an identical re-run byte-for-byte unchanged, even with a different preamble, BOM or CRLF", () => {
        createRoot(["0.14.0"])
        archive()
        write(
            HISTORY.english,
            `\uFEFFArchive preamble kept by its maintainer\r\n\r\n${read(HISTORY.english).replaceAll("\n", "\r\n")}`,
        )
        const before = tree()

        const result = archive()

        expect(result.action).toBe("noop")
        expect(result.written).toEqual([])
        expect(result.unchanged).toEqual(Object.values(HISTORY))
        expect(tree()).toEqual(before)
        expectHistory([VERSION, "0.14.0"])
        expectClean()
    })

    it("refuses a prepend whose unterminated current fence would swallow older history sections", () => {
        createRoot(["0.14.0"])
        write(CURRENT.english, source(VERSION, `${BODIES.english}\n\n\`\`\`markdown\n- Unclosed sample.`))
        const before = tree()

        for (const dryRun of [true, false]) {
            expect(() => archive({ dryRun })).toThrow()
            expect(tree()).toEqual(before)
        }
        expectClean()
    })

    it.each([false, true])("dry-run performs zero filesystem mutations (already archived: %s)", (archived) => {
        createRoot()
        if (archived) archive()
        const before = tree()
        const forbidden = () => {
            throw new Error("dry-run attempted a mutating filesystem call")
        }
        const fileSystem = injectedFs({
            mkdirSync: forbidden,
            openSync: forbidden,
            writeFileSync: forbidden,
            renameSync: forbidden,
            unlinkSync: forbidden,
            rmdirSync: forbidden,
            rmSync: forbidden,
        })

        const result = archive({ dryRun: true, fileSystem })

        expect(result.action).toBe("dry-run")
        expect(result.written).toEqual([])
        expect(result.planned).toEqual(archived ? [] : Object.values(HISTORY))
        expect(tree()).toEqual(before)
        expectClean()
    })

    it.each(LANGUAGES)("never overwrites different already-archived %s notes", (language) => {
        createRoot(["0.14.0"])
        archive()
        write(CURRENT[language], source(VERSION, "- A later edit that must not replace the archived release."))
        const before = tree()

        for (const dryRun of [true, false]) {
            expect(() => archive({ dryRun })).toThrow(/different/)
            expect(tree()).toEqual(before)
        }
        expectClean()
    })
})

describe("archive preconditions", () => {
    const invalidCurrent = [
        "Unreleased with notes",
        "empty Unreleased",
        "two released versions",
        "Unreleased plus release",
        "different bilingual versions",
        "both releases empty",
        "Chinese release empty",
        "English source missing",
        "no version heading",
    ] as const

    it.each(invalidCurrent)("refuses %s before creating history, guards or temps", (scenario) => {
        createRoot()
        switch (scenario) {
            case "Unreleased with notes":
            case "empty Unreleased":
                for (const language of LANGUAGES) {
                    write(CURRENT[language], source("Unreleased", scenario === "empty Unreleased" ? "" : BODIES[language]))
                }
                break
            case "two released versions":
            case "Unreleased plus release":
                for (const language of LANGUAGES) {
                    const extra = scenario === "two released versions" ? "0.14.0" : "Unreleased"
                    write(CURRENT[language], `${source(VERSION, BODIES[language])}\n## [${extra}]\n\n- Extra section.\n`)
                }
                break
            case "different bilingual versions":
                write(CURRENT.chinese, source("0.14.2", BODIES.chinese))
                break
            case "both releases empty":
                write(CURRENT.english, source(VERSION, ""))
                write(CURRENT.chinese, source(VERSION, ""))
                break
            case "Chinese release empty":
                write(CURRENT.chinese, source(VERSION, ""))
                break
            case "English source missing":
                fs.unlinkSync(path.join(root, CURRENT.english))
                break
            case "no version heading":
                write(CURRENT.english, "# Changelog\n\n- Orphaned notes.\n")
                break
        }
        const before = tree()
        for (const dryRun of [true, false]) {
            expect(() => archive({ dryRun })).toThrow()
            expect(tree()).toEqual(before)
        }
        expectClean()
    })

    it.each([
        undefined,
        null,
        "",
        "Unreleased",
        "v0.14.1",
        "0.14.1-dev.1",
        "0.14.1+build",
        "../0.14.1",
        "9.9.9",
    ])("requires an explicit plain release matching the frozen current: %s", (version) => {
        createRoot()
        const before = tree()
        expect(() => archive({ version })).toThrow()
        expect(tree()).toEqual(before)
        expectClean()
    })

    const invalidHistory = [
        "unpaired older release",
        "unpaired older release beside matching current",
        "empty older release",
        "Unreleased in history",
        "duplicate older release",
        "duplicate archive release",
        "empty history file",
        "history without sections",
        "conflicting partial release",
        "partial release not first",
    ] as const

    it.each(invalidHistory)("rejects the entire history set: %s", (scenario) => {
        createRoot(["0.14.0"])
        switch (scenario) {
            case "unpaired older release":
                fs.unlinkSync(path.join(root, HISTORY.chinese))
                break
            case "unpaired older release beside matching current":
                write(HISTORY.english, `${source(VERSION, BODIES.english)}\n## [0.14.0]\n\n${oldBody("english", "0.14.0")}\n`)
                write(HISTORY.chinese, source(VERSION, BODIES.chinese))
                break
            case "empty older release":
                write(HISTORY.chinese, source("0.14.0", ""))
                break
            case "Unreleased in history":
                write(HISTORY.english, `${read(HISTORY.english)}\n## [Unreleased]\n\n- Not released.\n`)
                break
            case "duplicate older release":
                write(HISTORY.english, `${read(HISTORY.english)}\n## [0.14.0]\n\n- Duplicated.\n`)
                break
            case "duplicate archive release":
                write(HISTORY.english, `${source(VERSION, BODIES.english)}\n## [${VERSION}]\n\n${BODIES.english}\n`)
                break
            case "empty history file":
                write(HISTORY.chinese, "")
                break
            case "history without sections":
                write(HISTORY.chinese, "# History\n\nNotes without a version.\n")
                break
            case "conflicting partial release":
                write(HISTORY.english, `${source(VERSION, "- Unknown different release notes.")}\n${read(HISTORY.english)}`)
                break
            case "partial release not first":
                write(HISTORY.english, `${read(HISTORY.english)}\n## [${VERSION}]\n\n${BODIES.english}\n`)
                break
        }
        const before = tree()
        for (const dryRun of [true, false]) {
            expect(() => archive({ dryRun })).toThrow()
            expect(tree()).toEqual(before)
        }
        expectClean()
    })
})

describe("writer exclusion and unknown state", () => {
    it("preserves another writer's guard for writes and dry-runs instead of auto-breaking it", () => {
        createRoot()
        write(`${GUARD}/owner`, "unknown writer pid 1234")
        const before = tree()

        for (const dryRun of [true, false]) {
            expect(() => archive({ dryRun })).toThrow()
            expect(tree()).toEqual(before)
        }
        expect(read(`${GUARD}/owner`)).toBe("unknown writer pid 1234")
    })

    it.each([false, true])("refuses unknown temp files/directories, including on noop (archived: %s)", (archived) => {
        createRoot()
        if (archived) archive()
        write(`${HISTORY.english}.tmp`, "foreign interrupted file")
        fs.mkdirSync(path.join(root, `${HISTORY.chinese}.tmp`))
        const before = tree()

        for (const dryRun of [true, false]) {
            expect(() => archive({ dryRun })).toThrow()
            expect(tree()).toEqual(before)
        }
        // Checking the second temp is not optional just because the first was found.
        fs.unlinkSync(path.join(root, `${HISTORY.english}.tmp`))
        const withoutFirst = tree()
        expect(() => archive()).toThrow()
        expect(tree()).toEqual(withoutFirst)
        expect(exists(GUARD)).toBe(false)
    })

    it("does not release a guard won by another writer after the initial inspection", () => {
        createRoot()
        const fileSystem = injectedFs({
            mkdirSync: (file: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
                if (file === path.join(root, GUARD)) write(`${GUARD}/owner`, "racing writer")
                return fs.mkdirSync(file, options)
            },
        })
        const before = tree()

        expect(() => archive({ fileSystem })).toThrow()

        expect(read(`${GUARD}/owner`)).toBe("racing writer")
        expectProtected(before)
        for (const sourcePath of Object.values(HISTORY)) expect(exists(sourcePath)).toBe(false)
    })

    it.each(LANGUAGES)("uses exclusive temp creation and preserves a %s temp won in a race", (language) => {
        createRoot(["0.14.0"])
        const before = tree()
        const temporary = path.join(root, `${HISTORY[language]}.tmp`)
        const fileSystem = injectedFs({
            openSync: (file: fs.PathLike, flags: fs.OpenMode) => {
                if (file === temporary) fs.writeFileSync(temporary, "foreign concurrent temp")
                return fs.openSync(file, flags)
            },
        })

        expect(() => archive({ fileSystem })).toThrow()

        expect(fs.readFileSync(temporary, "utf8")).toBe("foreign concurrent temp")
        for (const sourcePath of Object.values(HISTORY)) expect(tree()[sourcePath]).toBe(before[sourcePath])
        const other = language === "english" ? "chinese" : "english"
        expect(exists(`${HISTORY[other]}.tmp`)).toBe(false)
        expectProtected(before)
        expect(exists(GUARD)).toBe(false)
    })

    it("excludes a real second CLI process while the first holds the guard", () => {
        createRoot()
        let second: ReturnType<typeof runCli> | undefined
        const fileSystem = injectedFs({
            writeFileSync: (file: fs.PathOrFileDescriptor, contents: string, encoding: BufferEncoding) => {
                if (!second && typeof file === "number") second = runCli(["--version", VERSION])
                fs.writeFileSync(file, contents, encoding)
            },
        })

        archive({ fileSystem })

        expect(second?.error).toBeUndefined()
        expect(second?.status).toBe(1)
        expectHistory([VERSION])
        expectClean()
    })

    it("re-reads under the claimed guard so a completed intervening archive cannot be lost", () => {
        createRoot(["0.14.0"])
        let intervened = false
        const fileSystem = injectedFs({
            mkdirSync: (file: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
                if (file === path.join(root, GUARD) && !intervened) {
                    intervened = true
                    for (const language of LANGUAGES) write(HISTORY[language], historySource(language, ["0.13.0", "0.14.0"]))
                }
                return fs.mkdirSync(file, options)
            },
        })

        archive({ fileSystem })

        expect(intervened).toBe(true)
        expectHistory([VERSION, "0.13.0", "0.14.0"])
        expectClean()
    })

    it("preserves a history file unexpectedly changed while replacements were staged", () => {
        createRoot(["0.14.0"])
        const before = tree()
        let writes = 0
        const foreign = source("2.0.0", "- A non-cooperating editor's text.")
        const fileSystem = injectedFs({
            writeFileSync: (file: fs.PathOrFileDescriptor, contents: string, encoding: BufferEncoding) => {
                fs.writeFileSync(file, contents, encoding)
                if (typeof file === "number" && ++writes === 2) write(HISTORY.english, foreign)
            },
        })

        expect(() => archive({ fileSystem })).toThrow()

        expect(read(HISTORY.english)).toBe(foreign)
        expect(tree()[HISTORY.chinese]).toBe(before[HISTORY.chinese])
        expectProtected(before)
        expectClean()
    })
})

describe("write failures and interrupted publication", () => {
    it.each([1, 2])("cleans a partially written temp at staging write %s without publishing either history", (failedWrite) => {
        createRoot(["0.14.0"])
        const before = tree()
        let writes = 0
        const fileSystem = injectedFs({
            writeFileSync: (file: fs.PathOrFileDescriptor, contents: string, encoding: BufferEncoding) => {
                if (typeof file === "number" && ++writes === failedWrite) {
                    fs.writeFileSync(file, "partial bytes", encoding)
                    throw new Error("ENOSPC injected during history write")
                }
                fs.writeFileSync(file, contents, encoding)
            },
        })

        expect(() => archive({ fileSystem })).toThrow(/ENOSPC/)
        expect(writes).toBe(failedWrite)
        expect(tree()).toEqual(before)
        expectClean()
        archive()
        expectHistory([VERSION, "0.14.0"])
    })

    it("verifies staged bytes before publishing, so a truncated write cannot replace either language", () => {
        createRoot(["0.14.0"])
        const before = tree()
        const fileSystem = injectedFs({
            writeFileSync: (file: fs.PathOrFileDescriptor, contents: string, encoding: BufferEncoding) => {
                fs.writeFileSync(file, typeof file === "number" ? contents.slice(0, 17) : contents, encoding)
            },
        })

        expect(() => archive({ fileSystem })).toThrow()

        expect(tree()).toEqual(before)
        expectClean()
    })

    it("leaves existing histories intact when the first replacement rename fails", () => {
        createRoot(["0.14.0"])
        const before = tree()
        const fileSystem = injectedFs({
            renameSync: () => {
                throw new Error("EACCES injected before first publication")
            },
        })

        expect(() => archive({ fileSystem })).toThrow(/EACCES/)

        expect(tree()).toEqual(before)
        expectClean()
    })

    it.each([
        false,
        true,
    ])("reports a second-rename failure and repairs only the missing release (older history: %s)", (older) => {
        const previous = older ? ["0.14.0"] : []
        createRoot(previous)
        const before = tree()
        const fileSystem = injectedFs({
            renameSync: (from: fs.PathLike, to: fs.PathLike) => {
                if (to === path.join(root, HISTORY.chinese)) throw new Error("EIO injected during Chinese publication")
                fs.renameSync(from, to)
            },
        })
        let failure = ""
        try {
            archive({ fileSystem })
        } catch (error) {
            failure = String(error)
        }

        expect(failure).toMatch(/EIO/)
        expect(failure).toContain(HISTORY.english)
        expect(failure).toContain(VERSION)
        expect(parseChangelog(read(HISTORY.english)).sections[0].body).toBe(BODIES.english)
        expect(tree()[HISTORY.chinese]).toBe(before[HISTORY.chinese])
        expect(() => listHistoryVersions({ root })).toThrow()
        expectProtected(before)
        expectClean()
        const partial = tree()
        expect(archive({ dryRun: true }).planned).toEqual([HISTORY.chinese])
        expect(tree()).toEqual(partial)

        const repaired = archive()

        expect(repaired.action).toBe("resumed")
        expect(repaired.written).toEqual([HISTORY.chinese])
        expect(tree()[HISTORY.english]).toBe(partial[HISTORY.english])
        expectHistory([VERSION, ...previous])
        expectProtected(before)
        const complete = tree()
        expect(archive().action).toBe("noop")
        expect(tree()).toEqual(complete)
        expectClean()
    })

    it("can complete an exact Chinese-only partial release without rewriting it", () => {
        createRoot(["0.14.0"])
        write(HISTORY.chinese, `${source(VERSION, BODIES.chinese)}\n## [0.14.0]\n\n${oldBody("chinese", "0.14.0")}\n`)
        const before = tree()

        const repaired = archive()

        expect(repaired.action).toBe("resumed")
        expect(repaired.written).toEqual([HISTORY.english])
        expect(tree()[HISTORY.chinese]).toBe(before[HISTORY.chinese])
        expectHistory([VERSION, "0.14.0"])
        expectProtected(before)
        expectClean()
    })

    it("reports a cleanup failure together with the original write failure and preserves the residual temp", () => {
        createRoot(["0.14.0"])
        const before = tree()
        const temporary = path.join(root, `${HISTORY.english}.tmp`)
        const fileSystem = injectedFs({
            writeFileSync: (file: fs.PathOrFileDescriptor, _contents: string, encoding: BufferEncoding) => {
                fs.writeFileSync(file, "incomplete bytes", encoding)
                throw new Error("ENOSPC original write failure")
            },
            unlinkSync: (file: fs.PathLike) => {
                if (file === temporary) throw new Error("EACCES temp cleanup failure")
                fs.unlinkSync(file)
            },
        })

        expect(() => archive({ fileSystem })).toThrow(/ENOSPC[\s\S]*EACCES/)
        expect(fs.readFileSync(temporary, "utf8")).toBe("incomplete bytes")
        for (const sourcePath of Object.values(HISTORY)) expect(tree()[sourcePath]).toBe(before[sourcePath])
        expectProtected(before)
        expect(exists(GUARD)).toBe(false)
        const failed = tree()
        expect(() => archive()).toThrow()
        expect(tree()).toEqual(failed)
    })

    it("does not claim success or remove foreign guard contents when guard release fails", () => {
        createRoot()
        const before = tree()
        const fileSystem = injectedFs({
            renameSync: (from: fs.PathLike, to: fs.PathLike) => {
                fs.renameSync(from, to)
                write(`${GUARD}/foreign`, "unexpected guard contents")
            },
        })

        expect(() => archive({ fileSystem })).toThrow()

        expectHistory([VERSION])
        expect(read(`${GUARD}/foreign`)).toBe("unexpected guard contents")
        expectProtected(before)
        const guarded = tree()
        expect(() => archive()).toThrow()
        expect(tree()).toEqual(guarded)
    })

    it("diagnoses real abrupt process exit, requires manual residual inspection, then safely completes the exact partial release", () => {
        createRoot(["0.14.0"])
        const before = tree()
        // No helper file is written: the child runs the actual archive and exits
        // immediately after the first real rename, bypassing every finally block.
        const program = `
            import fs from 'node:fs';
            import path from 'node:path';
            import { appendHistory } from ${JSON.stringify(pathToFileURL(CLI).href)};
            const root = ${JSON.stringify(root)};
            appendHistory({ root, version: ${JSON.stringify(VERSION)}, fileSystem: {
                ...fs,
                renameSync(from, to) {
                    fs.renameSync(from, to);
                    if (to === path.join(root, ${JSON.stringify(HISTORY.english)})) process.exit(71);
                }
            }});
        `
        const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
            cwd: PROJECT_ROOT,
            encoding: "utf8",
            timeout: 10_000,
            windowsHide: true,
        })

        expect(child.error).toBeUndefined()
        expect(child.status, child.stderr).toBe(71)
        expect(exists(GUARD)).toBe(true)
        expect(exists(`${HISTORY.chinese}.tmp`)).toBe(true)
        expect(tree()[HISTORY.chinese]).toBe(before[HISTORY.chinese])
        expectProtected(before)
        const interrupted = tree()
        expect(() => archive()).toThrow()
        expect(tree()).toEqual(interrupted)

        // These are deliberate maintainer actions after inspection, not automatic
        // lock breaking or adoption of a file that the new process does not own.
        fs.rmdirSync(path.join(root, GUARD))
        const unlocked = tree()
        expect(() => archive({ dryRun: true })).toThrow()
        expect(() => archive()).toThrow()
        expect(tree()).toEqual(unlocked)
        fs.unlinkSync(path.join(root, `${HISTORY.chinese}.tmp`))
        const publishedEnglish = read(HISTORY.english)

        expect(archive().action).toBe("resumed")
        expect(read(HISTORY.english)).toBe(publishedEnglish)
        expectHistory([VERSION, "0.14.0"])
        expectProtected(before)
        expectClean()
    })
})

describe("append-history command line", () => {
    it.each([
        [],
        ["--refresh-index"],
        ["--version", VERSION, "--refresh-index"],
        ["--version", VERSION, "--version", VERSION],
        ["--version"],
        ["--version", "Unreleased"],
        ["--version", "0.14.1-dev.1"],
        ["--version", "../0.14.1"],
        ["--version", "0.14.2"],
    ])("rejects missing/removed/invalid options without writes: %j", (...args) => {
        createRoot()
        const before = tree()

        const result = runCli(args)

        expect(result.error).toBeUndefined()
        expect(result.status).toBe(1)
        expect(result.stderr.length).toBeGreaterThan(0)
        expect(tree()).toEqual(before)
        expectClean()
    })

    it("prints help without requiring sources or creating files", () => {
        const before = tree()
        const result = runCli(["--help"])
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(0)
        expect(result.stdout).toContain("--version <X.Y.Z>")
        expect(result.stdout).not.toContain("--refresh-index")
        expect(tree()).toEqual(before)
    })

    it("performs dry-run, archive and identical re-run through the real executable", () => {
        createRoot(["0.14.0"])
        const before = tree()

        const preview = runCli(["--version", VERSION, "--dry-run"])
        expect(preview.error).toBeUndefined()
        expect(preview.status, preview.stderr).toBe(0)
        expect(tree()).toEqual(before)

        const first = runCli(["--version", VERSION])
        expect(first.error).toBeUndefined()
        expect(first.status, first.stderr).toBe(0)
        expectHistory([VERSION, "0.14.0"])
        expectProtected(before)
        const archived = tree()

        const second = runCli(["--version", VERSION])
        expect(second.error).toBeUndefined()
        expect(second.status, second.stderr).toBe(0)
        expect(tree()).toEqual(archived)
        expectClean()
    })
})
