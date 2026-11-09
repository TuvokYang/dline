import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { proveEvidenceEdge } from "../lib/checks-code-conformance.mjs"
import { createCodeFactSnapshot } from "../lib/code-facts.mjs"
import { readProtoFacts } from "../lib/proto-facts.mjs"

function fixture(t, files) {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dline-proto-identities-"))
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }))
    for (const [file, source] of Object.entries(files)) {
        const target = path.join(repoRoot, "proto", file)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, source)
    }
    return repoRoot
}

const identity = (fullName, file) => ({ state: "resolved", fullName, file, kind: "message" })

test("RPC identities resolve imported responses and nested requests, not only their short names", (t) => {
    const repoRoot = fixture(t, {
        "wire/actions.proto":
            'syntax = "proto3"; package acme.control; import "wire/common.proto"; message Envelope { message Input {} } service Actions { rpc apply(Envelope.Input) returns (.acme.shared.Empty); }',
        "wire/common.proto": 'syntax = "proto3"; package acme.shared; message Empty {}',
        "unrelated.proto": "package unrelated; message Input {} message Empty {}",
    })
    const facts = readProtoFacts({ repoRoot })
    const method = facts.services[0].methods[0]
    assert.deepEqual(method.requestIdentity, identity("acme.control.Envelope.Input", "proto/wire/actions.proto"))
    assert.deepEqual(method.responseIdentity, identity("acme.shared.Empty", "proto/wire/common.proto"))
    assert.deepEqual(facts.files.find((file) => file.path === "proto/wire/actions.proto").imports, [
        { path: "wire/common.proto", visibility: "private", target: "proto/wire/common.proto" },
    ])
    const snapshot = createCodeFactSnapshot({ repoRoot })
    assert.deepEqual(snapshot.protoServices[0].methods[0].requestIdentity, method.requestIdentity)
    assert.ok(snapshot.protoTypes.some((type) => type.fullName === "acme.shared.Empty" && type.kind === "message"))
})

test("same spelling in another package or an unimported file cannot satisfy an RPC type", (t) => {
    const repoRoot = fixture(t, {
        "service.proto": "package control; service Actions { rpc apply(Request) returns (.foreign.Empty); }",
        "unimported.proto": "package control; message Request {}",
        "wrong.proto": "package foreign; message Empty {}",
    })
    const method = readProtoFacts({ repoRoot }).services[0].methods[0]
    assert.equal(method.requestIdentity?.state, "unresolved")
    assert.equal(method.responseIdentity?.state, "unresolved")
})

test("public import visibility is transitive, private import visibility is not", (t) => {
    for (const visibility of ["public ", ""]) {
        const repoRoot = fixture(t, {
            "service.proto":
                'package sample; import "bridge.proto"; message Request {} service Actions { rpc apply(Request) returns (Empty); }',
            "bridge.proto": `package sample; import ${visibility}"common.proto";`,
            "common.proto": "package sample; message Empty {}",
        })
        const method = readProtoFacts({ repoRoot }).services[0].methods[0]
        assert.deepEqual(method.requestIdentity, identity("sample.Request", "proto/service.proto"))
        if (visibility) assert.deepEqual(method.responseIdentity, identity("sample.Empty", "proto/common.proto"))
        else assert.equal(method.responseIdentity?.state, "unresolved")
    }
})

test("duplicate visible full identities and enum RPC types are never message certificates", (t) => {
    const repoRoot = fixture(t, {
        "service.proto":
            'package sample; import "a.proto"; import "b.proto"; enum Empty { ZERO = 0; } service Actions { rpc apply(Request) returns (Empty); }',
        "a.proto": "package sample; message Request {}",
        "b.proto": "package sample; message Request {}",
    })
    const method = readProtoFacts({ repoRoot }).services[0].methods[0]
    assert.equal(method.requestIdentity?.state, "ambiguous")
    assert.equal(method.responseIdentity?.state, "unresolved")
})

