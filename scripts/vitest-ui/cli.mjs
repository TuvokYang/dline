#!/usr/bin/env node
import { stringifyBoundedPayload } from "./lib/bounded-payload.mjs"
import {
    assertNoUnhandledErrors,
    collectFailures,
    connectVitestUi,
    filterFiles,
    getVitestUiIdentity,
    readKnownFiles,
    rerunWithScope,
    simplifyFile,
    summarizeFiles,
    waitForIdle,
} from "./lib/client.mjs"

function parseArgs(argv) {
    const positional = []
    const options = {}
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index]
        if (!arg.startsWith("--")) {
            positional.push(arg)
            continue
        }

        const [rawKey, inlineValue] = arg.slice(2).split("=", 2)
        const key = rawKey.replace(/-([a-z])/g, (_match, char) => char.toUpperCase())
        const next = argv[index + 1]
        if (inlineValue !== undefined) {
            options[key] = inlineValue
        } else if (next && !next.startsWith("--")) {
            options[key] = next
            index++
        } else {
            options[key] = true
        }
    }
    return { positional, options }
}

function printHelp() {
    console.log(`Vitest UI wrapper

Usage:
  npm run vitest:ui -- status [--filter all|fail|pass|success|skip|running] [--json] [--details] [--wait-idle]
  npm run vitest:ui -- errors [--json] [--include-containers]
  npm run vitest:ui -- files [--filter fail|pass|running|skip|all] [--json]
  npm run vitest:ui -- rerun all [--wait]
  npm run vitest:ui -- rerun failed [--wait]
  npm run vitest:ui -- rerun file --file src/example.test.ts [--wait] [--all-matches]
  npm run vitest:ui -- rerun test --file src/example.test.ts --test "test name" [--wait]
  npm run vitest:ui -- rerun task --task-id "<vitest task id>" [--wait]

Options:
  --url <url>         Vitest UI URL, default VITEST_UI_URL or http://localhost:51205/__vitest__/
  --timeout <ms>     Connect/wait timeout, default 180000 for wait operations
  --json             Print machine-readable JSON
  --details          Include flattened task details for listed files
  --wait / --wait-idle
                     Wait until current/rerun execution is idle before printing
  --allow-unknown    Treat uncollected placeholder files as idle when waiting
`)
}

function asBoolean(value) {
    return value === true || value === "true" || value === "1"
}

function numberOption(value, fallback) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
}

function printJson(value) {
    console.log(stringifyBoundedPayload(value))
}

const MAX_PRINTED_FAILURES = 10

function printStatus(result, { details = false } = {}) {
    const { summary, files, failures } = result
    if (result.identity?.root) {
        console.log(`root=${result.identity.root}${result.identity.configFile ? ` config=${result.identity.configFile}` : ""}`)
    }
    console.log(
        `files=${summary.total} fail=${summary.fail} pass=${summary.pass} running=${summary.running} skip=${summary.skip} unknown=${summary.unknown}`,
    )
    if (failures?.length) {
        console.log(`failedTests=${failures.length}`)
        for (const failure of failures.slice(0, MAX_PRINTED_FAILURES)) {
            const message = failure.errors[0]?.message ? ` ${failure.errors[0].message.replace(/\s+/g, " ").slice(0, 200)}` : ""
            console.log(`FAIL ${failure.file} :: ${failure.fullName}${message}`)
        }
        if (failures.length > MAX_PRINTED_FAILURES) {
            console.log(`... ${failures.length - MAX_PRINTED_FAILURES} additional failures omitted`)
        }
    }
    if (details) {
        for (const file of files) {
            console.log(`${file.state.toUpperCase()} ${file.filepath}`)
        }
    }
}

async function getStatus(client, options) {
    const timeoutMs = numberOption(options.timeout, 180_000)
    const files = asBoolean(options.waitIdle)
        ? await waitForIdle(client, { timeoutMs, allowUnknown: asBoolean(options.allowUnknown) })
        : await readKnownFiles(client, { allowUnknown: asBoolean(options.allowUnknown) })
    await assertNoUnhandledErrors(client)
    const filteredFiles = filterFiles(files, options.filter || "all")
    const simplifiedFiles = filteredFiles.map((file) => simplifyFile(file, { includeTasks: asBoolean(options.details) }))
    const failures = collectFailures(filteredFiles, { includeContainers: asBoolean(options.includeContainers) })
    return {
        baseUrl: client.baseUrl,
        identity: await getVitestUiIdentity(client),
        summary: summarizeFiles(files),
        filter: options.filter || "all",
        files: simplifiedFiles,
        failures,
    }
}

async function main() {
    const { positional, options } = parseArgs(process.argv.slice(2))
    const command = positional[0] || "status"

    if (command === "help" || asBoolean(options.help)) {
        printHelp()
        return
    }

    const client = await connectVitestUi({
        url: options.url,
        connectTimeoutMs: numberOption(options.timeout, 15_000),
        rpcTimeoutMs: numberOption(options.rpcTimeout, 180_000),
    })

    try {
        if (command === "status" || command === "files") {
            const result = await getStatus(client, {
                ...options,
                details: command === "files" ? true : options.details,
            })
            if (asBoolean(options.json)) printJson(result)
            else printStatus(result, { details: command === "files" || asBoolean(options.details) })
            return
        }

        if (command === "errors") {
            const result = await getStatus(client, { ...options, filter: "fail" })
            if (asBoolean(options.json)) printJson(result)
            else printStatus(result, { details: asBoolean(options.details) })
            return
        }

        if (command === "rerun") {
            const scope = positional[1] || options.scope || "all"
            const rerun = await rerunWithScope(client, {
                scope,
                file: options.file,
                testName: options.test || options.testName || options.match,
                taskId: options.taskId,
                exact: asBoolean(options.exact),
                allMatches: asBoolean(options.allMatches),
            })
            let files
            if (asBoolean(options.wait) || asBoolean(options.waitIdle)) {
                files = await waitForIdle(client, {
                    timeoutMs: numberOption(options.timeout, 180_000),
                    since: rerun.startedAt,
                    allowUnknown: asBoolean(options.allowUnknown),
                })
                await assertNoUnhandledErrors(client)
            }
            const result = {
                baseUrl: client.baseUrl,
                identity: await getVitestUiIdentity(client),
                rerun,
                summary: files ? summarizeFiles(files) : undefined,
                failures: files ? collectFailures(files) : undefined,
            }
            if (asBoolean(options.json)) {
                printJson(result)
            } else {
                console.log(`rerun scope=${rerun.scope} targets=${Array.isArray(rerun.targets) ? rerun.targets.length : 0}`)
                if (files)
                    printStatus({ identity: result.identity, summary: result.summary, files: [], failures: result.failures })
            }
            return
        }

        throw new Error(`Unknown command "${command}". Run "npm run vitest:ui -- help".`)
    } finally {
        client.close()
    }
}

main().catch((error) => {
    console.error(error?.stack || error?.message || String(error))
    process.exit(1)
})
