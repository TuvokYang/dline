import { defineConfig } from "vitest/config"
import { createBackendProject } from "./vitest.backend-projects"

export default defineConfig({
	test: {
		projects: [createBackendProject("backend-smoke", ["src/__tests__/smoke.test.ts"])],
	},
})
