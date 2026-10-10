import assert from "node:assert/strict"
import test from "node:test"
import { buildVitestUiArgs, parseServerArgs } from "./server-args.mjs"
import { createVitestSpawnCommand, resolveVitestCliPath } from "./spawn-command.mjs"

test("parses wrapper flags and builds Vitest 4 API arguments", () => {
    const options = parseServerArgs(
        ["--host", "127.0.0.1", "--port", "51208", "--config", "custom.vitest.config.ts"],
        {},
        { host: "localhost", port: 51205 },
    )

    assert.deepEqual(options, {
        host: "127.0.0.1",
        port: 51208,
        config: "custom.vitest.config.ts",
    })
    assert.deepEqual(buildVitestUiArgs(options), [
        "--ui",
        "--watch",
        "--no-open",
        "--api.host",
        "127.0.0.1",
        "--api.port",
        "51208",
        "--config",
        "custom.vitest.config.ts",
    ])
})

test("uses the current Node runtime and repository-local Vitest without a shell", () => {
    const cliPath = resolveVitestCliPath(process.cwd())
    const command = createVitestSpawnCommand({ cwd: process.cwd(), execPath: "node-test" })

    assert.equal(cliPath.endsWith("node_modules\\vitest\\vitest.mjs") || cliPath.endsWith("node_modules/vitest/vitest.mjs"), true)
    assert.equal(command.file, "node-test")
    assert.deepEqual(command.args, [cliPath])
    assert.deepEqual(command.options, { shell: false })
})
