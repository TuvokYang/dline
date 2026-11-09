import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { traceScriptCalls } from "../lib/script-call-flow.mjs"
import { createScriptValueResolver } from "../lib/script-values.mjs"
import { buildDependencyClosure } from "../lib/tree-sitter-dependencies.mjs"

async function trace(t, source, options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dline-script-calls-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const file = options.file ?? "entry.ts"
    fs.writeFileSync(path.join(root, file), 'import { sink } from "./sink"; ' + source)
    fs.writeFileSync(path.join(root, "sink.ts"), "export function sink(payload: unknown) { return payload }")
    const snapshot = await buildDependencyClosure({ repoRoot: root, seeds: [file] })
    const values = createScriptValueResolver(snapshot)
    return traceScriptCalls(values.evaluate(values.declaration(file, "emit")), values, snapshot, options)
}
const deliveries = (result) => result.calls.filter((call) => call.callee.file === "sink.ts")

test("records invoked functions but not unused closures, false branches or post-return code", async (t) => {
    assert.equal(deliveries(await trace(t, "export function emit() { return sink(1) }")).length, 1)
    for (const source of [
        "export function emit() { const unused = () => sink(1); return unused }",
        "export function emit() { if (false) return sink(1) }",
        "export function emit() { return; sink(1) }",
        "export function emit() { return false && sink(1) }",
        "export function emit() { return true || sink(1) }",
    ])
        assert.equal(deliveries(await trace(t, source)).length, 0)
})

test("single arrow parameters, JavaScript parameters and ambiguous locals never fall back to imports", async (t) => {
    const sources = [
        ["entry.ts", "export function emit() { const deliver = sink => sink(1); return deliver(() => null) }"],
        ["entry.js", "export function emit(sink) { return sink(1) }"],
        ["entry.ts", "export function emit() { var sink = () => null; var sink = () => null; return sink(1) }"],
    ]
    for (const [file, source] of sources) assert.equal(deliveries(await trace(t, source, { file })).length, 0)
})

test("enters a queued callback only through a concrete method that invokes the supplied callable", async (t) => {
    const source = (body) =>
        `class Tracker { schedule(request: () => unknown) { ${body} } } const tracker = new Tracker(); export function emit() { return tracker.schedule(() => sink(1)) }`
    assert.equal(deliveries(await trace(t, source("return Promise.allSettled([]).then(request)"))).length, 1)
    assert.equal(deliveries(await trace(t, source("return request"))).length, 0)
    assert.equal(deliveries(await trace(t, source("return Promise.allSettled([]).then(() => 1)"))).length, 0)
})

test("evaluates the two-level lookup result as the callee rather than any imported handler", async (t) => {
    const source = (arguments_) =>
        `const table = { demo: { accept: sink } }; function lookup(service: string, method: string) { const selected = table[service]; const handler = selected[method]; return handler } export function emit() { const handler = lookup(${arguments_}); return handler(42) }`
    const correct = await trace(t, source('"demo", "accept"'))
    assert.equal(deliveries(correct).length, 1)
    assert.equal(deliveries(correct)[0].arguments[0].value, 42)
    assert.equal(deliveries(await trace(t, source('"accept", "demo"'))).length, 0)
})

test("never treats a shadow Promise or an exhausted recursive circuit as successful analysis", async (t) => {
    assert.equal(
        deliveries(await trace(t, "export function emit(Promise: any) { return Promise.resolve().then(() => sink(1)) }")).length,
        0,
    )
    const recursive = await trace(t, "function recurse() { return recurse() } export function emit() { return recurse() }")
    assert.equal(recursive.exhausted, true)
    assert.equal(deliveries(recursive).length, 0)
    assert.equal((await trace(t, "export function emit() { return sink(1) }", { maxSteps: 1 })).exhausted, true)
})
