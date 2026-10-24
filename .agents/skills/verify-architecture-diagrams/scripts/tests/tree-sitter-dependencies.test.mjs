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
