import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { buildDependencyClosure } from "../lib/tree-sitter-dependencies.mjs"

function write(root, relative, content) {
    const target = path.join(root, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
}

test("builds a bounded runtime closure through helpers and excludes type-only edges from SCCs", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dline-tree-closure-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    write(root, "src/a.ts", 'import { b } from "./b"\nimport type { Shape } from "./types"\nexport const a: Shape = b()\n')
    write(root, "src/b.ts", 'import { c } from "./c"\nexport function b(){ return c() }\n')
    write(root, "src/c.ts", 'import { a } from "./a"\nexport function c(){ return a }\n')
    write(root, "src/types.ts", "export type Shape = number\n")

    const snapshot = await buildDependencyClosure({ repoRoot: root, seeds: ["src/a.ts"] })
    assert.deepEqual(snapshot.files, ["src/a.ts", "src/b.ts", "src/c.ts", "src/types.ts"])
    assert.equal(snapshot.imports.find((edge) => edge.specifier === "./types")?.classification, "type")
    assert.deepEqual(snapshot.runtimeSccs, [["src/a.ts", "src/b.ts", "src/c.ts"]])
    assert.equal(
        snapshot.facts.some((fact) => fact.path === "src/b.ts" && fact.category === "calls"),
        true,
    )
})

test("resolves Python dotted imports and enforces the file bound", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dline-python-closure-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    write(root, "main.py", "from pkg.helper import run\nvalue = run()\n")
    write(root, "pkg/helper.py", "def run():\n    return 1\n")

    const snapshot = await buildDependencyClosure({ repoRoot: root, seeds: ["main.py"] })
    assert.deepEqual(snapshot.files, ["main.py", "pkg/helper.py"])
    assert.equal(snapshot.imports[0].classification, "runtime")
    assert.deepEqual(snapshot.imports[0].target, { kind: "workspace", path: "pkg/helper.py" })

    const bounded = await buildDependencyClosure({ repoRoot: root, seeds: ["main.py"], maxFiles: 1 })
    assert.equal(
        bounded.diagnostics.some((entry) => entry.rule === "closure-file-limit"),
        true,
    )
})

test("resolves tsconfig path aliases from the nearest solution-style directory", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dline-alias-closure-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    // A solution root with references keeps the shared alias in a sibling app config; the
    // comment and trailing comma make the file JSONC, as editor templates emit it.
    write(root, "web/tsconfig.json", '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }\n')
    write(
        root,
        "web/tsconfig.app.json",
        '{\n  "compilerOptions": {\n    /* Bundler mode */\n    "paths": {\n      "@/*": ["./src/*"],\n      "@shared/*": ["../shared/*"],\n    },\n  },\n}\n',
    )
    write(
        root,
        "web/src/view.ts",
        'import { level } from "@shared/level"\nimport type { Row } from "@/rows"\nimport { useMemo } from "react"\nimport { gone } from "@shared/missing"\nexport const view = level(useMemo, gone) as Row\n',
    )
    write(root, "web/src/rows.ts", "export type Row = number\n")
    write(root, "shared/level.ts", "export function level(...args: unknown[]) { return args.length }\n")

    const snapshot = await buildDependencyClosure({ repoRoot: root, seeds: ["web/src/view.ts"] })
    const target = (specifier) => snapshot.imports.find((edge) => edge.specifier === specifier)?.target
    assert.deepEqual(target("@shared/level"), { kind: "workspace", path: "shared/level.ts" })
    assert.deepEqual(target("@/rows"), { kind: "workspace", path: "web/src/rows.ts" })
    assert.deepEqual(target("react"), { kind: "external", specifier: "react" })
    // A matched alias whose file is absent is a broken workspace import, not a package.
    assert.deepEqual(target("@shared/missing"), { kind: "unresolved", specifier: "@shared/missing" })
    assert.deepEqual(snapshot.files, ["shared/level.ts", "web/src/rows.ts", "web/src/view.ts"])
})

test("tries only the winning alias pattern and keeps string literals intact", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dline-alias-winner-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    // "@pkg/special/*" wins over "@pkg/*" for @pkg/special/value; its first target is missing and
    // its second exists. The less specific pattern would resolve to general/special/value.ts.
    // "@exact" is an exact pattern whose only target is missing, while the catch-all "@*" would
    // resolve it to general/exact.ts; the exact pattern still wins. The target "./odd,}/*" holds a
    // comma before a brace inside a string, next to real trailing commas.
    write(
        root,
        "tsconfig.json",
        [
            "{",
            '  "compilerOptions": {',
            '    "paths": {',
            '      "@*": ["general/*"],',
            '      "@pkg/*": ["general/*"],',
            '      "@pkg/special/*": ["missing/*", "fallback/*"],',
            '      "@pkg/broken/*": ["absent/*"],',
            '      "@exact": ["nowhere/exact"],',
            '      "@odd/*": ["./odd,}/*",],',
            "    },",
            "  },",
            "}",
            "",
        ].join("\n"),
    )
    write(
        root,
        "src/main.ts",
        [
            'import { a } from "@pkg/special/value"',
            'import { b } from "@pkg/broken/value"',
            'import { c } from "@exact"',
            'import { d } from "@odd/thing"',
            "export const all = [a, b, c, d]",
            "",
        ].join("\n"),
    )
    write(root, "general/special/value.ts", "export const a = 0\n")
    write(root, "general/broken/value.ts", "export const b = 0\n")
    write(root, "general/exact.ts", "export const c = 0\n")
    write(root, "fallback/value.ts", "export const a = 1\n")
    write(root, "odd,}/thing.ts", "export const d = 1\n")

    const snapshot = await buildDependencyClosure({ repoRoot: root, seeds: ["src/main.ts"] })
    const target = (specifier) => snapshot.imports.find((edge) => edge.specifier === specifier)?.target
    assert.deepEqual(target("@pkg/special/value"), { kind: "workspace", path: "fallback/value.ts" })
    assert.deepEqual(target("@pkg/broken/value"), { kind: "unresolved", specifier: "@pkg/broken/value" })
    assert.deepEqual(target("@exact"), { kind: "unresolved", specifier: "@exact" })
    assert.deepEqual(target("@odd/thing"), { kind: "workspace", path: "odd,}/thing.ts" })
})

test("scans every seed before the dependencies of an alphabetically earlier seed", async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dline-seed-order-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    write(root, "src/a/seed.ts", 'import { one } from "./one"\nimport { two } from "./two"\nexport const a = one + two\n')
    write(root, "src/a/one.ts", "export const one = 1\n")
    write(root, "src/a/two.ts", "export const two = 2\n")
    write(root, "src/z/seed.ts", 'import { a } from "../a/seed"\nexport const z = a\n')

    const bounded = await buildDependencyClosure({ repoRoot: root, seeds: ["src/a/seed.ts", "src/z/seed.ts"], maxFiles: 3 })
    assert.equal(bounded.files.includes("src/z/seed.ts"), true)
    assert.equal(
        bounded.imports.some((edge) => edge.importer === "src/z/seed.ts" && edge.target.path === "src/a/seed.ts"),
        true,
    )
    assert.equal(
        bounded.diagnostics.some((entry) => entry.rule === "closure-file-limit"),
        true,
    )
})
