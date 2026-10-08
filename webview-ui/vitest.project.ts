import { resolve } from "node:path"
import type { UserConfig } from "vitest/config"

export const webviewProjectConfig = {
	root: __dirname,
	define: {
		__PLATFORM__: JSON.stringify("vscode"),
		__DLINE_REPOSITORY_URL__: JSON.stringify("https://github.com/TuvokYang/Dline"),
		__DLINE_SOURCE_REF__: JSON.stringify("test-ref"),
	},
	test: {
		name: "webview",
		environment: "jsdom",
		include: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/**/*.spec.ts", "src/**/*.spec.tsx"],
		globals: true,
		setupFiles: ["./src/setupTests.ts"],
		testTimeout: 60_000,
		clearMocks: false,
		restoreMocks: false,
		pool: "vmThreads",
		maxWorkers: 4,
	},
	resolve: {
		alias: {
			"@": resolve(__dirname, "./src"),
			"@components": resolve(__dirname, "./src/components"),
			"@context": resolve(__dirname, "./src/context"),
			"@shared": resolve(__dirname, "../src/shared"),
			"@utils": resolve(__dirname, "./src/utils"),
		},
	},
} satisfies UserConfig
