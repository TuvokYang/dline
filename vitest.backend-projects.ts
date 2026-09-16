import { resolve } from "node:path"
import type { Plugin } from "vite"
import { defineProject } from "vitest/config"

/**
 * Resolve webview-local @ imports before the root @ alias handles backend imports.
 */
function resolveWebviewAlias(): Plugin {
	return {
		name: "resolve-webview-alias",
		resolveId(source, importer) {
			if (!source.startsWith("@/") || !importer?.includes("webview-ui")) {
				return null
			}

			return resolve(__dirname, "webview-ui/src", source.slice(2))
		},
	}
}

const sharedTestConfig = {
	exclude: ["node_modules/**", "dist/**", "src/test/e2e/**"],
	globals: true,
	setupFiles: ["src/test/setup.ts"],
	testTimeout: 60_000,
	clearMocks: false,
	restoreMocks: false,
	// `vmThreads` gives every test file its own VM context, which cannot share the Node
	// module cache. Each file therefore rebuilt the whole module graph, so import cost
	// dominated the suite by two orders of magnitude over actual test execution. Worker
	// threads reuse that cache while `isolate` still gives each file a fresh module
	// registry, keeping shared global state contained.
	pool: "threads" as const,
	maxWorkers: 4,
	minWorkers: 1,
}

const backendResolve = {
	alias: {
		"@": resolve(__dirname, "src"),
		"@api": resolve(__dirname, "src/core/api"),
		"@core": resolve(__dirname, "src/core"),
		"@generated": resolve(__dirname, "src/generated"),
		"@hosts": resolve(__dirname, "src/hosts"),
		"@integrations": resolve(__dirname, "src/integrations"),
		"@packages": resolve(__dirname, "src/packages"),
		"@services": resolve(__dirname, "src/services"),
		"@shared": resolve(__dirname, "src/shared"),
		"@utils": resolve(__dirname, "src/utils"),
	},
}

/**
 * Create one bounded backend project for an exclusive test domain.
 *
 * Keeping the domains separate is deliberate. Each project's narrow `include` also
 * bounds how many files Vitest globs and resolves, so merging every domain into a
 * single wide `include` made a focused run scan the entire suite and became far
 * slower than paying each project's startup cost.
 *
 * @param name Project name exposed to Vitest selectors and reports.
 * @param include Test file patterns owned by the project.
 * @param exclude Additional patterns delegated to other backend projects.
 * @returns A backend project with shared aliases and worker constraints.
 */
export function createBackendProject(name: string, include: string[], exclude: string[] = []) {
	return defineProject({
		plugins: [resolveWebviewAlias()],
		resolve: backendResolve,
		test: {
			...sharedTestConfig,
			name,
			environment: "node",
			include,
			exclude: [...sharedTestConfig.exclude, ...exclude],
		},
	})
}

export const backendProjects = [
	createBackendProject("backend-task", ["src/core/task/**/*.test.ts"]),
	createBackendProject("backend-prompts", ["src/core/prompts/**/*.test.ts"]),
	createBackendProject("backend-hooks", ["src/core/hooks/**/*.test.ts"]),
	createBackendProject(
		"backend-core",
		["src/core/**/*.test.ts"],
		["src/core/task/**", "src/core/prompts/**", "src/core/hooks/**"],
	),
	createBackendProject("backend", ["src/**/*.test.ts", "src/**/__tests__/**/*.test.ts"], ["src/core/**"]),
]
