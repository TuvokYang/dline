import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { checkAstForTask } from "../lib/checks-ast.mjs"

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dline-stage6-tree-sitter-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    return root
}

function write(root, relative, content) {
    const target = path.join(root, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
}

function diagram(file, fromPath, toPath) {
    return {
        file,
        line: 1,
        edges: [{ from: "A", to: "B", style: "solid", label: "hands", line: 2 }],
        modules: new Map([
            ["A", fromPath],
            ["B", toPath],
        ]),
    }
}

function task(id, owns, taskDiagram) {
    return { id, owns, diagrams: [taskDiagram] }
}

test("Stage 6 proves TypeScript and Python modules without package or tsconfig", async (t) => {
    const root = fixture(t)
    write(root, "ts/source.ts", 'import { receive } from "./target"\nexport function send(){ return receive() }\n')
    write(root, "ts/target.ts", "export function receive(){ return 1 }\n")
    write(root, "py/source.py", "from py.target import receive\ndef send():\n    return receive()\n")
    write(root, "py/target.py", "def receive():\n    return 1\n")

    assert.equal(fs.existsSync(path.join(root, "package.json")), false)
    assert.equal(fs.existsSync(path.join(root, "tsconfig.json")), false)

    const tsFindings = await checkAstForTask({
        task: task(
            "TASK-TS",
            [{ path: "ts/source.ts", kind: "symbol", selector: "send" }],
            diagram("ts-plan.md", "ts/source.ts", "ts/target.ts"),
        ),
        wsModules: null,
        repoRoot: root,
    })
    assert.deepEqual(tsFindings, [])

    const pyFindings = await checkAstForTask({
        task: task(
            "TASK-PY",
            [{ path: "py/source.py", kind: "symbol", selector: "send" }],
            diagram("py-plan.md", "py/source.py", "py/target.py"),
        ),
        wsModules: null,
        repoRoot: root,
    })
    assert.deepEqual(pyFindings, [])
})

test("Stage 6 fails closed for missing symbols and records indirect wiring as not checked", async (t) => {
    const root = fixture(t)
    write(root, "source.mjs", "export function present(){ return 1 }\n")
    write(root, "target.mjs", "export function receive(){ return 1 }\n")

    const findings = await checkAstForTask({
        task: task(
            "TASK-MUTATION",
            [{ path: "source.mjs", kind: "symbol", selector: "removedSymbol" }],
            diagram("plan.md", "source.mjs", "target.mjs"),
        ),
        wsModules: null,
        repoRoot: root,
    })
    assert.equal(
        findings.some((finding) => finding.rule === "owned-symbol-unverifiable" && finding.severity === "unverifiable"),
        true,
    )
    assert.equal(
        findings.some(
            (finding) => finding.rule === "implemented-edge-without-direct-import" && finding.severity === "not-checked",
        ),
        true,
    )
    assert.equal(
        findings.some((finding) => finding.severity === "blocking"),
        false,
    )
})
