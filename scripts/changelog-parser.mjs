/**
 * Canonical changelog text parsing and section validation.
 *
 * This module is the single implementation of version heading recognition, code
 * fence tracking, duplicate detection and empty-section policy. It reads no
 * file, resolves no path, knows no channel and returns no source location:
 * callers hand it text and receive the sections it declares. The shared reader
 * (`changelog.mjs`), the compatibility index generator and every Node consumer
 * therefore agree on exactly one set of rules.
 */

/** Rolling section of a build that has no released version yet. */
export const UNRELEASED_SECTION = "Unreleased"

/** A released version section names a plain numeric semantic version. */
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/

/** A byte order mark at the start of a source is not content. */
const BYTE_ORDER_MARK = /^\uFEFF/

/** A known fence opens a block whose matching fence must be at least as long. */
const FENCE_OPENING = /^ {0,3}(`{3,}|~{3,})/

/**
 * Version heading grammar.
 *
 * A heading is `##`, at least one space or tab, then one token, optionally
 * bracketed: `## [0.14.1]` and `## 0.14.1` are both versions, while `### Fixed`
 * and `## [0.14.1] (draft)` are not.
 */
const VERSION_HEADING = /^##[ \t]+(?:\[([^[\]\s]+)\]|([^[\]\s]+))[ \t]*$/

/**
 * Normalize source text before parsing.
 *
 * A changelog is maintained as UTF-8 Markdown on several platforms, so a BOM and
 * CRLF line endings are external encoding details rather than authored content.
 * Every consumer therefore sees exactly one normalized text.
 *
 * @param {string} source Changelog text as stored on disk.
 * @returns {string} Text without BOM and with LF line endings only.
 */
export function normalizeChangelogText(source) {
    if (typeof source !== "string") {
        throw new Error("A changelog source must be text.")
    }
    return source.replace(BYTE_ORDER_MARK, "").replace(/\r\n?/g, "\n")
}

/**
 * Recognize a released version section name.
 *
 * The version is also used as a directory name by the history archive, so only
 * digits and dots are accepted and a path fragment can never pass.
 *
 * @param {unknown} value Candidate version.
 * @returns {boolean} True for `major.minor.patch` with numeric parts only.
 */
export function isReleaseVersion(value) {
    return typeof value === "string" && RELEASE_VERSION.test(value.trim())
}

/**
 * GFM anchor of one version heading.
 *
 * A heading such as `## [0.14.1]` is rendered by GitHub with the anchor `0141`,
 * and `## [Unreleased]` with `unreleased`. The displayed packaged version is not
 * used, because a rolling build displays a timestamp while documenting the
 * section it actually names.
 *
 * @param {string} version Version or `Unreleased`.
 * @returns {string} Anchor without the leading `#`.
 */
export function sectionAnchor(version) {
    return String(version ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N} _-]/gu, "")
        .replace(/\s+/g, "-")
}

/**
 * Closing pattern of a fence opened by `opening`.
 *
 * A fence closes with the same character, at least as many times, and nothing
 * else on the line, so a longer fence can contain a shorter one.
 *
 * @param {string} opening Fence characters, already matched.
 * @returns {RegExp} Pattern matching only a valid closing fence.
 */
function closingFence(opening) {
    const character = opening.startsWith("`") ? "`" : "~"
    return new RegExp(`^ {0,3}\\${character}{${opening.length},}[ \\t]*$`)
}

/**
 * Parse one changelog text into its version sections.
 *
 * Lines before the first version heading are preamble and belong to no section.
 * A fence is tracked as a block, so a heading inside a fenced sample is data and
 * neither creates a section nor ends the enclosing one. A version declared twice
 * is rejected rather than silently resolved to the first, because two copies of
 * one release cannot both be that release's notes.
 *
 * @param {string} source Full changelog text.
 * @param {{ label?: string }} [options] Description used in failure messages.
 * @returns {{ sections: { version: string, body: string, empty: boolean }[] }} Parsed sections in document order.
 */
export function parseChangelog(source, options = {}) {
    const label = options.label ?? "changelog"
    /** @type {{ version: string, lines: string[] }[]} */
    const found = []
    /** @type {{ version: string, lines: string[] } | null} */
    let current = null
    /** @type {RegExp | null} */
    let fence = null

    for (const line of normalizeChangelogText(source).split("\n")) {
        if (fence) {
            // The closing line is part of the authored block, so it is kept too.
            if (fence.test(line)) fence = null
            if (current) current.lines.push(line)
            continue
        }
        const opening = FENCE_OPENING.exec(line)
        if (opening) {
            fence = closingFence(opening[1])
            if (current) current.lines.push(line)
            continue
        }
        const heading = VERSION_HEADING.exec(line)
        if (heading) {
            current = { version: heading[1] ?? heading[2], lines: [] }
            found.push(current)
            continue
        }
        if (current) current.lines.push(line)
    }

    const counts = new Map()
    for (const section of found) counts.set(section.version, (counts.get(section.version) ?? 0) + 1)
    for (const [version, count] of counts) {
        if (count > 1) throw new Error(`${label} declares the '${version}' section ${count} times; keep exactly one.`)
    }

    return {
        sections: found.map((section) => {
            const body = section.lines.join("\n").trim()
            return { version: section.version, body, empty: body === "" }
        }),
    }
}

/**
 * Select one section that must be usable.
 *
 * A released section is rejected when it is missing or empty. Only `Unreleased`
 * may be empty, because a rolling build may have nothing recorded yet, and the
 * caller has to ask for that tolerance explicitly so a released version can
 * never be relaxed into an empty document.
 *
 * @param {{ sections: { version: string, body: string, empty: boolean }[] }} parsed Parsed changelog.
 * @param {string} version Section to select.
 * @param {{ allowEmpty?: boolean }} [options] Empty tolerance for `Unreleased`.
 * @returns {{ version: string, body: string, empty: boolean }} The selected section.
 */
export function findSection(parsed, version, options = {}) {
    const wanted = String(version ?? "").trim()
    if (!wanted) throw new Error("Changelog version must not be empty.")
    if (options.allowEmpty && wanted !== UNRELEASED_SECTION) {
        throw new Error("allowEmpty is supported only for the Unreleased changelog section.")
    }
    const section = parsed.sections.find((candidate) => candidate.version === wanted)
    if (!section) throw new Error(`CHANGELOG section '${wanted}' was not found.`)
    if (section.empty && !options.allowEmpty) throw new Error(`CHANGELOG section '${wanted}' is empty.`)
    return section
}

/**
 * The default visual content of a version file: one title and one section.
 *
 * History snapshots and the generated index share this shape so a snapshot's
 * heading anchor is the same anchor the index links to.
 *
 * @param {string} version Version the section declares.
 * @param {string} body Authored body of that version, without its heading.
 * @returns {string} A single-section changelog document.
 */
export function renderSingleSection(version, body) {
    return `${["# Changelog", `## [${version}]`, body].join("\n\n")}\n`
}
