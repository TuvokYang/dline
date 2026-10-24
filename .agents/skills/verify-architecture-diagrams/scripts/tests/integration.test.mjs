import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(fileURLToPath(new URL("../../../../../", import.meta.url)))
const skillRoot = path.join(repoRoot, ".agents/skills/verify-architecture-diagrams")
const verifier = path.join(skillRoot, "scripts/verify-diagrams.mjs")

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dline-architecture-integration-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const workstream = path.join(root, "WS-TEST")
    fs.mkdirSync(workstream, { recursive: true })
    fs.writeFileSync(
        path.join(workstream, "spec.md"),
        "# WS-TEST Fixture\n\nArchitecture-Mode: diagram-driven-v1\n\nArrow labels are normative: `hands`.\n",
    )
    fs.writeFileSync(
        path.join(workstream, "plan.md"),
        "# Plan\n\n| Task | Goal Contract | Depends On | Execution Mode | Integration |\n|---|---|---|---|---|\n",
    )
    return { root, workstream }
}

test("product package, CI and architecture tests do not depend on this Skill", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"))
    assert.equal(Object.hasOwn(packageJson.scripts, "verify:architecture"), false)
    assert.equal(Object.hasOwn(packageJson.scripts, "test:architecture-verifier"), false)

    const workflow = fs.readFileSync(path.join(repoRoot, ".github/workflows/test.yml"), "utf8")
    assert.equal(workflow.includes("architecture-verifier"), false)
    assert.equal(workflow.includes("verify-architecture-diagrams"), false)

    const productScanner = fs.readFileSync(path.join(repoRoot, "src/core/task/__tests__/architecture/import-graph.ts"), "utf8")
    assert.equal(productScanner.includes(".agents/skills"), false)
    assert.equal(productScanner.includes("scripts/architecture"), false)
    assert.equal(fs.existsSync(path.join(repoRoot, "scripts/architecture/import-graph.mjs")), false)
})

test("diagram skills and workflows publish the exact opt-in, evidence and Skill-local command", () => {
    const documents = [
        ".agents/skills/verify-architecture-diagrams/SKILL.md",
        ".agents/skills/designing-workstream-diagrams/SKILL.md",
        ".agents/workflows/diagram-driven-task.md",
        ".agents/workflows/executing-diagram-task.md",
    ].map((relative) => fs.readFileSync(path.join(repoRoot, relative), "utf8"))
    for (const content of documents) {
        assert.match(content, /Architecture-Mode: diagram-driven-v1/)
        assert.match(content, /Architecture Evidence/)
        assert.match(content, /schema(?:-v2| version 2|_version: 2)/i)
        assert.match(content, /\{node, artifact\}/)
    }
    const command = /node \.agents\/skills\/verify-architecture-diagrams\/scripts\/verify-diagrams\.mjs/
    assert.match(documents[0], command)
    assert.match(documents[2], command)
    assert.match(documents[3], command)
})

test("a copied Skill runs in a non-Node project without repository dependencies", (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dline-architecture-copied-skill-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const copiedSkill = path.join(root, ".agents/skills/verify-architecture-diagrams")
    fs.mkdirSync(path.dirname(copiedSkill), { recursive: true })
    fs.cpSync(skillRoot, copiedSkill, { recursive: true })
    const workstream = path.join(root, "memory/WS-COPY")
    fs.mkdirSync(workstream, { recursive: true })
    fs.writeFileSync(
        path.join(workstream, "spec.md"),
        "# WS-COPY Fixture\n\nArchitecture-Mode: diagram-driven-v1\n\nArrow labels are normative: `hands`.\n",
    )
    fs.writeFileSync(
        path.join(workstream, "plan.md"),
        "# Plan\n\n| Task | Goal Contract | Depends On | Execution Mode | Integration |\n|---|---|---|---|---|\n",
    )
    const copiedVerifier = path.join(copiedSkill, "scripts/verify-diagrams.mjs")
    const result = spawnSync(process.execPath, [copiedVerifier, "--workstream", workstream, "--json"], {
        cwd: root,
        encoding: "utf8",
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const report = JSON.parse(result.stdout)
    assert.equal(fs.existsSync(path.join(root, "package.json")), false)
    assert.equal(fs.existsSync(path.join(root, "tsconfig.json")), false)
    assert.equal(report.coverage.complete, true)
    assert.equal(report.evidence.selfTest.status, "passed")
    assert.equal(report.counts.tooling, 0)
})

test("aggregate CLI accepts one explicit opt-in fixture without reading repository Memory", (t) => {
    const { root, workstream } = fixture(t)
    const result = spawnSync(process.execPath, [verifier, "--workstream", workstream, "--json", "--no-self-test"], {
        cwd: root,
        encoding: "utf8",
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const report = JSON.parse(result.stdout)
    assert.equal(report.exitCode, 0)
    assert.equal(report.workstream, workstream)
    assert.equal(report.counts.tooling, 0)
    assert.equal(report.counts.blocking, 0)
})
