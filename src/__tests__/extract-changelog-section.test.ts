import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { findSection, parseChangelog } from "../../scripts/changelog-parser.mjs"

const execute = promisify(execFile)
const PROJECT_ROOT = process.cwd()
const CLI = path.join(PROJECT_ROOT, "scripts", "extract-changelog-section.mjs")

/** Select one section through the canonical parser, as every consumer does. */
function select(source: string, version: string, options: { allowEmpty?: boolean } = {}): string {
    return findSection(parseChangelog(source), version, options).body
}

describe("parseChangelog", () => {
    it("extracts only the requested bracketed version section", () => {
        const changelog = "# Changelog\n\n## [1.2.3]\n\n### Fixes\n- fixed\n\n## [1.2.2]\n- old\n"

        expect(select(changelog, "1.2.3")).toBe("### Fixes\n- fixed")
    })

    it("preserves fenced headings and the notes after them", () => {
        const body = "### Changed\n- before\n\n```markdown\n## [1.2.2]\n- example\n```\n\n- after"
        const changelog = `## [1.2.3]\n\n${body}\n\n## [1.2.2]\n- actual old release\n`

        expect(select(changelog, "1.2.3")).toBe(body)
    })

    it("rejects duplicate release sections instead of silently selecting the first", () => {
        const changelog = "## [1.2.3]\n- first\n\n## [1.2.3]\n- conflicting second\n"

        expect(() => select(changelog, "1.2.3")).toThrow(/duplicat|exactly one|2 times/i)
    })

    it("keeps longer fences, tilde fences and CRLF sources intact", () => {
        const source = [
            "# Changelog",
            "",
            "## [1.2.3]",
            "",
            "~~~~markdown",
            "~~~",
            "## [9.9.9]",
            "~~~",
            "~~~~",
            "",
            "- after every fence",
            "",
            "## [1.2.2]",
            "",
            "- older",
        ].join("\r\n")

        expect(select(source, "1.2.3")).toBe(
            ["~~~~markdown", "~~~", "## [9.9.9]", "~~~", "~~~~", "", "- after every fence"].join("\n"),
        )
    })

    it("accepts an unbracketed version heading", () => {
        expect(select("## 1.2.3\n- shipped\n", "1.2.3")).toBe("- shipped")
    })

    it("does not treat a heading with trailing text as a version", () => {
        const parsed = parseChangelog("## [1.2.3] (draft)\n- text\n\n## [1.2.2]\n- older\n")

        expect(parsed.sections.map((section: { version: string }) => section.version)).toEqual(["1.2.2"])
    })

    it.each(["## [1.2.3", "## 1.2.3]"])("does not accept an unmatched bracket in %s", (heading) => {
        const parsed = parseChangelog(`${heading}\n- malformed heading\n\n## [1.2.2]\n- older\n`)
        expect(parsed.sections.map((section) => section.version)).toEqual(["1.2.2"])
    })

    it("extracts the rolling Unreleased section", () => {
        const changelog = "## [Unreleased]\n\n### Fixed\n- current\n\n## [1.2.3]\n- shipped\n"

        expect(select(changelog, "Unreleased")).toBe("### Fixed\n- current")
    })

    it("allows an explicitly empty rolling section without weakening release sections", () => {
        const changelog = "## [Unreleased]\n\n## [1.2.3]\n- shipped\n"

        expect(select(changelog, "Unreleased", { allowEmpty: true })).toBe("")
        expect(() => select(changelog, "Unreleased")).toThrow("CHANGELOG section 'Unreleased' is empty.")
    })

    it("rejects empty-section tolerance for a versioned release", () => {
        expect(() => select("## [1.2.3]\n", "1.2.3", { allowEmpty: true })).toThrow(
            "allowEmpty is supported only for the Unreleased changelog section.",
        )
    })

    it("reports every section in document order and strips a byte order mark", () => {
        const parsed = parseChangelog("\uFEFFHome | [Docs](docs)\n\n# Changelog\n\n## [2.0.0]\n- b\n\n## [1.0.0]\n- a\n")

        expect(parsed.sections.map((section: { version: string }) => section.version)).toEqual(["2.0.0", "1.0.0"])
        expect(parsed.sections[0].body).toBe("- b")
        // Preamble before the first heading belongs to no section.
        expect(parsed.sections.some((section: { body: string }) => section.body.includes("Home |"))).toBe(false)
    })

    it.each([
        ["## [1.2.2]\n- old\n", "CHANGELOG section '1.2.3' was not found."],
        ["## [1.2.3]\n\n## [1.2.2]\n- old\n", "CHANGELOG section '1.2.3' is empty."],
    ])("fails closed when release notes cannot be produced", (source, message) => {
        expect(() => select(source, "1.2.3")).toThrow(message)
    })
})

