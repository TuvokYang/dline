import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = path.resolve(fileURLToPath(new URL("../../../../../", import.meta.url)))
const factsModule = pathToFileURL(
    path.join(repoRoot, ".agents/skills/verify-architecture-diagrams/scripts/lib/tree-sitter-facts.mjs"),
).href
const categories = ["declarations", "imports", "calls", "writes", "boundaries"]

const samples = new Map([
    ["sample.ts", "import x from 'pkg'; export class A { m(){ this.v = f(x); } }"],
    ["sample.tsx", "import React from 'react'; export function View(){ state.value = make(); return <div>{render()}</div> }"],
    ["sample.js", "const dep = require('dep'); export function run(){ state.value = dep.make(); callback(); }"],
    ["sample.py", "import os\nfrom pkg.mod import thing\nclass A:\n    def m(self):\n        self.v = thing()\n"],
    ["sample.rs", "use crate::dep::Thing; struct A { v:i32 } impl A { fn m(&mut self){ self.v = make(); } }"],
    [
        "sample.go",
        'package demo\nimport "fmt"\ntype A struct { v int }\nfunc create() int { return 1 }\nfunc (a *A) m(){ a.v = create(); fmt.Println(a.v) }\n',
    ],
    [
        "sample.c",
        '#include <stdio.h>\nstruct A { int v; }; int make(void); void m(struct A *a){ a->v = make(); printf("%d", a->v); }',
    ],
    ["sample.cpp", "#include <vector>\nnamespace demo { class A { public: void m(){ v = make(); } int v; }; }"],
    ["sample.cs", "using Demo.Lib; namespace Demo { class A { int v; void M(){ v = Make(); } } }"],
    ["sample.java", "import demo.lib.Thing; package demo; class A { int v; void m(){ v = make(); Thing.run(); } }"],
    [
        "sample.kt",
        "package demo\nimport demo.lib.Thing\nfun create(): Int = 1\nclass A {\n  var v: Int = 0\n  fun m() {\n    v = create()\n    Thing.run()\n  }\n}\n",
    ],
    [
        "sample.php",
        "<?php namespace Demo; use Demo\\Lib\\Thing; class A { private $v; function m(){ $this->v = make(); Thing::run(); } }",
    ],
    ["sample.rb", "require 'dep'\nmodule Demo\n class A\n  def m\n   @v = make()\n   Thing.run()\n  end\n end\nend\n"],
])

const childScript = `
const [moduleUrl, file, encoded] = process.argv.slice(1)
const { scanTreeSitterSource } = await import(moduleUrl)
const source = Buffer.from(encoded, "base64").toString("utf8")
const categories = ["declarations", "imports", "calls", "writes", "boundaries"]
const result = await scanTreeSitterSource({ filePath: file, source, categories })
const counts = Object.fromEntries(categories.map((category) => [category, result.facts.filter((fact) => fact.category === category).length]))
console.log(JSON.stringify({ state: result.file.state, counts, diagnostics: result.diagnostics }))
`

test("every enabled vendored language compiles and emits all architecture fact categories", () => {
    for (const [file, source] of samples) {
        const encoded = Buffer.from(source, "utf8").toString("base64")
        const child = spawnSync(process.execPath, ["--input-type=module", "-e", childScript, factsModule, file, encoded], {
            cwd: repoRoot,
            encoding: "utf8",
            timeout: 30_000,
        })
        assert.equal(child.status, 0, `${file}: ${child.stderr || child.stdout}`)
        const result = JSON.parse(child.stdout)
        assert.equal(result.state, "parsed", `${file}: ${JSON.stringify(result.diagnostics)}`)
        for (const category of categories) {
            assert.ok(result.counts[category] > 0, `${file}: expected at least one ${category} fact`)
        }
    }
})
