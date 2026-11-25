import { readdir } from "node:fs/promises"
import path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect } from "@playwright/test"
import { SqliteUnifyStoreBackend } from "../../../../core/storage/backend/sqlite/SqliteUnifyStore"
import { ApiRequestRoundEntity, toApiRequestRoundEntity } from "../../../../core/task/performance/api-request-round-entity"
import { API_REQUEST_ROUND_SCHEMA_VERSION } from "../../../../core/task/performance/api-request-round-types"
import {
    ApiResponseExecutionEntity,
    toApiResponseExecutionEntity,
} from "../../../../core/task/performance/api-response-execution-entity"
import { API_RESPONSE_EXECUTION_SCHEMA_VERSION } from "../../../../core/task/performance/api-response-execution-types"

const HOUR_MS = 60 * 60 * 1_000

/**
 * Rounds appended after the real request. Each round holds two revisions, so the
 * `hour` window holds twice this many physical rows: far more than the 512-row
 * page the previous implementation ranked per query, while keeping the temporary
 * database small enough for a constrained CI disk.
 */
const SEEDED_ROUNDS = 40_000
/** Seeded rounds span this much of the hour window, ending just before the assertion. */
const SEED_SPAN_MS = 23 * HOUR_MS
/** Rows per physical insert, so seeding never materializes the whole history in memory. */
const INSERT_BATCH = 2_000
/** The dialog must answer well inside the 30 s Webview unary RPC guard. */
const BUDGET_MS = 10_000

/**
 * Append a long history inside the default hour window.
 *
 * Both chart resolutions must be covered: `hour` queries the last 24 hours and
 * `day` the last 30 days, so every seeded row is inside both windows.
 */
async function seedLongHistory(dlineDocsDir: string, taskId: string, nowMs: number): Promise<void> {
    const databasePath = path.join(dlineDocsDir, "tasks", taskId, "metrics.db")
    const database = await new SqliteUnifyStoreBackend().open(databasePath)
    const roundStore = await database.openStore(ApiRequestRoundEntity)
    const executionStore = await database.openStore(ApiResponseExecutionEntity)
    try {
        const stepMs = Math.max(1, Math.floor(SEED_SPAN_MS / SEEDED_ROUNDS))
        for (let offset = 0; offset < SEEDED_ROUNDS; offset += INSERT_BATCH) {
            const batchSize = Math.min(INSERT_BATCH, SEEDED_ROUNDS - offset)
            const rounds: ApiRequestRoundEntity[] = []
            const executions: ApiResponseExecutionEntity[] = []
            for (let index = offset; index < offset + batchSize; index += 1) {
                const completedAtMs = nowMs - SEED_SPAN_MS + index * stepMs
                const roundId = `${taskId}:seed-${index.toString().padStart(6, "0")}:provider:0`
                for (const revision of [0, 1]) {
                    rounds.push(
                        toApiRequestRoundEntity({
                            schemaVersion: API_REQUEST_ROUND_SCHEMA_VERSION,
                            taskId,
                            roundId,
                            revision,
                            logicalRequestId: roundId,
                            apiIndex: index,
                            taskAttempt: 0,
                            providerAttempt: 0,
                            startedAtMs: completedAtMs - 500,
                            completedAtMs,
                            providerDurationMs: 500,
                            status: "completed",
                            inputTokens: 1_000,
                            outputTokens: 100,
                            thoughtsTokens: 0,
                            cacheWriteTokens: 0,
                            cacheReadTokens: 0,
                            cacheUsageReported: false,
                            usageQuality: "exact",
                        }),
                    )
                }
                executions.push(
                    toApiResponseExecutionEntity({
                        schemaVersion: API_RESPONSE_EXECUTION_SCHEMA_VERSION,
                        taskId,
                        executionId: `${taskId}:seed-execution-${index.toString().padStart(6, "0")}`,
                        revision: 0,
                        roundId,
                        logicalRequestId: roundId,
                        apiIndex: index,
                        taskAttempt: 0,
                        providerAttempt: 0,
                        startedAtMs: completedAtMs - 1_000,
                        providerCompletedAtMs: completedAtMs,
                        completedAtMs: completedAtMs + 500,
                        providerDurationMs: 1_000,
                        executionDurationMs: 1_500,
                        status: "completed",
                        terminalKind: "provider_only",
                        toolCount: 0,
                        completedToolCount: 0,
                        failedToolCount: 0,
                        cancelledToolCount: 0,
                    }),
                )
            }
            await roundStore.insert(rounds)
            await executionStore.insert(executions)
        }
    } finally {
        await roundStore.close()
        await executionStore.close()
        await database.close()
    }
}

async function onlyTaskId(dlineDocsDir: string): Promise<string> {
    return E2ETestHelper.waitForValue(async () => {
        const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true }).catch(() => [])
        const taskIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
        return taskIds.length === 1 ? taskIds[0] : undefined
    }, 30_000)
}

e2e(
    "API rate history answers an hour and a day window far larger than one page within the RPC budget",
    async ({ sidebar, server, dlineDocsDir, userDataDir }) => {
        e2e.setTimeout(300_000)
        const marks: Array<[string, number]> = []
        let lastMarkMs = Date.now()
        const mark = (label: string): void => {
            const now = Date.now()
            marks.push([label, now - lastMarkMs])
            lastMarkMs = now
        }
        server.resetOpenAiMock()
        // Usage keeps the header metric pill available, exactly as a real conversation does.
        server.enqueueOpenAiResponses({
            type: "message",
            text: "E2E_RATE_HISTORY_READY",
            usage: { inputTokens: 1_200, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 100 },
        })

        const input = sidebar.getByTestId("chat-input")
        await expect(input).toBeEnabled({ timeout: 30_000 })
        await input.fill("E2E_RATE_HISTORY_SEED_TASK")
        await sidebar.getByTestId("send-button").click()
        await expect(sidebar.getByText("E2E_RATE_HISTORY_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
        mark("realRequest")

        const taskId = await onlyTaskId(dlineDocsDir)
        // Grow the Task's recorded history the way a very long conversation would.
        await seedLongHistory(dlineDocsDir, taskId, Date.now())
        mark("seedDatabase")

        const rate = sidebar.getByTestId("task-rate-metrics")
        await expect(rate).toBeVisible({ timeout: 60_000 })
        await rate.click()

        const dialog = sidebar.getByRole("dialog", { name: "API Rate History" })
        await expect(dialog).toBeVisible({ timeout: 30_000 })
        mark("openDialog")

        // The chart renders only from a successful read, so the budget covers the whole
        // round trip that previously ran one ranking query per page.
        const chart = dialog.getByRole("img", { name: "Task metrics history chart", exact: true })
        await expect(chart).toBeVisible({ timeout: BUDGET_MS })
        await expect(dialog.getByText("No API activity in this range.")).toHaveCount(0)
        mark("hourWindowQuery")

        await dialog.getByRole("combobox", { name: "History resolution" }).selectOption("day")
        await expect(chart).toBeVisible({ timeout: BUDGET_MS })
        await expect(dialog.getByText("No API activity in this range.")).toHaveCount(0)
        mark("dayWindowQuery")

        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        mark("errorScan")
        console.log(`[rate-history-timing] ${marks.map(([label, ms]) => `${label}=${ms}ms`).join(" ")}`)
    },
)
