import assert from "node:assert/strict"
import test from "node:test"

import { parseFrontmatter, parseYamlLite, YamlLiteError } from "../lib/yaml-lite.mjs"

test("block scalars do not hide subsequent task contracts", () => {
    const parsed = parseYamlLite(`id: TASK-001
objective: >-
  Preserve every
  contract field.
acceptance: [AC-1]
owns:
  - path: src/owner.ts
    boundary: {kind: whole_file}
reads: [src/port.ts]
required_verification:
  VER-ONE:
    required_result: passed
    claim: >-
      First proof
      remains required.
  VER-TWO:
    required_result: passed
    claim: Second proof
`)
    assert.deepEqual(parsed, {
        id: "TASK-001",
        objective: "Preserve every contract field.",
        acceptance: ["AC-1"],
        owns: [{ path: "src/owner.ts", boundary: { kind: "whole_file" } }],
        reads: ["src/port.ts"],
        required_verification: {
            "VER-ONE": { required_result: "passed", claim: "First proof remains required." },
            "VER-TWO": { required_result: "passed", claim: "Second proof" },
        },
    })
})

test("literal text preserves comments, document markers and indentation", () => {
    assert.deepEqual(parseYamlLite("body: |-\n  # content\n  ---\n    indented\n\n  final\ntail: true\n"), {
        body: "# content\n---\n  indented\n\nfinal",
        tail: true,
    })
})

test("folding preserves paragraph and more-indented line breaks", () => {
    assert.equal(parseYamlLite("body: >-\n  one\n  two\n\n  three\n    code\n  four\n").body, "one two\nthree\n  code\nfour")
})

test("block scalar chomping preserves only the requested final breaks", () => {
    for (const [indicator, expected] of [
        ["|", "text\n"],
        ["|-", "text"],
        ["|+", "text\n\n"],
    ]) {
        assert.equal(parseYamlLite(`body: ${indicator}\n  text\n\ntail: true\n`).body, expected)
    }
    assert.equal(parseYamlLite("body: |\n  text").body, "text")
    assert.equal(parseYamlLite("body: >\n\ntail: true\n").body, "")
})

test("sequence block scalars keep following fields and items", () => {
    assert.deepEqual(
        parseYamlLite(
            "items:\n  - claim: >-\n      first\n      second\n    result: passed\n  - claim: last\ntext:\n  - |-\n    value\n  - next\n",
        ),
        {
            items: [{ claim: "first second", result: "passed" }, { claim: "last" }],
            text: ["value", "next"],
        },
    )
})

test("explicit block indentation and frontmatter keep their boundaries", () => {
    const parsed = parseFrontmatter("---\nnext_action: >2-\n  first\n  second\nstatus: planned\n---\n# Body\n")
    assert.deepEqual(parsed.data, { next_action: "first second", status: "planned" })
    assert.equal(parsed.body, "# Body\n")
    assert.equal(parsed.lineOffset, 6)
})

test("indented document markers inside frontmatter remain block text", () => {
    const parsed = parseFrontmatter(
        "---\nstatus: completed\nnext_action: |-\n  ---\n  Keep the remainder.\nblockers: [unresolved]\n---\n# Body\n",
    )
    assert.deepEqual(parsed.data, {
        status: "completed",
        next_action: "---\nKeep the remainder.",
        blockers: ["unresolved"],
    })
    assert.equal(parsed.lineOffset, 7)
    assert.equal(parsed.body, "# Body\n")
})

test("unconsumed or malformed input is never accepted as a partial document", () => {
    for (const text of [
        "id: TASK-001\n  hidden: true\nrequired_verification: {}\n",
        'id: "TASK-001" trailing\n',
        "body: >0\n  text\n",
        "body: |\n    first\n   invalid\n",
        "id: TASK-001\n...\nsecond: document\n",
    ]) {
        assert.throws(() => parseYamlLite(text), YamlLiteError, text)
    }
})
