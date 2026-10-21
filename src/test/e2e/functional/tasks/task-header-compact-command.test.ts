import { readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { expectComposerText } from "@e2e/utils/composer"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"
import type { ElectronApplication } from "playwright"

interface StoredProfile {
    id: string
    name: string
    modelId?: string
    webToolsMode?: "WEB_TOOLS_MODE_FORCE_OFF"
    openai?: {
        capabilities?: {
            contextWindow?: number
        }
    }
    deepseek?: {
        capabilities?: {
            contextWindow?: number
        }
    }
}

interface CompactionProviderCase {
    readonly label: string
    readonly profileName: string
    readonly target: "openai-compatible-responses" | "deepseek-chat"
    readonly modelId: string
    readonly providerConfigKey: "openai" | "deepseek"
}

const OPENAI_RESPONSES_CASE: CompactionProviderCase = {
    label: "OpenAI Responses",
    profileName: E2E_PROFILE_NAMES.mockOpenAiResponses,
    target: "openai-compatible-responses",
    modelId: "gpt-5.4-mini",
    providerConfigKey: "openai",
}
const DEEPSEEK_CHAT_CASE: CompactionProviderCase = {
    label: "DeepSeek Chat",
    profileName: E2E_PROFILE_NAMES.mockDeepSeek,
    target: "deepseek-chat",
    modelId: "deepseek-v4-flash",
    providerConfigKey: "deepseek",
}

const COMPACT_INSTRUCTION_MARKER = "The current conversation is rapidly running out of context"
const profilesPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "api_profiles.json")
const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")

async function configureManualCompaction(dlineDir: string, provider = OPENAI_RESPONSES_CASE): Promise<void> {
    const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
    const profile = profiles.find((candidate) => candidate.name === provider.profileName)
    if (!profile) throw new Error(`Missing configurable ${provider.label} E2E profile`)
    const providerConfig = profile[provider.providerConfigKey] ?? {}
    profile[provider.providerConfigKey] = {
        ...providerConfig,
        capabilities: { ...providerConfig.capabilities, contextWindow: 131_072 },
    }
    profile.modelId = provider.modelId
    profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
    await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

    const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
    await writeFile(
        settingsPath(dlineDir),
        `${JSON.stringify(
            {
                ...settings,
                actModeProfileId: profile.id,
                actModeProfile: profile.name,
                planModeProfileId: profile.id,
                planModeProfile: profile.name,
                useAutoCondense: false,
            },
            null,
            2,
        )}\n`,
        "utf8",
    )
}

async function openSidebar(app: ElectronApplication, helper: E2ETestHelper): Promise<Frame> {
    const page = await app.firstWindow()
    await E2ETestHelper.openClineSidebar(page)
    const sidebar = await helper.getSidebar(page)
    await E2ETestHelper.dismissWhatsNewModal(sidebar)
    await helper.signin(sidebar)
    return sidebar
}

async function sendTask(sidebar: Frame, text: string): Promise<void> {
    const input = sidebar.getByTestId("chat-input")
    await expect(input).toBeEnabled()
    await input.fill(text)
    await sidebar.getByTestId("send-button").click()
    await expectComposerText(input, "")
    await expect(sidebar.getByText(text, { exact: true }).last()).toBeVisible()
}

