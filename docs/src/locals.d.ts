declare namespace App {
	interface Locals {
		/** Header tabs for the documentation sections, set by the route middleware in `src/routeData.ts`. */
		dlineSections?: import("./data/sections.mjs").SectionTab[]
	}
}
