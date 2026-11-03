import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { readTaskUiMessages, rewriteTaskUiMessages, waitForTaskRelease } from "@e2e/utils/task-instance-store"
import { expect, type Frame, type TestInfo } from "@playwright/test"
import type { UiMessage } from "@shared/ExtensionMessage"
import type { ElectronApplication } from "playwright"

interface RecordedRound {
    roundId: string
    revision: number
    providerDurationMs: number
    inputTokens: number | null
    outputTokens: number | null
    status: string
}

async function configureMessageFolding(dlineDir: string): Promise<void> {
    const settingsPath = path.join(dlineDir, "data", "settings", "settings.json")
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>
    settings.aggressiveRendering = "message_segment"
    settings.enableCheckpointsSetting = true
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8")
}

async function openSidebar(app: ElectronApplication, helper: E2ETestHelper): Promise<Frame> {
    const page = await app.firstWindow()
    await E2ETestHelper.openClineSidebar(page)
    const sidebar = await helper.getSidebar(page)
    await E2ETestHelper.dismissWhatsNewModal(sidebar)
    await helper.signin(sidebar)
    return sidebar
}

async function send(sidebar: Frame, text: string): Promise<void> {
    const input = sidebar.getByTestId("chat-input")
    await expect(input).toBeEnabled({ timeout: 30_000 })
    await input.fill(text)
    await input.press("Enter")
}

async function onlyTaskId(docs: string): Promise<string> {
    return E2ETestHelper.waitForValue(async () => {
        const entries = await readdir(path.join(docs, "tasks"), { withFileTypes: true }).catch(() => [])
        const ids = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
        return ids.length === 1 ? ids[0] : undefined
    }, 30_000)
}

async function closeTask(sidebar: Frame, docs: string, taskId: string): Promise<void> {
    await sidebar.getByRole("button", { name: "Close Task", exact: true }).click()
    await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toHaveCount(0)
    await waitForTaskRelease(docs, taskId)
}

async function reopen(sidebar: Frame, task: string): Promise<void> {
    await E2ETestHelper.dismissWhatsNewModal(sidebar)
    await sidebar.getByText(task, { exact: true }).last().click()
    await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(sidebar.locator("[data-row-ts]").first()).toBeAttached({ timeout: 30_000 })
}

function say(ts: number, kind: UiMessage["say"], text = "", extra: Partial<UiMessage> = {}): UiMessage {
    return { ts, type: "say", say: kind, text, ...extra }
}

function request(ts: number, completed = true): UiMessage {
    return say(ts, "api_req_started", JSON.stringify({ request: "bug264", ...(completed ? { cost: 0.01 } : {}) }))
}

function checkpoint(ts: number): UiMessage {
    return say(ts, "checkpoint_created", "", { lastCheckpointHash: ["bug264-tree"] })
}

function readCall(ts: number, file: string): UiMessage {
    return say(ts, "tool", JSON.stringify({ tool: "readFile", path: file }), { partial: false })
}

function bulkTranscript(base: number, task: string): UiMessage[] {
    const command = (offset: number): UiMessage => ({
        ts: base + offset,
        type: "say",
        say: "command",
        text: `echo bug264-${offset}`,
        commandStatus: "completed",
        exitCode: 0,
    })
    return [
        say(base, "task", task),
        request(base + 1),
        command(2),
        say(base + 3, "tool", JSON.stringify({ tool: "actModeRespond", content: "BUG264_BOUNDARY" })),
        request(base + 4),
        command(5),
        { ts: base + 6, type: "ask", ask: "qna_respond", text: "BUG264_BULK_END", partial: false },
    ]
}

/** Read only the isolated test Task's actual, latest persisted Provider rounds. */
function recordedRounds(docs: string, taskId: string): RecordedRound[] {
    const file = path.join(docs, "tasks", taskId, "metrics.db")
    let database: DatabaseSync | undefined
    try {
        database = new DatabaseSync(file, { readOnly: true })
        const registry = database
            .prepare("SELECT physical_name FROM entity_schema_registry WHERE schema_id = ?")
            .get("api-request-round-flat") as { physical_name: string } | undefined
        if (!registry) return []
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(registry.physical_name)) throw new Error("Invalid metrics table identifier")
        const rows = database
            .prepare(
                `SELECT "roundId", "revision", "providerDurationMs", "inputTokens", "outputTokens", "status" FROM "${registry.physical_name}" ORDER BY "completedAtMs", "revision"`,
            )
            .all() as unknown as RecordedRound[]
        const latest = new Map<string, RecordedRound>()
        for (const row of rows) {
            if (row.revision >= (latest.get(row.roundId)?.revision ?? -1)) latest.set(row.roundId, row)
        }
        return [...latest.values()]
    } catch (error) {
        if (String(error).includes("unable to open database file")) return []
        throw error
    } finally {
        database?.close()
    }
}

