import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { classifyArtifactSymbol, proveEvidenceEdge } from "../lib/checks-code-conformance.mjs"
import { resolveScriptImport } from "../lib/script-exports.mjs"
import { buildDependencyClosure } from "../lib/tree-sitter-dependencies.mjs"

function fixture(t, files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dline-script-bindings-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    for (const [file, source] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
        fs.writeFileSync(path.join(root, file), source)
    }
    return root
}

test("captures qualified methods without treating an unrelated same-name method as that symbol", async (t) => {
    const repoRoot = fixture(t, {
        "service.ts": "export class Service { private createBlock() { return 1 } }\nclass Other { createBlock() {} }",
    })
    const closure = await buildDependencyClosure({ repoRoot, seeds: ["service.ts"] })
    const proof = (symbol) =>
        classifyArtifactSymbol({ artifact: { path: "service.ts", symbol }, codeSnapshot: { treeSitterFacts: closure.facts } })
    assert.equal(proof("Service.createBlock").status, "proven")
    assert.equal(proof("Missing.createBlock").status, "unverifiable")
})

test("resolves only the imported binding through renamed and star barrel exports", async (t) => {
    const repoRoot = fixture(t, {
        "consumer.ts": 'import type { PublicEvent } from "./barrel"\nexport const n = 1',
        "barrel.ts": 'export { type Event as PublicEvent } from "./middle"\nexport type { Unused } from "./unrelated"',
        "middle.ts": 'export * from "./contract"',
        "contract.ts": 'export interface Event { type: "ready" }',
        "unrelated.ts": "export interface Unused {}",
    })
    const closure = await buildDependencyClosure({ repoRoot, seeds: ["consumer.ts"] })
    const edge = closure.imports.find((entry) => entry.importer === "consumer.ts")
    assert.deepEqual(
        edge.bindings.map(({ local, imported, provenance }) => ({
            local,
            imported,
            origins: provenance.declarations.map(({ path, symbol }) => [path, symbol]),
        })),
        [{ local: "PublicEvent", imported: "PublicEvent", origins: [["contract.ts", "Event"]] }],
    )
})

test("proves a runtime barrel dependency only for a value binding, not a type in a mixed import", async (t) => {
    const repoRoot = fixture(t, {
        "consumer.ts": 'import { type Event, receive } from "./barrel"; export const send = () => receive()',
        "barrel.ts": 'export type { Event } from "./event"; export { receive } from "./receiver"',
        "event.ts": "export interface Event {}",
        "receiver.ts": "export const receive = () => 1",
    })
    const closure = await buildDependencyClosure({ repoRoot, seeds: ["consumer.ts"] })
    const codeSnapshot = { imports: closure.imports.map((edge) => ({ ...edge, typeOnly: edge.classification === "type" })) }
    const proof = (target) =>
        proveEvidenceEdge({
            edge: { kind: "direct_import", emit: { path: "consumer.ts" }, receive: { path: target } },
            codeSnapshot,
            presentArtifacts: new Set(["consumer.ts", "event.ts", "receiver.ts"]),
        })
    assert.equal(proof("receiver.ts").status, "proven")
    assert.equal(proof("event.ts").status, "contradicted")
})

test("resolves namespace member exports in value space and refuses a type-only forwarding hop", async (t) => {
    for (const typeOnly of [false, true]) {
        const repoRoot = fixture(t, {
            "client.ts": 'import * as wire from "./barrel"',
            "barrel.ts": 'export * as api from "./messages"',
            "messages.ts": `export ${typeOnly ? "type " : ""}{ Message } from "./codec"`,
            "codec.ts":
                "export interface Message { value: string }; export const Message = { toJSON(value: Message) { return value } }",
        })
        const snapshot = await buildDependencyClosure({ repoRoot, seeds: ["client.ts"] })
        const type = resolveScriptImport(snapshot, "client.ts", "wire", ["api", "Message"])
        const value = resolveScriptImport(snapshot, "client.ts", "wire", ["api", "Message"], { runtime: true })
        assert.equal(type.state, "resolved")
        if (typeOnly) assert.notEqual(value.state, "resolved")
        else
            assert.deepEqual(
                value.declarations.map(({ path, symbol }) => [path, symbol]),
                [["codec.ts", "Message"]],
            )
        assert.notEqual(
            resolveScriptImport(snapshot, "client.ts", "wire", ["Api", "Message"], { runtime: true }).state,
            "resolved",
        )
    }
})

test("does not resolve ambiguous star exports or a barrel export omitted by the bounded scan", async (t) => {
    const repoRoot = fixture(t, {
        "consumer.ts": 'import type { Event } from "./barrel"',
        "barrel.ts": 'export * from "./a"\nexport * from "./b"',
        "a.ts": "export interface Event {}",
        "b.ts": "export interface Event {}",
    })
    for (const maxFiles of [256, 2]) {
        const closure = await buildDependencyClosure({ repoRoot, seeds: ["consumer.ts"], maxFiles })
        const edge = closure.imports.find((entry) => entry.importer === "consumer.ts")
        assert.deepEqual(edge.bindings[0].provenance.declarations, [])
        assert.notEqual(edge.bindings[0].provenance.state, "resolved")
    }
})
