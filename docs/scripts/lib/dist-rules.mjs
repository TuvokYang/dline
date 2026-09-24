/**
 * Rules for the built site in dist/. Every function is pure so the rules can be
 * tested without running a build; scripts/check-dist.mjs does the file I/O.
 */
import { locales, ROOT_LOCALE } from "../../src/data/locales.mjs"
import { findForbiddenText } from "./forbidden-patterns.mjs"
import { CJK_TEXT } from "./locale-text.mjs"

/**
 * @typedef {{ file: string, message: string }} DistIssue
 * @typedef {{ url: string, file: string, fragment: string }} LinkTarget
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
const ELEMENT_ID = /\sid\s*=\s*(["'])(.*?)\1/gis
const HTML_ENTITY = /&(?:amp|quot|apos|lt|gt|#39|#x27);/g
/** @type {Readonly<Record<string, string>>} */
const ENTITY_TEXT = Object.freeze({
	"&amp;": "&",
	"&quot;": '"',
	"&apos;": "'",
	"&lt;": "<",
	"&gt;": ">",
	"&#39;": "'",
	"&#x27;": "'",
})

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
 * Where a URL found in a built page points inside dist/. Returns undefined for
 * URLs that leave the site or miss the base (the latter are reported by
 * findUnprefixedUrls).
 * @param {string} url raw attribute value
 * @param {string} fromFile dist-relative path of the page that contains the URL
 * @param {string} basePrefix base without trailing slash; "" for a root deployment
 * @returns {LinkTarget | undefined}
 */
export function resolveBuiltTarget(url, fromFile, basePrefix) {
	const value = decodeAttribute(url.trim())
	const hashIndex = value.indexOf("#")
	const fragment = hashIndex === -1 ? "" : safeDecode(value.slice(hashIndex + 1))
	const path = (hashIndex === -1 ? value : value.slice(0, hashIndex)).split("?", 1)[0] ?? ""
	if (path === "") {
		return value.startsWith("#") ? { url, file: fromFile, fragment } : undefined
	}
	if (!isRootRelative(path) || !hasBasePrefix(path, basePrefix)) {
		return undefined
	}
	const sitePath = safeDecode(path.slice(basePrefix.length)).replace(/^\/+/, "")
	return { url, file: builtFileFor(sitePath), fragment }
}

/**
 * Internal links, assets and redirects whose target file or fragment is not in
 * the build. Pure: the caller supplies every built file and the HTML text.
 * @param {{ pages: ReadonlyMap<string, string>, files: ReadonlySet<string>, basePrefix: string }} input
 *   pages maps dist-relative HTML paths to their text; files lists every dist-relative file
 * @returns {DistIssue[]}
 */
export function checkInternalLinks({ pages, files, basePrefix }) {
	/** @type {Map<string, Set<string>>} */
	const idCache = new Map()
	const idsOf = (/** @type {string} */ file) => {
		let ids = idCache.get(file)
		if (!ids) {
			ids = collectElementIds(pages.get(file) ?? "")
			idCache.set(file, ids)
		}
		return ids
	}
	/** @type {DistIssue[]} */
	const issues = []
	for (const [file, html] of pages) {
		const reported = new Set()
		for (const url of collectUrls(html.replace(SCRIPT_BODY, "$1$2"))) {
			const target = resolveBuiltTarget(url, file, basePrefix)
			const problem = target && !reported.has(url) ? describeMissingTarget(target, files, idsOf) : undefined
			if (problem) {
				reported.add(url)
				issues.push({ file, message: `${problem}: ${url}` })
			}
		}
	}
	return issues
}

/**
 * Element ids declared in built HTML, decoded to their literal values.
 * @param {string} html
 * @returns {Set<string>}
 */
export function collectElementIds(html) {
	const ids = html.replace(SCRIPT_BODY, "$1$2").matchAll(ELEMENT_ID)
	return new Set(Array.from(ids, (match) => decodeAttribute(match[2] ?? "")))
}

/**
 * @param {LinkTarget} target
 * @param {ReadonlySet<string>} files
 * @param {(file: string) => Set<string>} idsOf
 * @returns {string | undefined}
 */
function describeMissingTarget({ file, fragment }, files, idsOf) {
	if (!files.has(file)) {
		return `link target was not built (${file})`
	}
	if (fragment && /\.html$/i.test(file) && !idsOf(file).has(fragment)) {
		return `link fragment #${fragment} has no matching id in ${file}`
	}
	return undefined
}

/**
 * Built file that serves a base-free site path under Astro's directory format.
 * @param {string} sitePath path without the base and without a leading slash
 * @returns {string}
 */
function builtFileFor(sitePath) {
	if (sitePath === "" || sitePath.endsWith("/")) {
		return `${sitePath}index.html`
	}
	const lastSegment = sitePath.slice(sitePath.lastIndexOf("/") + 1)
	return /\.[a-z\d]+$/i.test(lastSegment) ? sitePath : `${sitePath}/index.html`
}

/**
 * @param {string} value
 * @returns {string}
 */
function decodeAttribute(value) {
	return value.replace(HTML_ENTITY, (entity) => ENTITY_TEXT[entity] ?? entity)
}

/**
 * @param {string} value
 * @returns {string}
 */
function safeDecode(value) {
	try {
		return decodeURIComponent(value)
	} catch {
		return value
	}
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
