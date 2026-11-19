/**
 * Read-only access to the canonical current notes and one history per language.
 * Current is maintained directly in CHANGELOG.md and its English counterpart;
 * no index or duplicate current document is generated.
 */
import fs from "node:fs"
import path from "node:path"
import {
    findSection,
    isReleaseVersion,
    normalizeChangelogText,
    parseChangelog,
    sectionAnchor,
    UNRELEASED_SECTION,
} from "./changelog-parser.mjs"

export const CHANGELOG_LANGUAGES = ["english", "chinese"]
export const CURRENT_SOURCES = { english: "docs/changelog/CHANGELOG_en.md", chinese: "CHANGELOG.md" }
export const HISTORY_SOURCES = { english: "docs/changelog/history.en.md", chinese: "docs/changelog/history.zh-CN.md" }
const LANGUAGE_NAMES = { english: "English", chinese: "Chinese" }

/** @param {unknown} version @returns {string} A plain version safe for an archive heading. */
export function assertReleaseVersion(version) {
    if (!isReleaseVersion(version)) {
        throw new Error(`Changelog version '${String(version ?? "")}' must be a plain major.minor.patch version.`)
    }
    return String(version).trim()
}

/** @returns {{ english: string, chinese: string }} Canonical current paths. */
export function currentSourcePaths() {
    return { ...CURRENT_SOURCES }
}

/** Read errors are translated once at this file boundary. */
function readSource(fileSystem, root, relativePath) {
    try {
        return fileSystem.readFileSync(path.join(root, relativePath), "utf8")
    } catch (error) {
        throw new Error(
            `Changelog '${relativePath}' could not be read: ${error instanceof Error ? error.message : String(error)}`,
        )
    }
}

function assertCurrentShape(parsed, sourcePath) {
    if (parsed.sections.length !== 1) {
        throw new Error(`Current changelog '${sourcePath}' must contain exactly one section: Unreleased or its accurate version.`)
    }
    const [section] = parsed.sections
    if (section.version !== UNRELEASED_SECTION) assertReleaseVersion(section.version)
}

function assertHistoryShape(parsed, sourcePath) {
    for (const section of parsed.sections) {
        if (section.version === UNRELEASED_SECTION) throw new Error(`History '${sourcePath}' cannot contain Unreleased notes.`)
        assertReleaseVersion(section.version)
        if (section.empty) throw new Error(`History '${sourcePath}': CHANGELOG section '${section.version}' is empty.`)
    }
}

/** Parse both files once and validate their shared source contract. */
function readPair({ root, source, fileSystem, allowMissing = false }) {
    const paths = source === "current" ? CURRENT_SOURCES : HISTORY_SOURCES
    if (allowMissing && CHANGELOG_LANGUAGES.every((language) => !fileSystem.existsSync(path.join(root, paths[language])))) {
        return null
    }
    const parsed = {}
    for (const language of CHANGELOG_LANGUAGES) {
        const sourcePath = paths[language]
        parsed[language] = parseChangelog(readSource(fileSystem, root, sourcePath), {
            label: `${LANGUAGE_NAMES[language]} changelog '${sourcePath}'`,
        })
        if (source === "current") assertCurrentShape(parsed[language], sourcePath)
        else assertHistoryShape(parsed[language], sourcePath)
    }
    const versions = (language) => parsed[language].sections.map((section) => section.version)
    const english = versions("english")
    const chinese = versions("chinese")
    const comparable = (values) => (source === "history" ? [...values].sort(compareVersionsDescending) : values)
    if (comparable(english).join(",") !== comparable(chinese).join(",")) {
        throw new Error(
            `The ${source} changelog declares different sections per language: English [${english.join(", ")}] and Chinese [${chinese.join(", ")}].`,
        )
    }
    return { paths, parsed }
}

/**
 * Read an exact section, or select the sole current section with version=current.
 * No missing version falls back to history or to another section.
 * @param {{ root: string, version: string, source?: "current"|"history", fileSystem?: import("node:fs") }} request
 * @returns {{ version: string, source: "current"|"history", anchor: string, english: { body: string, sourcePath: string, empty: boolean }, chinese: { body: string, sourcePath: string, empty: boolean } }}
 */
