import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"

import {
    canonicalSourcePath,
    scanTreeSitterFiles,
    scanTreeSitterSource,
    TREE_SITTER_FACT_SCHEMA_VERSION,
} from "../lib/tree-sitter-facts.mjs"

test("normalizes captures into immutable source-positioned facts", async () => {
    const repoRoot = process.cwd()
    const filePath = path.join(repoRoot, "fixtures", "service.ts")
    const result = await scanTreeSitterSource({
        repoRoot,
        filePath,
        source: "export class Service { run(): void {} }\nexport function createService() { return new Service() }\n",
    })

    assert.equal(result.file.path, "fixtures/service.ts")
    assert.equal(result.file.language, "typescript")
    assert.equal(result.file.state, "parsed")
    const names = result.facts
        .filter((fact) => fact.capture.startsWith("name."))
        .map((fact) => fact.text)
        .sort()
    assert.deepEqual(names, ["Service", "createService", "run"])
    assert.equal(
        result.facts.every((fact) => fact.schemaVersion === TREE_SITTER_FACT_SCHEMA_VERSION),
        true,
    )
    assert.equal(
        result.facts.every((fact) => fact.start.line >= 1 && fact.start.column >= 1),
        true,
    )
    assert.equal(
        result.facts.every((fact) => /^[a-f0-9]{64}$/.test(fact.id)),
        true,
    )
    assert.equal(Object.isFrozen(result.facts), true)
    assert.equal(Object.isFrozen(result.facts[0]), true)
})

test("produces the same snapshot for reordered duplicate multi-language inputs", async () => {
    const repoRoot = path.join(process.cwd(), "virtual-tree-sitter-fixture")
    const sources = new Map([
        ["a.ts", "export function alpha() { return 1 }\n"],
        ["b.py", "class Beta:\n    def run(self):\n        return 1\n"],
    ])
    const readFile = (absolute) => sources.get(path.basename(absolute))
    const first = await scanTreeSitterFiles({
        repoRoot,
        files: ["b.py", "a.ts", "b.py"],
        readFile,
    })
    const second = await scanTreeSitterFiles({
        repoRoot,
        files: ["a.ts", "b.py"],
        readFile,
    })

    assert.deepEqual(first, second)
    assert.deepEqual(
        first.files.map((file) => file.path),
        ["a.ts", "b.py"],
    )
    assert.deepEqual([...new Set(first.facts.map((fact) => fact.language))].sort(), ["python", "typescript"])
})

test("reports unsupported languages and syntax errors without inventing facts", async () => {
    const unsupported = await scanTreeSitterSource({
        repoRoot: process.cwd(),
        filePath: "fixture.txt",
        source: "not source code",
    })
    assert.equal(unsupported.file.state, "unsupported")
    assert.deepEqual(unsupported.facts, [])
    assert.deepEqual(
        unsupported.diagnostics.map((entry) => entry.rule),
        ["unsupported-language"],
    )

    const quarantinedSwift = await scanTreeSitterSource({
        repoRoot: process.cwd(),
        filePath: "fixture.swift",
        source: "import Foundation",
    })
    assert.equal(quarantinedSwift.file.state, "unsupported")
    assert.deepEqual(
        quarantinedSwift.diagnostics.map((entry) => entry.rule),
        ["unsupported-language"],
    )

    const malformed = await scanTreeSitterSource({
        repoRoot: process.cwd(),
        filePath: "fixture.ts",
        source: "export function broken(",
    })
    assert.equal(malformed.file.state, "syntax_error")
    assert.equal(
        malformed.diagnostics.some((entry) => entry.rule === "syntax-error" || entry.rule === "missing-syntax"),
        true,
    )
    await assert.rejects(
        () => scanTreeSitterSource({ filePath: "fixture.ts", source: "export {}", categories: ["unknown"] }),
        /unknown Tree-sitter query categories/,
    )
})

test("bounds captured source text while retaining stable content identity", async () => {
    const body = Array.from({ length: 300 }, (_, index) => `  method${index}() { return ${index} }`).join("\n")
    const result = await scanTreeSitterSource({
        repoRoot: process.cwd(),
        filePath: "large.ts",
        source: `export class Large {\n${body}\n}\n`,
    })
    const largeDefinition = result.facts.find((fact) => fact.capture === "definition.class")
    assert.ok(largeDefinition)
    assert.equal(largeDefinition.truncated, true)
    assert.equal(largeDefinition.text.length, 1024)
    assert.match(largeDefinition.textHash, /^[a-f0-9]{64}$/)
    assert.equal(canonicalSourcePath(process.cwd(), path.join(process.cwd(), "large.ts")), "large.ts")
})
