/**
 * Remark plugin that makes root-relative links in documentation content safe for
 * a site served below a base path, such as a GitHub Pages project site.
 *
 * Authors write base-free links (`/getting-started/installing-dline/`), which keeps
 * content independent of where the site is deployed. Astro does not rewrite
 * Markdown or MDX links with its `base`, so this plugin prefixes every
 * root-relative URL in Markdown links, images, definitions, raw HTML and MDX JSX
 * `href`/`src`/`link` attributes. Relative, hash-only and absolute URLs are left
 * untouched.
 */

const JSX_ELEMENT_TYPES = new Set(["mdxJsxFlowElement", "mdxJsxTextElement"])
const URL_NODE_TYPES = new Set(["link", "image", "definition"])
const LINK_ATTRIBUTES = new Set(["href", "src", "link"])
const HTML_URL_ATTRIBUTE = /(\s(?:href|src)\s*=\s*)(["'])(\/(?!\/)[^"']*)\2/g

/**
 * @param {{ base?: string }} [options]
 */
export function remarkBaseLinks(options = {}) {
	const prefix = toPrefix(options.base ?? "/")
	return (/** @type {MdastNode} */ tree) => {
		if (!prefix) {
			return
		}
		walk(tree, (node) => rewriteNode(node, prefix))
	}
}

/**
 * Convert an Astro base ("/" or "/segment/") into a prefix without a trailing
 * slash; the root base yields an empty prefix.
 * @param {string} base
 * @returns {string}
 */
export function toPrefix(base) {
	const trimmed = base.replace(/^\/+|\/+$/g, "")
	return trimmed ? `/${trimmed}` : ""
}

/**
 * Prefix a root-relative URL with the base prefix. Already-prefixed URLs are
 * returned unchanged so the rewrite is idempotent.
 * @param {string} url
 * @param {string} prefix
 * @returns {string}
 */
export function withBase(url, prefix) {
	if (!prefix || !isRootRelative(url)) {
		return url
	}
	if (url === prefix || url.startsWith(`${prefix}/`)) {
		return url
	}
	return `${prefix}${url}`
}

/**
 * @param {string} url
 * @returns {boolean}
 */
function isRootRelative(url) {
	return url.startsWith("/") && !url.startsWith("//")
}

/**
 * @param {MdastNode} node
 * @param {string} prefix
 */
function rewriteNode(node, prefix) {
	if (URL_NODE_TYPES.has(node.type) && typeof node.url === "string") {
		node.url = withBase(node.url, prefix)
		return
	}
	if (JSX_ELEMENT_TYPES.has(node.type) && Array.isArray(node.attributes)) {
		for (const attribute of node.attributes) {
			if (attribute.type === "mdxJsxAttribute" && LINK_ATTRIBUTES.has(attribute.name) && typeof attribute.value === "string") {
				attribute.value = withBase(attribute.value, prefix)
			}
		}
		return
	}
	if (node.type === "html" && typeof node.value === "string") {
		node.value = node.value.replace(
			HTML_URL_ATTRIBUTE,
			(_match, lead, quote, url) => `${lead}${quote}${withBase(url, prefix)}${quote}`,
		)
	}
}

/**
 * @param {MdastNode} node
 * @param {(node: MdastNode) => void} visitor
 */
function walk(node, visitor) {
	visitor(node)
	if (Array.isArray(node.children)) {
		for (const child of node.children) {
			walk(child, visitor)
		}
	}
}

/**
 * @typedef {{
 *   type: string,
 *   url?: string,
 *   value?: unknown,
 *   attributes?: Array<{ type: string, name: string, value?: unknown }>,
 *   children?: MdastNode[],
 * }} MdastNode
 */
