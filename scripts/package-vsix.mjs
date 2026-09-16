#!/usr/bin/env node

/**
 * Production VSIX packaging script.
 *
 * The packaged identity is derived from the branch and the tag that points at
 * HEAD, so one command produces the right artifact for each release channel:
 *
 * | HEAD                    | name             | version                    |
 * | ----------------------- | ---------------- | -------------------------- |
 * | main + `vX.Y.Z`         | dline            | X.Y.Z (from the tag)       |
 * | dev + `dev-vX.Y.Z`      | dline-preview    | X.Y.Z (from the tag)       |
 * | dev without a tag       | dline-insiders   | major.minor.<unix seconds> |
 *
 * A tagged channel is a release candidate, so the tag version, package.json,
 * and both changelogs must already agree before anything is packaged. The
 * untagged insiders channel is a rolling build, so it replaces the patch with a
 * timestamp instead and skips the changelog gate.
 *
 * Any other combination is rejected rather than guessed: `main` without a tag is
 * the unfinished middle of a promotion, and a production tag outside `main` (or
 * a dev tag outside `dev`) means the tag was created on the wrong branch.
 *
 * package.json and README.md are restored even when packaging aborts.
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

const CHANGELOG_PATHS = [path.join(PROJECT_ROOT, "CHANGELOG.md"), path.join(PROJECT_ROOT, "docs", "changelog", "CHANGELOG_en.md")]

const PRODUCTION_TAG_PATTERN = /^v(\d+\.\d+\.\d+)$/
const DEV_TAG_PATTERN = /^dev-v(\d+\.\d+\.\d+)$/

const PREVIEW_SUFFIX = "-preview"
const PREVIEW_DISPLAY_SUFFIX = " (Preview)"
const INSIDERS_SUFFIX = "-insiders"
const INSIDERS_DISPLAY_SUFFIX = " (Insiders)"

/**
 * Run a git command and return its trimmed output.
 *
 * @param {string} command Git command to execute.
 * @returns {string|null} Trimmed stdout, or null when the command fails.
 */
