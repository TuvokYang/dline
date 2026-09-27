import { readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { locales, ROOT_LOCALE } from "../../src/data/locales.mjs"

export { ROOT_LOCALE }
export const CONTENT_ROOT = fileURLToPath(new URL("../../src/content/docs/", import.meta.url))
export const SECONDARY_LOCALES = Object.freeze(Object.keys(locales).filter((locale) => locale !== ROOT_LOCALE))

const PAGE_EXTENSION = /\.mdx?$/i

/**
 * @typedef {{ relativePath: string, locale: string, slug: string }} PageIdentity
 * @typedef {PageIdentity & { file: string }} PageEntry
 */

/**
 * Map a path relative to the docs content root onto its locale and Starlight
 * slug. Returns undefined for files Starlight does not publish as pages.
 * @param {string} relativePath
 * @returns {PageIdentity | undefined}
 */
export function toPageIdentity(relativePath) {
	const posixPath = relativePath.replaceAll("\\", "/")
	if (!PAGE_EXTENSION.test(posixPath)) {
		return undefined
	}
	const segments = posixPath.replace(PAGE_EXTENSION, "").toLowerCase().split("/")
	if (segments.at(-1) === "index") {
		segments.pop()
	}
	const locale = SECONDARY_LOCALES.includes(segments[0] ?? "") ? String(segments.shift()) : ROOT_LOCALE
	return { relativePath: posixPath, locale, slug: segments.join("/") }
}

/**
 * Site path of a page without the deployment base, e.g. "/zh-cn/usage/ide/".
 * @param {PageIdentity} page
 * @returns {string}
 */
export function pagePath(page) {
	const segments = [page.locale === ROOT_LOCALE ? "" : page.locale, page.slug].filter(Boolean)
	return segments.length ? `/${segments.join("/")}/` : "/"
}

/**
 * List every published page below the content root. Files whose names start
 * with an underscore are ignored, matching Starlight's docs loader.
 * @param {string} [root]
 * @returns {Promise<PageEntry[]>}
 */
export async function listPages(root = CONTENT_ROOT) {
	const entries = await readdir(root, { recursive: true, withFileTypes: true })
	/** @type {PageEntry[]} */
	const pages = []
	for (const entry of entries) {
		if (!entry.isFile() || entry.name.startsWith("_")) {
			continue
		}
		const file = path.join(entry.parentPath, entry.name)
		const identity = toPageIdentity(path.relative(root, file))
		if (identity) {
			pages.push({ ...identity, file })
		}
	}
	return pages.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}
