#!/usr/bin/env node

// Swap README.md with README.marketplace.md so the VS Code Marketplace listing
// (which is generated from the README baked into the .vsix at package time)
// keeps the extension-focused content even after the repo's README.md is
// repurposed as a multi-product landing page.
//
// The README files diverge in two directions:
//   - README.md is what GitHub renders on the repo home page. We want this to
//     cover the SDK, JetBrains plugin, CLI, and VS Code extension together.
//   - README.marketplace.md is what users see on the VS Code Marketplace and
//     inside the extension after install. It stays focused on the VS Code UX.
//
// vsce reads README.md from the extension root at `vsce package` / `vsce publish`
// time. Its `--readme-path` flag only selects among files that survive
// .vscodeignore, and README.marketplace.md is deliberately excluded from the
// .vsix, so we copy README.marketplace.md over README.md just before packaging
// and put the original back afterwards.
//
// swapIn is idempotent: if README.md already matches README.marketplace.md
// (e.g., an outer wrapper has already swapped), it no-ops instead of erroring
// on the backup file. This lets nested callers (publish.yml wrapping the whole
// step, plus the individual npm scripts swapping internally) coexist safely.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { withSignalSafeCleanup } from "./signal-safe-cleanup.mjs"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.join(__dirname, "..")

const README_PATH = path.join(projectRoot, "README.md")
const MARKETPLACE_PATH = path.join(projectRoot, "README.marketplace.md")
const BACKUP_PATH = path.join(projectRoot, ".README.github.bak")
const PACKAGE_JSON_PATH = path.join(projectRoot, "package.json")

/**
 * Branch the marketplace README links are authored against.
 *
 * The source document is written for readers browsing the repository default
 * branch, so every self-referencing link is committed as `/blob/main/...`.
 */
const AUTHORED_REF = "main"

function readFile(p) {
	return fs.readFileSync(p, "utf-8")
}

/** @param {string} value */
function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Repository web URL declared by the manifest, without a `.git` suffix.
 *
 * @returns {string|null} Normalized URL, or null when the manifest declares none.
 */
function readRepositoryUrl() {
	const manifest = JSON.parse(readFile(PACKAGE_JSON_PATH))
	const url = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url
	if (!url) return null
	return url
		.replace(/^git\+/, "")
		.replace(/\.git$/, "")
		.replace(/\/$/, "")
}

/**
 * Point this repository's own documentation links at the ref being packaged.
 *
 * A VSIX built from `dev` still carried `/blob/main/` links, so "变更日志" and
 * "English" resolved against the default branch rather than the code that was
 * actually shipped. Preview and Insiders readers then saw documentation for a
 * different revision, and a link to a file that only exists on the packaged
 * branch resolved to a 404.
 *
 * Only links whose prefix matches the manifest repository are rewritten, so
 * references to third-party repositories that legitimately contain `/blob/main/`
 * are left untouched.
 *
 * @param {string} content Marketplace README source.
 * @param {string|null} repositoryUrl Repository URL from the manifest.
 * @param {string|null} ref Branch, tag, or commit to link against.
 * @returns {string} Content with self-referencing links pinned to `ref`.
 */
export function rewriteRepositoryRefs(content, repositoryUrl, ref) {
	if (!ref || !repositoryUrl || ref === AUTHORED_REF) return content
	const pattern = new RegExp(`(${escapeRegExp(repositoryUrl)}/(?:blob|raw|tree)/)${AUTHORED_REF}(?=[/#?]|$)`, "g")
	return content.replace(pattern, `$1${ref}`)
}

/**
 * Swap the marketplace README into place.
 *
 * @param {{ ref?: string|null }} [options] `ref` pins self-referencing links to
 *   the packaged branch, tag, or commit. Omit it to publish the authored links.
 */
export function swapIn(options = {}) {
	if (!fs.existsSync(MARKETPLACE_PATH)) {
		throw new Error(`Missing ${MARKETPLACE_PATH}. The marketplace README must exist before publishing.`)
	}
	if (!fs.existsSync(README_PATH)) {
		throw new Error(`Missing ${README_PATH}. Cannot swap in marketplace README.`)
	}

	const desiredContent = rewriteRepositoryRefs(readFile(MARKETPLACE_PATH), readRepositoryUrl(), options.ref ?? null)

	// Compare against the content this call would write, so an outer wrapper that
	// already swapped with the same ref is still detected as a no-op.
	if (readFile(README_PATH) === desiredContent) {
		return { skipped: true }
	}

	if (fs.existsSync(BACKUP_PATH)) {
		throw new Error(
			`Stale backup at ${BACKUP_PATH}. A previous publish may have aborted before restoring README.md. ` +
				`Move it back to README.md manually before retrying.`,
		)
	}

	fs.copyFileSync(README_PATH, BACKUP_PATH)
	fs.writeFileSync(README_PATH, desiredContent)
	return { skipped: false }
}

export function restore() {
	if (!fs.existsSync(BACKUP_PATH)) {
		return { skipped: true }
	}
	fs.copyFileSync(BACKUP_PATH, README_PATH)
	fs.unlinkSync(BACKUP_PATH)
	return { skipped: false }
}

/**
 * Run `work` while README.marketplace.md is swapped into README.md.
 *
 * The cleanup stack is shared with callers so every temporary packaging file
 * is restored by the same normal, error, SIGINT, and SIGTERM lifecycle. When
 * `swapIn` skips because an outer wrapper already swapped, this call does not
 * register a README restore and remains safe to nest.
 *
 * @template T
 * @param {(cleanups: import("./signal-safe-cleanup.mjs").SynchronousCleanupStack) => T | Promise<T>} work
 * @param {Parameters<typeof withSignalSafeCleanup>[1] & { ref?: string|null }} [options]
 * @returns {Promise<T>}
 */
export async function withMarketplaceReadme(work, options = {}) {
	const { ref = null, ...cleanupOptions } = options
	return withSignalSafeCleanup(async (cleanups) => {
		const swapped = !swapIn({ ref }).skipped
		if (swapped) {
			cleanups.defer(() => restore())
		}
		return work(cleanups)
	}, cleanupOptions)
}

const invokedAsCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)
if (invokedAsCli) {
	const cmd = process.argv[2]
	try {
		if (cmd === "swap-in") {
			const result = swapIn()
			console.log(result.skipped ? "marketplace-readme: already swapped, skipping" : "marketplace-readme: swapped in")
		} else if (cmd === "restore") {
			const result = restore()
			console.log(result.skipped ? "marketplace-readme: no backup, skipping" : "marketplace-readme: restored")
		} else {
			console.error("Usage: marketplace-readme.mjs <swap-in|restore>")
			process.exit(2)
		}
	} catch (err) {
		console.error(`marketplace-readme: ${err.message}`)
		process.exit(1)
	}
}
