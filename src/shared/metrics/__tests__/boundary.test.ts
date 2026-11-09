import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const MODULE_DIR = path.resolve(__dirname, "..")

/** Every hand-written source file of the neutral metrics module. */
function sourceFiles(directory: string): string[] {
    const files: string[] = []
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const location = path.join(directory, entry.name)
        if (entry.isDirectory()) {
            if (entry.name === "__tests__") continue
            files.push(...sourceFiles(location))
        } else if (entry.isFile() && entry.name.endsWith(".ts")) {
            files.push(location)
        }
    }
    return files
}

describe("neutral module boundary", () => {
    /**
     * The neutral module is consumed by both the extension host and the Webview, so it
     * may not reach into the host, the controller or the Task runtime in either alias
     * form. This is the executable form of the architecture contract, not a style rule.
     */
    it("imports nothing from core, hosts or the controller", () => {
        const forbidden = [/from\s+["']@\/core\//, /from\s+["']@core\//, /from\s+["']@\/hosts\//, /from\s+["']@hosts\//]
        const offenders: string[] = []

        for (const file of sourceFiles(MODULE_DIR)) {
            const source = readFileSync(file, "utf8")
            for (const pattern of forbidden) {
                if (pattern.test(source)) offenders.push(`${path.relative(MODULE_DIR, file)} matches ${pattern}`)
            }
        }

        expect(offenders).toEqual([])
    })

    /**
     * No Node builtin either: `src/shared` also ships to the Webview, where `node:*`
     * modules do not exist. Keeping the module pure is what lets TASK-12305 read the
     * same contracts without a host-only dependency.
     */
    it("imports no node builtins", () => {
        const offenders = sourceFiles(MODULE_DIR)
            .filter((file) => /from\s+["']node:/.test(readFileSync(file, "utf8")))
            .map((file) => path.relative(MODULE_DIR, file))

        expect(offenders).toEqual([])
    })

    /**
     * The module must stay free of I/O and side effects: an emit path that touches the
     * filesystem or a timer would make the Task's own completion depend on it.
     */
    it("performs no file, process or timer work", () => {
        const forbidden = [/\bwriteFile/, /\breadFile/, /\bcreateWriteStream/, /\bprocess\./, /\bsetInterval\b/, /\bsetTimeout\b/]
        const offenders: string[] = []

        for (const file of sourceFiles(MODULE_DIR)) {
            const source = readFileSync(file, "utf8")
            for (const pattern of forbidden) {
                if (pattern.test(source)) offenders.push(`${path.relative(MODULE_DIR, file)} matches ${pattern}`)
            }
        }

        expect(offenders).toEqual([])
    })
})
