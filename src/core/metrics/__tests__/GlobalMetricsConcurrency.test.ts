import fs from "node:fs/promises"
import path from "node:path"
import type { UsageEvent } from "@shared/metrics/events"
import * as esbuild from "esbuild"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { MetricsFlushHost } from "../MetricsFlushHost"
import { MetricsLedger } from "../MetricsLedger"
import type { MetricsScope } from "../MetricsScope"

/**
 * The worker bundle these cases run against, built here rather than consumed from `dist/`.
 *
 * `MetricsFlushHost` starts a worker thread from a compiled entry, because a worker has no
 * extension-host module graph and cannot resolve this project's TypeScript aliases. The
 * production bundle is therefore an esbuild output that only a package build emits, so a
 * test run against `dist/` inherits whatever an earlier `npm run package` happened to leave
 * there: absent in a clean checkout, stale after a source change.
 *
 * These cases assert the real write path end to end, so they cannot substitute a stub: one
 * connection serializing several tasks is the property under test. Building from the same
 * entry and the same `tsconfig.json` the release build compiles keeps the test independent of
 * build history while still exercising the real bundle.
 */
const PROJECT_ROOT = process.cwd()
const WORKER_ENTRY = path.join(PROJECT_ROOT, "src", "core", "metrics", "MetricsWorker.ts")
/**
 * Test-owned output, never `dist/`: `dist/` is shared with packaging and E2E builds, and a
 * test must not depend on or disturb what those left behind.
 */
const WORKER_PATH = path.join(PROJECT_ROOT, "tmp", "metrics-worker.js")

beforeAll(async () => {
    await fs.mkdir(path.dirname(WORKER_PATH), { recursive: true })
    await esbuild.build({
        entryPoints: [WORKER_ENTRY],
        outfile: WORKER_PATH,
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "es2022",
        tsconfig: path.join(PROJECT_ROOT, "tsconfig.json"),
        // A worker thread has no extension-host API surface, so the module must stay
        // unresolved here exactly as it is in the packaged build.
        external: ["vscode"],
        // A worker entry has to be self-contained: it cannot require sibling chunks lazily.
        splitting: false,
        sourcemap: false,
        // A missing entry or alias must fail this suite loudly instead of yielding a bundle
        // the worker cannot load, which would surface later as silently dropped writes.
        logLevel: "silent",
    })
}, 60_000)

const T0 = Date.UTC(2026, 0, 2, 3, 4, 0)

const TASK_COUNT = 4
const ROUNDS_PER_TASK = 25

describe("global metrics under concurrent tasks", () => {
    let root: string

    beforeEach(async () => {
        await fs.mkdir(path.join(process.cwd(), "tmp"), { recursive: true })
        root = await fs.mkdtemp(path.join(process.cwd(), "tmp", "metrics-concurrency-"))
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    function globalScope(): MetricsScope {
        return { level: "global", scopeId: "", databasePath: path.join(root, "metrics.db") }
    }

    async function openHost(scope: MetricsScope): Promise<MetricsFlushHost> {
        const host = new MetricsFlushHost({
            scope,
            workerPath: WORKER_PATH,
            // A background pass would commit between the assertions the cases make about
            // what is still buffered, so each case drives `flush()` explicitly.
            flushIntervalMs: 60_000,
        })
        await host.start()
        return host
    }

    // Several Tasks settling into one scope is the contention this design removes: they
    // share a single queue and one worker, so the writer commits one batch at a time
    // instead of every Task holding its own connection. Every fact must still be
    // recorded exactly once, which the receipt key guarantees.
    it("writes every task's fact exactly once through one writer", async () => {
        const scope = globalScope()
        const host = await openHost(scope)
        try {
            for (let roundIndex = 0; roundIndex < ROUNDS_PER_TASK; roundIndex += 1) {
                for (let taskIndex = 0; taskIndex < TASK_COUNT; taskIndex += 1) {
                    host.emit(usageOf(`task-${taskIndex}`, roundIndex))
                }
            }
            expect(host.snapshot().queue.pending).toBe(TASK_COUNT * ROUNDS_PER_TASK)

            await host.flush()
            // A second pass must find nothing: the first one committed the whole buffer.
            await host.flush()

            const ledger = await MetricsLedger.open({ scope })
            try {
                const rows = await ledger.readUsageRows()
                // One row per Task: the identity includes the task id, so tasks sharing a
                // Profile and model still accumulate separately.
                expect(rows).toHaveLength(TASK_COUNT)
                for (const row of rows) {
                    expect(row.respondingRequests).toBe(ROUNDS_PER_TASK)
                    expect(row.inputTokens).toBe(ROUNDS_PER_TASK * 100)
                    expect(row.outputTokens).toBe(ROUNDS_PER_TASK * 10)
                }
            } finally {
                await ledger.close()
            }

            const snapshot = host.snapshot()
            expect(snapshot.state).toBe("ok")
            expect(snapshot.consecutiveFailures).toBe(0)
            expect(snapshot.lostEvents).toBe(false)
            expect(snapshot.queue.pending).toBe(0)
        } finally {
            await host.stop()
        }
    })

    // A retry after `SQLITE_BUSY` must not double count. The receipt is written in the
    // same transaction as the numbers, so replaying an identical batch is a duplicate.
    it("records a replayed batch once", async () => {
        const scope = globalScope()
        const host = await openHost(scope)
        try {
            for (let index = 0; index < 10; index += 1) host.emit(usageOf("task-a", index))
            await host.flush()

            for (let index = 0; index < 10; index += 1) host.emit(usageOf("task-a", index))
            await host.flush()

            const ledger = await MetricsLedger.open({ scope })
            try {
                const rows = await ledger.readUsageRows()
                expect(rows).toHaveLength(1)
                expect(rows[0]).toMatchObject({ respondingRequests: 10, inputTokens: 1_000 })
            } finally {
                await ledger.close()
            }
        } finally {
            await host.stop()
        }
    })
})

function usageOf(taskId: string, index: number): UsageEvent {
    return {
        kind: "usage",
        eventId: `usage:${taskId}:round:${index}`,
        observedAtMs: T0 + 1_000,
        sequence: 1,
        workspaceId: "ws",
        taskId,
        profileId: "profile-a",
        providerId: "provider-a",
        modelId: "model-a",
        keyFingerprint: "fp",
        logicalRequestId: `${taskId}:turn`,
        roundId: `${taskId}:round:${index}`,
        inputTokens: 100,
        outputTokens: 10,
        usageReported: true,
        costComplete: false,
        currencyMixed: false,
        usageQuality: "exact",
    }
}
