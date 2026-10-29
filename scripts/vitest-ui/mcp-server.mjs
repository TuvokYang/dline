#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod/v4"
import { boundStructuredPayload, stringifyBoundedPayload } from "./lib/bounded-payload.mjs"
import {
    assertNoUnhandledErrors,
    collectFailures,
    connectVitestUi,
    filterFiles,
    getVitestUiIdentity,
    isSameVitestUiIdentity,
    readKnownFiles,
    rerunWithScope,
    simplifyFile,
    summarizeFiles,
    waitForIdle,
} from "./lib/client.mjs"
import { ensureVitestUiServer } from "./lib/managed-server.mjs"

function textResult(structuredContent) {
    const bounded = boundStructuredPayload(structuredContent)
    return {
        content: [
            {
                type: "text",
                text: stringifyBoundedPayload(structuredContent),
            },
        ],
        structuredContent: bounded,
    }
}

let ownedServerExitError

async function withClient(url, expectedIdentity, callback) {
    if (ownedServerExitError) throw ownedServerExitError
    const client = await connectVitestUi({ url })
    try {
        const actualIdentity = await getVitestUiIdentity(client)
        if (!isSameVitestUiIdentity(actualIdentity, expectedIdentity)) {
            throw new Error(
                `Vitest UI endpoint identity changed: expected root=${expectedIdentity.root} config=${expectedIdentity.configFile}, received root=${actualIdentity.root} config=${actualIdentity.configFile}`,
            )
        }
        return await callback(client, actualIdentity)
    } finally {
        client.close()
    }
}

const { url, child, identity } = await ensureVitestUiServer({
    onExit: (code, signal) => {
        ownedServerExitError = new Error(`Owned Vitest UI exited code=${code ?? ""} signal=${signal ?? ""}`)
        console.error(`[vitest-ui-mcp] ${ownedServerExitError.message}`)
    },
})

const server = new McpServer({
    name: "dline-vitest-ui",
    version: "1.0.0",
})

server.registerTool(
    "vitest_status",
    {
        title: "Vitest UI Status",
        description: "Read the current Vitest UI watch state without starting a new test run.",
        inputSchema: {
            filter: z.enum(["all", "fail", "failed", "pass", "success", "skip", "running"]).default("all"),
            includeTasks: z.boolean().default(false),
            includeFailures: z.boolean().default(true),
            includeContainers: z.boolean().default(false),
            waitForIdle: z.boolean().default(false),
            allowUnknown: z.boolean().default(false),
            timeoutMs: z.number().int().positive().default(180_000),
        },
    },
    async ({ filter, includeTasks, includeFailures, includeContainers, waitForIdle: shouldWait, allowUnknown, timeoutMs }) =>
        withClient(url, identity, async (client, actualIdentity) => {
            const files = shouldWait
                ? await waitForIdle(client, { timeoutMs, allowUnknown })
                : await readKnownFiles(client, { allowUnknown })
            await assertNoUnhandledErrors(client)
            const filtered = filterFiles(files, filter)
            return textResult({
                url: client.baseUrl,
                identity: actualIdentity,
                summary: summarizeFiles(files),
                filter,
                files: filtered.map((file) => simplifyFile(file, { includeTasks })),
                failures: includeFailures ? collectFailures(filtered, { includeContainers }) : undefined,
            })
        }),
)

server.registerTool(
    "vitest_rerun",
    {
        title: "Vitest UI Rerun",
        description: "Rerun all tests, failed files, one file, one task id, or one test name through the Vitest UI watch server.",
        inputSchema: {
            scope: z.enum(["all", "failed", "fail", "file", "test", "task"]).default("all"),
            file: z.string().optional(),
            testName: z.string().optional(),
            taskId: z.string().optional(),
            exact: z.boolean().default(false),
            allMatches: z.boolean().default(false),
            waitForIdle: z.boolean().default(true),
            allowUnknown: z.boolean().default(false),
            timeoutMs: z.number().int().positive().default(180_000),
        },
    },
    async ({ scope, file, testName, taskId, exact, allMatches, waitForIdle: shouldWait, allowUnknown, timeoutMs }) =>
        withClient(url, identity, async (client, actualIdentity) => {
            const rerun = await rerunWithScope(client, { scope, file, testName, taskId, exact, allMatches })
            const files = shouldWait ? await waitForIdle(client, { timeoutMs, since: rerun.startedAt, allowUnknown }) : undefined
            if (files) await assertNoUnhandledErrors(client)
            return textResult({
                url: client.baseUrl,
                identity: actualIdentity,
                rerun,
                summary: files ? summarizeFiles(files) : undefined,
                failures: files ? collectFailures(files) : undefined,
            })
        }),
)

server.registerTool(
    "vitest_failures",
    {
        title: "Vitest UI Failures",
        description: "Return only failed Vitest tests and their error messages.",
        inputSchema: {
            includeContainers: z.boolean().default(false),
            waitForIdle: z.boolean().default(false),
            allowUnknown: z.boolean().default(false),
            timeoutMs: z.number().int().positive().default(180_000),
        },
    },
    async ({ includeContainers, waitForIdle: shouldWait, allowUnknown, timeoutMs }) =>
        withClient(url, identity, async (client, actualIdentity) => {
            const files = shouldWait
                ? await waitForIdle(client, { timeoutMs, allowUnknown })
                : await readKnownFiles(client, { allowUnknown })
            await assertNoUnhandledErrors(client)
            const failedFiles = filterFiles(files, "fail")
            return textResult({
                url: client.baseUrl,
                identity: actualIdentity,
                summary: summarizeFiles(files),
                failures: collectFailures(failedFiles, { includeContainers }),
            })
        }),
)

const transport = new StdioServerTransport()
await server.connect(transport)
console.error(`[vitest-ui-mcp] ready: ${url} root=${identity.root}`)

function shutdown() {
    if (child && !child.killed) {
        child.kill("SIGTERM")
    }
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
process.on("exit", shutdown)
