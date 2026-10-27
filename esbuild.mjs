import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as esbuild from "esbuild"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const production = process.argv.includes("--production") || process.env.IS_DEBUG_BUILD === "false"
const watch = process.argv.includes("--watch")
const standalone = process.argv.includes("--standalone")
const e2eBuild = process.argv.includes("--e2e-build")
const destDir = standalone ? "dist-standalone" : "dist"

/**
 * Identity of this build, used to match a crash report against the source map
 * that can decode it.
 *
 * A released bundle is minified and its map never ships, so a stack frame only
 * becomes readable once the maintainer locates the map produced by the same
 * build. CI supplies the commit sha; a local production build falls back to a
 * timestamp so two builds can still be told apart.
 */
const buildId = production ? (process.env.DLINE_BUILD_ID ?? `local-${Date.now().toString(36)}`) : "dev"

/**
 * @type {import('esbuild').Plugin}
 */
const aliasResolverPlugin = {
    name: "alias-resolver",
    setup(build) {
        const aliases = {
            "@": path.resolve(__dirname, "src"),
            "@api": path.resolve(__dirname, "src/core/api"),
            "@core": path.resolve(__dirname, "src/core"),
            "@generated": path.resolve(__dirname, "src/generated"),
            "@hosts": path.resolve(__dirname, "src/hosts"),
            "@integrations": path.resolve(__dirname, "src/integrations"),
            "@packages": path.resolve(__dirname, "src/packages"),
            "@services": path.resolve(__dirname, "src/services"),
            "@shared": path.resolve(__dirname, "src/shared"),
            "@utils": path.resolve(__dirname, "src/utils"),
        }

        // For each alias entry, create a resolver
        Object.entries(aliases).forEach(([alias, aliasPath]) => {
            const aliasRegex = new RegExp(`^${alias}($|/.*)`)
            build.onResolve({ filter: aliasRegex }, (args) => {
                const importPath = args.path.replace(alias, aliasPath)

                // First, check if the path exists as is
                if (fs.existsSync(importPath)) {
                    const stats = fs.statSync(importPath)
                    if (stats.isDirectory()) {
                        // If it's a directory, try to find index files
                        const extensions = [".ts", ".tsx", ".js", ".jsx"]
                        for (const ext of extensions) {
                            const indexFile = path.join(importPath, `index${ext}`)
                            if (fs.existsSync(indexFile)) {
                                return { path: indexFile }
                            }
                        }
                    } else {
                        // It's a file that exists, so return it
                        return { path: importPath }
                    }
                }

                // If the path doesn't exist, try appending extensions
                const extensions = [".ts", ".tsx", ".js", ".jsx"]
                for (const ext of extensions) {
                    const pathWithExtension = `${importPath}${ext}`
                    if (fs.existsSync(pathWithExtension)) {
                        return { path: pathWithExtension }
                    }
                }

                // If nothing worked, return the original path and let esbuild handle the error
                return { path: importPath }
            })
        })
    },
}

const esbuildProblemMatcherPlugin = {
    name: "esbuild-problem-matcher",

    setup(build) {
        build.onStart(() => {
            console.log("[watch] build started")
        })
        build.onEnd((result) => {
            result.errors.forEach(({ text, location }) => {
                console.error(`✘ [ERROR] ${text}`)
                console.error(`    ${location.file}:${location.line}:${location.column}:`)
            })
            console.log("[watch] build finished")
        })
    },
}

/**
 * Records which build produced the bundle in `dist/`.
 *
 * Written next to the map rather than inside it: the map is deleted before
 * packaging, and the identity file is what tells a maintainer which archived
 * map a given crash report needs.
 */
