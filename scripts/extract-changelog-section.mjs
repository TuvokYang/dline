#!/usr/bin/env node
/**
 * Bilingual changelog notes CLI.
 *
 * This is a thin wrapper: it parses arguments, asks the shared reader
 * (`changelog.mjs`) for one validated section, writes the returned body, and
 * exits non-zero on any failure. It owns no parsing rule, no version selection
 * and no fallback - a missing section is an error, never a different version.
 *
 * Usage:
 *   node scripts/extract-changelog-section.mjs --version <current|X.Y.Z|Unreleased>
 *       --language <en|zh-CN> --output <path> [--root <dir>]
 *       [--source current|history] [--allow-empty]
 *   node scripts/extract-changelog-section.mjs --check [--root <dir>]
 *
 * `--source current` is the default, so a packaged build reads only the current
 * notes and never scans the whole history. `--source history` reads the snapshot
 * of exactly the named version. `Unreleased` exists only in the current notes.
 * `--allow-empty` tolerates an empty rolling section and is rejected for a
 * released version, so a release can never ship empty notes.
 *
 * `--check` is the explicit maintenance gate behind `npm run changelog:check`: it
 * validates the sole current section, a numbered current against the manifest,
 * and both single-file histories. It never rewrites the maintained sources.
 */

import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { checkChangelogSet, readChangelog } from "./changelog.mjs"
import { UNRELEASED_SECTION } from "./changelog-parser.mjs"

/** Language flags accepted on the command line, in their file spelling. */
const LANGUAGE_FLAGS = { en: "english", "zh-CN": "chinese" }

/** Options that take a value. */
const VALUE_OPTIONS = new Set(["--version", "--language", "--output", "--root", "--source"])

/** Options that are flags only. */
const BOOLEAN_OPTIONS = new Set(["--allow-empty", "--check", "--help"])

/** Human-readable usage text, also printed on a usage error. */
const USAGE = [
    "Usage: node scripts/extract-changelog-section.mjs --version <current|X.Y.Z|Unreleased> --language <en|zh-CN> --output <path>",
    "           [--root <dir>] [--source current|history] [--allow-empty]",
    "       node scripts/extract-changelog-section.mjs --check [--root <dir>]",
].join("\n")

/**
 * Split command-line arguments into known options.
 *
 * Unknown options and a repeated option are caller errors: silently ignoring
 * either would let a mistyped notes command read a different section than the one
 * a release publishes.
 *
 * @param {string[]} argv Arguments without the node executable and script path.
 * @returns {{ options: Record<string, string|true>, help: boolean }} Parsed options.
 */
export function parseArguments(argv) {
    /** @type {Record<string, string|true>} */
    const options = {}
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index]
        if (argument === "--help" || argument === "-h") {
            options["--help"] = true
            continue
        }
        if (!VALUE_OPTIONS.has(argument) && !BOOLEAN_OPTIONS.has(argument)) {
            throw new Error(`Unsupported option '${argument}'.\n${USAGE}`)
        }
        if (argument in options) throw new Error(`Option '${argument}' was given more than once.`)
        if (BOOLEAN_OPTIONS.has(argument)) {
            options[argument] = true
            continue
        }
        const value = argv[index + 1]
        if (value === undefined || value.startsWith("--")) {
            throw new Error(`Option '${argument}' requires a value.\n${USAGE}`)
        }
        options[argument] = value
        index += 1
    }
    return { options, help: options["--help"] === true }
}

/**
 * Read one validated section and return the exact body to write.
 *
 * @param {{ options: Record<string, string|true> }} parsed Parsed command line.
 * @returns {Promise<{ output: string|null, body: string, description: string }>} Output path and body.
 */
async function extract(parsed) {
    const { options } = parsed
    const version = String(options["--version"] ?? "").trim()
    const languageFlag = String(options["--language"] ?? "").trim()
    const outputPath = String(options["--output"] ?? "").trim()
    const source = String(options["--source"] ?? "current").trim()
    const allowEmpty = options["--allow-empty"] === true
    if (!version) throw new Error(`Missing --version.\n${USAGE}`)
    if (!languageFlag) throw new Error(`Missing --language.\n${USAGE}`)
    if (!outputPath) throw new Error(`Missing --output.\n${USAGE}`)
    const language = LANGUAGE_FLAGS[languageFlag]
    if (!language) throw new Error(`Unsupported --language '${languageFlag}'; use 'en' or 'zh-CN'.`)
    const root = path.resolve(String(options["--root"] ?? process.cwd()))
    const notes = readChangelog({ root, version, source })
    if (allowEmpty && version !== "current" && notes.version !== UNRELEASED_SECTION) {
        throw new Error("--allow-empty is supported only for the Unreleased section or the current selector.")
    }
    const section = notes[language]
    if (section.empty && !(allowEmpty && notes.version === UNRELEASED_SECTION)) {
        throw new Error(`CHANGELOG section '${notes.version}' is empty.`)
    }
    return {
        output: path.resolve(outputPath),
        body: section.empty ? "" : `${section.body}\n`,
        description: `${notes.version} (${languageFlag}) from ${section.sourcePath}`,
    }
}

/**
 * Run the maintenance check and print its verdict.
 *
 * @param {Record<string, string|true>} options Parsed command line.
 * @returns {string} Summary line.
 */
function check(options) {
    const root = path.resolve(String(options["--root"] ?? process.cwd()))
    const result = checkChangelogSet({ root })
    return (
        `changelog: current ${result.version} and ${result.historyVersions.length} history version(s) are valid; ` +
        `current sources: ${result.currentFiles.join(", ")}.`
    )
}

/**
 * Command entry point.
 *
 * @param {string[]} [argv] Arguments without the node executable and script path.
 * @returns {Promise<void>}
 */
export async function main(argv = process.argv.slice(2)) {
    const parsed = parseArguments(argv)
    if (parsed.help) {
        console.log(USAGE)
        return
    }
    if (parsed.options["--check"] === true) {
        for (const option of Object.keys(parsed.options)) {
            if (option !== "--check" && option !== "--root" && option !== "--help") {
                throw new Error(`--check does not accept '${option}'.`)
            }
        }
        console.log(check(parsed.options))
        return
    }
    const result = await extract(parsed)
    if (!result.output) throw new Error("No output path was resolved.")
    await fs.mkdir(path.dirname(result.output), { recursive: true })
    await fs.writeFile(result.output, result.body, "utf8")
    console.log(`changelog: wrote ${result.description} to ${result.output}`)
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ""
if (invokedPath === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
    })
}
