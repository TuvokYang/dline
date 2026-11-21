#!/usr/bin/env node
/**
 * Explicitly prepend one frozen release to each language's history document.
 *
 * Current notes are read-only maintenance sources, never consumed or rewritten.
 * History bodies and their existing order are preserved through the shared parser;
 * rewriting a history canonicalizes only its preamble, headings and line endings.
 * No index, source link, per-version directory or backup database is generated.
 *
 * The guard excludes cooperating archive writers, not arbitrary editors. Each
 * history replacement uses an exclusively created sibling temp file, but the two
 * renames are NOT a cross-file transaction. A failure reports the paths published
 * so far. Re-running can complete only an exact-current, otherwise paired partial
 * release; different notes and unrelated missing versions are always refused.
 * Unknown temps and guards left by a killed process require manual inspection.
 *
 * Usage: node scripts/append-history.mjs --version <X.Y.Z> [--root <dir>] [--dry-run]
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { assertReleaseVersion, CHANGELOG_LANGUAGES, HISTORY_SOURCES, readCurrent } from "./changelog.mjs"
import { findSection, normalizeChangelogText, parseChangelog, renderSingleSection } from "./changelog-parser.mjs"

const USAGE = "Usage: node scripts/append-history.mjs --version <X.Y.Z> [--root <dir>] [--dry-run]"
const GUARD_PATH = "docs/changelog/.history-lock"
const TEMP_SUFFIX = ".tmp"
const LANGUAGE_NAMES = { english: "English", chinese: "Chinese" }

/** @param {unknown} error @returns {string} */
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error)
}

/** Detect even a dangling symlink: it is unknown state, not a free path. */
function pathExists(absolute, fileSystem) {
    try {
        fileSystem.lstatSync(absolute)
        return true
    } catch (error) {
        if (error?.code === "ENOENT") return false
        throw error
    }
}

function guardHeld() {
    return new Error(
        `Another changelog writer holds '${GUARD_PATH}'. Wait for it to finish, or inspect a killed run's guard ` +
            "and remove it by hand. This command never breaks a guard automatically.",
    )
}

function assertNoGuard(root, fileSystem) {
    if (pathExists(path.join(root, GUARD_PATH), fileSystem)) throw guardHeld()
}

function assertNoTemps(root, fileSystem) {
    for (const sourcePath of Object.values(HISTORY_SOURCES)) {
        const temporary = `${sourcePath}${TEMP_SUFFIX}`
        if (pathExists(path.join(root, temporary), fileSystem)) {
            throw new Error(
                `Unknown history temp '${temporary}' remains from an interrupted run. Inspect it before removing it; ` +
                    "this command neither adopts nor overwrites it.",
            )
        }
    }
}

/** Missing histories are allowed; other read failures must never become empty history. */
function readStored(root, sourcePath, fileSystem) {
    try {
        return fileSystem.readFileSync(path.join(root, sourcePath), "utf8")
    } catch (error) {
        if (error?.code === "ENOENT") return null
        throw new Error(`History '${sourcePath}' could not be read: ${errorMessage(error)}`)
    }
}

/** Parse and validate every section, not just the version being appended. */
function readHistory(root, language, fileSystem) {
    const sourcePath = HISTORY_SOURCES[language]
    const text = readStored(root, sourcePath, fileSystem)
    if (text === null) return { text, sections: [] }
    const parsed = parseChangelog(text, { label: `${LANGUAGE_NAMES[language]} history '${sourcePath}'` })
    if (parsed.sections.length === 0) {
        throw new Error(`History '${sourcePath}' is empty or declares no release sections; inspect it before archiving.`)
    }
    for (const section of parsed.sections) {
        assertReleaseVersion(section.version)
        findSection(parsed, section.version)
    }
    return { text, sections: parsed.sections }
}

function sameBody(left, right) {
    return normalizeChangelogText(left) === normalizeChangelogText(right)
}

/**
 * The shared renderer owns the document title and first section; subsequent
 * sections keep every parsed body, including code fences, links and blank lines.
 * Prepend in archive-operation order, never sort or reconstruct from an index.
 */
function prependHistory(version, body, sections) {
    const contents =
        renderSingleSection(version, body) + sections.map((section) => `\n## [${section.version}]\n\n${section.body}\n`).join("")
    const expected = [{ version, body }, ...sections]
    const rendered = parseChangelog(contents).sections
    // An unterminated fence in current can be valid as a single section yet
    // swallow older headings after concatenation. Prove the complete round trip
    // with the shared parser before writing, rather than inventing fence rules.
    if (
        rendered.length !== expected.length ||
        rendered.some((section, index) => section.version !== expected[index].version || section.body !== expected[index].body)
    ) {
        throw new Error(
            `Cannot prepend '${version}' while preserving every history section. ` +
                "Inspect current Markdown for an unterminated code fence or altered section boundaries before archiving.",
        )
    }
    return contents
}

