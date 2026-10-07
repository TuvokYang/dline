/**
 * Documentation sections.
 *
 * Every top-level sidebar group in `navigation.mjs` is one section. The header
 * shows the sections as tabs, and each page shows only the sidebar of the
 * section that contains it. These helpers work on Starlight's resolved route
 * data, so labels are already localized and hrefs already carry the locale
 * prefix and the Pages base.
 *
 * @typedef {import("@astrojs/starlight/route-data").StarlightRouteData} RouteData
 * @typedef {RouteData["sidebar"][number]} SidebarEntry
 * @typedef {Extract<SidebarEntry, { type: "group" }>} SidebarGroup
 * @typedef {Extract<SidebarEntry, { type: "link" }>} SidebarLink
 * @typedef {{ label: string, href: string, isCurrent: boolean }} SectionTab
 */

/**
 * Every link inside a sidebar entry, depth first.
 * @param {SidebarEntry} entry
 * @returns {SidebarLink[]}
 */
export function linksOf(entry) {
	return entry.type === "group" ? entry.entries.flatMap(linksOf) : [entry]
}

/**
 * Split the route's sidebar into sections and narrow it to the current one.
 *
 * Pages outside every section (the splash home and 404) keep the full sidebar
 * and get tabs with no current section. Pagination drops a previous or next
 * link only when it points into another section, so frontmatter overrides that
 * link elsewhere survive.
 *
 * @param {Pick<RouteData, "sidebar" | "pagination">} route
 * @returns {{ tabs: SectionTab[], sidebar: SidebarEntry[], pagination: RouteData["pagination"] }}
 */
export function selectSection({ sidebar, pagination }) {
	const sections = sidebar.filter(
		/** @returns {entry is SidebarGroup} */ (entry) => entry.type === "group" && linksOf(entry).length > 0,
	)
	const current = sections.findIndex((section) => linksOf(section).some((link) => link.isCurrent))
	const tabs = sections.map((section, index) => ({
		label: section.label,
		href: linksOf(section)[0].href,
		isCurrent: index === current,
	}))
	if (current === -1) {
		return { tabs, sidebar, pagination }
	}
	const foreignHrefs = new Set(
		sections.flatMap((section, index) => (index === current ? [] : linksOf(section).map((link) => link.href))),
	)
	/** @param {SidebarLink | undefined} link */
	const withinSection = (link) => (link && foreignHrefs.has(link.href) ? undefined : link)
	return {
		tabs,
		sidebar: sections[current].entries,
		pagination: { prev: withinSection(pagination.prev), next: withinSection(pagination.next) },
	}
}