describe("extract-changelog-section.mjs", () => {
    let root = ""

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "changelog-cli-"))
        await fs.mkdir(path.join(root, "docs", "changelog"), { recursive: true })
        await fs.writeFile(
            path.join(root, "docs/changelog/CHANGELOG_en.md"),
            "# Changelog\n\n## [1.2.3]\n\n### Fixed\n- shipped entry\n",
        )
        await fs.writeFile(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## [1.2.3]\n\n### Fixed\n- 已发布条目\n")
        await fs.writeFile(path.join(root, "docs/changelog/history.en.md"), "# History\n\n## [1.2.2]\n\n- archived entry\n")
        await fs.writeFile(path.join(root, "docs/changelog/history.zh-CN.md"), "# History\n\n## [1.2.2]\n\n- 归档条目\n")
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    /** Run the real CLI and return its exit status, output and stdout/stderr. */
    async function run(args: string[]): Promise<{ code: number; text: string; message: string }> {
        try {
            const result = await execute(process.execPath, [CLI, ...args], { cwd: PROJECT_ROOT, windowsHide: true })
            return { code: 0, text: result.stdout, message: result.stderr }
        } catch (error) {
            const failure = error as { code?: number; stdout?: string; stderr?: string }
            return { code: failure.code ?? 1, text: failure.stdout ?? "", message: failure.stderr ?? "" }
        }
    }

    it("writes one validated released section for the requested language", async () => {
        const output = path.join(root, "out", "notes.md")
        const result = await run(["--version", "1.2.3", "--language", "en", "--output", output, "--root", root])

        expect(result.code).toBe(0)
        expect(await fs.readFile(output, "utf8")).toBe("### Fixed\n- shipped entry\n")
        // The traceable source is reported, not a compatibility index.
        expect(result.text).toContain("docs/changelog/CHANGELOG_en.md")
    })

    it("reads the other language from its own current source", async () => {
        const output = path.join(root, "zh.md")
        const result = await run(["--version", "1.2.3", "--language", "zh-CN", "--output", output, "--root", root])

        expect(result.code).toBe(0)
        expect(await fs.readFile(output, "utf8")).toBe("### Fixed\n- 已发布条目\n")
    })

    it("reads a released version from history only when that source is named", async () => {
        const output = path.join(root, "archived.md")
        const result = await run([
            "--version",
            "1.2.2",
            "--language",
            "en",
            "--output",
            output,
            "--root",
            root,
            "--source",
            "history",
        ])

        expect(result.code).toBe(0)
        expect(await fs.readFile(output, "utf8")).toBe("- archived entry\n")
        expect(result.text).toContain("docs/changelog/history.en.md")
    })

    it("fails instead of falling back to history when the current notes lack the version", async () => {
        const output = path.join(root, "missing.md")
        const result = await run(["--version", "1.2.2", "--language", "en", "--output", output, "--root", root])

        expect(result.code).not.toBe(0)
        expect(result.message).toContain("CHANGELOG section '1.2.2' was not found.")
        await expect(fs.access(output)).rejects.toMatchObject({ code: "ENOENT" })
    })

    it("rejects a rolling section that only one language records", async () => {
        await fs.writeFile(
            path.join(root, "docs/changelog/CHANGELOG_en.md"),
            "# Changelog\n\n## [Unreleased]\n\n- english only\n",
        )
        await fs.writeFile(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n")
        const output = path.join(root, "half.md")
        const result = await run(["--version", "Unreleased", "--language", "en", "--output", output, "--root", root])

        expect(result.code).not.toBe(0)
        expect(result.message).toContain("has no Chinese notes")
        await expect(fs.access(output)).rejects.toMatchObject({ code: "ENOENT" })
    })

    it.each(["Unreleased", "current"])("allows empty rolling notes only explicitly via %s", async (selector) => {
        await fs.writeFile(path.join(root, "docs/changelog/CHANGELOG_en.md"), "# Changelog\n\n## [Unreleased]\n")
        await fs.writeFile(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n")
        const output = path.join(root, "rolling.md")

        const refused = await run(["--version", selector, "--language", "en", "--output", output, "--root", root])
        expect(refused.code).not.toBe(0)
        expect(refused.message).toContain("CHANGELOG section 'Unreleased' is empty.")

        const allowed = await run([
            "--version",
            selector,
            "--language",
            "en",
            "--output",
            output,
            "--root",
            root,
            "--allow-empty",
        ])
        expect(allowed.code).toBe(0)
        expect(await fs.readFile(output, "utf8")).toBe("")
    })

    it("uses the Insiders draft command on frozen and rolling notes without permitting empty release notes", async () => {
        const workflow = await fs.readFile(path.join(PROJECT_ROOT, ".github/workflows/publish-insiders.yml"), "utf8")
        const invocation = workflow.match(/^\s*node scripts\/extract-changelog-section\.mjs ([^\r\n]+)$/m)?.[1]
        expect(invocation).toBeDefined()
        const output = path.join(root, "insiders.md")
        const args = invocation?.trim().split(/\s+/) ?? []
        expect(args).toContain('"$current_notes_path"')
        const draftArgs = [...args.map((arg) => (arg === '"$current_notes_path"' ? output : arg)), "--root", root]

        const frozen = await run(draftArgs)
        expect(frozen.message).toBe("")
        expect(frozen.code).toBe(0)
        const published = await fs.readFile(output, "utf8")
        expect(published).toBe("### Fixed\n- 已发布条目\n")

        await fs.writeFile(path.join(root, "docs/changelog/CHANGELOG_en.md"), "# Changelog\n\n## [1.2.3]\n")
        await fs.writeFile(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## [1.2.3]\n")
        const empty = await run(draftArgs)
        expect(empty.code).not.toBe(0)
        expect(empty.message).toContain("1.2.3")
        expect(await fs.readFile(output, "utf8")).toBe(published)

        await fs.writeFile(path.join(root, "docs/changelog/CHANGELOG_en.md"), "# Changelog\n\n## [Unreleased]\n")
        await fs.writeFile(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n")
        expect((await run(draftArgs)).code).toBe(0)
        expect(await fs.readFile(output, "utf8")).toBe("")
    })

    it("rejects empty tolerance for a released version and unknown options", async () => {
        const output = path.join(root, "strict.md")
        const weakened = await run([
            "--version",
            "1.2.3",
            "--language",
            "en",
            "--output",
            output,
            "--root",
            root,
            "--allow-empty",
        ])
        expect(weakened.code).not.toBe(0)
        expect(weakened.message).toContain("--allow-empty is supported only for the Unreleased")

        const unknown = await run(["--version", "1.2.3", "--language", "en", "--output", output, "--root", root, "--verbose"])
        expect(unknown.code).not.toBe(0)
        expect(unknown.message).toContain("Unsupported option '--verbose'")

        const badLanguage = await run(["--version", "1.2.3", "--language", "fr", "--output", output, "--root", root])
        expect(badLanguage.code).not.toBe(0)
        expect(badLanguage.message).toContain("Unsupported --language 'fr'")
    })

    it("rejects an Unreleased history query because that section has no snapshot", async () => {
        const result = await run([
            "--version",
            "Unreleased",
            "--language",
            "en",
            "--output",
            path.join(root, "x.md"),
            "--root",
            root,
            "--source",
            "history",
        ])

        expect(result.code).not.toBe(0)
        expect(result.message).toContain("has no history snapshot")
    })

    it("checks the sole current and both history files without generating an index", async () => {
        await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.2.3" }))
        const before = await fs.readFile(path.join(root, "CHANGELOG.md"), "utf8")
        const passed = await run(["--check", "--root", root])
        expect(passed.code).toBe(0)
        expect(passed.text).toContain("current 1.2.3")
        expect(await fs.readFile(path.join(root, "CHANGELOG.md"), "utf8")).toBe(before)
        await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.3.0" }))
        const mismatched = await run(["--check", "--root", root])
        expect(mismatched.code).not.toBe(0)
        expect(mismatched.message).toContain("but package.json is 1.3.0")
    })

    it("selects the current section without requiring a numbered duplicate", async () => {
        const output = path.join(root, "current-notes.md")
        const result = await run(["--version", "current", "--language", "zh-CN", "--output", output, "--root", root])
        expect(result.code).toBe(0)
        expect(await fs.readFile(output, "utf8")).toBe("### Fixed\n- 已发布条目\n")
    })
})