e2e(
    "TaskHeader Compact sends /cmd:compact through the active conversation",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configureManualCompaction(dlineDir)
        server.resetOpenAiMock()
        server.enqueueResponses(
            "openai-compatible-responses",
            // Compaction while a dialog is open condenses the answered history before it,
            // so the task first needs one answered exchange besides the opening request.
            {
                type: "tool",
                id: "call_task_header_compact_read",
                name: "read_file",
                arguments: { path: "README.md" },
                expectedRequestIncludes: ["E2E_TASK_HEADER_COMPACT_TASK"],
            },
            {
                type: "tool",
                id: "call_task_header_compact_ready",
                name: "qna_respond",
                arguments: { response: "E2E_TASK_HEADER_COMPACT_READY" },
                usage: { inputTokens: 80_000, outputTokens: 100 },
                expectedToolResults: [{ callId: "call_task_header_compact_read", contentIncludes: "# Test Workspace" }],
            },
            {
                type: "tool",
                id: "call_task_header_compact_summary",
                name: "summarize_task",
                arguments: { context: "E2E_TASK_HEADER_COMPACT_SUMMARY preserves the active task." },
                delayMs: 1_500,
                expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER, "E2E_TASK_HEADER_COMPACT_TASK"],
                expectedRequestExcludes: ["/cmd:compact"],
            },
            {
                type: "tool",
                id: "call_task_header_compact_continued",
                name: "qna_respond",
                arguments: { response: "E2E_TASK_HEADER_COMPACT_CONTINUED" },
                expectedRequestIncludes: ["E2E_TASK_HEADER_COMPACT_SUMMARY", "E2E_TASK_HEADER_COMPACT_PRESERVED_DRAFT"],
                expectedRequestExcludes: [COMPACT_INSTRUCTION_MARKER, "/cmd:compact"],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_TASK_HEADER_COMPACT_TASK")
            await expect(sidebar.getByText("E2E_TASK_HEADER_COMPACT_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })

            const input = sidebar.getByTestId("chat-input")
            await expect(input).toBeEnabled()
            await input.fill("E2E_TASK_HEADER_COMPACT_PRESERVED_DRAFT")
            const expandTaskHeader = sidebar.getByLabel("Expand task header")
            if (await expandTaskHeader.isVisible()) await expandTaskHeader.click()
            const compactButton = sidebar.getByRole("button", { name: "Compact task" })
            await expect(compactButton).toBeEnabled()
            await compactButton.click()
            await expect(sidebar.getByText("Compact the current task?", { exact: true })).toBeVisible()
            await sidebar.getByTitle("Yes, compact the task").click()

            const progress = sidebar.getByTestId("context-window-segmented-progress")
            const durableSegment = sidebar.getByTestId("context-window-segment-durable")
            await expect(progress).toHaveAttribute("data-phase", "sending", { timeout: 30_000 })
            const durableBeforeCompaction = Number(await durableSegment.getAttribute("data-authoritative-tokens"))
            // The hidden Pass is sized from its own request. The fixture's 80K usage for a
            // request of about 73 KB exceeds one token per byte, so the estimator rejects
            // that sample and sizes the Pass from bytes; the system prompt alone keeps it
            // well above 10K, and the landed summary must still shrink it.
            expect(durableBeforeCompaction).toBeGreaterThan(10_000)

            await expect(sidebar.getByText("E2E_TASK_HEADER_COMPACT_SUMMARY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await expectComposerText(input, "E2E_TASK_HEADER_COMPACT_PRESERVED_DRAFT")
            await sidebar.locator('vscode-button[aria-label="Condense Conversation"]').click()

            // The review was drawn on the run's own card, so that card is the only compaction row.
            const compactionPass = sidebar.getByTestId("compaction-pass")
            await expect(compactionPass).toHaveCount(1)
            // The task runtime names every compaction run `compaction:<uuid>` and records the
            // cause as its trigger, not in the id; neither the Webview nor the product
            // keys on a `manual-compaction:` prefix any more.
            await expect(compactionPass).toHaveAttribute("data-compaction-operation-id", /^compaction:/, {
                timeout: 60_000,
            })
            await expect(compactionPass).toHaveAttribute("data-compaction-status", "completed", { timeout: 60_000 })
            await expect
                .poll(async () => Number(await durableSegment.getAttribute("data-authoritative-tokens")), { timeout: 30_000 })
                .toBeLessThan(durableBeforeCompaction)
            await expect(sidebar.locator('vscode-button[aria-label="Condense Conversation"]')).toHaveCount(0)

            // Compacting from the header answers nothing: the dialog the task stopped on
            // stays open, the draft stays in the composer, and no round starts until the
            // user replies.
            expect(server.getRequestCount("openai-compatible-responses")).toBe(3)
            await expectComposerText(input, "E2E_TASK_HEADER_COMPACT_PRESERVED_DRAFT")
            await expect(input).toBeEnabled()
            await sidebar.getByTestId("send-button").click()
            await expect(sidebar.getByText("E2E_TASK_HEADER_COMPACT_CONTINUED", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(4)
            const requests = server.getMockConsumptions("openai-compatible-responses")
            expect(requests[2]).toMatchObject({ responseType: "tool", toolName: "summarize_task" })
            for (const request of requests) expect(request.contractError).toBeUndefined()
            await expect(compactionPass).toHaveCount(1)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

for (const provider of [OPENAI_RESPONSES_CASE, DEEPSEEK_CHAT_CASE]) {
    e2e(
        `TaskHeader Compact after attempt_completion lands the accepted summary on its card and keeps the task open (${provider.label})`,
        async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
            e2e.setTimeout(180_000)
            await configureManualCompaction(dlineDir, provider)
            server.resetOpenAiMock()
            server.enqueueResponses(
                provider.target,
                {
                    type: "tool",
                    id: "call_completion_compact_read",
                    name: "read_file",
                    arguments: { path: "README.md" },
                    expectedRequestIncludes: ["E2E_COMPLETION_COMPACT_TASK"],
                },
                {
                    type: "tool",
                    id: "call_completion_compact_done",
                    name: "attempt_completion",
                    arguments: { result: "E2E_COMPLETION_COMPACT_RESULT" },
                    usage: { inputTokens: 80_000, outputTokens: 100 },
                    expectedToolResults: [{ callId: "call_completion_compact_read", contentIncludes: "# Test Workspace" }],
                },
                {
                    type: "tool",
                    id: "call_completion_compact_summary",
                    name: "summarize_task",
                    arguments: { context: "E2E_COMPLETION_COMPACT_SUMMARY preserves the completed task." },
                    delayMs: 1_500,
                    expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER, "E2E_COMPLETION_COMPACT_TASK"],
                    expectedRequestExcludes: ["/cmd:compact"],
                },
                {
                    type: "tool",
                    id: "call_completion_compact_continued",
                    name: "qna_respond",
                    arguments: { response: "E2E_COMPLETION_COMPACT_CONTINUED" },
                    expectedRequestIncludes: ["E2E_COMPLETION_COMPACT_SUMMARY", "E2E_COMPLETION_COMPACT_FOLLOW_UP"],
                    expectedRequestExcludes: [COMPACT_INSTRUCTION_MARKER, "/cmd:compact"],
                },
            )

            const app = await openVSCode(workspaceDir)
            try {
                const sidebar = await openSidebar(app, helper)
                await sendTask(sidebar, "E2E_COMPLETION_COMPACT_TASK")
                const startNewTask = sidebar.locator('vscode-button[aria-label="Start New Task"]')
                await expect(startNewTask).toBeVisible({ timeout: 60_000 })

                const expandTaskHeader = sidebar.getByLabel("Expand task header")
                if (await expandTaskHeader.isVisible()) await expandTaskHeader.click()
                const compactButton = sidebar.getByRole("button", { name: "Compact task" })
                await expect(compactButton).toBeEnabled()
                await compactButton.click()
                await expect(sidebar.getByText("Compact the current task?", { exact: true })).toBeVisible()
                await sidebar.getByTitle("Yes, compact the task").click()

                await expect(sidebar.getByText("E2E_COMPLETION_COMPACT_SUMMARY", { exact: false }).last()).toBeVisible({
                    timeout: 60_000,
                })
                await sidebar.locator('vscode-button[aria-label="Condense Conversation"]').click()

                // Wait until the accepted summary has landed before judging the footer.
                const compactionPass = sidebar.getByTestId("compaction-pass")
                await expect(compactionPass).toHaveAttribute("data-compaction-status", "completed", { timeout: 60_000 })

                // A compacted task offers no dialog actions: neither Start New Task nor any other button.
                await expect(startNewTask, "Start New Task after compaction").toHaveCount(0, { timeout: 15_000 })
                await expect(
                    sidebar.getByRole("contentinfo").locator("vscode-button"),
                    "dialog actions after compaction",
                ).toHaveCount(0)

                // Typing continues the task from the summary.
                expect(server.getRequestCount(provider.target)).toBe(3)
                const input = sidebar.getByTestId("chat-input")
                await expect(input).toBeEnabled()
                await input.fill("E2E_COMPLETION_COMPACT_FOLLOW_UP")
                await sidebar.getByTestId("send-button").click()
                await expect(sidebar.getByText("E2E_COMPLETION_COMPACT_CONTINUED", { exact: false }).last()).toBeVisible({
                    timeout: 60_000,
                })
                await expect.poll(() => server.getRequestCount(provider.target)).toBe(4)
                for (const request of server.getMockConsumptions(provider.target)) {
                    expect(request.contractError).toBeUndefined()
                }
                await expect(compactionPass).toHaveCount(1)
                await expect(compactionPass).toHaveAttribute("data-compaction-status", "completed")
                await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
            } finally {
                await app.close()
            }
        },
    )
}
