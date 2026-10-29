import { readdir } from "node:fs/promises"
import path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { readExtensionHostRuntimeHealth } from "@e2e/utils/task-history-control-client"
import { pauseTaskBetweenTurns } from "@e2e/utils/task-instance-store"
import { expect, type Frame, type Page } from "@playwright/test"
import type { ElectronApplication } from "playwright"
import { InstanceDatabase, openInstanceStorage } from "@/core/storage/instance"
import type { JournalEntry } from "@/core/task/stores"
import { openTaskJournalStores } from "@/core/task/stores"
import { encodeTaskPayload } from "@/core/task/stores/payload/TaskPayloadCodec"
import { JournalEntryRow } from "@/core/task/stores/sqlite/entities"

const TASK_TEXT = "E2E_LONG_JOURNAL_REQUEST_TASK"
const READY_MARKER = "E2E_LONG_JOURNAL_READY"
const FOLLOW_UP = "E2E_LONG_JOURNAL_FOLLOW_UP"
const SUMMARY_MARKER = "E2E_LONG_JOURNAL_COMPACTED_SUMMARY"
const COMPLETION_MARKER = "E2E_LONG_JOURNAL_COMPLETE"
const JOURNAL_MESSAGE_COUNT = 30_000
const MAX_EVENT_LOOP_DELAY_MS = 250
const MAX_REQUEST_ELAPSED_MS = 30_000

async function openSidebar(app: ElectronApplication, helper: E2ETestHelper): Promise<{ page: Page; sidebar: Frame }> {
    const page = await app.firstWindow()
    await E2ETestHelper.openClineSidebar(page)
    const sidebar = await helper.getSidebar(page)
    await E2ETestHelper.dismissWhatsNewModal(sidebar)
    await helper.signin(sidebar)
    return { page, sidebar }
}

async function submit(sidebar: Frame, text: string): Promise<void> {
    const input = sidebar.getByTestId("chat-input")
    await expect(input).toBeEnabled({ timeout: 30_000 })
    await input.fill(text)
    await input.press("Enter")
    await expect(sidebar.getByText(text, { exact: true }).last()).toBeVisible({ timeout: 30_000 })
}

async function closeTask(sidebar: Frame): Promise<void> {
    const close = sidebar.getByRole("button", { name: "Close Task", exact: true })
    await expect(close).toBeVisible({ timeout: 30_000 })
    await close.click()
    await expect(sidebar.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 })
}

async function onlyTaskId(dlineDocsDir: string): Promise<string> {
    return await E2ETestHelper.waitForValue(async () => {
        const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true }).catch(() => [])
        const ids = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
        return ids.length === 1 ? ids[0] : undefined
    }, 30_000)
}

async function reopen(page: Page, sidebar: Frame): Promise<void> {
    await page.getByRole("button", { name: "History", exact: true }).click()
    const item = sidebar.locator(".history-preview-item, .history-item").filter({ hasText: TASK_TEXT })
    await expect(item).toHaveCount(1, { timeout: 60_000 })
    await item.click()
    await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({ timeout: 60_000 })
    await expect(sidebar.getByTestId("send-button")).toHaveAttribute("data-action", /^(?:send|resume)$/, { timeout: 60_000 })
}

