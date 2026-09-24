/**
 * Built-artifact gate for the documentation site.
 *
 * Run after `npm run build` with the same DOCS_SITE / DOCS_BASE environment.
 * Verifies that every locale edition produced its entry page, that no
 * root-relative URL misses the GitHub Pages base, that every internal link,
 * asset and fragment resolves to a built file and element id, that English
 * pages contain no Chinese UI or prose, and that no forbidden tracking, font
 * service or retired runtime reached the published files.
 */
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { resolveSiteConfig } from "../site.config.mjs"
import { toPrefix } from "../src/plugins/remark-base-links.mjs"
import { checkBuiltFile, checkInternalLinks, requiredEntryPages } from "./lib/dist-rules.mjs"

const DIST_ROOT = fileURLToPath(new URL("../dist/", import.meta.url))
const TEXT_EXTENSIONS = new Set([".html", ".css", ".js", ".mjs", ".json", ".xml", ".txt", ".webmanifest"])

const basePrefix = toPrefix(resolveSiteConfig().base)
const allFiles = await listBuiltFiles(DIST_ROOT)
const present = new Set(allFiles)
const files = allFiles.filter((file) => TEXT_EXTENSIONS.has(path.posix.extname(file).toLowerCase()))
const texts = new Map(
	await Promise.all(files.map(async (relativePath) => [relativePath, await readFile(path.join(DIST_ROOT, relativePath), "utf8")])),
)
const pages = new Map(Array.from(texts).filter(([relativePath]) => relativePath.endsWith(".html")))

const issues = [
	...requiredEntryPages()
		.filter((page) => !present.has(page))
		.map((page) => ({ file: page, message: "required locale entry page was not built" })),
	...Array.from(texts, ([relativePath, text]) => checkBuiltFile({ relativePath, text, basePrefix })).flat(),
	...checkInternalLinks({ pages, files: present, basePrefix }),
]

if (issues.length > 0) {
	for (const issue of issues) {
		console.error(`dist/${issue.file}: ${issue.message}`)
	}
	console.error(`\nDist check failed: ${issues.length} issue(s) in ${files.length} file(s).`)
	process.exitCode = 1
} else {
	console.log(
		`Dist check passed: ${files.length} text file(s), ${pages.size} page(s) with resolved internal links under base ${basePrefix || "/"}.`,
	)
}

/**
 * Every file below dist/, as "/"-separated paths relative to it.
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function listBuiltFiles(root) {
	try {
		const entries = await readdir(root, { recursive: true, withFileTypes: true })
		return entries
			.filter((entry) => entry.isFile())
			.map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
			.sort()
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			console.error("dist/ does not exist; run `npm run build` first.")
			process.exit(1)
		}
		throw error
	}
}
