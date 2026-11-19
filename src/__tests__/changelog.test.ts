import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { checkChangelogSet, listHistoryVersions, readChangelog, readCurrent } from "../../scripts/changelog.mjs"

let root: string
const CURRENT = { english: "docs/changelog/CHANGELOG_en.md", chinese: "CHANGELOG.md" }
const HISTORY = { english: "docs/changelog/history.en.md", chinese: "docs/changelog/history.zh-CN.md" }

function write(relative: string, text: string): void {
    const target = path.join(root, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, text)
}

function source(version: string, body: string): string {
    return `# Changelog\n\n## [${version}]\n\n${body}\n`
}

function current(version = "Unreleased"): void {
    write(CURRENT.english, source(version, "### Changed\n- Current English change."))
    write(CURRENT.chinese, source(version, "### Changed\n- 当前中文变更。"))
}

function history(): void {
    write(HISTORY.english, `${source("0.14.1", "### Fixed\n- English release.")}\n## [0.14.0]\n\n- Earlier English.\n`)
    write(HISTORY.chinese, `${source("0.14.1", "### Fixed\n- 中文版本。")}\n## [0.14.0]\n\n- 更早中文。\n`)
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "dline-current-"))
    write("package.json", JSON.stringify({ version: "0.14.1" }))
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe("canonical current changelog", () => {
    it.each(["Unreleased", "0.14.1"])("reads the sole %s section from the root language sources", (version) => {
        current(version)
        const notes = readCurrent({ root })
        expect(notes.version).toBe(version)
        expect(notes.english.body).toBe("### Changed\n- Current English change.")
        expect(notes.chinese.body).toBe("### Changed\n- 当前中文变更。")
        expect(notes.english.sourcePath).toBe(CURRENT.english)
        expect(notes.chinese.sourcePath).toBe("CHANGELOG.md")
        expect(readChangelog({ root, version: "current" })).toEqual(notes)
    })

    it("does not read duplicate current files or fall back to history", () => {
        current()
        history()
        write("docs/changelog/current.en.md", source("0.14.1", "- Stale copied notes."))
        write("docs/changelog/current.zh-CN.md", source("0.14.1", "- 旧副本。"))
        expect(readCurrent({ root }).version).toBe("Unreleased")
        expect(() => readChangelog({ root, version: "0.14.1" })).toThrow(/not found|missing/i)
    })

    it("rejects the former combined Unreleased and candidate layout", () => {
        current()
        for (const file of Object.values(CURRENT)) fs.appendFileSync(path.join(root, file), "\n## [0.14.1]\n\n- Old release.\n")
        expect(() => readCurrent({ root })).toThrow(/exactly one|single section/i)
    })

    it("rejects a generated version/link index instead of treating it as current", () => {
        current()
        write(
            "CHANGELOG.md",
            "# Changelog\n\n## [Unreleased]\n\n[Current](current.zh-CN.md)\n\n## [0.14.1]\n\n[Old](history.zh-CN.md)\n",
        )
        expect(() => readCurrent({ root })).toThrow(/exactly one|single section/i)
    })

    it("rejects mismatched language versions", () => {
        current()
        write(CURRENT.english, source("0.14.1", "- English release."))
        expect(() => readCurrent({ root })).toThrow(/different|mismatch/i)
    })

    it("accepts two empty rolling sections but rejects one empty language", () => {
        current()
        write(CURRENT.english, source("Unreleased", ""))
        expect(() => readCurrent({ root })).toThrow(/both|half|Chinese|English/i)
        write(CURRENT.chinese, source("Unreleased", ""))
        const notes = readCurrent({ root })
        expect(notes.english.empty).toBe(true)
        expect(notes.chinese.empty).toBe(true)
    })

    it("rejects an empty released current", () => {
        current("0.14.1")
        write(CURRENT.chinese, source("0.14.1", ""))
        expect(() => readCurrent({ root })).toThrow(/empty/i)
    })

    it("ignores headings inside fenced current notes", () => {
        current()
        write(CURRENT.english, source("Unreleased", "### Changed\n- Entry.\n\n```md\n## [0.14.0]\n```"))
        expect(readCurrent({ root }).english.body).toBe("### Changed\n- Entry.\n\n```md\n## [0.14.0]\n```")
    })
})

describe("single history file per language", () => {
    it("reads the requested version from each history file, not a version directory", () => {
        current()
        history()
        write("docs/changelog/history/0.14.1/en.md", source("0.14.1", "- Wrong directory."))
        const notes = readChangelog({ root, version: "0.14.1", source: "history" })
        expect(notes.english.body).toBe("### Fixed\n- English release.")
        expect(notes.chinese.body).toBe("### Fixed\n- 中文版本。")
        expect(notes.chinese.sourcePath).toBe(HISTORY.chinese)
        expect(notes.anchor).toBe("0141")
        expect(listHistoryVersions({ root })).toEqual(["0.14.1", "0.14.0"])
    })

    it("never substitutes a different historical version", () => {
        history()
        expect(() => readChangelog({ root, version: "0.13.0", source: "history" })).toThrow(/not found|missing/i)
    })

    it("refuses rolling notes in history", () => {
        history()
        write(HISTORY.english, source("Unreleased", "- Not a release."))
        expect(() => listHistoryVersions({ root })).toThrow(/Unreleased|released/i)
        expect(() => readChangelog({ root, version: "Unreleased", source: "history" })).toThrow(/history/i)
    })

    it("refuses duplicate versions and half-translated history", () => {
        history()
        fs.appendFileSync(path.join(root, HISTORY.english), "\n## [0.14.1]\n\n- Duplicate.\n")
        expect(() => listHistoryVersions({ root })).toThrow(/duplicate|2 times/i)
        history()
        write(HISTORY.chinese, source("0.14.1", "- 中文版本。"))
        expect(() => listHistoryVersions({ root })).toThrow(/different|mismatch/i)
    })

    it("allows no history before the first archive but not one missing language", () => {
        expect(listHistoryVersions({ root })).toEqual([])
        write(HISTORY.english, source("0.14.1", "- English only."))
        expect(() => listHistoryVersions({ root })).toThrow(/missing|both|pair|read/i)
    })
})

describe("read-only maintenance check", () => {
    it("accepts rolling current without inventing a manifest-version section or writing indexes", () => {
        current()
        history()
        const before = Object.fromEntries(
            [...Object.values(CURRENT), ...Object.values(HISTORY)].map((file) => [
                file,
                fs.readFileSync(path.join(root, file), "utf8"),
            ]),
        )
        const result = checkChangelogSet({ root })
        expect(result.version).toBe("Unreleased")
        expect(result.historyVersions).toEqual(["0.14.1", "0.14.0"])
        for (const [file, text] of Object.entries(before)) expect(fs.readFileSync(path.join(root, file), "utf8")).toBe(text)
        expect(fs.existsSync(path.join(root, "docs/changelog/history/0.14.1"))).toBe(false)
    })

    it("requires a numbered current to agree with the manifest", () => {
        current("0.14.2")
        expect(() => checkChangelogSet({ root })).toThrow(/0\.14\.2.*0\.14\.1|manifest/i)
    })

    it("refuses an archived copy that disagrees with a numbered current", () => {
        current("0.14.1")
        history()
        expect(() => checkChangelogSet({ root })).toThrow(/differs|conflict/i)
    })
})
