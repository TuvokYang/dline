import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { scriptField as field } from "../lib/script-model.mjs"
import { createScriptValueResolver } from "../lib/script-values.mjs"
import { buildDependencyClosure } from "../lib/tree-sitter-dependencies.mjs"

async function fixture(t, files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dline-script-values-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    for (const [file, source] of Object.entries(files)) fs.writeFileSync(path.join(root, file), source)
    const snapshot = await buildDependencyClosure({ repoRoot: root, seeds: Object.keys(files) })
    const values = createScriptValueResolver(snapshot)
    const named = (name, file = "entry.ts") => values.evaluate(values.declaration(file, name))
    return { snapshot, values, named }
}

test("follows the actual two-level registry values, including a renamed runtime import", async (t) => {
    const { named } = await fixture(t, {
        "handler.ts": "export function accept(input: unknown) { return input }",
        "other.ts": "export function accept(input: unknown) { return null }",
        "entry.ts":
            'import { accept as actual } from "./handler"; import { accept as wrong } from "./other"; const methods = { accept: actual }; const registry = { "demo.Service": methods }; export const selected = registry["demo.Service"].accept; export const rejected = wrong; throw new Error("must never execute fixture")',
    })
    assert.equal(named("selected").kind, "callable")
    assert.equal(named("selected").file, "handler.ts")
    assert.equal(named("rejected").file, "other.ts")
    assert.notEqual(named("selected").node, named("rejected").node)
})

test("rejects static table overwrites, alias writes, duplicate keys and spread uncertainty", async (t) => {
    for (const mutation of ["table.accept = other;", "const alias = table; alias.accept = other;", "", ""].entries()) {
        const [index, write] = mutation
        const table =
            index === 2
                ? "{ accept: actual, accept: other }"
                : index === 3
                  ? "{ accept: actual, ...unknown }"
                  : "{ accept: actual }"
        const { named } = await fixture(t, {
            "entry.ts": `const actual = () => 1; const other = () => 2; const table = ${table}; ${write} export const selected = table.accept;`,
        })
        assert.equal(named("selected").kind, "unknown")
    }
})

test("preserves parameter identity and projections rather than comparing same-spelled identifiers", async (t) => {
    const { values } = await fixture(t, {
        "entry.ts": "export function dispatch(request: unknown) { const alias = request; return alias.message }",
    })
    const dispatch = values.declaration("entry.ts", "dispatch")
    const parameter = field(dispatch, "parameters").children[0]
    const result = field(dispatch, "body").children.find((node) => node.type === "return_statement").children[0]
    assert.deepEqual(values.evaluate(result).projection, ["message"])
    assert.equal(values.evaluate(result).binding, parameter)
})

test("does not use a class method after the constructor replaces that instance member", async (t) => {
    const { named } = await fixture(t, {
        "entry.ts":
            "class Sink { constructor() { this.accept = () => null } accept(input: unknown) { return input } } const sink = new Sink(); export const selected = sink.accept;",
    })
    assert.equal(named("selected").kind, "unknown")
})

test("does not claim a concrete instance when a constructor returns another object", async (t) => {
    const { named } = await fixture(t, {
        "entry.ts":
            "const other = { accept: () => null }; class Sink { constructor() { return other } accept(input: unknown) { return input } } const sink = new Sink(); export const selected = sink.accept;",
    })
    assert.equal(named("selected").kind, "unknown")
})

test("follows a concrete constructor parameter property to the exact injected instance method", async (t) => {
    const { named } = await fixture(t, {
        "entry.ts":
            "class Sink { accept(input: unknown) { return input } } class Port { constructor(private readonly sink: Sink) {} } const sink = new Sink(); const port = new Port(sink); export const selected = port.sink.accept;",
    })
    const selected = named("selected")
    assert.equal(selected.kind, "callable")
    assert.equal(selected.receiver.kind, "instance")
    assert.equal(field(selected.receiver.node, "name").text, "Sink")
})
