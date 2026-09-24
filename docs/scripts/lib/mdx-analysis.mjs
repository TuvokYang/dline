/**
 * Lightweight, line-preserving analysis of Markdown/MDX source.
 *
 * Every masking helper keeps newlines in place so that indices found in the
 * masked text map back to the same line in the original file.
 */

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
const FENCE = /^\s*(`{3,}|~{3,})/
const INLINE_CODE = /(`+)[^`\n]*?\1/g
const IMPORT = /^\s*import\s+([\s\S]+?)\s+from\s+["'][^"']+["'];?\s*$/gm
const COMPONENT_TAG = /<([A-Z]\w*)(?=[\s/>.])/g
const INLINE_LINK = /(!?)\[(?:[^[\]]|\[[^\]]*\])*\]\(\s*<?([^()\s<>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g
const DEFINITION = /^[ \t]*\[[^\]]+\]:[ \t]*<?([^\s>]+)>?/gm
const ATTRIBUTE = /\b(?:href|src|link)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*["'`]([^"'`]*)["'`]\s*\})/g
const FRONTMATTER_KEY = /^([A-Za-z_][\w:-]*)\s*:/gm

/**
 * Split frontmatter from the body; the body keeps blank lines in place of the
 * frontmatter so indices in the body match the original file.
 * @param {string} source
 * @returns {{ frontmatter: string, body: string }}
 */
export function maskFrontmatter(source) {
	const match = FRONTMATTER.exec(source)
	if (!match) {
		return { frontmatter: "", body: source }
	}
	const blankLines = match[0].replace(/[^\n]/g, "")
	return { frontmatter: match[1] ?? "", body: blankLines + source.slice(match[0].length) }
}

/**
 * Blank out fenced code blocks and inline code spans.
 * @param {string} text
 * @returns {string}
 */
export function maskCode(text) {
	/** @type {string | undefined} */
	let openFence
	return text
		.split("\n")
		.map((line) => {
			const marker = FENCE.exec(line)?.[1]
			if (openFence) {
				if (marker && marker[0] === openFence[0] && marker.length >= openFence.length && line.trim() === marker) {
					openFence = undefined
				}
				return ""
			}
			if (marker) {
				openFence = marker
				return ""
			}
			return line.replace(INLINE_CODE, (span) => " ".repeat(span.length))
		})
		.join("\n")
}

/**
 * Local names bound by ESM imports in MDX.
 * @param {string} text
 * @returns {Set<string>}
 */
export function collectImports(text) {
	const names = new Set()
	for (const [, clause = ""] of text.matchAll(IMPORT)) {
		for (const part of clause.replace(/[{}]/g, ",").split(",")) {
			const local = part
				.trim()
				.split(/\s+as\s+/)
				.at(-1)
				?.replace(/^\*\s*/, "")
				.trim()
			if (local) {
				names.add(local)
			}
		}
	}
	return names
}

/**
 * First occurrence index of every capitalized JSX component tag.
 * @param {string} text
 * @returns {Map<string, number>}
 */
export function collectComponentTags(text) {
	const tags = new Map()
	for (const match of text.matchAll(COMPONENT_TAG)) {
		const name = match[1] ?? ""
		if (!tags.has(name)) {
			tags.set(name, match.index)
		}
	}
	return tags
}

/**
 * @typedef {{ url: string, kind: "link" | "image" | "attribute", index: number }} ContentLink
 */

/**
 * Every URL referenced by Markdown links, images, reference definitions and
 * JSX/HTML `href`, `src` or `link` attributes.
 * @param {string} text
 * @returns {ContentLink[]}
 */
export function collectLinks(text) {
	/** @type {ContentLink[]} */
	const links = []
	for (const match of text.matchAll(INLINE_LINK)) {
		links.push({ url: match[2] ?? "", kind: match[1] ? "image" : "link", index: match.index })
	}
	for (const match of text.matchAll(DEFINITION)) {
		links.push({ url: match[1] ?? "", kind: "link", index: match.index })
	}
	for (const match of text.matchAll(ATTRIBUTE)) {
		links.push({ url: match[1] ?? match[2] ?? match[3] ?? "", kind: "attribute", index: match.index })
	}
	return links.sort((left, right) => left.index - right.index)
}

/**
 * Top-level keys declared in a YAML frontmatter block.
 * @param {string} frontmatter
 * @returns {Set<string>}
 */
export function frontmatterKeys(frontmatter) {
	return new Set(Array.from(frontmatter.matchAll(FRONTMATTER_KEY), (match) => match[1] ?? ""))
}

/**
 * 1-based line number of a character index.
 * @param {string} text
 * @param {number} index
 * @returns {number}
 */
export function lineOf(text, index) {
	let line = 1
	for (let position = text.indexOf("\n"); position !== -1 && position < index; position = text.indexOf("\n", position + 1)) {
		line += 1
	}
	return line
}