const writeBuildIdentity = {
    name: "write-build-identity",
    setup(build) {
        build.onEnd((result) => {
            const identityPath = path.join(__dirname, destDir, "build-identity.json")

            // A failed build left no bundle to identify. Keeping a stale file
            // would point a maintainer at the wrong source map.
            if (result.errors.length > 0) return

            if (!production) {
                // A dev build overwrites dist/ but emits no archived map, so a
                // leftover production identity would misdescribe what is there.
                fs.rmSync(identityPath, { force: true })
                return
            }

            const identity = {
                buildId,
                builtAt: new Date().toISOString(),
                // Names the map emitted by this same build; symbolication is
                // impossible without it and the reader should see that.
                sourceMap: `${path.basename(build.initialOptions.outfile)}.map`,
            }
            // Stage and rename so a reader never sees a half-written identity.
            // The staging name is unique because two builds sharing an output
            // directory would otherwise interleave writes into one temp file
            // and rename a truncated document into place.
            const stagingPath = `${identityPath}.${crypto.randomBytes(6).toString("hex")}.partial`
            try {
                fs.writeFileSync(stagingPath, `${JSON.stringify(identity, null, 2)}\n`, "utf8")
                fs.renameSync(stagingPath, identityPath)
            } catch (error) {
                fs.rmSync(stagingPath, { force: true })
                throw error
            }
        })
    },
}

const copyWasmFiles = {
    name: "copy-wasm-files",
    setup(build) {
        build.onEnd(() => {
            // tree sitter
            const sourceDir = path.join(__dirname, "node_modules", "web-tree-sitter")
            const targetDir = path.join(__dirname, destDir)

            // Copy tree-sitter.wasm
            fs.copyFileSync(path.join(sourceDir, "tree-sitter.wasm"), path.join(targetDir, "tree-sitter.wasm"))

            // Copy language-specific WASM files
            const languageWasmDir = path.join(__dirname, "node_modules", "tree-sitter-wasms", "out")
            const languages = [
                "typescript",
                "tsx",
                "python",
                "rust",
                "javascript",
                "go",
                "cpp",
                "c",
                "c_sharp",
                "ruby",
                "java",
                "php",
                "swift",
                "kotlin",
            ]

            languages.forEach((lang) => {
                const filename = `tree-sitter-${lang}.wasm`
                fs.copyFileSync(path.join(languageWasmDir, filename), path.join(targetDir, filename))
            })
        })
    },
}

const buildEnvVars = {
    "import.meta.url": "_importMetaUrl",
    "process.env.IS_STANDALONE": JSON.stringify(standalone ? "true" : "false"),
    // Reported with diagnostics so a maintainer can find the matching source
    // map. Baked in rather than read at runtime because the running extension
    // has no other way to know which build produced it.
    "process.env.DLINE_BUILD_ID": JSON.stringify(buildId),
    // Prevent bluebird (bundled via exceljs) from detecting navigator global
    // added in Node.js 24, which causes a fatal crash in VSCode 1.123.0+
    navigator: "undefined",
}

if (production) {
    // IS_DEV is always disabled in production builds.
    buildEnvVars["process.env.IS_DEV"] = JSON.stringify("false")
} else {
    // Dev builds (npm run compile / watch / vsix:dev): enable development
    // features and retain backend debug logs in installed dev VSIX packages.
    buildEnvVars["process.env.IS_DEV"] = JSON.stringify("true")
    buildEnvVars["process.env.DLINE_LOG_LEVEL"] = JSON.stringify(process.env.DLINE_LOG_LEVEL || "debug")
}
// Set the build environment.
if (process.env.DLINE_ENVIRONMENT) {
    buildEnvVars["process.env.DLINE_ENVIRONMENT"] = JSON.stringify(process.env.DLINE_ENVIRONMENT)
}

