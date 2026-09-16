#!/usr/bin/env node

/**
 * Production VSIX packaging script.
 *
 * Behavior:
 * - On main branch or git tag: packages normally (e.g., dline-5.0.4.vsix)
 * - On feature/development branches: applies the insiders identity
 *   (preview: true, name → dline-insiders, displayName → Dline (Insiders))
 *
 * This script:
 * 1. Checks if current HEAD is on main branch or a git tag
 * 2. If not, backs up package.json and applies insiders modifications
 * 3. Swaps README.marketplace.md into README.md and runs vsce package
 * 4. Restores README.md and package.json
 */

import { execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { withMarketplaceReadme } from "./marketplace-readme.mjs"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PROJECT_ROOT = path.join(__dirname, "..")
const PACKAGE_JSON_PATH = path.join(PROJECT_ROOT, "package.json")
const DIST_DIR = path.join(PROJECT_ROOT, "dist")

const INSIDERS_SUFFIX = "-insiders"
const INSIDERS_DISPLAY_SUFFIX = " (Insiders)"

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
 * Check if current HEAD is on a git tag.
 * @returns {boolean}
 */
function isOnTag() {
	try {
		execSync("git describe --tags --exact-match", {
			cwd: PROJECT_ROOT,
			stdio: "ignore",
		})
		return true
	} catch {
		return false
	}
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
		return false
	}
}

/**
 * Read and parse package.json.
 * @returns {object}
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

const onTag = isOnTag()
const onMain = isOnMainBranch()
const hash = getGitHash()

console.log(`[package-vsix] Git hash: ${hash}`)
console.log(`[package-vsix] On tag: ${onTag}`)
console.log(`[package-vsix] On main branch: ${onMain}`)

await withMarketplaceReadme((cleanups) => {
	if (onTag || onMain) {
		console.log("[package-vsix] On main branch or tag, packaging with original version...")
	} else {
		const originalContent = fs.readFileSync(PACKAGE_JSON_PATH, "utf-8")
		const pkg = JSON.parse(originalContent)

		// Register restoration before mutating package.json so signals during
		// vscode:prepublish or vsce packaging restore both temporary files.
		cleanups.defer(() => {
			console.log("[package-vsix] Restoring original package.json")
			fs.writeFileSync(PACKAGE_JSON_PATH, originalContent)
		})
		const originalName = pkg.name
		const originalDisplayName = pkg.displayName
		pkg.preview = true
		pkg.name = originalName + INSIDERS_SUFFIX
		pkg.displayName = originalDisplayName + INSIDERS_DISPLAY_SUFFIX
		if (pkg.contributes?.viewsContainers?.activitybar?.title) {
			pkg.contributes.viewsContainers.activitybar.title = originalDisplayName + INSIDERS_DISPLAY_SUFFIX
		}
		writePackageJson(pkg)
		console.log(`[package-vsix] Applied insiders theme: preview=true, name=${pkg.name}`)
	}

	// Ensure dist directory exists
	if (!fs.existsSync(DIST_DIR)) {
		fs.mkdirSync(DIST_DIR, { recursive: true })
	}

	const vsceCmd = "npx vsce package --no-dependencies --allow-package-secrets sendgrid"
	console.log(`[package-vsix] Running: ${vsceCmd}`)
	execSync(vsceCmd, {
		cwd: PROJECT_ROOT,
		stdio: "inherit",
		shell: true,
	})
	console.log("[package-vsix] Package completed successfully!")
})
