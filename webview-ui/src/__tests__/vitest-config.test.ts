import { describe, expect, it } from "vitest"
import { webviewProjectConfig } from "../../vitest.project"

interface WebviewTestConfig {
	test?: {
		name?: string
		include?: string[]
		setupFiles?: string[]
		environment?: string
		pool?: string
		maxWorkers?: number
		minWorkers?: number
		vmMemoryLimit?: string
	}
}

describe("Webview Vitest project", () => {
	it("owns Webview tests in a bounded jsdom project", () => {
		const test = (webviewProjectConfig as WebviewTestConfig).test

		expect(test?.name).toBe("webview")
		expect(test?.include).toEqual(["src/**/*.test.ts", "src/**/*.test.tsx", "src/**/*.spec.ts", "src/**/*.spec.tsx"])
		expect(test?.environment).toBe("jsdom")
		expect(test?.setupFiles).toEqual(["./src/setupTests.ts"])
		expect(test?.pool).toBe("vmThreads")
		expect(test?.maxWorkers).toBe(4)
		expect(test?.minWorkers).toBeUndefined()
		expect(test?.vmMemoryLimit).toBeUndefined()
	})
})
