import { spawnSync } from "node:child_process"

const GIT_TIMEOUT_MS = 15_000
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024

function git(args, { cwd, input, accepted = [0] } = {}) {
    const result = spawnSync("git", args, {
        cwd,
        input,
        encoding: "utf8",
        windowsHide: true,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
    })
    if (result.error) throw result.error
    if (!accepted.includes(result.status)) {
        throw new Error(`git ${args[0]} failed (${result.status ?? result.signal}): ${result.stderr.trim()}`)
    }
    return result.stdout
}

function ignoredStagedPaths() {
    const cwd = git(["rev-parse", "--show-toplevel"]).replace(/\r?\n$/, "")
    // Renames become deletion/addition pairs; only the destination carries new content.
    // Deleting a previously tracked ignored file must remain possible.
    const staged = git(["diff", "--cached", "--name-only", "--no-renames", "--diff-filter=ACMT", "-z", "--"], { cwd })
    if (!staged) return []

    // --no-index also checks force-added and already tracked paths. Git alone owns
    // nested rules, negations, info/exclude, global excludes, and alternate indices.
    const output = git(["check-ignore", "--no-index", "--verbose", "-z", "--stdin"], {
        cwd,
        input: staged,
        accepted: [0, 1],
    })
    if (!output) return []
    const fields = output.split("\0")
    if (fields.pop() !== "" || fields.length % 4 !== 0) throw new Error("Malformed git check-ignore output")
    const ignored = []
    for (let index = 0; index < fields.length; index += 4) {
        const [source, line, pattern, path] = fields.slice(index, index + 4)
        if (!pattern.startsWith("!")) ignored.push({ source, line, pattern, path })
    }
    return ignored
}

try {
    const ignored = ignoredStagedPaths()
    if (ignored.length > 0) {
        console.error("Commit blocked: staged paths match Git ignore rules. The index is unchanged.")
        for (const { path, source, line, pattern } of ignored) {
            console.error(`  ${JSON.stringify(path)} <- ${JSON.stringify(source)}:${line} (${JSON.stringify(pattern)})`)
        }
        console.error("Unstage these paths or correct their ignore rules before retrying.")
        process.exitCode = 1
    }
} catch (error) {
    console.error(`Cannot verify staged ignore rules; commit blocked: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
}
