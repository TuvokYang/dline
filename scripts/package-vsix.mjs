#!/usr/bin/env node

/**
 * Channel-aware VSIX packaging script.
 *
 * Local invocations derive the channel from the branch and exact tag at HEAD.
 * CI can pass `--channel` explicitly so pull-request packages remain neutral
 * while dev, pre-release, and production runs receive their public identities:
 *
 * | Channel      | name             | version                                 | Marketplace track |
 * | ------------ | ---------------- | --------------------------------------- | ----------------- |
 * | ci           | dline            | package.json version                    | -                 |
 * | production   | dline            | X.EVEN.Z (from `vX.Y.Z`)                | release           |
 * | pre-release  | dline            | X.ODD.Z (from `dev-vX.Y.Z`)             | pre-release       |
 * | insiders     | dline-insiders   | major.<pre-release minor>.<unix seconds> | release           |
 *
 * Pre-release and production share the `tuvokyang.dline` extension; only the
 * VSIX pre-release marker (vsce `preRelease`) puts a build on the pre-release
 * track. Registries key a version only by its number, so the two channels split
 * the version space by minor parity (see release-version-policy.mjs).
 *
 * GitHub distribution follows the same channel contract:
 * - untagged main runs CI only and is rejected by automatic release packaging;
 * - vX.Y.Z publishes stable assets after full validation or a manager override;
 * - dev-vX.Y.Z publishes a public GitHub pre-release and the Marketplace pre-release track;
 * - every dev push publishes a per-commit maintainers-only Insiders draft and registries,
 *   including the dev head that a dev-vX.Y.Z tag names.
 *
 * Tagged channels require the tag, package.json, and both changelogs to agree.
 * The rolling insiders channel replaces the patch with a timestamp and skips
 * the changelog gate. package.json and README.md are restored even when
 * packaging aborts.
 */

import { execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { withMarketplaceReadme } from "./marketplace-readme.mjs"
import { assertChannelVersion, createInsidersVersion as createPolicyInsidersVersion } from "./release-version-policy.mjs"
import { packageVsix } from "./vsix-packager.mjs"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PROJECT_ROOT = path.join(__dirname, "..")
const PACKAGE_JSON_PATH = path.join(PROJECT_ROOT, "package.json")
const DIST_DIR = path.join(PROJECT_ROOT, "dist")

const CHANGELOG_PATHS = [path.join(PROJECT_ROOT, "CHANGELOG.md"), path.join(PROJECT_ROOT, "docs", "changelog", "CHANGELOG_en.md")]

const PRODUCTION_TAG_PATTERN = /^v(\d+\.\d+\.\d+)$/
const DEV_TAG_PATTERN = /^dev-v(\d+\.\d+\.\d+)$/
const INSIDERS_DRAFT_TAG_PATTERN = /^insiders-[0-9a-f]{40}$/

const PRE_RELEASE_CHANNEL = "pre-release"
const INSIDERS_SUFFIX = "-insiders"
const INSIDERS_DISPLAY_SUFFIX = " (Insiders)"
const SUPPORTED_CHANNELS = new Set(["auto", "ci", "production", PRE_RELEASE_CHANNEL, "insiders"])

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
 * Get the public release tag that points exactly at HEAD.
 *
 * Per-commit Insiders drafts use an internal `insiders-<SHA>` release tag.
 * Ignore those tags so rerunning an Insiders package remains valid and a later
 * dev-vX.Y.Z tag on the same commit is selected deterministically.
 *
 * @returns {string|null} Public or unsupported tag name, or null when HEAD has only internal draft tags.
 */
function getExactTag() {
	const rawTags = tryGit("git tag --points-at HEAD")
	if (!rawTags) return null

	const tags = rawTags.split(/\r?\n/).filter(Boolean)
	const unsupportedTags = tags.filter(
		(tag) => !PRODUCTION_TAG_PATTERN.test(tag) && !DEV_TAG_PATTERN.test(tag) && !INSIDERS_DRAFT_TAG_PATTERN.test(tag),
	)
	if (unsupportedTags.length > 0) return unsupportedTags[0]

	const releaseTags = tags.filter((tag) => PRODUCTION_TAG_PATTERN.test(tag) || DEV_TAG_PATTERN.test(tag))
	if (releaseTags.length > 1) {
		fail(`HEAD has multiple public release tags: ${releaseTags.join(", ")}. Keep exactly one release channel tag.`)
	}
	return releaseTags[0] ?? null
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
 * Git ref the packaged README links and images are pinned to.
 *
 * The marketplace README links to repository files with relative paths, and
 * every one of them must resolve to the revision this VSIX ships: a Preview or
 * Insiders build comes from `dev`, whose changelog and demos differ from the
 * default branch.
 *
 * A release tag is preferred because it is immutable and readable. An
 * untagged build (Insiders, CI) is pinned to the exact commit rather than the
 * moving branch.
 *
 * @param {string|null} tag Release tag at HEAD, when present.
 * @returns {string} Tag or commit SHA to link against.
 */
function resolveDocumentationRef(tag) {
	if (tag) return tag
	const commit = tryGit("git rev-parse HEAD")
	if (!commit) fail("Cannot resolve HEAD; the packaged README links need an exact commit.")
	return commit
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
 * @param {"production"|"pre-release"} channel Channel the tag selects.
 * @param {string} tag Tag pointing at HEAD.
 * @param {string} tagVersion Version parsed out of the tag.
 * @param {string} packageVersion Version currently in package.json.
 */
function assertReleaseVersionConsistency(channel, tag, tagVersion, packageVersion) {
	try {
		assertChannelVersion(channel, tagVersion)
	} catch (error) {
		fail(`Tag '${tag}': ${error.message}`)
	}
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
 * Create the monotonically increasing Marketplace-compatible insiders version.
 *
 * @param {string} packageVersion Version currently in package.json.
 * @returns {string}
 */
function createInsidersVersion(packageVersion) {
	try {
		return createPolicyInsidersVersion(packageVersion)
	} catch (error) {
		fail(`Cannot derive the Insiders version: ${error.message}`)
	}
}

/**
 * Resolve which channel the current HEAD belongs to.
 *
 * @param {string} packageVersion Version currently in package.json.
 * @returns {{channel: "production"|"pre-release"|"insiders", version: string, tag: string|null}}
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
		assertReleaseVersionConsistency("production", tag, productionTag[1], packageVersion)
		return { channel: "production", version: productionTag[1], tag }
	}

	if (devTag) {
		if (branch !== null && branch !== "dev") {
			fail(`Development tag '${tag}' is checked out on '${branch}'. A dev release tag must live on dev.`)
		}
		assertReleaseVersionConsistency(PRE_RELEASE_CHANNEL, tag, devTag[1], packageVersion)
		return { channel: PRE_RELEASE_CHANNEL, version: devTag[1], tag }
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

	return { channel: "insiders", version: createInsidersVersion(packageVersion), tag: null }
}

/**
 * Resolve an explicitly requested CI channel without relying on checkout mode.
 *
 * @param {string} requestedChannel Requested channel.
 * @param {string} packageVersion Version currently in package.json.
 * @returns {{channel: "ci"|"production"|"pre-release"|"insiders", version: string, tag: string|null}}
 */
function resolveRequestedChannel(requestedChannel, packageVersion) {
	if (requestedChannel === "auto") {
		return resolveChannel(packageVersion)
	}

	if (requestedChannel === "insiders") {
		// Insiders is a separate extension versioned by timestamp, so a release
		// tag cannot change its identity. A dev-vX.Y.Z tag must name the dev head,
		// which is exactly the commit the dev push packages as Insiders; rejecting
		// tagged commits would fail every pre-release's dev Tests run.
		return { channel: "insiders", version: createInsidersVersion(packageVersion), tag: null }
	}

	const tag = getExactTag()
	if (requestedChannel === "ci") {
		return { channel: "ci", version: packageVersion, tag }
	}

	const pattern = requestedChannel === "production" ? PRODUCTION_TAG_PATTERN : DEV_TAG_PATTERN
	const match = tag?.match(pattern)
	if (!match) {
		const expected = requestedChannel === "production" ? "vX.Y.Z" : "dev-vX.Y.Z"
		fail(`${requestedChannel} packaging requires an exact ${expected} tag at HEAD.`)
	}
	assertReleaseVersionConsistency(requestedChannel, tag, match[1], packageVersion)
	return { channel: requestedChannel, version: match[1], tag }
}

/**
 * Parse CLI options used by CI and local packaging.
 *
 * @param {string[]} argv Command-line arguments.
 * @returns {{requestedChannel: string, outputPath: string|null}}
 */
function parseArguments(argv) {
	let requestedChannel = "auto"
	let outputPath = null

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index]
		if (argument === "--channel") {
			requestedChannel = argv[index + 1]
			index += 1
		} else if (argument === "--out") {
			outputPath = argv[index + 1]
			index += 1
		} else if (argument === "--help" || argument === "-h") {
			console.log("Usage: npm run vsix -- [--channel auto|ci|insiders|pre-release|production] [--out <path>]")
			process.exit(0)
		} else {
			fail(`Unknown argument '${argument}'.`)
		}
	}

	if (!requestedChannel || !SUPPORTED_CHANNELS.has(requestedChannel)) {
		fail(`Unsupported channel '${requestedChannel ?? ""}'.`)
	}
	if (argv.includes("--out") && !outputPath) {
		fail("--out requires a path.")
	}

	return { requestedChannel, outputPath }
}

/**
 * Apply a channel identity to a package manifest in place.
 *
 * Only Insiders is a separate extension. A pre-release keeps the production
 * identity: it is the same extension on the Marketplace pre-release track, so
 * its manifest must not diverge from the release it precedes.
 *
 * @param {object} pkg Parsed package.json.
 * @param {"ci"|"production"|"pre-release"|"insiders"} channel Target channel.
 * @param {string} version Version to publish.
 * @returns {boolean} True when the manifest was modified.
 */
function applyChannelIdentity(pkg, channel, version) {
	if (channel !== "insiders") return false

	const displayName = pkg.displayName + INSIDERS_DISPLAY_SUFFIX

	pkg.preview = true
	pkg.name += INSIDERS_SUFFIX
	pkg.displayName = displayName
	pkg.version = version
	if (pkg.contributes?.viewsContainers?.activitybar?.title) {
		pkg.contributes.viewsContainers.activitybar.title = displayName
	}
	return true
}

// --- Main ---

const { requestedChannel, outputPath } = parseArguments(process.argv.slice(2))
const packageVersion = readPackageJson().version
const { channel, version, tag } = resolveRequestedChannel(requestedChannel, packageVersion)
const resolvedOutputPath = outputPath ? (path.isAbsolute(outputPath) ? outputPath : path.join(PROJECT_ROOT, outputPath)) : null

const documentationRef = resolveDocumentationRef(tag)

console.log(`[package-vsix] Git hash: ${getGitHash()}`)
console.log(`[package-vsix] Tag: ${tag ?? "(none)"}`)
console.log(`[package-vsix] Channel: ${channel}`)
console.log(`[package-vsix] Version: ${version}`)
console.log(`[package-vsix] Documentation ref: ${documentationRef}`)

await withMarketplaceReadme(
	async (cleanups) => {
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
			console.log(`[package-vsix] Packaging ${channel} identity: name=${pkg.name}, version=${pkg.version}`)
		}

		const destinationDirectory = resolvedOutputPath ? path.dirname(resolvedOutputPath) : DIST_DIR
		if (!fs.existsSync(destinationDirectory)) {
			fs.mkdirSync(destinationDirectory, { recursive: true })
		}

		const preRelease = channel === PRE_RELEASE_CHANNEL
		console.log(
			`[package-vsix] Packaging through the VSCE API${preRelease ? " as a pre-release" : ""}${resolvedOutputPath ? `: ${resolvedOutputPath}` : ""}`,
		)
		await packageVsix({
			cwd: PROJECT_ROOT,
			mode: "build-and-pack",
			packagePath: resolvedOutputPath,
			preRelease,
		})
		console.log("[package-vsix] Package completed successfully!")
	},
	{ ref: documentationRef },
)