test("relative lookup binds the first namespace component before looking for nested types", (t) => {
    const repoRoot = fixture(t, {
        "service.proto":
            'package sample.inner; import "common.proto"; message Outer {} service Actions { rpc apply(Outer.Input) returns (sample.Outer.Input); }',
        "common.proto": "package sample; message Outer { message Input {} }",
    })
    const method = readProtoFacts({ repoRoot }).services[0].methods[0]
    // The nearer sample.inner.Outer shadows sample.Outer, even though it has no Input.
    assert.equal(method.requestIdentity?.state, "unresolved")
    assert.deepEqual(method.responseIdentity, identity("sample.Outer.Input", "proto/common.proto"))
})

test("comments, option strings, missing imports and public import cycles cannot invent types", (t) => {
    const repoRoot = fixture(t, {
        "service.proto":
            'package sample; import public "bridge.proto"; import weak "missing.proto"; option java_package = "message Fake {}"; /* message Ghost {} */ message Request { string message = 1; } service Actions { rpc apply(Request) returns (Ghost); }',
        "bridge.proto": 'package sample; import public "service.proto";',
    })
    const facts = readProtoFacts({ repoRoot })
    assert.deepEqual(
        facts.types.map((type) => type.fullName),
        ["sample.Request"],
    )
    assert.deepEqual(facts.services[0].methods[0].requestIdentity, identity("sample.Request", "proto/service.proto"))
    assert.equal(facts.services[0].methods[0].responseIdentity?.state, "unresolved")
    assert.equal(facts.files.find((file) => file.path === "proto/service.proto").imports[1].target, null)
})

test("canonical RPC evidence must bind its actual service file, and duplicate services stay ambiguous", (t) => {
    const repoRoot = fixture(t, {
        "service.proto":
            "package sample; message Request {} message Empty {} service Actions { rpc apply(Request) returns (Empty); }",
        "other.proto":
            "package other; message Request {} message Empty {} service Actions { rpc apply(Request) returns (Empty); }",
    })
    const codeSnapshot = createCodeFactSnapshot({ repoRoot })
    const presentArtifacts = new Set(["send.ts", "handle.ts", "proto/service.proto", "proto/other.proto"])
    const edge = {
        kind: "rpc",
        emit: { path: "send.ts" },
        receive: { path: "handle.ts" },
        contract: { path: "proto/service.proto" },
        rpc: { service: "sample.Actions", method: "apply" },
    }
    const prove = (edge, snapshot = codeSnapshot) => proveEvidenceEdge({ edge, codeSnapshot: snapshot, presentArtifacts })
    assert.equal(prove(edge).status, "unverifiable") // Canonical identity is necessary, never delivery evidence.
    assert.equal(prove({ ...edge, contract: { path: "proto/other.proto" } }).status, "contradicted")
    assert.equal(
        prove(edge, {
            ...codeSnapshot,
            protoServices: [
                ...codeSnapshot.protoServices,
                codeSnapshot.protoServices.find((service) => service.fullName === "sample.Actions"),
            ],
        }).status,
        "unverifiable",
    )
})

test("nested declarations after a oneof remain visible while malformed declaration bodies stay diagnostic", (t) => {
    const repoRoot = fixture(t, {
        "service.proto":
            "package sample; message Outer { oneof choice { string value = 1; } message Input {} } service Actions { rpc apply(Outer.Input) returns (Outer.Input); }",
    })
    assert.deepEqual(
        readProtoFacts({ repoRoot }).services[0].methods[0].requestIdentity,
        identity("sample.Outer.Input", "proto/service.proto"),
    )
    const malformed = fixture(t, { "invalid.proto": "package sample; message Request {" })
    const facts = readProtoFacts({ repoRoot: malformed })
    assert.equal(facts.diagnostics.length, 1)
    assert.deepEqual(facts.types, [])
})
