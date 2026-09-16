import { describe, expect, it } from "vitest"
import backendConfig from "../../vitest.backend.config"
import config from "../../vitest.config"
import smokeConfig from "../../vitest.smoke.config"

interface TestProjectConfig {
	test?: {
		name?: string
		include?: string[]
		exclude?: string[]
		setupFiles?: string[]
		environment?: string
		pool?: string
		maxWorkers?: number
		minWorkers?: number
		vmMemoryLimit?: string
	}
}

interface RootTestConfig {
	test?: {
		projects?: Array<TestProjectConfig | string>
	}
}

describe("Vitest project isolation", () => {
	/** Verifies backend domains remain bounded while the Webview keeps its own project boundary. */
	it("defines bounded backend projects and the Webview project boundary", () => {
		const rootConfig = config as RootTestConfig
		const projects = rootConfig.test?.projects ?? []
		const backendProjects = projects
			.slice(0, -1)
			.filter((project): project is TestProjectConfig => typeof project !== "string")
		const backendByName = new Map(backendProjects.map((project) => [project.test?.name, project.test]))

		expect(projects).toHaveLength(6)
		expect(projects[5]).toBe("webview-ui/vitest.config.ts")
		expect([...backendByName.keys()]).toEqual(["backend-task", "backend-prompts", "backend-hooks", "backend-core", "backend"])
		expect(backendByName.get("backend-task")?.include).toEqual(["src/core/task/**/*.test.ts"])
		expect(backendByName.get("backend-prompts")?.include).toEqual(["src/core/prompts/**/*.test.ts"])
		expect(backendByName.get("backend-hooks")?.include).toEqual(["src/core/hooks/**/*.test.ts"])
		expect(backendByName.get("backend-core")?.include).toEqual(["src/core/**/*.test.ts"])
		expect(backendByName.get("backend")?.include).toEqual(["src/**/*.test.ts", "src/**/__tests__/**/*.test.ts"])
		expect(backendByName.get("backend-core")?.exclude).toEqual(
			expect.arrayContaining(["src/core/task/**", "src/core/prompts/**", "src/core/hooks/**"]),
		)
		expect(backendByName.get("backend")?.exclude).toContain("src/core/**")

		for (const project of backendProjects.map((entry) => entry.test)) {
			expect(project?.environment).toBe("node")
			expect(project?.setupFiles).toEqual(["src/test/setup.ts"])
			expect(project?.pool).toBe("threads")
			expect(project?.maxWorkers).toBe(4)
			expect(project?.minWorkers).toBe(1)
			expect(project?.vmMemoryLimit).toBeUndefined()
		}
	})

	it("keeps backend and smoke entry points independent from the Webview project", () => {
		const backendProjects = (backendConfig as RootTestConfig).test?.projects ?? []
		const smokeProjects = (smokeConfig as RootTestConfig).test?.projects ?? []
		const backendNames = backendProjects.map((project) => (typeof project === "string" ? project : project.test?.name))
		const smokeProject = smokeProjects[0]

		expect(backendNames).toEqual(["backend-task", "backend-prompts", "backend-hooks", "backend-core", "backend"])
		expect(backendProjects.every((project) => typeof project !== "string")).toBe(true)
		expect(smokeProjects).toHaveLength(1)
		expect(typeof smokeProject).not.toBe("string")
		if (typeof smokeProject !== "string") {
			expect(smokeProject?.test?.name).toBe("backend-smoke")
			expect(smokeProject?.test?.include).toEqual(["src/__tests__/smoke.test.ts"])
			expect(smokeProject?.test?.environment).toBe("node")
		}
	})
})
