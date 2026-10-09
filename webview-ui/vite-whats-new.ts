import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { Plugin } from "vite"
import type { WhatsNewInline, WhatsNewRelease } from "./src/config/whats-new-release"

/** Import specifier the webview uses to read the parsed release. */
export const WHATS_NEW_MODULE_ID = "virtual:dline-whats-new"
const RESOLVED_MODULE_ID = `\0${WHATS_NEW_MODULE_ID}`

/** English edition shown in the dialog; WHATS_NEW.md beside it is the Chinese counterpart. */
export const WHATS_NEW_SOURCE = resolve(__dirname, "../docs/whats-new/WHATS_NEW_en.md")

const RELEASE_HEADING = /^##\s+(\d+\.\d+\.\d+)\s*$/
const LEVEL_TWO_HEADING = /^##\s/
const SECTION_HEADING = /^#{1,2}\s/
const LIST_ITEM = /^-\s+(\S.*)$/
const CONTINUATION = /^\s{2,}(\S.*)$/
const NESTED_LIST = /^([-*+]|\d+[.)])\s/
const HTML_COMMENT = /<!--[\s\S]*?-->/g
// Bold and link text may not nest other syntax, so a nested marker is left in a text run and rejected.
const INLINE_TOKEN = /\*\*([^*`[\]]+)\*\*|`([^`]+)`|\[([^*`[\]]+)\]\(([^)\s]+)\)/g
// Syntax outside the supported subset that would otherwise render as literal characters.
const UNSUPPORTED_INLINE = /[*`]|\]\(|~~|<[A-Za-z/!]|&#?[A-Za-z0-9]+;/

interface PendingItem {
	text: string
	readonly location: string
}

/**
 * Parse the newest release section of a What's New document.
 *
 * Only the first `##` section is read, and its heading must be a bare
 * `X.Y.Z` version; text before it and older sections are documentation for
 * readers of the file. The section must be one flat `- ` list whose items use
 * only bold, inline code, and https links.
 *
 * @param markdown Document source.
 * @param source Path used in error messages.
 * @throws When the section is missing, empty, or uses unsupported Markdown, so
 *   a malformed document fails the build instead of shipping a broken dialog.
 */
export function parseWhatsNew(markdown: string, source: string): WhatsNewRelease {
	const lines = withoutComments(markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")).split("\n")
	const headingIndex = lines.findIndex((line) => LEVEL_TWO_HEADING.test(line))
	if (headingIndex === -1) {
		throw new Error(`${source}: no release heading such as "## 1.2.3" was found.`)
	}
	const version = RELEASE_HEADING.exec(lines[headingIndex])?.[1]
	if (version === undefined) {
		throw new Error(
			`${source}:${headingIndex + 1}: the first "##" heading must be a bare release version such as "## 1.2.3", got "${lines[headingIndex].trim()}".`,
		)
	}
	const items = readListItems(lines, headingIndex + 1, source)
	if (items.length === 0) {
		throw new Error(`${source}:${headingIndex + 1}: release ${version} has no "- " list items.`)
	}
	return { version, items: items.map((item) => parseInline(item.text, item.location)) }
}

/** Serve {@link parseWhatsNew} of `sourcePath` as {@link WHATS_NEW_MODULE_ID}. */
export function whatsNewPlugin(sourcePath: string = WHATS_NEW_SOURCE): Plugin {
	return {
		name: "dline-whats-new",
		resolveId(id) {
			return id === WHATS_NEW_MODULE_ID ? RESOLVED_MODULE_ID : null
		},
		load(id) {
			if (id !== RESOLVED_MODULE_ID) return null
			this.addWatchFile(sourcePath)
			const release = parseWhatsNew(readFileSync(sourcePath, "utf8"), sourcePath)
			return `export default ${JSON.stringify(release)}`
		},
	}
}

/** Blank out HTML comments while keeping their line breaks, so error line numbers stay accurate. */
function withoutComments(markdown: string): string {
	return markdown.replace(HTML_COMMENT, (comment) => comment.replace(/[^\n]/g, ""))
}

function readListItems(lines: readonly string[], firstLine: number, source: string): PendingItem[] {
	const items: PendingItem[] = []
	for (let index = firstLine; index < lines.length; index++) {
		const line = lines[index]
		const location = `${source}:${index + 1}`
		if (SECTION_HEADING.test(line)) break
		if (line.trim() === "") continue

		const item = LIST_ITEM.exec(line)
		if (item) {
			items.push({ text: item[1].trim(), location })
			continue
		}
		const continuation = CONTINUATION.exec(line)
		const previous = items.at(-1)
		if (continuation && previous) {
			if (NESTED_LIST.test(continuation[1])) {
				throw new Error(`${location}: nested lists are not supported.`)
			}
			previous.text = `${previous.text} ${continuation[1].trim()}`
			continue
		}
		throw new Error(`${location}: expected a "- " list item or an indented continuation line, got "${line.trim()}".`)
	}
	return items
}

function parseInline(text: string, location: string): WhatsNewInline[] {
	const runs: WhatsNewInline[] = []
	const pushText = (value: string) => {
		if (value === "") return
		if (UNSUPPORTED_INLINE.test(value)) {
			throw new Error(
				`${location}: unsupported inline Markdown in "${value.trim()}"; only **bold**, \`code\`, and [text](https://...) links are allowed.`,
			)
		}
		runs.push({ kind: "text", text: value })
	}

	let cursor = 0
	for (const match of text.matchAll(INLINE_TOKEN)) {
		const start = match.index ?? cursor
		pushText(text.slice(cursor, start))
		const [, strong, code, linkText, href] = match
		if (strong !== undefined) {
			runs.push({ kind: "strong", text: strong })
		} else if (code !== undefined) {
			runs.push({ kind: "code", text: code })
		} else {
			if (text[start - 1] === "!") {
				throw new Error(`${location}: image "${linkText}" is not supported; use a plain link.`)
			}
			if (!href.startsWith("https://")) {
				throw new Error(`${location}: link "${linkText}" must use an absolute https:// URL, got "${href}".`)
			}
			runs.push({ kind: "link", text: linkText, href })
		}
		cursor = start + match[0].length
	}
	pushText(text.slice(cursor))
	return runs
}
