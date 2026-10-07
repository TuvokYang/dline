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
//
// README.marketplace.md links to repository files with relative paths. The
// swap pins every such link to the exact packaged ref (see pinRepositoryLinks),
// so the listing never falls back to vsce's default of the repository's
// default branch.

import { execFileSync } from "node:child_process"
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

const URL_SCHEME = /^[a-z][a-z\d+.-]*:/i
const CODE_FENCE = /^\s*(?:```|~~~)/
/** `[text](target "title")` and `![alt](target)`; the text may not contain brackets. */
const MARKDOWN_LINK = /(!?)\[([^\]]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g
const HTML_MEDIA_SOURCE = /(<(?:img|source|video)\b[^>]*?\s(?:src|poster)=)(["'])(.*?)\2/gi
const HTML_ANCHOR_TARGET = /(<a\b[^>]*?\shref=)(["'])(.*?)\2/gi

function readFile(p) {
	return fs.readFileSync(p, "utf-8")
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
 * Commit checked out in the project root: the revision a VSIX built now ships.
 *
 * @returns {string} Full commit SHA.
 */
function currentCommit() {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: projectRoot,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim()
	} catch {
		throw new Error("Cannot resolve the packaged commit with `git rev-parse HEAD`. Pass an explicit ref to pin README links.")
	}
}

/** @param {string} target */
function isRepositoryPath(target) {
	return target !== "" && !URL_SCHEME.test(target) && !target.startsWith("#") && !target.startsWith("//")
}

/**
 * Absolute GitHub URL of a repository-relative path at `ref`.
 *
 * @param {string} repositoryUrl Repository web URL.
 * @param {string} ref Branch, tag, or commit.
 * @param {"blob"|"raw"} view `raw` serves the file itself (images); `blob` renders it.
 * @param {string} target Path relative to the repository root, optionally with a fragment or query.
 */
function pinnedUrl(repositoryUrl, ref, view, target) {
	const suffixStart = target.search(/[?#]/)
	const filePath = suffixStart === -1 ? target : target.slice(0, suffixStart)
	const suffix = suffixStart === -1 ? "" : target.slice(suffixStart)
	const normalized = path.posix.normalize(filePath.replace(/^\/+/, ""))
	if (normalized === ".." || normalized.startsWith("../")) {
		throw new Error(`Marketplace README link '${target}' points outside the repository.`)
	}
	return `${repositoryUrl}/${view}/${ref}/${normalized}${suffix}`
}

/**
 * Pin one line of Markdown/HTML: images to `raw`, links to `blob`.
 *
 * @param {string} line
 * @param {(view: "blob"|"raw", target: string) => string} pin
 */
function pinLine(line, pin) {
	return line
		.replace(MARKDOWN_LINK, (match, bang, text, target, title) =>
			isRepositoryPath(target) ? `${bang}[${text}](${pin(bang ? "raw" : "blob", target)}${title})` : match,
		)
		.replace(HTML_MEDIA_SOURCE, (match, prefix, quote, target) =>
			isRepositoryPath(target) ? `${prefix}${quote}${pin("raw", target)}${quote}` : match,
		)
		.replace(HTML_ANCHOR_TARGET, (match, prefix, quote, target) =>
			isRepositoryPath(target) ? `${prefix}${quote}${pin("blob", target)}${quote}` : match,
		)
}

/**
 * Pin every repository-relative link and image to the ref being packaged.
 *
 * The source README links to repository files with relative paths. The
 * Marketplace and Open VSX render the listing outside the repository, and vsce
 * would otherwise resolve those paths against `blob/HEAD`, the default branch:
 * a Preview or Insiders VSIX built from `dev` then showed another revision's
 * changelog, and a demo that exists only on `dev` rendered as a broken image.
 *
 * Absolute URLs, in-page anchors and fenced code blocks are left untouched.
 *
 * @param {string} content Marketplace README source.
 * @param {string} repositoryUrl Repository web URL from the manifest.
 * @param {string} ref Branch, tag, or commit the VSIX is built from.
 * @returns {string} Content whose repository links all point at `ref`.
 */
export function pinRepositoryLinks(content, repositoryUrl, ref) {
	if (!repositoryUrl) throw new Error("package.json declares no repository URL; README links cannot be pinned.")
	if (!ref) throw new Error("No ref to pin README links to.")
	const pin = (view, target) => pinnedUrl(repositoryUrl, ref, view, target)
	let inFence = false
	return content
		.split("\n")
		.map((line) => {
			if (CODE_FENCE.test(line)) {
				inFence = !inFence
				return line
			}
			return inFence ? line : pinLine(line, pin)
		})
		.join("\n")
}

/**
 * Swap the marketplace README into place.
 *
 * @param {{ ref?: string|null }} [options] Branch, tag, or commit the repository
 *   links are pinned to. Defaults to the checked-out commit.
 */
export function swapIn(options = {}) {
	if (!fs.existsSync(MARKETPLACE_PATH)) {
		throw new Error(`Missing ${MARKETPLACE_PATH}. The marketplace README must exist before publishing.`)
	}
	if (!fs.existsSync(README_PATH)) {
		throw new Error(`Missing ${README_PATH}. Cannot swap in marketplace README.`)
	}

	const ref = options.ref || currentCommit()
	const desiredContent = pinRepositoryLinks(readFile(MARKETPLACE_PATH), readRepositoryUrl(), ref)

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