async function observeRoundResponses(sidebar: Frame): Promise<void> {
    await sidebar.evaluate(() => {
        document.documentElement.dataset.bug264RoundResponses = "[]"
        const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
        window.addEventListener("message", (event: MessageEvent<unknown>) => {
            if (!record(event.data) || event.data.type !== "grpc_response" || !record(event.data.grpc_response)) return
            const response = event.data.grpc_response
            if (response.error || !record(response.message)) return
            const payload = response.message
            if (!Array.isArray(payload.points) || typeof payload.taskInstanceId !== "string") return
            const previous = JSON.parse(document.documentElement.dataset.bug264RoundResponses ?? "[]") as unknown[]
            document.documentElement.dataset.bug264RoundResponses = JSON.stringify([...previous.slice(-9), payload])
        })
    })
}

async function roundResponses(sidebar: Frame): Promise<Array<{ taskInstanceId: string; points: unknown[] }>> {
    return sidebar.evaluate(() => JSON.parse(document.documentElement.dataset.bug264RoundResponses ?? "[]"))
}

function usageNumbers(text: string) {
    const duration = /(?:^| · )~?(\d+(?:\.\d+)?)(ms|s)(?: · |$)/.exec(text)
    const tokens = /~?(\d+(?:\.\d+)?)([kM]?) in \/ ~?(\d+(?:\.\d+)?)([kM]?) out/.exec(text)
    const rate = /(?:^| · )~?(\d+) tok\/s(?: · |$)/.exec(text)
    const tokenValue = (value: string, suffix: string) =>
        Number(value) * (suffix === "M" ? 1_000_000 : suffix === "k" ? 1_000 : 1)
    return {
        durationMs: duration ? Number(duration[1]) * (duration[2] === "s" ? 1000 : 1) : undefined,
        input: tokens ? tokenValue(tokens[1], tokens[2]) : undefined,
        output: tokens ? tokenValue(tokens[3], tokens[4]) : undefined,
        tps: rate ? Number(rate[1]) : undefined,
    }
}

async function evidence(sidebar: Frame, testInfo: TestInfo, details: object): Promise<void> {
    const evidencePath = testInfo.outputPath("message-folding-evidence.json")
    await writeFile(
        evidencePath,
        `${JSON.stringify({ ...details, responses: await roundResponses(sidebar) }, null, 2)}\n`,
        "utf8",
    )
    await testInfo.attach("message-folding-evidence", { path: evidencePath, contentType: "application/json" })
    const screenshotPath = testInfo.outputPath("message-folding-screen.png")
    await sidebar.page().screenshot({ path: screenshotPath })
    await testInfo.attach("message-folding-screen", { path: screenshotPath, contentType: "image/png" })
}

e2e("BUG264 B01 - mixed bulk", async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, workspaceDir }, testInfo) => {
    e2e.setTimeout(120_000)
    await configureMessageFolding(dlineDir)
    server.resetOpenAiMock()
    server.enqueueOpenAiResponses({ type: "tool", name: "qna_respond", arguments: { response: "BUG264_BULK_SEED" } })
    const app = await openVSCode(workspaceDir, { DLINE_EXPERIMENTAL_AGGRESSIVE_RENDERING: "true" })
    try {
        const sidebar = await openSidebar(app, helper)
        const task = "BUG264_BULK_TASK"
        await send(sidebar, task)
        await expect(sidebar.getByText("BUG264_BULK_SEED", { exact: true })).toBeVisible({ timeout: 60_000 })
        const taskId = await onlyTaskId(dlineDocsDir)
        await closeTask(sidebar, dlineDocsDir, taskId)
        await rewriteTaskUiMessages(dlineDocsDir, taskId, () => bulkTranscript(Date.now(), task))
        await reopen(sidebar, task)
        const headers = sidebar.getByTestId("activity-fold-header")
        await expect(headers).toHaveCount(2)
        await headers.first().click()
        await expect(headers.first()).toHaveAttribute("aria-expanded", "true")
        await expect(headers.last()).toHaveAttribute("aria-expanded", "false")
        await sidebar.getByRole("button", { name: "Expand all activity", exact: true }).click()
        await evidence(sidebar, testInfo, {
            states: await headers.evaluateAll((items) => items.map((item) => item.getAttribute("aria-expanded"))),
        })
        for (const header of await headers.all()) await expect(header).toHaveAttribute("aria-expanded", "true")
        await sidebar.getByRole("button", { name: "Collapse all activity", exact: true }).click()
        for (const header of await headers.all()) await expect(header).toHaveAttribute("aria-expanded", "false")
        await expect(sidebar.getByTestId("activity-fold-children")).toHaveCount(0)
    } finally {
        await app.close()
    }
})

