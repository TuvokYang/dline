/**
 * Rules for the built site in dist/. Every function is pure so the rules can be
 * tested without running a build; scripts/check-dist.mjs does the file I/O.
 */
import { locales, ROOT_LOCALE } from "../../src/data/locales.mjs"
import { findForbiddenText } from "./forbidden-patterns.mjs"
import { CJK_TEXT } from "./locale-text.mjs"

/**
 * @typedef {{ file: string, message: string }} DistIssue
 */

const SCRIPT_BODY = /(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi
const HTML_URL_ATTRIBUTE = /\s(?:href|src|poster|action)\s*=\s*(["'])(.*?)\1/gis
const HTML_SRCSET_ATTRIBUTE = /\ssrcset\s*=\s*(["'])(.*?)\1/gis
const REFRESH_URL = /\bcontent\s*=\s*(["'])\s*\d+\s*;\s*url\s*=\s*(.*?)\1/gis
const CSS_URL = /url\(\s*(["']?)(.*?)\1\s*\)/gi

/** Blocks whose text is code, markup or a deliberate language list, never page prose. */
const NON_PROSE_BLOCK = /<(script|style|pre|code|template|starlight-lang-select)\b[\s\S]*?<\/\1\s*>/gi
const VISIBLE_ATTRIBUTE = /\s(?:title|alt|aria-label|placeholder|data-copied|data-translations)\s*=\s*(["'])(.*?)\1/gis
const TAG = /<[^>]*>/g
const LEAK_CONTEXT = 24

/**
 * Entry page that every locale edition must produce, relative to dist/.
 * @returns {string[]}
 */
export function requiredEntryPages() {
	return Object.keys(locales).map((locale) => (locale === ROOT_LOCALE ? "index.html" : `${locale}/index.html`))
}

/**
 * Locale edition that owns a built file, derived from its first path segment.
 * @param {string} relativePath path relative to dist/, using "/" separators
 * @returns {string}
 */
export function localeOfBuiltFile(relativePath) {
	const [first = ""] = relativePath.split("/")
	return first !== ROOT_LOCALE && Object.hasOwn(locales, first) && relativePath.includes("/") ? first : ROOT_LOCALE
}

/**
 * Root-relative URLs in built HTML or CSS that miss the deployment base, which
 * would 404 on a GitHub Pages project site.
 * @param {string} text
 * @param {string} basePrefix base without trailing slash, e.g. "/dline"; "" for a root deployment
 * @returns {string[]} unique offending URLs in first-seen order
 */
export function findUnprefixedUrls(text, basePrefix) {
	if (!basePrefix) {
		return []
	}
	const offending = collectUrls(text.replace(SCRIPT_BODY, "$1$2")).filter(
		(url) => isRootRelative(url) && !hasBasePrefix(url, basePrefix),
	)
	return Array.from(new Set(offending))
}

/**
 * First Chinese character visible to readers of a non-Chinese page, with some
 * surrounding text for diagnosis. Code, scripts and the language picker are
 * ignored because they legitimately contain other scripts.
 * @param {string} html
 * @returns {string | undefined}
 */
export function findChineseLeak(html) {
	const withoutCode = html.replace(NON_PROSE_BLOCK, " ")
	const attributeText = Array.from(withoutCode.matchAll(VISIBLE_ATTRIBUTE), (match) => match[2] ?? "")
	const visibleText = [withoutCode.replace(TAG, " "), ...attributeText].join("\n")
	const match = CJK_TEXT.exec(visibleText)
	if (!match) {
		return undefined
	}
	const start = Math.max(0, match.index - LEAK_CONTEXT)
	return visibleText.slice(start, match.index + LEAK_CONTEXT).replace(/\s+/g, " ").trim()
}

/**
 * Validate one built text file.
 * @param {{ relativePath: string, text: string, basePrefix: string }} input
 * @returns {DistIssue[]}
 */
export function checkBuiltFile({ relativePath, text, basePrefix }) {
	/** @type {DistIssue[]} */
	const issues = []
	const report = (/** @type {string} */ message) => issues.push({ file: relativePath, message })

	const forbidden = findForbiddenText(text)
	if (forbidden) {
		report(forbidden.reason)
	}
	if (/\.(?:html|css)$/i.test(relativePath)) {
		for (const url of findUnprefixedUrls(text, basePrefix)) {
			report(`root-relative URL misses the site base ${basePrefix}/: ${url}`)
		}
	}
	if (/\.html$/i.test(relativePath) && localeOfBuiltFile(relativePath) !== ROOT_LOCALE) {
		const leak = findChineseLeak(text)
		if (leak) {
			report(`Chinese text on a non-Chinese page: "${leak}"`)
		}
	}
	return issues
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function collectUrls(text) {
	const urls = [
		...Array.from(text.matchAll(HTML_URL_ATTRIBUTE), (match) => match[2] ?? ""),
		...Array.from(text.matchAll(REFRESH_URL), (match) => match[2] ?? ""),
		...Array.from(text.matchAll(CSS_URL), (match) => match[2] ?? ""),
	]
	for (const match of text.matchAll(HTML_SRCSET_ATTRIBUTE)) {
		for (const candidate of (match[2] ?? "").split(",")) {
			urls.push(candidate.trim().split(/\s+/, 1)[0] ?? "")
		}
	}
	return urls.map((url) => url.trim())
}

/**
 * @param {string} url
 * @returns {boolean}
 */
function isRootRelative(url) {
	return url.startsWith("/") && !url.startsWith("//")
}

/**
 * @param {string} url
 * @param {string} basePrefix
 * @returns {boolean}
 */
function hasBasePrefix(url, basePrefix) {
	return url === basePrefix || ["/", "?", "#"].some((separator) => url.startsWith(`${basePrefix}${separator}`))
}
