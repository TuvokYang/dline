import path from "node:path"
import { describe, expect, it } from "vitest"
import { isUnder, parseModuleReferences, scanImportGraph } from "./import-graph"

const REPO = path.resolve(__dirname, "../../../../..")

function referenceShape(source: string) {
    return parseModuleReferences(source, "sample.ts").map(({ specifier, kind, typeOnly, bindings }) => ({
        specifier,
        kind,
        typeOnly,
        bindings,
    }))
}

describe("architecture import graph scanner", () => {
    it("recognizes every supported module reference without reading comments or strings", () => {
        const references = referenceShape(`
			import type { A as LocalA } from "./type-only"
			import Default, * as Namespace from "./static"
			import "./side-effect"
			export type { B } from "./exported"
			import Alias = require("./import-equals")
			type Query = import("./import-type").Query
			const dynamic = import("./dynamic")
			const required = require("./required")
			const prose = "import('./not-code')"
			// import "./comment"
		`)

        expect(references).toEqual([
            {
                specifier: "./type-only",
                kind: "import",
                typeOnly: true,
                bindings: [{ imported: "A", local: "LocalA", typeOnly: true }],
            },
            {
                specifier: "./static",
                kind: "import",
                typeOnly: false,
                bindings: [
                    { imported: "default", local: "Default", typeOnly: false },
                    { imported: "*", local: "Namespace", typeOnly: false },
                ],
            },
            { specifier: "./side-effect", kind: "side_effect_import", typeOnly: false, bindings: [] },
            {
                specifier: "./exported",
                kind: "export",
                typeOnly: true,
                bindings: [{ imported: "B", local: "B", typeOnly: true }],
            },
            {
                specifier: "./import-equals",
                kind: "import_equals",
                typeOnly: false,
                bindings: [{ imported: "*", local: "Alias", typeOnly: false }],
            },
            { specifier: "./import-type", kind: "import_type", typeOnly: true, bindings: [] },
            { specifier: "./dynamic", kind: "dynamic_import", typeOnly: false, bindings: [] },
            { specifier: "./required", kind: "require", typeOnly: false, bindings: [] },
        ])
    })

    it("resolves aliases, directory barrels, packages, and builtins against the project config", () => {
        const edges = scanImportGraph({
            repoRoot: REPO,
            tsconfigPath: path.join(REPO, "tsconfig.json"),
            roots: [path.join(REPO, "src/core/task/runtime")],
        })
        const eventLoop = edges.filter((edge) => edge.importer.endsWith("/runtime/EventLoop.ts"))

        expect(eventLoop.find((edge) => edge.specifier === "../kernel")?.target).toMatchObject({
            kind: "workspace",
            path: "src/core/task/kernel/index.ts",
        })
        expect(edges.some((edge) => edge.target.kind === "builtin")).toBe(false)
    })

    it("treats a relative path that escapes a boundary as outside it", () => {
        const root = path.join(REPO, "src/core/task/kernel")
        expect(isUnder(path.join(root, "turn/tool-lanes.ts"), root)).toBe(true)
        expect(isUnder(path.join(root, "../../controller/index.ts"), root)).toBe(false)
    })
})