async function seedCompactedLongJournal(dlineDocsDir: string, taskId: string): Promise<void> {
    const root = path.join(dlineDocsDir, "tasks", taskId)
    const storage = openInstanceStorage(root)
    try {
        const database = await storage.openDatabase(InstanceDatabase.Journal, "e2e-long-journal-writer")
        const stores = await openTaskJournalStores(database)
        const entryStore = await database.openStore(JournalEntryRow)
        const userRef = await stores.payloads.put(
            encodeTaskPayload({ kind: "api_history_message", message: { role: "user", content: "seeded user" } }),
        )
        const assistantRef = await stores.payloads.put(
            encodeTaskPayload({ kind: "api_history_message", message: { role: "assistant", content: "seeded answer" } }),
        )
        const summaryRef = await stores.payloads.put(
            encodeTaskPayload({ kind: "compaction_summary", compactionId: "e2e-long-journal", text: SUMMARY_MARKER }),
        )
        let seq = stores.journal.watermark().seq
        const rows: JournalEntryRow[] = []
        if (seq > 0) {
            rows.push(
                JournalEntryRow.fromEntry({
                    version: 1,
                    watermark: { seq: ++seq },
                    operationId: "e2e-long-journal:rewind",
                    kind: "rewind",
                    target: { seq: 0 },
                }),
            )
        }
        const first = seq + 1
        for (let index = 0; index < JOURNAL_MESSAGE_COUNT; index++) {
            const entry: JournalEntry = {
                version: 1,
                watermark: { seq: ++seq },
                operationId: `e2e-long-journal:message:${index}`,
                kind: "message",
                payloadRef: index % 2 === 0 ? userRef : assistantRef,
                source: index % 2 === 0 ? "intake" : "provider",
            }
            rows.push(JournalEntryRow.fromEntry(entry))
        }
        rows.push(
            JournalEntryRow.fromEntry({
                version: 1,
                watermark: { seq: ++seq },
                operationId: "e2e-long-journal:summary",
                kind: "supersede_range",
                range: { from: { seq: first }, to: { seq: first + JOURNAL_MESSAGE_COUNT - 1 } },
                payloadRef: summaryRef,
                source: "system",
            }),
        )
        await entryStore.insert(rows)
    } finally {
        await storage.close()
    }
    await pauseTaskBetweenTurns(dlineDocsDir, taskId)
}

function startHealthSampler(controlDirectory: string) {
    let stopped = false
    const samples: Awaited<ReturnType<typeof readExtensionHostRuntimeHealth>>[] = []
    const run = (async () => {
        while (!stopped) {
            samples.push(await readExtensionHostRuntimeHealth(controlDirectory))
            await new Promise((resolve) => setTimeout(resolve, 25))
        }
    })()
    return {
        samples,
        async stop() {
            stopped = true
            await run
        },
    }
}

e2e(
    "A compacted 30k-entry journal sends the next request without starving the extension host",
    async ({ dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }, testInfo) => {
        e2e.setTimeout(300_000)
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses(
            { type: "tool", id: "call_long_journal_ready", name: "qna_respond", arguments: { response: READY_MARKER } },
            {
                type: "tool",
                id: "call_long_journal_complete",
                name: "attempt_completion",
                arguments: { result: COMPLETION_MARKER },
                expectedRequestIncludes: [SUMMARY_MARKER, FOLLOW_UP],
            },
        )

        let taskId: string
        const firstApp = await openVSCode(workspaceDir)
        try {
            const { sidebar } = await openSidebar(firstApp, helper)
            await submit(sidebar, TASK_TEXT)
            await expect(sidebar.getByText(READY_MARKER, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            taskId = await onlyTaskId(dlineDocsDir)
            await closeTask(sidebar)
        } finally {
            await firstApp.close()
        }

        await seedCompactedLongJournal(dlineDocsDir, taskId)
        const controlDirectory = path.join(userDataDir, "task-history-control")
        const resumedApp = await openVSCode(workspaceDir, { DLINE_E2E_TASK_HISTORY_CONTROL_DIR: controlDirectory })
        try {
            const { page, sidebar } = await openSidebar(resumedApp, helper)
            await reopen(page, sidebar)
            const sampler = startHealthSampler(controlDirectory)
            const startedAt = performance.now()
            try {
                await submit(sidebar, FOLLOW_UP)
                await expect(sidebar.getByText(COMPLETION_MARKER, { exact: true }).last()).toBeVisible({ timeout: 60_000 })
            } finally {
                await sampler.stop()
            }
            const elapsedMs = performance.now() - startedAt
            const maxEventLoopDelayMs = Math.max(0, ...sampler.samples.map((sample) => sample.eventLoopDelayMs))
            const evidence = {
                journalEntries: JOURNAL_MESSAGE_COUNT,
                elapsedMs,
                maxEventLoopDelayMs,
                sampleCount: sampler.samples.length,
            }
            console.log(`[long-journal-request-liveness] ${JSON.stringify(evidence)}`)
            await testInfo.attach("long-journal-request-liveness.json", {
                body: Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8"),
                contentType: "application/json",
            })

            expect(elapsedMs).toBeLessThan(MAX_REQUEST_ELAPSED_MS)
            expect(maxEventLoopDelayMs).toBeLessThan(MAX_EVENT_LOOP_DELAY_MS)
            expect(sampler.samples.length).toBeGreaterThan(0)
            expect(server.getMockConsumptions().map((item) => item.contractError)).toEqual([undefined, undefined])
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await resumedApp.close()
        }
    },
)