/**
 * A partial publication is recoverable only for this exact current release.
 * Excluding that release must leave identical bilingual version sets. The
 * already-published release must be first, just as a previous prepend left it.
 * This deliberately does not relax the shared reader's history-pair contract.
 */
function planArchive(root, version, fileSystem) {
    assertNoTemps(root, fileSystem)
    const current = readCurrent({ root, fileSystem })
    if (current.version !== version) {
        throw new Error(
            `The current changelog declares '${current.version}', not '${version}'. ` +
                `Freeze both current headings as '## [${version}]' in version preparation before archiving; ` +
                "Unreleased is never renamed or assigned a version by this command.",
        )
    }
    const histories = {}
    for (const language of CHANGELOG_LANGUAGES) {
        if (current[language].empty) {
            throw new Error(`${LANGUAGE_NAMES[language]} current '${current[language].sourcePath}' has no '${version}' notes.`)
        }
        histories[language] = readHistory(root, language, fileSystem)
    }
    const previous = (language) => histories[language].sections.filter((section) => section.version !== version)
    const englishVersions = new Set(previous("english").map((section) => section.version))
    const chineseVersions = new Set(previous("chinese").map((section) => section.version))
    if (englishVersions.size !== chineseVersions.size || [...englishVersions].some((release) => !chineseVersions.has(release))) {
        throw new Error(
            `History versions other than '${version}' are not paired: English [${[...englishVersions].join(", ")}] ` +
                `and Chinese [${[...chineseVersions].join(", ")}]. Restore the missing history; unknown half-sets are never adopted.`,
        )
    }
    const pending = []
    const unchanged = []
    for (const language of CHANGELOG_LANGUAGES) {
        const archived = histories[language].sections.find((section) => section.version === version)
        if (!archived) {
            pending.push(language)
            continue
        }
        if (!sameBody(archived.body, current[language].body)) {
            throw new Error(
                `'${version}' is already archived with different ${LANGUAGE_NAMES[language]} notes in ` +
                    `'${HISTORY_SOURCES[language]}'. Archived releases are never overwritten.`,
            )
        }
        unchanged.push(HISTORY_SOURCES[language])
    }
    if (pending.length === 1) {
        const published = CHANGELOG_LANGUAGES.find((language) => language !== pending[0])
        if (histories[published].sections[0].version !== version) {
            throw new Error(
                `The partial '${version}' release is not first in '${HISTORY_SOURCES[published]}'. ` +
                    "This is not a recognizable interrupted prepend; inspect the unknown half-set by hand.",
            )
        }
    }
    const replacements = {}
    for (const language of pending) {
        replacements[language] = prependHistory(version, current[language].body, histories[language].sections)
    }
    return { histories, replacements, pending, unchanged }
}

function claimGuard(root, fileSystem) {
    const guard = path.join(root, GUARD_PATH)
    fileSystem.mkdirSync(path.dirname(guard), { recursive: true })
    try {
        fileSystem.mkdirSync(guard)
    } catch (error) {
        if (error?.code === "EEXIST") throw guardHeld()
        throw error
    }
    return guard
}

/** Exclusive creation is the authority; an existence check alone is not a claim. */
function stageHistory(absolute, contents, ownedTemps, fileSystem) {
    const temporary = `${absolute}${TEMP_SUFFIX}`
    const descriptor = fileSystem.openSync(temporary, "wx")
    ownedTemps.add(temporary)
    try {
        fileSystem.writeFileSync(descriptor, contents, "utf8")
    } finally {
        fileSystem.closeSync(descriptor)
    }
    if (fileSystem.readFileSync(temporary, "utf8") !== contents) {
        throw new Error(`Staged history '${temporary}' did not read back intact.`)
    }
}

/** A non-cooperating edit observed before rename must not be silently lost. */
function publishHistory(root, language, previous, ownedTemps, fileSystem) {
    const sourcePath = HISTORY_SOURCES[language]
    if (readStored(root, sourcePath, fileSystem) !== previous) {
        throw new Error(`History '${sourcePath}' changed after validation; the unexpected contents were not overwritten.`)
    }
    const absolute = path.join(root, sourcePath)
    const temporary = `${absolute}${TEMP_SUFFIX}`
    fileSystem.renameSync(temporary, absolute)
    ownedTemps.delete(temporary)
}

/**
 * Archive an explicitly named, already-frozen release without modifying current.
 *
 * All validation runs before the guard or temps are created and again under the
 * guard. Both replacements are staged before the first history is published.
 *
 * @param {{ root: string, version: string, dryRun?: boolean, fileSystem?: import("node:fs") }} request
 * @returns {{ version: string, action: "created"|"resumed"|"noop"|"dry-run",
 *   historyPaths: { english: string, chinese: string }, planned: string[], written: string[], unchanged: string[] }}
 */
