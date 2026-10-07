/// <reference types="vitest/config" />

import { writeFileSync } from "node:fs"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react-swc"
import { resolve } from "path"
import * as typescript from "typescript"
import { defineConfig, type Plugin, type PluginOption, type ViteDevServer } from "vite"
import checker from "vite-plugin-checker"
import { supportsVitePluginCheckerTypeScript } from "./vite-checker-compatibility"
import { virtuosoUpwardCompensationPlugin } from "./vite-virtuoso-upward-compensation"

// Custom plugin to write the server port to a file
const writePortToFile = (): Plugin => {
	return {
		name: "write-port-to-file",
		configureServer(server: ViteDevServer) {
			server.httpServer?.once("listening", () => {
				const address = server.httpServer?.address()
				const port = typeof address === "object" && address ? address.port : null

				if (port) {
					const origin = `http://localhost:${port}`
					server.config.server.origin = origin
					const portFilePath = resolve(__dirname, ".vite-port")
					writeFileSync(portFilePath, port.toString())
				} else {
					console.warn("[writePortToFile] Could not determine server port")
				}
			})
		},
	}
}

const isDevBuild = process.argv.includes("--dev-build")
const plugins: PluginOption[] = [virtuosoUpwardCompensationPlugin(), react(), tailwindcss(), writePortToFile()]
if (supportsVitePluginCheckerTypeScript(typescript)) {
	plugins.push(checker({ typescript: true }) as Plugin)
} else {
	console.warn(
		"[vite] Skipping vite-plugin-checker because the installed TypeScript package does not expose its legacy compiler host API; use the existing tsc watch process for type diagnostics.",
	)
}

// Valid platforms, these should the keys in platform-configs.json
const VALID_PLATFORMS = ["vscode", "standalone"]
const platform = process.env.PLATFORM || "vscode" // Default to vscode

if (!VALID_PLATFORMS.includes(platform)) {
	throw new Error(`Invalid PLATFORM "${platform}". Must be one of: ${VALID_PLATFORMS.join(", ")}`)
}
console.log("Building webview for", platform)

export default defineConfig({
	base: "./",
	optimizeDeps: {
		force: true, // Forces re-optimization
	},
	plugins,
	test: {
		name: "webview",
		environment: "jsdom",
		include: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/**/*.spec.ts", "src/**/*.spec.tsx"],
		globals: true,
		setupFiles: ["./src/setupTests.ts"],
		pool: "vmForks",
		maxWorkers: 2,
		coverage: {
			provider: "v8",
			reportOnFailure: true,
			reporter: ["html", "lcov", "text"],
			reportsDirectory: "./coverage",
			exclude: [
				"**/*.{spec,test}.{js,jsx,ts,tsx,mjs,cjs}",

				"**/*.d.ts",
				"**/vite-env.d.ts",
				"**/*.{config,setup}.{js,ts,mjs,cjs}",

				"**/*.{css,scss,sass,less,styl}",
				"**/*.{svg,png,jpg,jpeg,gif,ico}",

				"**/*.{json,yaml,yml}",

				"**/__mocks__/**",
				"node_modules/**",
				"build/**",
				"coverage/**",
				"dist/**",
				"public/**",

				"src/services/grpc-client.ts",
			],
		},
	},
	build: {
		outDir: "build",
		reportCompressedSize: false,
		// Only minify in production build
		minify: !isDevBuild,
		// Enable inline source maps for dev build
		sourcemap: isDevBuild ? "inline" : false,
		rollupOptions: {
			output: {
				inlineDynamicImports: true,
				entryFileNames: `assets/[name].js`,
				chunkFileNames: `assets/[name].js`,
				assetFileNames: `assets/[name].[ext]`,
				// Disable compact output for dev build
				compact: !isDevBuild,
				// Add generous formatting for dev build
				...(isDevBuild && {
					generatedCode: {
						constBindings: false,
						objectShorthand: false,
						arrowFunctions: false,
					},
				}),
			},
		},
		chunkSizeWarningLimit: 100000,
	},
	server: {
		port: 25463,
		fs: {
			allow: [resolve(__dirname, "..")],
		},
		hmr: {
			host: "localhost",
			protocol: "ws",
		},
		cors: {
			origin: "*",
			methods: "*",
			allowedHeaders: "*",
		},
	},
	define: {
		__PLATFORM__: JSON.stringify(platform),
		process: JSON.stringify({
			platform: JSON.stringify(process?.platform),
			env: {
				NODE_ENV: JSON.stringify(process?.env?.IS_DEV ? "development" : "production"),
				DLINE_ENVIRONMENT: JSON.stringify(process?.env?.DLINE_ENVIRONMENT ?? "production"),
				IS_DEV: JSON.stringify(process?.env?.IS_DEV),
				IS_TEST: JSON.stringify(process?.env?.IS_TEST),
				CI: JSON.stringify(process?.env?.CI),
				// PostHog environment variables
				TELEMETRY_SERVICE_API_KEY: JSON.stringify(process?.env?.TELEMETRY_SERVICE_API_KEY),
				ERROR_SERVICE_API_KEY: JSON.stringify(process?.env?.ERROR_SERVICE_API_KEY),
			},
		}),
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
})
