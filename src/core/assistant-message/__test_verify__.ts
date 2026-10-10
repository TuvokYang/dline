/**
 * Quick verification script for DiffParser.
 * Run: npx tsx src/core/assistant-message/__test_verify__.ts
 */
import { DiffParser } from "./diff"

function run(diff: string, original: string) {
    const p = new DiffParser(original)
    for (const l of diff.split("\n")) p.processLine(l)
    p.finalize()
    return p.getResult()
}

let pass = 0,
    fail = 0
function check(name: string, ok: boolean) {
    if (ok) {
        pass++
        process.stdout.write(`  ✅ ${name}\n`)
    } else {
        fail++
        process.stdout.write(`  ❌ ${name}\n`)
    }
}

// Test 1: single block match
process.stdout.write("\nTest 1: single block\n")
const r1 = run("------- SEARCH\nline2\n=======\nnew line2\n+++++++ REPLACE", "line1\nline2\nline3\n")
check("blocks=1", r1.blocks.length === 1)
check("no error", !r1.blocks[0].hasError)
check("startLine=2", r1.blocks[0].startLine === 2)
check("searchText", r1.blocks[0].searchText === "line2")
check("newContent", r1.newContent === "line1\nnew line2\nline3\n")

// Test 2: multi-block
process.stdout.write("\nTest 2: multi-block\n")
const r2 = run(
    "------- SEARCH\nline1\n=======\nA\n+++++++ REPLACE\n------- SEARCH\nline3\n=======\nB\n+++++++ REPLACE",
    "line1\nline2\nline3\n",
)
check("blocks=2", r2.blocks.length === 2)
check("block0 ok", !r2.blocks[0].hasError)
check("block1 ok", !r2.blocks[1].hasError)
check("newContent", r2.newContent === "A\nline2\nB\n")

// Test 3: SEARCH_NOT_FOUND
process.stdout.write("\nTest 3: SEARCH_NOT_FOUND\n")
const r3 = run("------- SEARCH\nno_match\n=======\nnew\n+++++++ REPLACE", "line1\n")
check("hasError", r3.blocks[0].hasError)
check("errorCode", r3.blocks[0].errorCode === "SEARCH_NOT_FOUND")
check("errorMessage exists", !!r3.blocks[0].errorMessage)
check("rawText", r3.blocks[0].rawText.includes("------- SEARCH"))
check("newContent unchanged", r3.newContent === "line1\n")

// Test 4: empty diff
process.stdout.write("\nTest 4: empty diff\n")
const r4 = run("", "line1\n")
check("blocks=0", r4.blocks.length === 0)
check("newContent", r4.newContent === "line1\n")

// Test 5: UNCLOSED
process.stdout.write("\nTest 5: UNCLOSED\n")
const r5 = run("------- SEARCH\nline1", "line1\n")
check("hasError", r5.blocks[0]?.hasError)
check("errorCode UNCLOSED", r5.blocks[0]?.errorCode === "UNCLOSED_SEARCH")

process.stdout.write(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail > 0 ? 1 : 0)
