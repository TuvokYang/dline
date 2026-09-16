import { defineConfig } from "vitest/config"
import { backendProjects } from "./vitest.backend-projects"

export default defineConfig({
	test: {
		projects: backendProjects,
	},
})