e2e("BUG264 B02 - live read", async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, workspaceDir }, testInfo) => {
    e2e.setTimeout(150_000)
    await configureMessageFolding(dlineDir)
    await writeFile(path.join(workspaceDir, "fold-first.txt"), "BUG264_FIRST_READ\n", "utf8")
    await writeFile(path.join(workspaceDir, "fold-second.txt"), "BUG264_SECOND_READ\n", "utf8")
    server.resetOpenAiMock()
    server.enqueueOpenAiResponses(
        {
            type: "tool",
            id: "bug264_read_first",
            name: "read_file",
            arguments: { path: "fold-first.txt" },
            usage: { inputTokens: 200, outputTokens: 100 },
        },
        {
            type: "tool",
            id: "bug264_read_second",
            name: "read_file",
            arguments: { path: "fold-second.txt" },
            holdUntilReleased: "bug264-second-read",
            afterChatContentDelayMs: 25_000,
            expectedToolResults: [{ callId: "bug264_read_first", contentIncludes: "BUG264_FIRST_READ" }],
        },
        { type: "tool", name: "qna_respond", arguments: { response: "BUG264_READS_DONE" } },
    )
    const app = await openVSCode(workspaceDir, { DLINE_EXPERIMENTAL_AGGRESSIVE_RENDERING: "true" })
    try {
        const sidebar = await openSidebar(app, helper)
        await send(sidebar, "BUG264_LIVE_READ_TASK")
        const taskId = await onlyTaskId(dlineDocsDir)
        await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(2)
        const firstFold = sidebar.getByTestId("activity-fold").first()
        await expect(firstFold).toBeVisible({ timeout: 30_000 })
        const foldId = await firstFold.getAttribute("data-fold-id")
        expect(foldId).not.toBeNull()
        server.releaseResponseGate("bug264-second-read")
        await expect
            .poll(
                async () =>
                    (await readTaskUiMessages(dlineDocsDir, taskId)).some((message) => {
                        if (message.partial !== true || (message.say !== "tool" && message.ask !== "tool")) return false
                        try {
                            const tool = JSON.parse(message.text ?? "{}") as { tool?: string; path?: string }
                            return tool.tool === "readFile" && tool.path?.endsWith("fold-second.txt") === true
                        } catch {
                            return false
                        }
                    }),
                { timeout: 30_000 },
            )
            .toBe(true)
        await evidence(sidebar, testInfo, { taskId, foldId, messages: await readTaskUiMessages(dlineDocsDir, taskId) })
        const preserved = sidebar.locator(`[data-fold-id="${foldId}"]`)
        await expect(preserved).toHaveCount(1)
        await expect(preserved.getByTestId("activity-fold-header")).toHaveAttribute("aria-expanded", "false")
        await expect(preserved.getByTestId("activity-fold-children")).toHaveCount(0)
        await expect(sidebar.getByText("BUG264_READS_DONE", { exact: true })).toBeVisible({ timeout: 60_000 })
        expect(server.getMockConsumptions("openai-compatible-chat").every((item) => item.contractError === undefined)).toBe(true)
    } finally {
        await app.close()
    }
})