export function readChangelog(request) {
    const { root, version, source = "current", fileSystem = fs } = request ?? {}
    if (!root) throw new Error("Reading changelog notes requires a repository root.")
    if (source !== "current" && source !== "history") {
        throw new Error(`Unsupported changelog source '${source}'; use 'current' or 'history'.`)
    }
    const requested = String(version ?? "").trim()
    if (!requested) throw new Error("Changelog version must not be empty.")
    if (source === "history" && (requested === UNRELEASED_SECTION || requested === "current")) {
        throw new Error(`The '${requested}' section has no history snapshot; name an exact released version.`)
    }
    const pair = readPair({ root, source, fileSystem })
    const wanted = requested === "current" ? pair.parsed.english.sections[0].version : requested
    const languages = {}
    for (const language of CHANGELOG_LANGUAGES) {
        const section = findSection(pair.parsed[language], wanted, { allowEmpty: wanted === UNRELEASED_SECTION })
        languages[language] = { body: section.body, sourcePath: pair.paths[language], empty: section.empty }
    }
    if (wanted === UNRELEASED_SECTION && languages.english.empty !== languages.chinese.empty) {
        const missing = languages.english.empty ? "English" : "Chinese"
        throw new Error(
            `The 'Unreleased' section has no ${missing} notes. Record both languages or neither; a half-translated build is rejected.`,
        )
    }
    return { version: wanted, source, anchor: sectionAnchor(wanted), english: languages.english, chinese: languages.chinese }
}

/** @param {{ root: string, fileSystem?: import("node:fs") }} request @returns {ReturnType<typeof readChangelog>} */
export function readCurrent(request) {
    return readChangelog({ ...request, version: "current", source: "current" })
}

/** @param {string} left @param {string} right @returns {number} Descending semantic version order. */
export function compareVersionsDescending(left, right) {
    const a = left.split(".").map(Number)
    const b = right.split(".").map(Number)
    for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return b[index] - a[index]
    return 0
}

/** @param {{ root: string, fileSystem?: import("node:fs") }} request @returns {string[]} */
export function listHistoryVersions(request) {
    const { root, fileSystem = fs } = request ?? {}
    if (!root) throw new Error("Listing changelog history requires a repository root.")
    const pair = readPair({ root, source: "history", fileSystem, allowMissing: true })
    return pair ? pair.parsed.english.sections.map((section) => section.version).sort(compareVersionsDescending) : []
}

/**
 * Check the maintained files without rewriting them. A development Unreleased
 * current does not need an invented manifest-version section beside it.
 * @param {{ root: string, fileSystem?: import("node:fs"), manifestVersion?: string }} request
 * @returns {{ version: string, historyVersions: string[], currentFiles: string[] }}
 */
export function checkChangelogSet(request) {
    const { root, fileSystem = fs } = request ?? {}
    if (!root) throw new Error("Checking changelog consistency requires a repository root.")
    const manifestVersion = request.manifestVersion ?? JSON.parse(readSource(fileSystem, root, "package.json")).version
    assertReleaseVersion(manifestVersion)
    const current = readCurrent({ root, fileSystem })
    if (current.version !== UNRELEASED_SECTION && current.version !== manifestVersion) {
        throw new Error(
            `The current changelog is ${current.version}, but package.json is ${manifestVersion}; keep the manifest and numbered current identical.`,
        )
    }
    const historyVersions = listHistoryVersions({ root, fileSystem })
    if (historyVersions.includes(current.version)) {
        const archived = readChangelog({ root, version: current.version, source: "history", fileSystem })
        for (const language of CHANGELOG_LANGUAGES) {
            if (normalizeChangelogText(archived[language].body) !== normalizeChangelogText(current[language].body)) {
                throw new Error(
                    `The ${LANGUAGE_NAMES[language]} '${current.version}' history differs from current; archived notes must not be overwritten.`,
                )
            }
        }
    }
    return { version: current.version, historyVersions, currentFiles: Object.values(CURRENT_SOURCES) }
}
