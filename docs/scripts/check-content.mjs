/**
 * Source-level documentation gate.
 *
 * Verifies locale parity, explicit navigation decisions, redirect integrity,
 * base-safe and locale-consistent links, conversion of Mintlify components,
 * and the absence of forbidden tracking or stale service references.
 */
import { readFile } from "node:fs/promises"
import { resolveSiteConfig } from "../site.config.mjs"
import { sidebar, unlistedSlugs } from "../src/data/navigation.mjs"
import { redirects } from "../src/data/redirects.mjs"
import { toPrefix } from "../src/plugins/remark-base-links.mjs"
import { listPages } from "./lib/content-files.mjs"
import { checkLocaleParity, checkNavigation, checkPage, checkRedirects, checkSections } from "./lib/content-rules.mjs"

const basePrefix = toPrefix(resolveSiteConfig().base)
const pages = await listPages()

const issues = [
	...(
		await Promise.all(pages.map(async (page) => checkPage({ page, source: await readFile(page.file, "utf8"), basePrefix })))
	).flat(),
	...checkLocaleParity(pages),
	...checkNavigation(pages, sidebar, unlistedSlugs),
	...checkSections(sidebar),
	...checkRedirects(redirects, pages),
]

const rootCount = pages.filter((page) => page.locale === "root").length
if (issues.length > 0) {
	for (const issue of issues) {
		console.error(`src/content/docs/${issue.file}:${issue.line} ${issue.message}`)
	}
	console.error(`\nContent check failed: ${issues.length} issue(s) in ${pages.length} page(s).`)
	process.exitCode = 1
} else {
	console.log(
		`Content check passed: ${pages.length} page(s) (${rootCount} en, ${pages.length - rootCount} zh-CN), ${Object.keys(redirects).length} redirect(s).`,
	)
}
