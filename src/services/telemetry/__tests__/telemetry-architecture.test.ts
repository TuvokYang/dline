import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Enforces the dependency direction the decomposition exists to create.
 *
 * The failure being prevented is structural rather than type-level: an import
 * that compiles perfectly well but reintroduces the cycle between
 * `instrumentation/` and `runtime/`, or lets a recorder reach a vendor SDK
 * directly. A compiler cannot object to either.
 *
 * The scan is text-based because the installed TypeScript package exposes only
 * a version stub, not the compiler API. To stay trustworthy without an AST, the
 * patterns anchor on the module specifier itself rather than on the `import`
 * keyword — so a multi-line import clause cannot hide a dependency — and the
 * first test below feeds every syntax form through the scanner to prove the
 * later assertions are not passing vacuously.
 */

const TELEMETRY_ROOT = path.join(process.cwd(), "src", "services", "telemetry")

/**
 * Patterns covering every way a module can be named.
 *
 * `from "x"` is matched without reference to what precedes it, which is what
 * makes multi-line and type-only imports visible.
 */
const SPECIFIER_PATTERNS: readonly RegExp[] = [
    // `import ... from "x"`, `export ... from "x"` — clause may span lines.
    /\bfrom\s*["']([^"']+)["']/g,
    // `import "x"` — side effect only.
    /\bimport\s+["']([^"']+)["']/g,
    // `import("x")` — dynamic.
    /\bimport\s*\(\s*["']([^"']+)["']/g,
    // `require("x")` and `import x = require("y")`.
    /\brequire\s*\(\s*["']([^"']+)["']/g,
]

/** Every module specifier named in one source text. */
function moduleSpecifiersIn(source: string): string[] {
    const specifiers = new Set<string>()
    for (const pattern of SPECIFIER_PATTERNS) {
        for (const match of source.matchAll(pattern)) {
            specifiers.add(match[1])
        }
    }
    return [...specifiers]
}

/** Every module specifier referenced by one file. */
async function moduleSpecifiersOf(filePath: string): Promise<string[]> {
    return moduleSpecifiersIn(await fs.readFile(filePath, "utf8"))
}

/** Source files under `dir` and its subdirectories, excluding tests. */
async function productionFilesUnder(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const files: string[] = []
    for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            if (entry.name === "__tests__") continue
            files.push(...(await productionFilesUnder(full)))
        } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
            files.push(full)
        }
    }
    return files
}

