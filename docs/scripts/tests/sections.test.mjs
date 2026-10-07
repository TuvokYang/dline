import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { linksOf, selectSection } from "../../src/data/sections.mjs"

/**
 * @param {string} href
 * @param {boolean} [isCurrent]
 */
const link = (href, isCurrent = false) => ({
	type: /** @type {const} */ ("link"),
	label: href,
	href,
	isCurrent,
	badge: undefined,
	attrs: {},
})

/**
 * @param {string} label
 * @param {any[]} entries
 */
const group = (label, entries) => ({
	type: /** @type {const} */ ("group"),
	label,
	entries,
	collapsed: false,
	badge: undefined,
})

/** @param {string} [current] */
const sidebarAt = (current) => [
	group("User Guide", [
		group("Quick Start", [link("/overview/", current === "/overview/"), link("/install/", current === "/install/")]),
		group("Models", [link("/models/", current === "/models/")]),
	]),
	group("Developer Guide", [link("/developer-guide/setup/", current === "/developer-guide/setup/")]),
]

describe("linksOf", () => {
	it("flattens nested groups depth first", () => {
		assert.deepEqual(
			linksOf(sidebarAt()[0]).map((entry) => entry.href),
			["/overview/", "/install/", "/models/"],
		)
	})
})

describe("selectSection", () => {
	it("narrows the sidebar to the section that contains the current page", () => {
		const sidebar = sidebarAt("/models/")
		const result = selectSection({ sidebar, pagination: { prev: undefined, next: undefined } })
		assert.equal(result.sidebar, sidebar[0].entries)
		assert.deepEqual(result.tabs, [
			{ label: "User Guide", href: "/overview/", isCurrent: true },
			{ label: "Developer Guide", href: "/developer-guide/setup/", isCurrent: false },
		])
	})

	it("keeps pagination inside the current section", () => {
		const sidebar = sidebarAt("/models/")
		const pagination = { prev: link("/install/"), next: link("/developer-guide/setup/") }
		const result = selectSection({ sidebar, pagination })
		assert.equal(result.pagination.prev?.href, "/install/")
		assert.equal(result.pagination.next, undefined)
	})

	it("drops a previous link that points into another section", () => {
		const sidebar = sidebarAt("/developer-guide/setup/")
		const result = selectSection({ sidebar, pagination: { prev: link("/models/"), next: undefined } })
		assert.equal(result.pagination.prev, undefined)
		assert.equal(result.sidebar, sidebar[1].entries)
	})

	it("keeps pagination that leaves the sidebar, such as a frontmatter override", () => {
		const sidebar = sidebarAt("/overview/")
		const result = selectSection({ sidebar, pagination: { prev: link("/elsewhere/"), next: undefined } })
		assert.equal(result.pagination.prev?.href, "/elsewhere/")
	})

	it("leaves pages outside every section untouched and marks no tab", () => {
		const sidebar = sidebarAt()
		const pagination = { prev: undefined, next: undefined }
		const result = selectSection({ sidebar, pagination })
		assert.equal(result.sidebar, sidebar)
		assert.equal(result.pagination, pagination)
		assert.ok(result.tabs.every((tab) => !tab.isCurrent))
	})

	it("ignores empty groups and top-level links when building tabs", () => {
		const sidebar = [group("Empty", []), link("/loose/"), ...sidebarAt("/overview/")]
		const result = selectSection({ sidebar, pagination: { prev: undefined, next: undefined } })
		assert.deepEqual(
			result.tabs.map((tab) => tab.label),
			["User Guide", "Developer Guide"],
		)
	})
})
