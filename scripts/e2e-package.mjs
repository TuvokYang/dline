#!/usr/bin/env node

/**
 * Local E2E packaging entry.
 *
 * The E2E VSIX is built from the checkout being tested, which is usually an
 * arbitrary commit: it has no release tag, and it must not be rejected by the
 * channel gates of `scripts/package-vsix.mjs`. This entry therefore selects the
 * content section itself — the checkout's sole current notes — and hands
 * the request to the shared VSCE adapter, so E2E packages the same four
 * language-split documents as every other local entry.
 *
 * The generated documents link to repository files, so this entry also names the
 * exact revision to link at: the checked-out commit, which is what this package
 * ships. It never routes through the tag-gated channel entry to obtain one.
 *
 * The `dist/` build lock is owned by the caller (`with-dist-lock.mjs`), exactly as
 * before; this script only replaces the bare `vsce package` invocation.
 */

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { packageVsix } from "./vsix-packager.mjs"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PROJECT_ROOT = path.join(__dirname, "..")
const PACKAGE_JSON_PATH = path.join(PROJECT_ROOT, "package.json")

const packagePath = path.join(PROJECT_ROOT, "dist", "e2e.vsix")

const manifest = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf-8"))
const version = manifest.version
if (typeof version !== "string" || !version.trim()) {
    throw new Error("[e2e-package] package.json declares no version to document.")
}

/**
 * Commit checked out in the project root: the revision this VSIX ships.
 *
 * @returns {string} Full commit SHA.
 */
function readDocumentationRef() {
    try {
        return execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: PROJECT_ROOT,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim()
    } catch {
        throw new Error("[e2e-package] Cannot resolve the packaged commit with `git rev-parse HEAD`.")
    }
}

const documentationRef = readDocumentationRef()

fs.mkdirSync(path.dirname(packagePath), { recursive: true })
console.log(`[e2e-package] Packaging ${manifest.name} ${version} as ${packagePath}`)
console.log(`[e2e-package] Documentation ref: ${documentationRef}`)

// `build-and-pack` keeps the prepublish build the previous `vsce package`
// invocation performed; only the changelog source moves to the generated documents.
const result = await packageVsix({
    cwd: PROJECT_ROOT,
    mode: "build-and-pack",
    packagePath,
    changelogSection: "current",
    documentationRef,
})

console.log(`[e2e-package] Package completed: ${result.packagePath}`)
