#!/usr/bin/env node

/**
 * Dev package script for VS Code extension.
 * Packages the extension with a git hash suffix when not on main branch or tag.
 *
 * Behavior:
 * - On main branch or git tag: packages normally (e.g., dline-5.0.4.vsix)
 * - On feature/development branches: appends git hash (e.g., dline-5.0.4-a1b2c3d.vsix)
 *
 * This script:
 * 1. Checks if current HEAD is on main branch or a git tag
 * 2. If not, backs up package.json and temporarily modifies version to include hash
 * 3. Generates the four packaged documents and runs vsce package
 * 4. Restores package.json
 */

import { execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { withSignalSafeCleanup } from "./signal-safe-cleanup.mjs"
import { packageVsix } from "./vsix-packager.mjs"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PROJECT_ROOT = path.join(__dirname, "..")
const PACKAGE_JSON_PATH = path.join(PROJECT_ROOT, "package.json")

/**
 * Formal release tags: production `vX.Y.Z` and pre-release `dev-vX.Y.Z`.
 *
 * Both name a released changelog section, so a local build of that commit
 * documents it. The packaged version keeps its own strategy, which this
 * pattern does not change.
 */
const RELEASE_TAG_PATTERN = /^(?:dev-)?v(\d+\.\d+\.\d+)$/

/** Selector for the single section the maintained notes currently hold. */
const CURRENT_SECTION = "current"

/**
 * Get short git hash of current HEAD.
 * @returns {string} 7-character git hash
 */
function getGitHash() {
    return execSync("git rev-parse --short HEAD", {
        cwd: PROJECT_ROOT,
        encoding: "utf-8",
    }).trim()
}

/**
 * Full SHA of HEAD, which GitHub resolves unambiguously in blob and raw URLs.
 * @returns {string}
 */
function tryGitFullHash() {
    return execSync("git rev-parse HEAD", {
        cwd: PROJECT_ROOT,
        encoding: "utf-8",
    }).trim()
}

/**
 * Exact tag at HEAD, or null when the commit is untagged.
 * @returns {string|null}
 */
function getExactTag() {
    try {
        return execSync("git describe --tags --exact-match", {
            cwd: PROJECT_ROOT,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim()
    } catch {
        return null
    }
}

/**
 * Content section this development build documents.
 *
 * A development package keeps its own version strategy (the packaged manifest
 * version may carry a hash suffix), so the notes are separate from it: a formal
 * version tag, production `vX.Y.Z` or pre-release `dev-vX.Y.Z`, names the
 * released section. Any other commit documents whatever section the maintained
 * notes currently hold: `Unreleased` during development, or the frozen candidate
 * between version preparation and publication.
 *
 * @param {string|null} tag Exact tag at HEAD.
 * @returns {string}
 */
function selectChangelogSection(tag) {
    return tag?.match(RELEASE_TAG_PATTERN)?.[1] ?? CURRENT_SECTION
}

/**
 * Check if current branch is main (or master).
 * @returns {boolean}
 */
function isOnMainBranch() {
    try {
        const branch = execSync("git branch --show-current", {
            cwd: PROJECT_ROOT,
            encoding: "utf-8",
        }).trim()
        return branch === "main" || branch === "master"
    } catch {
        // If detached HEAD or error, treat as non-main
        return false
    }
}

/**
 * Read and parse package.json.
 * @returns {{ version: string, [key: string]: any }}
 */
function _readPackageJson() {
    return JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf-8"))
}

/**
 * Write package.json back to disk.
 * @param {object} pkg
 */
function writePackageJson(pkg) {
    fs.writeFileSync(PACKAGE_JSON_PATH, `${JSON.stringify(pkg, null, "\t")}\n`)
}

// --- Main ---

const tag = getExactTag()
const onTag = tag !== null
const onMain = isOnMainBranch()
const hash = getGitHash()
const changelogSection = selectChangelogSection(tag)

// A dev VSIX is built from an arbitrary branch, so the generated documents'
// repository links are pinned to the exact commit being packaged rather than
// the default branch.
const documentationRef = tryGitFullHash()

console.log(`[package-dev] Git hash: ${hash}`)
console.log(`[package-dev] On tag: ${onTag}`)
console.log(`[package-dev] On main branch: ${onMain}`)
console.log(`[package-dev] Changelog section: ${changelogSection}`)
console.log(`[package-dev] Documentation ref: ${documentationRef}`)

/**
 * Verify the built bundle is a dev build right before packing.
 *
 * dist/extension.js is shared with other build entry points (e.g. the E2E
 * prepublish writes a production bundle to the same path). If one of those
 * runs between our build step and vsce packing, we would silently ship a
 * production bundle in a dev VSIX. The DLINE_BUILD_TYPE banner written by
 * esbuild.mjs makes the bundle variant verifiable.
 */
function assertDevBundle() {
    const bundlePath = path.join(PROJECT_ROOT, "dist", "extension.js")
    const header = fs.readFileSync(bundlePath, "utf-8").slice(0, 512)
    const marker = header.match(/DLINE_BUILD_TYPE:(\w+)/)
    if (!marker || marker[1] !== "dev") {
        throw new Error(
            `[package-dev] dist/extension.js is not a dev bundle (marker: ${marker ? marker[1] : "missing"}). ` +
                "Another build (e.g. test:e2e prepublish) overwrote it. Re-run vsix:dev without concurrent builds.",
        )
    }
    console.log("[package-dev] Verified dist/extension.js is a dev bundle.")
}

// Generated documents are handed to VSCE by explicit path, so this entry only
// restores its temporary manifest and never swaps the root README.
await withSignalSafeCleanup(async (cleanups) => {
    if (onTag || onMain) {
        console.log("[package-dev] On main branch or tag, packaging with original version...")
    } else {
        const originalContent = fs.readFileSync(PACKAGE_JSON_PATH, "utf-8")
        const pkg = JSON.parse(originalContent)
        const originalVersion = pkg.version

        // Register restoration before mutating package.json so signals during any
        // subsequent build or pack step restore the temporary manifest.
        cleanups.defer(() => {
            console.log(`[package-dev] Restoring original version: ${originalVersion}`)
            fs.writeFileSync(PACKAGE_JSON_PATH, originalContent)
        })
        pkg.version = `${pkg.version}-${hash}`
        writePackageJson(pkg)
        console.log(`[package-dev] Modified version: ${originalVersion} → ${pkg.version}`)
    }

    // The Webview build reads this to name the packaged build in What's New.
    process.env.DLINE_PACKAGING_VERSION = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf-8")).version

    // 1. Run the same validation and Webview build as vscode:prepublish,
    // then produce a dev extension bundle with IS_DEV=true and source maps.
    console.log("[package-dev] Building extension in dev mode...")
    for (const command of ["npm run check-types", "npm run build:webview", "npm run lint", "node esbuild.mjs"]) {
        execSync(command, {
            cwd: PROJECT_ROOT,
            stdio: "inherit",
            shell: true,
        })
    }

    // 2. Pack the already-built files without running vscode:prepublish, which
    // would overwrite dist with a production bundle.
    assertDevBundle()
    const packageManifest = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf-8"))
    const expectedPackagePath = path.join(PROJECT_ROOT, `${packageManifest.name}-${packageManifest.version}.vsix`)
    console.log("[package-dev] Creating VSIX through the shared VSCE API adapter...")
    const { packagePath } = await packageVsix({
        cwd: PROJECT_ROOT,
        cleanups,
        mode: "pack-only",
        packagePath: expectedPackagePath,
        // The section is the selected content; the adapter displays whatever
        // version this build wrote into package.json.
        changelogSection,
        documentationRef,
    })
    const packageSizeMb = fs.statSync(packagePath).size / 1_000_000
    console.log(`[package-dev] Package completed: ${packagePath} (${packageSizeMb.toFixed(2)} MB)`)
})