e2e("BUG264 B03 - live TPS", async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, workspaceDir }, testInfo) => {
    e2e.setTimeout(150_000)
    await configureMessageFolding(dlineDir)
    server.resetOpenAiMock()
    server.enqueueOpenAiResponses(
        {
            type: "tool",
            id: "bug264_command",
            name: "execute_command",
            arguments: {
                command: "node -e \"console.log('BUG264_COMMAND_RESULT')\"",
                requires_approval: false,
                synchronous: true,
            },
            holdUntilReleased: "bug264-first-request",
            usage: { inputTokens: 1200, outputTokens: 300 },
        },
        {
            type: "tool",
            name: "qna_respond",
            arguments: { response: "BUG264_METRICS_DONE" },
            usage: { inputTokens: 1400, outputTokens: 400 },
            expectedToolResults: [{ callId: "bug264_command", contentIncludes: "BUG264_COMMAND_RESULT" }],
        },
    )
    const app = await openVSCode(workspaceDir, { DLINE_EXPERIMENTAL_AGGRESSIVE_RENDERING: "true" })
    try {
        const sidebar = await openSidebar(app, helper)
        await observeRoundResponses(sidebar)
        await send(sidebar, "BUG264_LIVE_METRICS_TASK")
        const taskId = await onlyTaskId(dlineDocsDir)
        await expect.poll(() => roundResponses(sidebar), { timeout: 30_000 }).not.toEqual([])
        const opening = (await roundResponses(sidebar))[0].taskInstanceId
        server.releaseResponseGate("bug264-first-request")
        const approve = sidebar.getByText("Approve", { exact: true })
        const done = sidebar.getByText("BUG264_METRICS_DONE", { exact: true })
        await expect(approve.or(done)).toBeVisible({ timeout: 60_000 })
        if (await approve.isVisible()) await approve.click()
        await expect(done).toBeVisible({ timeout: 60_000 })
        await expect
            .poll(() => recordedRounds(dlineDocsDir, taskId).filter((round) => round.outputTokens !== null).length)
            .toBe(2)
        const rounds = recordedRounds(dlineDocsDir, taskId)
        const measured = rounds.find((round) => round.outputTokens === 300)
        expect(measured?.providerDurationMs).toBeGreaterThan(0)
        await evidence(sidebar, testInfo, {
            taskId,
            opening,
            rounds,
            requests: (await readTaskUiMessages(dlineDocsDir, taskId)).filter((message) => message.say === "api_req_started"),
        })
        const capsule = sidebar.getByTestId("activity-fold-usage").first()
        await expect(capsule).toBeVisible({ timeout: 15_000 })
        const figures = usageNumbers(await capsule.innerText())
        expect(figures.input).toBe(1200)
        expect(figures.output).toBe(300)
        expect(figures.tps).toBe(Math.round(300_000 / (measured?.providerDurationMs ?? 1)))
        expect(Math.abs((figures.durationMs ?? 0) - (measured?.providerDurationMs ?? 0))).toBeLessThanOrEqual(100)
        expect((await roundResponses(sidebar)).every((response) => response.taskInstanceId === opening)).toBe(true)
        expect(server.getMockConsumptions("openai-compatible-chat").every((item) => item.contractError === undefined)).toBe(true)
    } finally {
        await app.close()
    }
})

e2e.describe("BUG264 recorded usage after History metrics readiness", () => {
    // In the one-shot RED implementation query 2 is the History query. Keep this
    // finite delay in GREEN as a real-response ordering fault, not a metrics mock.
    e2e.use({
        grpcUnaryFaults: JSON.stringify({
            action: "delayRequest",
            service: "dline.TaskService",
            method: "getTaskRateMetrics",
            occurrence: 2,
            delayMs: 1000,
            markerName: "bug264-history-metrics-ready",
        }),
    })

    e2e("BUG264 B04 - recorded TPS", async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, workspaceDir }, testInfo) => {
        e2e.setTimeout(120_000)
        await configureMessageFolding(dlineDir)
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses({
            type: "tool",
            name: "qna_respond",
            arguments: { response: "BUG264_RECORDED_SEED" },
            usage: { inputTokens: 200, outputTokens: 100 },
            delayMs: 250,
        })
        const app = await openVSCode(workspaceDir, { DLINE_EXPERIMENTAL_AGGRESSIVE_RENDERING: "true" })
        try {
            const sidebar = await openSidebar(app, helper)
            const task = "BUG264_RECORDED_TASK"
            await send(sidebar, task)
            await expect(sidebar.getByText("BUG264_RECORDED_SEED", { exact: true })).toBeVisible({ timeout: 60_000 })
            const taskId = await onlyTaskId(dlineDocsDir)
            await expect.poll(() => recordedRounds(dlineDocsDir, taskId).some((round) => round.outputTokens === 100)).toBe(true)
            const measured = recordedRounds(dlineDocsDir, taskId).find((round) => round.outputTokens === 100)
            expect(measured?.providerDurationMs).toBeGreaterThan(0)
            await closeTask(sidebar, dlineDocsDir, taskId)
            const base = Date.now()
            await rewriteTaskUiMessages(dlineDocsDir, taskId, () => [
                say(base, "task", task),
                checkpoint(base + 1),
                request(base + 2),
                readCall(base + 3, "README.md"),
                checkpoint(base + 4),
                request(base + 5, false),
            ])
            await observeRoundResponses(sidebar)
            await reopen(sidebar, task)
            await expect(sidebar.getByTestId("activity-fold-header")).toHaveCount(1, { timeout: 30_000 })
            await expect
                .poll(async () => (await roundResponses(sidebar)).some((response) => response.points.length > 0))
                .toBe(true)
            await evidence(sidebar, testInfo, { taskId, rounds: recordedRounds(dlineDocsDir, taskId) })
            const capsule = sidebar.getByTestId("activity-fold-usage")
            await expect(capsule).toBeVisible({ timeout: 10_000 })
            const figures = usageNumbers(await capsule.innerText())
            expect(figures.input).toBe(200)
            expect(figures.output).toBe(100)
            expect(figures.tps).toBe(Math.round(100_000 / (measured?.providerDurationMs ?? 1)))
            expect(server.openAiRequestCount).toBe(1)
        } finally {
            await app.close()
        }
    })
})
