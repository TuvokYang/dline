/**
 * Proto lint script — cross-platform replacement for proto-lint.sh.
 * Uses Node.js APIs instead of bash + system diff, avoiding the
 * "exec: diff: executable file not found" error on Windows.
 */

import { execSync } from "child_process"
import { readdirSync, readFileSync } from "fs"
import { join } from "path"

// 1. Lint proto files
console.log("[proto-lint] Running buf lint...")
execSync("npx buf lint", { stdio: "inherit" })

// 2. Format proto files in-place using biome (avoids buf's diff dependency on Windows)
console.log("[proto-lint] Formatting proto files...")
execSync("npx biome format proto --write --no-errors-on-unmatched", { stdio: "inherit" })

// 3. Check RPC naming convention: no repeated capital letters in RPC names
//    See https://github.com/cline/cline/pull/7054
const protoDir = "proto"
const files = []

function collect(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
            collect(full)
        } else if (entry.name.endsWith(".proto")) {
            files.push(full)
        }
    }
}
collect(protoDir)

// Match RPC names with two or more consecutive uppercase letters
// Example violation: "rpc GetID(...)" — "ID" has two consecutive capitals
const rpcRegex = /rpc\s+(\w*[A-Z]{2,}\w*)\s*\(/g
let hasError = false

for (const file of files) {
    const content = readFileSync(file, "utf8")
    let match
    while ((match = rpcRegex.exec(content)) !== null) {
        console.error(`[proto-lint] Error: ${file}: RPC name "${match[1]}" contains repeated capital letters`)
        hasError = true
    }
}

if (hasError) {
    console.error("[proto-lint] Proto lint failed: RPC naming convention violations found")
    process.exit(1)
}

console.log("[proto-lint] Proto lint passed")
