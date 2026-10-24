import assert from "node:assert/strict"
import test from "node:test"

import {
    createLanguageParser,
    disposeParsedSource,
    languageForPath,
    parseSource,
    supportedExtensions,
} from "../lib/tree-sitter-runtime.mjs"

test("loads vendored TypeScript grammar and captures definitions", async () => {
    const parsed = await parseSource(
        "fixture.ts",
        "export class Service { run(): void {} }\nexport function createService() { return new Service() }\n",
    )
    try {
        const captures = parsed.definitionQuery.captures(parsed.tree.rootNode)
        const names = captures.filter((capture) => capture.name.startsWith("name.")).map((capture) => capture.node.text)
        assert.deepEqual(names.sort(), ["Service", "createService", "run"])
    } finally {
        disposeParsedSource(parsed)
    }
})

test("loads vendored Python grammar independently of product runtime", async () => {
    const parsed = await parseSource("fixture.py", "class Service:\n    def run(self):\n        return 1\n")
    try {
        const captures = parsed.definitionQuery.captures(parsed.tree.rootNode)
        const names = captures.filter((capture) => capture.name.startsWith("name.")).map((capture) => capture.node.text)
        assert.deepEqual(names.sort(), ["Service", "run"])
    } finally {
        disposeParsedSource(parsed)
    }
})

test("publishes one deterministic extension-to-language boundary", async () => {
    assert.equal(languageForPath("sample.tsx"), "tsx")
    assert.equal(languageForPath("sample.mjs"), "javascript")
    assert.equal(languageForPath("sample.cjs"), "javascript")
    assert.equal(languageForPath("sample.mts"), "typescript")
    assert.equal(languageForPath("sample.cts"), "typescript")
    assert.equal(languageForPath("sample.unknown"), null)
    assert.ok(supportedExtensions().includes(".rs"))
    assert.equal(supportedExtensions().includes(".swift"), false)
    await assert.rejects(() => createLanguageParser("sample.unknown"), /unsupported Tree-sitter language/)
})
