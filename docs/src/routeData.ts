import { defineRouteMiddleware } from "@astrojs/starlight/route-data"
import { selectSection } from "./data/sections.mjs"

/**
 * Starlight route middleware: narrow each page's sidebar and pagination to its
 * documentation section and publish the section tabs for the header.
 */
export const onRequest = defineRouteMiddleware((context) => {
	const route = context.locals.starlightRoute
	const { tabs, sidebar, pagination } = selectSection(route)
	context.locals.dlineSections = tabs
	route.sidebar = sidebar
	route.pagination = pagination
})