function tryGit(command) {
	try {
		return execSync(command, { cwd: PROJECT_ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim()
	} catch {
		return null
	}
}

/**
 * Get short git hash of current HEAD.
 * @returns {string} 7-character git hash
 */
function getGitHash() {
	return tryGit("git rev-parse --short HEAD") ?? "unknown"
}

/**
 * Get the tag that points exactly at HEAD.
 * @returns {string|null} Tag name, or null when HEAD carries no tag.
 */
function getExactTag() {
	return tryGit("git describe --tags --exact-match")
}

/**
 * Get the current branch name.
 *
 * Returns null in detached HEAD, which is how CI normally checks out a tag.
 * @returns {string|null}
 */
function getCurrentBranch() {
	const branch = tryGit("git branch --show-current")
	return branch ? branch : null
}

/**
 * Read and parse package.json.
 * @returns {object}
 */
function readPackageJson() {
	return JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf-8"))
}

/**
 * Write package.json back to disk.
 * @param {object} pkg
 */
function writePackageJson(pkg) {
	fs.writeFileSync(PACKAGE_JSON_PATH, `${JSON.stringify(pkg, null, "\t")}\n`)
}

/**
 * Fail the run with a single-line reason.
 * @param {string} reason
 * @returns {never}
 */
function fail(reason) {
	console.error(`[package-vsix] ${reason}`)
	process.exit(1)
}

/**
 * Check whether a changelog documents the released version.
 *
 * Both language editions use `## [X.Y.Z]` section headings, so a missing
 * heading means the release notes were not written for this version.
 *
 * @param {string} changelogPath Absolute path to a changelog file.
 * @param {string} version Version expected to have a section.
 * @returns {boolean}
 */
function changelogDocumentsVersion(changelogPath, version) {
	if (!fs.existsSync(changelogPath)) return false
	const content = fs.readFileSync(changelogPath, "utf-8")
	return content.split(/\r?\n/).some((line) => line.trim() === `## [${version}]`)
}

/**
 * Reject a tagged release whose version is not consistent everywhere.
 *
 * @param {string} tag Tag pointing at HEAD.
 * @param {string} tagVersion Version parsed out of the tag.
 * @param {string} packageVersion Version currently in package.json.
 */
function assertReleaseVersionConsistency(tag, tagVersion, packageVersion) {
	if (tagVersion !== packageVersion) {
		fail(`Tag '${tag}' declares version ${tagVersion} but package.json is ${packageVersion}. Bump the version first.`)
	}

	const missing = CHANGELOG_PATHS.filter((changelogPath) => !changelogDocumentsVersion(changelogPath, tagVersion))
	if (missing.length > 0) {
		const names = missing.map((changelogPath) => path.relative(PROJECT_ROOT, changelogPath)).join(", ")
		fail(`No '## [${tagVersion}]' section found in: ${names}. Release notes must exist in every language edition.`)
	}
}

/**
 * Resolve which channel the current HEAD belongs to.
 *
 * @param {string} packageVersion Version currently in package.json.
 * @returns {{channel: "production"|"preview"|"insiders", version: string, tag: string|null}}
 */
function resolveChannel(packageVersion) {
	const branch = getCurrentBranch()
	const tag = getExactTag()
	const productionTag = tag?.match(PRODUCTION_TAG_PATTERN)
	const devTag = tag?.match(DEV_TAG_PATTERN)

	if (productionTag) {
		if (branch !== null && branch !== "main" && branch !== "master") {
			fail(`Production tag '${tag}' is checked out on '${branch}'. A production tag must live on main.`)
		}
		assertReleaseVersionConsistency(tag, productionTag[1], packageVersion)
		return { channel: "production", version: productionTag[1], tag }
	}

	if (devTag) {
		if (branch !== null && branch !== "dev") {
			fail(`Development tag '${tag}' is checked out on '${branch}'. A dev release tag must live on dev.`)
		}
		assertReleaseVersionConsistency(tag, devTag[1], packageVersion)
		return { channel: "preview", version: devTag[1], tag }
	}

	if (tag !== null) {
		fail(`Tag '${tag}' matches neither vX.Y.Z nor dev-vX.Y.Z. Remove it or use a supported release tag.`)
	}

	if (branch === "main" || branch === "master") {
		fail("main has no release tag. Packaging is only allowed from a tagged main commit; tag the promotion first.")
	}

	if (branch !== "dev") {
		fail(`Branch '${branch ?? "detached HEAD"}' has no packaging channel. Package from main, dev, or a release tag.`)
	}

	const [major, minor] = packageVersion.split(".")
	return { channel: "insiders", version: `${major}.${minor}.${Math.floor(Date.now() / 1000)}`, tag: null }
}

/**
 * Apply a channel identity to a package manifest in place.
 *
 * @param {object} pkg Parsed package.json.
 * @param {"production"|"preview"|"insiders"} channel Target channel.
 * @param {string} version Version to publish.
 * @returns {boolean} True when the manifest was modified.
 */
function applyChannelIdentity(pkg, channel, version) {
	if (channel === "production") return false

	const suffix = channel === "preview" ? PREVIEW_SUFFIX : INSIDERS_SUFFIX
	const displaySuffix = channel === "preview" ? PREVIEW_DISPLAY_SUFFIX : INSIDERS_DISPLAY_SUFFIX
	const displayName = pkg.displayName + displaySuffix

	pkg.preview = true
	pkg.name += suffix
	pkg.displayName = displayName
	pkg.version = version
	if (pkg.contributes?.viewsContainers?.activitybar?.title) {
		pkg.contributes.viewsContainers.activitybar.title = displayName
	}
	return true
}

// --- Main ---

const packageVersion = readPackageJson().version
const { channel, version, tag } = resolveChannel(packageVersion)

console.log(`[package-vsix] Git hash: ${getGitHash()}`)
console.log(`[package-vsix] Tag: ${tag ?? "(none)"}`)
console.log(`[package-vsix] Channel: ${channel}`)
console.log(`[package-vsix] Version: ${version}`)

await withMarketplaceReadme((cleanups) => {
	const originalContent = fs.readFileSync(PACKAGE_JSON_PATH, "utf-8")
	const pkg = JSON.parse(originalContent)

	// Register restoration before mutating package.json so signals during
	// vscode:prepublish or vsce packaging restore both temporary files.
	cleanups.defer(() => {
		console.log("[package-vsix] Restoring original package.json")
		fs.writeFileSync(PACKAGE_JSON_PATH, originalContent)
	})

	if (applyChannelIdentity(pkg, channel, version)) {
		writePackageJson(pkg)
		console.log(`[package-vsix] Applied ${channel} identity: name=${pkg.name}, version=${pkg.version}`)
	} else {
		console.log(`[package-vsix] Packaging production identity: name=${pkg.name}, version=${pkg.version}`)
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