export function appendHistory(request) {
    const { root, version, dryRun = false, fileSystem = fs } = request ?? {}
    if (!root) throw new Error("Archiving changelog history requires a repository root.")
    if (version === undefined || version === null || version === "") {
        throw new Error("Archiving changelog history requires an explicit --version <X.Y.Z>.")
    }
    const release = assertReleaseVersion(version)
    assertNoGuard(root, fileSystem)
    const preview = planArchive(root, release, fileSystem)
    if (dryRun) {
        assertNoGuard(root, fileSystem)
        return {
            version: release,
            action: "dry-run",
            historyPaths: { ...HISTORY_SOURCES },
            planned: preview.pending.map((language) => HISTORY_SOURCES[language]),
            written: [],
            unchanged: preview.unchanged,
        }
    }

    const guard = claimGuard(root, fileSystem)
    const ownedTemps = new Set()
    const written = []
    const cleanupErrors = []
    let result
    let failure
    try {
        const plan = planArchive(root, release, fileSystem)
        for (const language of plan.pending) {
            stageHistory(path.join(root, HISTORY_SOURCES[language]), plan.replacements[language], ownedTemps, fileSystem)
        }
        for (const language of plan.pending) {
            publishHistory(root, language, plan.histories[language].text, ownedTemps, fileSystem)
            written.push(HISTORY_SOURCES[language])
        }
        result = {
            version: release,
            action: plan.pending.length === 0 ? "noop" : plan.pending.length === 1 ? "resumed" : "created",
            historyPaths: { ...HISTORY_SOURCES },
            planned: plan.pending.map((language) => HISTORY_SOURCES[language]),
            written,
            unchanged: plan.unchanged,
        }
    } catch (error) {
        failure = error
    } finally {
        // Only paths exclusively created by this call are eligible for cleanup.
        // Cleanup failures are reported alongside the original publish failure.
        for (const temporary of ownedTemps) {
            try {
                fileSystem.unlinkSync(temporary)
            } catch (error) {
                cleanupErrors.push(`Temp '${temporary}' remains: ${errorMessage(error)}`)
            }
        }
        try {
            fileSystem.rmdirSync(guard)
        } catch (error) {
            cleanupErrors.push(`Guard '${GUARD_PATH}' remains; inspect it manually: ${errorMessage(error)}`)
        }
    }
    if (failure || cleanupErrors.length > 0) {
        const publication =
            written.length === 0
                ? "No history replacement was published by this run."
                : `Published by this run: ${written.join(", ")}. The two history files are not a cross-file transaction.`
        throw new Error(
            `Archiving '${release}' failed: ${failure ? errorMessage(failure) : "cleanup failed"}. ${publication} ` +
                `Current changelog sources were not modified and still retain the release. After inspecting any remaining ` +
                `guard or temp, re-run --version ${release} with the same current notes to complete an exact partial publication. ` +
                cleanupErrors.join(" "),
        )
    }
    return result
}

function parseArguments(argv) {
    let version
    let root = process.cwd()
    let dryRun = false
    let help = false
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index]
        if (argument === "--help" || argument === "-h") {
            help = true
        } else if (argument === "--dry-run") {
            dryRun = true
        } else if (argument === "--version" || argument === "--root") {
            const value = argv[index + 1]
            if (value === undefined || value.startsWith("--")) {
                throw new Error(`Option '${argument}' requires a value.\n${USAGE}`)
            }
            if (argument === "--version") {
                if (version !== undefined) throw new Error(`Option '--version' was given more than once.\n${USAGE}`)
                version = value
            } else {
                root = value
            }
            index += 1
        } else {
            throw new Error(`Unsupported option '${argument}'.\n${USAGE}`)
        }
    }
    if (!help && version === undefined) throw new Error(`Missing --version.\n${USAGE}`)
    return { root: path.resolve(root), version, dryRun, help }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ""
if (invokedPath === fileURLToPath(import.meta.url)) {
    try {
        const options = parseArguments(process.argv.slice(2))
        if (options.help) {
            console.log(USAGE)
        } else {
            const result = appendHistory(options)
            console.log(`[append-history] ${result.action}: ${result.version}`)
            for (const sourcePath of options.dryRun ? result.planned : result.written) {
                console.log(`[append-history] ${options.dryRun ? "would write" : "written"}: ${sourcePath}`)
            }
            for (const sourcePath of result.unchanged) {
                console.log(`[append-history] unchanged: ${sourcePath}`)
            }
        }
    } catch (error) {
        console.error(errorMessage(error))
        process.exitCode = 1
    }
}