describe("telemetry module boundaries", () => {
    it("detects every import form, so a boundary cannot be crossed by syntax choice", () => {
        // The negative control for every assertion below: if the scanner cannot
        // see these forms, the boundary tests would pass by blindness rather
        // than by compliance.
        const fixture = `
			import { A } from "./single-line"
			import {
				B,
				C,
			} from "./multi-line"
			import type { D } from "./type-only"
			import "./side-effect"
			export { E } from "./re-export"
			export {
				F,
			} from "./multi-line-re-export"
			import legacy = require("./import-equals")
			async function load() {
				const mod = await import("./dynamic")
				const cjs = require("./require-call")
				return [mod, cjs, legacy]
			}
		`

        expect(moduleSpecifiersIn(fixture).sort()).toEqual([
            "./dynamic",
            "./import-equals",
            "./multi-line",
            "./multi-line-re-export",
            "./re-export",
            "./require-call",
            "./side-effect",
            "./single-line",
            "./type-only",
        ])
    })

    it("reads specifiers from real source files", async () => {
        const specifiers = await moduleSpecifiersOf(path.join(TELEMETRY_ROOT, "runtime", "index.ts"))

        expect(specifiers).toContain("./runtime-event-bus")
        // A multi-line re-export, which an import-anchored scan would miss.
        expect(specifiers).toContain("./analysis/root-cause-types")
    })

    it("keeps instrumentation independent of the runtime pipeline", async () => {
        const files = await productionFilesUnder(path.join(TELEMETRY_ROOT, "instrumentation"))
        expect(files.length).toBeGreaterThan(0)

        for (const file of files) {
            const runtimeImports = (await moduleSpecifiersOf(file)).filter((specifier) => specifier.includes("runtime"))
            expect(runtimeImports, `${path.basename(file)} must reach the pipeline through the port`).toEqual([])
        }
    })

    it("keeps the runtime pipeline independent of instrumentation", async () => {
        const files = await productionFilesUnder(path.join(TELEMETRY_ROOT, "runtime"))
        expect(files.length).toBeGreaterThan(0)

        for (const file of files) {
            const instrumentationImports = (await moduleSpecifiersOf(file)).filter((specifier) =>
                specifier.includes("instrumentation"),
            )
            expect(instrumentationImports, `${path.basename(file)} must not depend on instrumentation helpers`).toEqual([])
        }
    })

    it("keeps domain recorders free of providers, SDKs and host UI", async () => {
        const files = await productionFilesUnder(path.join(TELEMETRY_ROOT, "events"))
        expect(files.length).toBeGreaterThan(0)

        // A recorder that can reach a provider can also bypass the dispatcher,
        // which is where metadata and the category policy are applied.
        const forbidden = [
            "@opentelemetry",
            "posthog",
            "providers/opentelemetry",
            "providers/posthog",
            "host-provider",
            "@hosts/",
            "runtime/",
            "TelemetryProviderFactory",
        ]

        for (const file of files) {
            for (const specifier of await moduleSpecifiersOf(file)) {
                for (const banned of forbidden) {
                    expect(specifier.includes(banned), `${path.basename(file)} must not import ${specifier}`).toBe(false)
                }
            }
        }
    })

    it("does not expose parallel runtime owners or legacy OTLP activation config", async () => {
        const source = await fs.readFile(path.join(TELEMETRY_ROOT, "runtime", "index.ts"), "utf8")
        const activation = await fs.readFile(path.join(TELEMETRY_ROOT, "runtime", "activation.ts"), "utf8")

        for (const retiredExport of ["RuntimeTelemetryService", "RuntimeTelemetryLifecycle", "OtelLogTransport"]) {
            expect(source, `${retiredExport} must stay internal to the runtime package`).not.toContain(retiredExport)
        }
        for (const retiredConfig of ["otlpEndpoint", "otlpProtocol", "processorFactory"]) {
            expect(activation, `${retiredConfig} must not configure a parallel runtime exporter`).not.toContain(retiredConfig)
        }
    })

    it("routes production runtime events through the canonical registry", async () => {
        const compositionRoot = await fs.readFile(path.join(process.cwd(), "src", "common.ts"), "utf8")

        expect(compositionRoot).toContain("onEvent: (event) => forwardRuntimeEvent(event, telemetryService)")
    })

    it("keeps Task-critical paths independent of telemetry lifecycle promises", async () => {
        const common = await fs.readFile(path.join(process.cwd(), "src", "common.ts"), "utf8")
        const remoteConfig = await fs.readFile(
            path.join(process.cwd(), "src", "core", "storage", "remote-config", "utils.ts"),
            "utf8",
        )
        expect(common).not.toMatch(/\bawait\s+activateRuntimeTelemetry\s*\(/)
        expect(remoteConfig).not.toMatch(/\bawait\s+telemetryService\.(?:removeProvider|forceFlush|applyConsent)\s*\(/)

        const roots = [
            path.join(process.cwd(), "src", "core", "task"),
            path.join(process.cwd(), "src", "core", "api"),
            path.join(process.cwd(), "src", "core", "controller", "task"),
        ]
        for (const root of roots) {
            for (const file of await productionFilesUnder(root)) {
                const source = await fs.readFile(file, "utf8")
                expect(source, `${path.relative(process.cwd(), file)} must not wait for telemetry`).not.toMatch(
                    /\bawait\s+(?:getTelemetryService\s*\(|telemetryService\.)/,
                )
            }
        }
    })

    it("keeps normal OpenTelemetry diagnostics at debug level", async () => {
        const files = await productionFilesUnder(path.join(TELEMETRY_ROOT, "providers", "opentelemetry"))
        expect(files.length).toBeGreaterThan(0)

        for (const file of files) {
            const source = await fs.readFile(file, "utf8")
            expect(source, `${path.basename(file)} must not emit high-volume OTLP status at log level`).not.toContain(
                "Logger.log(",
            )
        }
    })

    it("uses the Dline namespace for exported metric names", async () => {
        const catalog = await fs.readFile(path.join(TELEMETRY_ROOT, "events", "catalog.ts"), "utf8")

        expect(catalog).not.toMatch(/["']cline\.[a-z]/)
        expect(catalog).toContain('"dline.grpc.response.size_bytes"')
    })

    it("keeps the pipeline port free of dependencies", async () => {
        // The port is the shared contract; anything it imports becomes a
        // dependency of every producer and pipeline in the package.
        const specifiers = await moduleSpecifiersOf(path.join(TELEMETRY_ROOT, "service", "pipeline-port.ts"))
        expect(specifiers).toEqual([])
    })
})
