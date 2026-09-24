/**
 * Navigation decisions for the documentation site.
 *
 * `sidebar` is the only source of sidebar structure. Group labels are written in
 * the root locale (Simplified Chinese) with English translations keyed by BCP-47
 * tag; page entries use slugs so each locale shows its own page title and the
 * Pages base path is applied by Starlight.
 *
 * Starlight publishes every content file, including files missing from the
 * sidebar. `scripts/check-content.mjs` therefore requires each page to be either
 * reachable from `sidebar` or listed in `unlistedSlugs`, so no page is published
 * without an explicit decision.
 */

/** @type {NonNullable<import("@astrojs/starlight/types").StarlightUserConfig["sidebar"]>} */
export const sidebar = [
	{
		label: "使用指南",
		translations: { en: "User Guide" },
		items: ["dline-overview"],
	},
]

/**
 * Slugs that are intentionally published without a sidebar entry.
 * The empty slug is the splash home page of each locale.
 * @type {ReadonlySet<string>}
 */
export const unlistedSlugs = new Set([""])
