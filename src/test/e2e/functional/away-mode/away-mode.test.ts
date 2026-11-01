import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { expectComposerText } from "@e2e/utils/composer"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Page } from "@playwright/test"
import { InstanceDatabase, openInstanceStorage } from "@/core/storage/instance"
import { openTaskJournalStores } from "@/core/task/stores"
import { decodeTaskPayload } from "@/core/task/stores/payload/TaskPayloadCodec"
import type { RoundNoticeEnvelope, RoundPreparedEnvelope } from "@/core/task/stores/payload/TaskPayloadEnvelopes"

async function openSettings(page: Page, sidebar: Frame) {
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    await sidebar.getByTestId("tab-features").click()
    await expect(sidebar.getByRole("heading", { name: "Feature Settings" })).toBeVisible()
}

async function enableAway(page: Page, sidebar: Frame) {
    await openSettings(page, sidebar)
    const main = sidebar.getByRole("switch", { name: "Enable Away Mode", exact: true })
    await expect(main).toHaveAttribute("aria-checked", "false")
    await main.click()
    await expect(main).toHaveAttribute("aria-checked", "true")
    await sidebar.getByRole("button", { name: "Done", exact: true }).click()
}

async function singleTaskId(docs: string) {
    const ids = (await readdir(path.join(docs, "tasks"), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    expect(ids).toHaveLength(1)
    return ids[0]
}

/** Read only; the extension remains the journal's sole writer. */
async function roundEvidence(docs: string, taskId: string) {
    const storage = openInstanceStorage(path.join(docs, "tasks", taskId))
    try {
        const stores = await openTaskJournalStores(await storage.openDatabase(InstanceDatabase.Journal, "away-e2e-reader"))
        const rounds: RoundPreparedEnvelope[] = []
        const notices: RoundNoticeEnvelope[] = []
        for (const entry of await stores.journal.read()) {
            if (!entry.payloadRef) continue
            const payload = decodeTaskPayload<{ kind: string }>(await stores.payloads.read(entry.payloadRef))
            if (payload.kind === "round_prepared") rounds.push(payload as RoundPreparedEnvelope)
            if (payload.kind === "round_notice") notices.push(payload as RoundNoticeEnvelope)
        }
        return { rounds, notices }
    } finally {
        await storage.close()
    }
}

function expectIndependentExit(body: unknown, notice: RoundNoticeEnvelope) {
    const messages = (body as { messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }> })
        .messages
    // The persisted notice must cross the provider boundary as its own user text
    // block, rather than being merged into a tool result or an environment block.
    const matches = messages.filter(
        (message) =>
            message.role === "user" &&
            (typeof message.content === "string"
                ? message.content === notice.text
                : message.content.length === 1 && message.content[0].type === "text" && message.content[0].text === notice.text),
    )
    expect(matches).toHaveLength(1)
}

e2e(
    "Away - Settings enable, automatic feedback, Stop preserves a running command and unsent draft, then normal questions wait",
    async ({ helper, openVSCode, workspaceDir, dlineDocsDir, server, userDataDir }) => {
        e2e.setTimeout(180_000)
        server.resetOpenAiMock()
        const command =
            "node -e \"require('fs').writeFileSync('away-running.txt','started');setTimeout(()=>console.log('E2E_AWAY_COMMAND_FINISHED'),10000)\""
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                id: "away-question",
                name: "ask_followup_question",
                arguments: { question: "E2E_AWAY_AUTOMATIC_QUESTION" },
            },
            {
                type: "tool",
                id: "away-command",
                name: "execute_command",
                arguments: { command, workdirectory: ".", requires_approval: true, synchronous: true, timeout: 30 },
            },
            {
                type: "tool",
                id: "normal-question",
                name: "ask_followup_question",
                arguments: { question: "E2E_AWAY_NORMAL_QUESTION" },
                expectedToolResults: [{ callId: "away-command", contentIncludes: "E2E_AWAY_COMMAND_FINISHED" }],
            },
            { type: "tool", id: "normal-done", name: "attempt_completion", arguments: { result: "E2E_AWAY_NORMAL_DONE" } },
        )
        const app = await openVSCode(workspaceDir, { DLINE_EXPERIMENTAL_AWAY_MODE: "true" })
        try {
            const page = await app.firstWindow()
            await E2ETestHelper.openClineSidebar(page)
            const sidebar = await helper.getSidebar(page)
            await E2ETestHelper.dismissWhatsNewModal(sidebar)
            await helper.signin(sidebar)
            await enableAway(page, sidebar)
            const input = sidebar.getByTestId("chat-input")
            await input.fill("/away E2E_AWAY_TASK")
            await sidebar.getByTestId("send-button").click()
            // This marker is written by the real running command; no Approve click
            // precedes it even though requires_approval was true.
            await expect
                .poll(async () => readFile(path.join(workspaceDir, "away-running.txt"), "utf8").catch(() => ""), {
                    timeout: 60_000,
                })
                .toBe("started")
            const stop = sidebar.locator('vscode-button[aria-label="Stop Away Mode"]')
            await expect(stop).toBeVisible()
            await input.fill("E2E_AWAY_UNSENT_DRAFT")
            await stop.click()
            await expect(stop).toHaveCount(0)
            await expectComposerText(input, "E2E_AWAY_UNSENT_DRAFT")
            await expect(sidebar.getByText("E2E_AWAY_NORMAL_QUESTION", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            expect(server.openAiRequestCount).toBe(3)
            const taskId = await singleTaskId(dlineDocsDir)
            const evidence = await roundEvidence(dlineDocsDir, taskId)
            expect(evidence.rounds.at(-1)?.draft.materialPlan).toMatchObject({ notices: [{ reason: "stopped" }] })
            expect(evidence.rounds.at(-1)?.draft.materialPlan?.activeAway).toBeUndefined()
            expect(evidence.notices).toHaveLength(1)
            const requests = server.getMockConsumptions("openai-compatible-chat")
            expect(requests.map((r) => r.toolName)).toEqual(["ask_followup_question", "execute_command", "ask_followup_question"])
            expect(requests.every((r) => r.contractError === undefined)).toBe(true)
            expectIndependentExit(requests[2].requestBody, evidence.notices[0])
            expect(requests[1].requestToolResults.map((r) => r.callId)).toEqual(["away-question"])
            await input.fill("E2E_AWAY_NORMAL_REPLY")
            await input.press("Enter")
            await expect(sidebar.getByText("E2E_AWAY_NORMAL_DONE", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            expect(server.openAiRequestCount).toBe(4)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Away - disabling the master revokes the current mode without cancelling the in-flight request or changing automatic preference",
    async ({ helper, openVSCode, workspaceDir, dlineDocsDir, server, userDataDir }) => {
        e2e.setTimeout(180_000)
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses(
            { type: "tool", id: "away-first", name: "qna_respond", arguments: { response: "E2E_AWAY_FIRST" } },
            {
                type: "tool",
                id: "normal-qna",
                name: "qna_respond",
                arguments: { response: "E2E_AWAY_REVOKED_WAIT" },
                delayMs: 12_000,
            },
            { type: "tool", id: "revoked-done", name: "attempt_completion", arguments: { result: "E2E_AWAY_REVOKED_DONE" } },
        )
        const app = await openVSCode(workspaceDir, { DLINE_EXPERIMENTAL_AWAY_MODE: "true" })
        try {
            const page = await app.firstWindow()
            await E2ETestHelper.openClineSidebar(page)
            const sidebar = await helper.getSidebar(page)
            await E2ETestHelper.dismissWhatsNewModal(sidebar)
            await helper.signin(sidebar)
            await enableAway(page, sidebar)
            await openSettings(page, sidebar)
            await sidebar.getByRole("switch", { name: "Automatic Away Mode", exact: true }).click()
            await expect(sidebar.getByRole("switch", { name: "Automatic Away Mode", exact: true })).toHaveAttribute(
                "aria-checked",
                "true",
            )
            await sidebar.getByRole("button", { name: "Done", exact: true }).click()
            await sidebar.getByTestId("chat-input").fill("/away E2E_AWAY_REVOKE_TASK")
            await sidebar.getByTestId("send-button").click()
            await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(2)
            await openSettings(page, sidebar)
            await sidebar.getByRole("switch", { name: "Enable Away Mode", exact: true }).click()
            await expect(sidebar.getByRole("switch", { name: "Automatic Away Mode", exact: true })).toBeDisabled()
            await expect(sidebar.getByRole("switch", { name: "Automatic Away Mode", exact: true })).toHaveAttribute(
                "aria-checked",
                "true",
            )
            await sidebar.getByRole("button", { name: "Done", exact: true }).click()
            await expect(sidebar.locator('vscode-button[aria-label="Stop Away Mode"]')).toHaveCount(0)
            await expect(sidebar.getByText("E2E_AWAY_REVOKED_WAIT", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            const waiting = server.getMockConsumptions("openai-compatible-chat")
            expect(waiting).toHaveLength(2)
            expect(waiting[1].abortedAtMs).toBeUndefined()
            await sidebar.getByTestId("chat-input").fill("E2E_AWAY_REVOKED_REPLY")
            await sidebar.getByTestId("chat-input").press("Enter")
            await expect(sidebar.getByText("E2E_AWAY_REVOKED_DONE", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            const evidence = await roundEvidence(dlineDocsDir, await singleTaskId(dlineDocsDir))
            expect(evidence.rounds.at(-1)?.draft.materialPlan).toMatchObject({ notices: [{ reason: "configuration_revoked" }] })
            expect(evidence.rounds.at(-1)?.draft.materialPlan?.activeAway).toBeUndefined()
            const requests = server.getMockConsumptions("openai-compatible-chat")
            expect(requests).toHaveLength(3)
            expect(requests.every((r) => r.contractError === undefined)).toBe(true)
            expectIndependentExit(requests[2].requestBody, evidence.notices[0])
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)
