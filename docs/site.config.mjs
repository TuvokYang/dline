/**
 * Single source of truth for where the documentation site is served.
 *
 * GitHub Pages serves production from the custom-domain root at
 * https://docs.dline.cc/. DOCS_SITE and DOCS_BASE override the defaults (for a
 * fork, a project-path deployment, or a preview) without editing content or
 * rewriting the built output.
 *
 * Both astro.config.ts and the verification scripts import this module so the
 * build and its checks can never disagree about the base path.
 */

export const DEFAULT_SITE = "https://docs.dline.cc"
export const DEFAULT_BASE = "/"

/**
 * Resolve the deployed origin and base path.
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ site: string, base: string }}
 */
export function resolveSiteConfig(env = process.env) {
	return {
		site: normalizeSite(env.DOCS_SITE || DEFAULT_SITE),
		base: normalizeBase(env.DOCS_BASE || DEFAULT_BASE),
	}
}

/**
 * Normalize a base path to either "/" or "/segment/.../" with exactly one
 * leading and trailing slash.
 * @param {string} base
 * @returns {string}
 */
export function normalizeBase(base) {
	const trimmed = base.trim().replace(/^\/+|\/+$/g, "")
	return trimmed ? `/${trimmed}/` : "/"
}

/**
 * Keep only the origin of the configured site so that a base path can never be
 * smuggled in through DOCS_SITE.
 * @param {string} site
 * @returns {string}
 */
export function normalizeSite(site) {
	return new URL(site).origin
}