// OpenTelemetry configuration (injected at build time from GitHub secrets)
// These provide production defaults that can be overridden at runtime via environment variables
if (process.env.OTEL_TELEMETRY_ENABLED) {
    buildEnvVars["process.env.OTEL_TELEMETRY_ENABLED"] = JSON.stringify(process.env.OTEL_TELEMETRY_ENABLED)
}
if (process.env.OTEL_LOGS_EXPORTER) {
    buildEnvVars["process.env.OTEL_LOGS_EXPORTER"] = JSON.stringify(process.env.OTEL_LOGS_EXPORTER)
}
if (process.env.OTEL_METRICS_EXPORTER) {
    buildEnvVars["process.env.OTEL_METRICS_EXPORTER"] = JSON.stringify(process.env.OTEL_METRICS_EXPORTER)
}
if (process.env.OTEL_EXPORTER_OTLP_PROTOCOL) {
    buildEnvVars["process.env.OTEL_EXPORTER_OTLP_PROTOCOL"] = JSON.stringify(process.env.OTEL_EXPORTER_OTLP_PROTOCOL)
}
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    buildEnvVars["process.env.OTEL_EXPORTER_OTLP_ENDPOINT"] = JSON.stringify(process.env.OTEL_EXPORTER_OTLP_ENDPOINT)
}
if (process.env.OTEL_EXPORTER_OTLP_HEADERS) {
    buildEnvVars["process.env.OTEL_EXPORTER_OTLP_HEADERS"] = JSON.stringify(process.env.OTEL_EXPORTER_OTLP_HEADERS)
}
if (process.env.OTEL_METRIC_EXPORT_INTERVAL) {
    buildEnvVars["process.env.OTEL_METRIC_EXPORT_INTERVAL"] = JSON.stringify(process.env.OTEL_METRIC_EXPORT_INTERVAL)
}
// Base configuration shared between extension and standalone builds
const baseConfig = {
    bundle: true,
    minify: production,
    // Production emits an external map so released stack traces stay
    // symbolicatable, while `.vscodeignore` keeps `**/*.map` out of the VSIX.
    // "external" also omits the sourceMappingURL comment, so an installed
    // extension never advertises a map it does not ship.
    sourcemap: production ? "external" : true,
    logLevel: "silent",
    define: buildEnvVars,
    tsconfig: path.resolve(__dirname, "tsconfig.json"),
    plugins: [
        copyWasmFiles,
        aliasResolverPlugin,
        writeBuildIdentity,
        /* add to the end of plugins array */
        esbuildProblemMatcherPlugin,
    ],
    format: "cjs",
    sourcesContent: false,
    platform: "node",
    banner: {
        // The DLINE_BUILD_TYPE marker lets packaging scripts verify which build
        // variant a bundle came from, so a dev VSIX can never silently ship a
        // production bundle written by a concurrent build (or vice versa).
        js: `/* DLINE_BUILD_TYPE:${production ? "production" : "dev"} */\nconst _importMetaUrl=require('url').pathToFileURL(__filename)`,
    },
}

// Extension-specific configuration
const extensionConfig = {
    ...baseConfig,
    entryPoints: ["src/extension.ts"],
    outfile: `${destDir}/extension.js`,
    external: ["vscode"],
}

// Standalone-specific configuration
const standaloneConfig = {
    ...baseConfig,
    entryPoints: ["src/standalone/cline-core.ts"],
    outfile: `${destDir}/cline-core.js`,
    // These modules need to load files from the module directory at runtime,
    // so they cannot be bundled.
    external: ["vscode", "@grpc/reflection", "grpc-health-check", "better-sqlite3"],
}

// E2E build script configuration
const e2eBuildConfig = {
    ...baseConfig,
    entryPoints: ["src/test/e2e/utils/build.ts"],
    outfile: `${destDir}/e2e-build.mjs`,
    external: ["@vscode/test-electron", "execa"],
    sourcemap: false,
    plugins: [aliasResolverPlugin, esbuildProblemMatcherPlugin],
}

async function main() {
    const config = standalone ? standaloneConfig : e2eBuild ? e2eBuildConfig : extensionConfig
    const extensionCtx = await esbuild.context(config)
    if (watch) {
        await extensionCtx.watch()
    } else {
        await extensionCtx.rebuild()
        await extensionCtx.dispose()
    }
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
