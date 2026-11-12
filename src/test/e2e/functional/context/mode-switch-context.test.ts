import { readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import {
    type ComposerTextReaderWindow,
    expectComposerPlaceholder,
    expectComposerText,
    installComposerTextReader,
} from "@e2e/utils/composer"
import {
    COMPACT_INSTRUCTION_MARKER,
    COMPACT_SIGNAL,
    captureContextWindowEvidence,
    expandTaskHeader,
    expectCompactionSummary,
    expectFourContextSegments,
    expectNoInternalCompactionEcho,
    INTERNAL_MODE_RESPONSE,
    openSidebar,
    readContextWindowVisual,
    requestToolNames,
    sendTask,
    taskDirectoryIds,
} from "@e2e/utils/context-window-fixture"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { readTaskConversationText } from "@e2e/utils/task-instance-store"
import { expect, type Frame } from "@playwright/test"

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
}

const profilesPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "api_profiles.json")
const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")

async function configureModeProfiles(
    dlineDir: string,
    options: {
        actProfile: string
        actContextWindow: number
        planProfile: string
        planContextWindow: number
        /** Leave unset to keep the stored setting. */
        useAutoCondense?: boolean
    },
): Promise<void> {
    const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
    for (const [name, contextWindow] of [
        [options.actProfile, options.actContextWindow],
        [options.planProfile, options.planContextWindow],
    ] as const) {
        const profile = profiles.find((candidate) => candidate.name === name)
        if (!profile?.openai?.capabilities) throw new Error(`Missing configurable E2E profile: ${name}`)
        profile.openai.capabilities.contextWindow = contextWindow
        profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
    }
    await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

    const actProfile = profiles.find((candidate) => candidate.name === options.actProfile)
    const planProfile = profiles.find((candidate) => candidate.name === options.planProfile)
    if (!actProfile || !planProfile) throw new Error("Configured mode Profiles disappeared before settings write")
    const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
    await writeFile(
        settingsPath(dlineDir),
        `${JSON.stringify(
            {
                ...settings,
                planActSeparateModelsSetting: true,
                actModeProfileId: actProfile.id,
                actModeProfile: actProfile.name,
                planModeProfileId: planProfile.id,
                planModeProfile: planProfile.name,
                ...(options.useAutoCondense === undefined ? {} : { useAutoCondense: options.useAutoCondense }),
            },
            null,
            2,
        )}\n`,
        "utf8",
    )
}

async function configureAutoCompact(dlineDir: string, enabled: boolean): Promise<void> {
    const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
    const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
    if (!profile?.openai?.capabilities) throw new Error("Missing configurable OpenAI Responses E2E profile")
    profile.modelId = "gpt-5.4-mini"
    profile.openai.capabilities.contextWindow = 131_072
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
                useAutoCondense: enabled,
            },
            null,
            2,
        )}\n`,
        "utf8",
    )
}

async function configureTaskProfileSwitch(dlineDir: string): Promise<void> {
    const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
    const targetProfile = profiles.find((profile) => profile.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
    if (!targetProfile?.openai?.capabilities) throw new Error("Missing configurable OpenAI Responses E2E profile")
    targetProfile.modelId = "gpt-5.6-sol"
    targetProfile.openai.capabilities.contextWindow = 372_000
    targetProfile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
    const sourceProfile = profiles.find((profile) => profile.name === E2E_PROFILE_NAMES.mockDeepSeek)
    if (!sourceProfile) throw new Error("Missing configurable DeepSeek E2E profile")
    sourceProfile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
    await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

    const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
    await writeFile(
        settingsPath(dlineDir),
        `${JSON.stringify(
            {
                ...settings,
                planActSeparateModelsSetting: false,
                actModeProfileId: sourceProfile.id,
                actModeProfile: sourceProfile.name,
                planModeProfileId: sourceProfile.id,
                planModeProfile: sourceProfile.name,
                useAutoCondense: true,
                autoCondenseTriggerPercent: 97,
                autoCondenseMaxContextTokens: 0,
            },
            null,
            2,
        )}\n`,
        "utf8",
    )
}

async function configureProfileCompactionSwitch(dlineDir: string): Promise<void> {
    const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
    const sourceProfile = profiles.find((profile) => profile.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
    const targetProfile = profiles.find((profile) => profile.name === E2E_PROFILE_NAMES.mockOpenAi)
    if (!sourceProfile?.openai?.capabilities || !targetProfile?.openai?.capabilities) {
        throw new Error("Missing configurable OpenAI E2E profiles")
    }
    sourceProfile.modelId = "gpt-5.6-sol"
    sourceProfile.openai.capabilities.contextWindow = 272_000
    sourceProfile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
    targetProfile.modelId = "gpt-5.6-sol"
    targetProfile.openai.capabilities.contextWindow = 131_072
    targetProfile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
    await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

    const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
    await writeFile(
        settingsPath(dlineDir),
        `${JSON.stringify(
            {
                ...settings,
                planActSeparateModelsSetting: false,
                actModeProfileId: sourceProfile.id,
                actModeProfile: sourceProfile.name,
                planModeProfileId: sourceProfile.id,
                planModeProfile: sourceProfile.name,
                useAutoCondense: false,
            },
            null,
            2,
        )}\n`,
        "utf8",
    )
}

async function clickProfileOption(sidebar: Frame, profileName: string): Promise<void> {
    const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
    if ((await modelSwitcher.innerText()).trim() === profileName) return
    await modelSwitcher.click()
    const profileOption = sidebar.getByRole("option").filter({ has: sidebar.getByText(profileName, { exact: true }) })
    await expect(profileOption).toHaveCount(1)
    await profileOption.click()
}

async function startInputValueObserver(sidebar: Frame): Promise<void> {
    await installComposerTextReader(sidebar)
    await sidebar.evaluate(() => {
        const root = globalThis as typeof globalThis &
            ComposerTextReaderWindow & {
                __dlineModeSwitchInputObserver?: { timer: number; values: string[] }
            }
        const readDraft = root.__dlineE2EComposerText
        if (!readDraft) throw new Error("composer text reader is not installed")
        if (root.__dlineModeSwitchInputObserver) window.clearInterval(root.__dlineModeSwitchInputObserver.timer)
        const values: string[] = []
        const read = () => {
            const input = document.querySelector('[data-testid="chat-input"]')
            if (input) values.push(readDraft(input))
        }
        read()
        const timer = window.setInterval(read, 5)
        root.__dlineModeSwitchInputObserver = { timer, values }
    })
}

async function stopInputValueObserver(sidebar: Frame): Promise<string[]> {
    return sidebar.evaluate(() => {
        const root = globalThis as typeof globalThis & {
            __dlineModeSwitchInputObserver?: { timer: number; values: string[] }
        }
        const observer = root.__dlineModeSwitchInputObserver
        if (!observer) return []
        window.clearInterval(observer.timer)
        delete root.__dlineModeSwitchInputObserver
        return [...observer.values]
    })
}

async function expectPlanMode(sidebar: Frame): Promise<void> {
    await expect(sidebar.getByRole("switch", { name: "Plan" })).toHaveAttribute("aria-checked", "true", {
        timeout: 60_000,
    })
}

/**
 * Wait until the completion dialog is open and can take a reply.
 *
 * `attempt_completion` publishes its text before its checkpoint and hooks
 * settle, and only the opened dialog can take a transition draft as its reply.
 * A switch made in between leaves the draft in the composer for the user to
 * send, which is what these tests are not about.
 */
async function waitForCompletionDialog(sidebar: Frame): Promise<void> {
    await expect(sidebar.locator('vscode-button[aria-label="Start New Task"]')).toBeVisible({ timeout: 60_000 })
}

/**
 * Accept a manual summary under review and wait for it to land on its card.
 *
 * A command sent on its own answers nothing, so the dialog it was sent to
 * comes back after the review and still waits for the user's reply.
 */
async function expectManualCompactionLanded(sidebar: Frame, summary: string): Promise<void> {
    await expect(sidebar.getByText(summary, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
    const confirmButton = sidebar.locator('vscode-button[aria-label="Condense Conversation"]')
    await expect(confirmButton).toBeVisible({ timeout: 60_000 })
    await expectNoInternalCompactionEcho(sidebar)
    await confirmButton.click()
    await expect(confirmButton).toHaveCount(0)
    await expect(sidebar.getByTestId("compaction-pass").last()).toHaveAttribute("data-compaction-status", "completed", {
        timeout: 60_000,
    })
}

e2e(
    "Task-local profile switch - DeepSeek 160K to GPT-5.6 does not inject compaction below 372K",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configureTaskProfileSwitch(dlineDir)

        server.enqueueResponses("deepseek-chat", {
            type: "tool",
            id: "call_profile_switch_deepseek_ready",
            name: "attempt_completion",
            arguments: { result: "E2E_PROFILE_SWITCH_DEEPSEEK_READY" },
            usage: { inputTokens: 160_000, outputTokens: 100 },
            expectedRequestIncludes: ["E2E_PROFILE_SWITCH_DEEPSEEK_TASK"],
        })
        server.enqueueResponses("openai-compatible-responses", {
            type: "tool",
            id: "call_profile_switch_gpt_continue",
            name: "attempt_completion",
            arguments: { result: "E2E_PROFILE_SWITCH_GPT_CONTINUE_OK" },
            expectedRequestIncludes: ["E2E_PROFILE_SWITCH_GPT_CONTINUE"],
            expectedRequestExcludes: [COMPACT_INSTRUCTION_MARKER],
        })

        const app = await openVSCode(workspaceDir)
        try {
            const { sidebar } = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_PROFILE_SWITCH_DEEPSEEK_TASK", 60_000)
            await expect(sidebar.getByText("E2E_PROFILE_SWITCH_DEEPSEEK_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            const taskFooter = sidebar.getByRole("contentinfo")
            await expect(taskFooter.getByText("Start New Task", { exact: true })).toBeVisible()
            await expect(taskFooter.locator('[data-testid="send-button"][data-action="resume"]')).toHaveCount(0)
            // Reproduce the real task-local profile race: the selection RPC is
            // intentionally still in flight when the next user turn is submitted.
            await clickProfileOption(sidebar, E2E_PROFILE_NAMES.mockOpenAiResponses)
            await expect(taskFooter.getByText("Start New Task", { exact: true })).toBeVisible()
            await expect(taskFooter.locator('[data-testid="send-button"][data-action="resume"]')).toHaveCount(0)

            const input = sidebar.getByTestId("chat-input")
            await expect(input).toBeEnabled()
            await input.fill("E2E_PROFILE_SWITCH_GPT_CONTINUE")
            await sidebar.getByTestId("send-button").click()
            await expect(sidebar.getByText("E2E_PROFILE_SWITCH_GPT_CONTINUE_OK", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })

            await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(1)
            const targetRequest = server.getMockConsumptions("openai-compatible-responses")[0]
            expect(targetRequest).toMatchObject({ provider: "openai", protocol: "openai-responses" })
            expect(targetRequest.requestBody).toMatchObject({ model: "gpt-5.6-sol" })
            expect(JSON.stringify(targetRequest.requestBody)).not.toContain(COMPACT_INSTRUCTION_MARKER)
            expect(targetRequest.contractError).toBeUndefined()
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Task-local profile switch - smaller target warns and rebinds without immediate compaction",
    async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }, testInfo) => {
        e2e.setTimeout(240_000)
        await configureProfileCompactionSwitch(dlineDir)
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_profile_compaction_history_ready",
                name: "qna_respond",
                arguments: { response: "E2E_PROFILE_COMPACTION_HISTORY_READY" },
                expectedRequestIncludes: ["E2E_PROFILE_COMPACTION_TASK"],
            },
            {
                type: "tool",
                id: "call_profile_compaction_source_ready",
                name: "attempt_completion",
                arguments: { result: "E2E_PROFILE_COMPACTION_SOURCE_READY" },
                usage: { inputTokens: 140_000, outputTokens: 100 },
                expectedRequestIncludes: ["E2E_PROFILE_COMPACTION_LATEST"],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const { sidebar } = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_PROFILE_COMPACTION_TASK", 60_000)
            await expect(sidebar.getByText("E2E_PROFILE_COMPACTION_HISTORY_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await sendTask(sidebar, "E2E_PROFILE_COMPACTION_LATEST", 60_000)
            await expect(sidebar.getByText("E2E_PROFILE_COMPACTION_SOURCE_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await expandTaskHeader(sidebar)

            await clickProfileOption(sidebar, E2E_PROFILE_NAMES.mockOpenAi)
            const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
            await expect(modelSwitcher).toContainText(E2E_PROFILE_NAMES.mockOpenAiResponses)
            const dialog = sidebar.getByRole("dialog")
            await expect(dialog.getByRole("heading", { name: "Switch to a smaller context window?" })).toBeVisible()
            await expect(dialog).toContainText("nothing is compacted now")
            await expect(dialog).toContainText("ordinary compaction still runs later")
            await expect(dialog.getByText("Context in use", { exact: true })).toBeVisible()
            await expect(dialog.getByText("140,100 tokens", { exact: true })).toBeVisible()
            await expect(dialog).toContainText("Must fit below")
            await expect(dialog.getByRole("button", { name: "Compact & Switch" })).toHaveCount(0)
            await dialog.getByRole("button", { name: "Switch", exact: true }).click()

            const progress = sidebar.getByTestId("context-window-segmented-progress")
            await expect(modelSwitcher).toHaveText(E2E_PROFILE_NAMES.mockOpenAi, { timeout: 60_000 })
            await expect(sidebar.getByRole("dialog")).toHaveCount(0)
            await expect(progress).toHaveAttribute("data-phase", "stable", { timeout: 60_000 })
            const visual = await readContextWindowVisual(sidebar)
            expectFourContextSegments(visual)
            expect(visual).toMatchObject({
                contextWindow: 131_072,
                mode: "act",
                phase: "stable",
                profileName: E2E_PROFILE_NAMES.mockOpenAi,
            })
            expect(visual.segments[2]?.authoritativeTokens).toBeGreaterThan(0)
            expect(visual.segments.reduce((total, segment) => total + segment.authoritativeTokens, 0)).toBeGreaterThanOrEqual(
                140_100,
            )
            await captureContextWindowEvidence(sidebar, testInfo, "context-rebound")

            const [taskId] = await taskDirectoryIds(dlineDocsDir)
            if (!taskId) throw new Error("Profile switch E2E task directory was not created")
            const committedApiHistory = await readTaskConversationText(dlineDocsDir, taskId)
            expect(committedApiHistory).toContain("E2E_PROFILE_COMPACTION_TASK")
            expect(committedApiHistory).toContain("E2E_PROFILE_COMPACTION_HISTORY_READY")
            expect(committedApiHistory).toContain("E2E_PROFILE_COMPACTION_LATEST")
            expect(committedApiHistory).toContain("E2E_PROFILE_COMPACTION_SOURCE_READY")
            expect(committedApiHistory).not.toContain("E2E_PROFILE_TARGET_SUMMARY")

            await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(2)
            expect(server.getRequestCount("openai-compatible-chat")).toBe(0)
            await expect(sidebar.getByTestId("compaction-pass")).toHaveCount(0)
            await expect(sidebar.getByText("Restore Task Only", { exact: true })).toHaveCount(0)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Mode switch context - welcome draft stays local until configured Enter submits it",
    async ({ dlineDocsDir, helper, server, sidebar, userDataDir }) => {
        e2e.setTimeout(120_000)
        await helper.signin(sidebar)
        server.enqueueResponses("openai-compatible-chat", {
            type: "tool",
            id: "call_welcome_mode_enter",
            name: "make_plan",
            arguments: { response: "E2E_WELCOME_MODE_ENTER_SENT", needs_more_exploration: false },
            expectedRequestIncludes: ["E2E_WELCOME_MODE_DRAFT", "PLAN MODE"],
        })

        const input = sidebar.getByTestId("chat-input")
        await expect(sidebar.getByRole("switch", { name: "Act" })).toHaveAttribute("aria-checked", "true")
        await input.fill("E2E_WELCOME_MODE_DRAFT")
        await sidebar.getByTestId("mode-switch").click()

        await expectPlanMode(sidebar)
        await expectComposerText(input, "E2E_WELCOME_MODE_DRAFT")
        expect(await taskDirectoryIds(dlineDocsDir)).toEqual([])
        expect(server.getRequestCount("openai-compatible-chat")).toBe(0)
        expect(server.getRequestCount("openai-compatible-responses")).toBe(0)

        await input.press("Enter")
        await expectComposerText(input, "")
        await expect(sidebar.getByText("E2E_WELCOME_MODE_DRAFT", { exact: true }).last()).toBeVisible()
        await expect(sidebar.getByText("E2E_WELCOME_MODE_ENTER_SENT", { exact: false }).last()).toBeVisible({
            timeout: 60_000,
        })
        await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(1)
        expect(server.getRequestCount("openai-compatible-responses")).toBe(0)
        expect(await taskDirectoryIds(dlineDocsDir)).toHaveLength(1)
        expect(server.getMockConsumptions("openai-compatible-chat")[0].contractError).toBeUndefined()
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)

e2e(
    "Mode switch context - returning to Welcome cannot submit a draft until Send is clicked",
    async ({ dlineDocsDir, helper, server, sidebar, userDataDir }) => {
        e2e.setTimeout(150_000)
        await helper.signin(sidebar)
        server.enqueueResponses(
            "openai-compatible-chat",
            {
                type: "tool",
                id: "call_welcome_after_close_ready",
                name: "attempt_completion",
                arguments: { result: "E2E_WELCOME_AFTER_CLOSE_READY" },
            },
            {
                type: "tool",
                id: "call_welcome_after_close_explicit_send",
                name: "make_plan",
                arguments: { response: "E2E_WELCOME_AFTER_CLOSE_SENT", needs_more_exploration: false },
                expectedRequestIncludes: ["E2E_WELCOME_AFTER_CLOSE_DRAFT", "PLAN MODE"],
            },
        )

        await sendTask(sidebar, "E2E_WELCOME_AFTER_CLOSE_TASK")
        await expect(sidebar.getByText("E2E_WELCOME_AFTER_CLOSE_READY", { exact: false }).last()).toBeVisible({
            timeout: 60_000,
        })
        await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(1)
        expect(await taskDirectoryIds(dlineDocsDir)).toHaveLength(1)

        await sidebar.getByRole("button", { name: "Close Task", exact: true }).click()
        const input = sidebar.getByTestId("chat-input")
        await expectComposerPlaceholder(input, "Type your task here...")
        await E2ETestHelper.dismissWhatsNewModal(sidebar)
        await input.fill("E2E_WELCOME_AFTER_CLOSE_DRAFT")
        await sidebar.getByTestId("mode-switch").click()

        await expectPlanMode(sidebar)
        await expectComposerText(input, "E2E_WELCOME_AFTER_CLOSE_DRAFT")
        await sidebar.page().waitForTimeout(1_000)
        expect(await taskDirectoryIds(dlineDocsDir)).toHaveLength(1)
        expect(server.getRequestCount("openai-compatible-chat")).toBe(1)

        await sidebar.getByTestId("send-button").click()
        await expectComposerText(input, "")
        await expect(sidebar.getByText("E2E_WELCOME_AFTER_CLOSE_SENT", { exact: false }).last()).toBeVisible({
            timeout: 60_000,
        })
        await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(2)
        expect(await taskDirectoryIds(dlineDocsDir)).toHaveLength(2)
        expect(server.getMockConsumptions("openai-compatible-chat")[1].contractError).toBeUndefined()
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)

e2e(
    "Mode switch context - over-limit same profile switches directly without compaction",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(150_000)
        // The contract is that the switch itself asks for no compaction; automatic compaction of
        // the over-limit history before the next request is a separate behavior, so it stays off.
        await configureModeProfiles(dlineDir, {
            actProfile: E2E_PROFILE_NAMES.mockOpenAi,
            actContextWindow: 131_072,
            planProfile: E2E_PROFILE_NAMES.mockOpenAi,
            planContextWindow: 131_072,
            useAutoCondense: false,
        })
        server.enqueueResponses(
            "openai-compatible-chat",
            {
                type: "tool",
                id: "call_same_profile_completion",
                name: "attempt_completion",
                arguments: { result: "E2E_SAME_PROFILE_READY" },
                usage: { inputTokens: 400_000, outputTokens: 100 },
            },
            {
                type: "tool",
                id: "call_same_profile_plan",
                name: "make_plan",
                arguments: { response: "E2E_SAME_PROFILE_PLAN_OK", needs_more_exploration: false },
                expectedRequestIncludes: ["E2E_SAME_PROFILE_PLAN_DRAFT", "PLAN MODE"],
                expectedRequestExcludes: [COMPACT_SIGNAL],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const { sidebar } = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_SAME_PROFILE_TASK")
            await expect(sidebar.getByText("E2E_SAME_PROFILE_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await waitForCompletionDialog(sidebar)

            const input = sidebar.getByTestId("chat-input")
            await input.fill("E2E_SAME_PROFILE_PLAN_DRAFT")
            await startInputValueObserver(sidebar)
            await sidebar.getByTestId("mode-switch").evaluate((element) => (element as HTMLElement).click())
            await expectPlanMode(sidebar)
            await expect(sidebar.getByRole("heading", { name: "Compact context before switching?" })).toHaveCount(0)
            await expect(sidebar.getByText("E2E_SAME_PROFILE_PLAN_OK", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            const observedValues = await stopInputValueObserver(sidebar)
            expect(observedValues).not.toContain(COMPACT_SIGNAL)
            await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(2)
            const planRequest = server.getMockConsumptions("openai-compatible-chat")[1]
            expect(requestToolNames(planRequest)).toContain("make_plan")
            expect(requestToolNames(planRequest)).not.toContain("act_mode_respond")
            expect(planRequest.contractError).toBeUndefined()
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Mode switch interaction - an awaiting plan switches to Act without a request when input is empty",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(120_000)
        await configureModeProfiles(dlineDir, {
            actProfile: E2E_PROFILE_NAMES.mockOpenAi,
            actContextWindow: 131_072,
            planProfile: E2E_PROFILE_NAMES.mockOpenAi,
            planContextWindow: 131_072,
        })
        server.enqueueResponses("openai-compatible-chat", {
            type: "tool",
            id: "call_awaiting_plan",
            name: "make_plan",
            arguments: { response: "E2E_AWAITING_PLAN_READY", needs_more_exploration: false },
            expectedRequestIncludes: ["E2E_AWAITING_PLAN_TASK", "PLAN MODE"],
        })

        const app = await openVSCode(workspaceDir)
        try {
            const { sidebar } = await openSidebar(app, helper)
            await sidebar.getByTestId("mode-switch").click()
            await expectPlanMode(sidebar)
            await sendTask(sidebar, "E2E_AWAITING_PLAN_TASK")
            await expect(sidebar.getByText("E2E_AWAITING_PLAN_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })

            const input = sidebar.getByTestId("chat-input")
            await expect(input).toBeEnabled()
            await expectComposerText(input, "")
            await startInputValueObserver(sidebar)
            await sidebar.getByTestId("mode-switch").evaluate((element) => (element as HTMLElement).click())
            await expect(sidebar.getByRole("switch", { name: "Act" })).toHaveAttribute("aria-checked", "true", {
                timeout: 60_000,
            })

            const observedValues = await stopInputValueObserver(sidebar)
            expect.soft(observedValues).not.toContain(INTERNAL_MODE_RESPONSE)
            expect.soft(await sidebar.locator("body").innerText()).not.toContain(INTERNAL_MODE_RESPONSE)
            await expect(input).toBeEnabled()
            await expectComposerText(input, "")
            await expect(sidebar.getByText("E2E_AWAITING_PLAN_READY", { exact: false }).last()).toBeVisible()
            await expect(sidebar.getByText("E2E_AWAITING_PLAN_CONTINUED", { exact: false })).toHaveCount(0)
            expect(server.getRequestCount("openai-compatible-chat")).toBe(1)
            await expectNoInternalCompactionEcho(sidebar)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Mode switch interaction - an awaiting Act question switches to Plan without a request when input is empty",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(120_000)
        await configureModeProfiles(dlineDir, {
            actProfile: E2E_PROFILE_NAMES.mockOpenAi,
            actContextWindow: 131_072,
            planProfile: E2E_PROFILE_NAMES.mockOpenAi,
            planContextWindow: 131_072,
        })
        server.enqueueResponses("openai-compatible-chat", {
            type: "tool",
            id: "call_awaiting_act_question",
            name: "qna_respond",
            arguments: { response: "E2E_AWAITING_ACT_QUESTION" },
            expectedRequestIncludes: ["E2E_AWAITING_ACT_TASK", "ACT MODE"],
        })

        const app = await openVSCode(workspaceDir)
        try {
            const { sidebar } = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_AWAITING_ACT_TASK")
            await expect(sidebar.getByText("E2E_AWAITING_ACT_QUESTION", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })

            const input = sidebar.getByTestId("chat-input")
            await expect(input).toBeEnabled()
            await expectComposerText(input, "")
            await sidebar.getByTestId("mode-switch").evaluate((element) => (element as HTMLElement).click())
            await expectPlanMode(sidebar)
            await expect(input).toBeEnabled()
            await expectComposerText(input, "")
            await expect(sidebar.getByText("E2E_AWAITING_ACT_QUESTION", { exact: false }).last()).toBeVisible()
            await expect(sidebar.getByText("E2E_AWAITING_ACT_PLAN_CONTINUED", { exact: false })).toHaveCount(0)
            expect(server.getRequestCount("openai-compatible-chat")).toBe(1)
            await expectNoInternalCompactionEcho(sidebar)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Mode switch interaction - an awaiting Act question consumes its Plan-switch draft once",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(120_000)
        await configureModeProfiles(dlineDir, {
            actProfile: E2E_PROFILE_NAMES.mockOpenAi,
            actContextWindow: 131_072,
            planProfile: E2E_PROFILE_NAMES.mockOpenAi,
            planContextWindow: 131_072,
        })
        server.enqueueResponses(
            "openai-compatible-chat",
            {
                type: "tool",
                id: "call_reverse_draft_question",
                name: "qna_respond",
                arguments: { response: "E2E_REVERSE_DRAFT_QUESTION" },
            },
            {
                type: "tool",
                id: "call_reverse_draft_plan",
                name: "make_plan",
                arguments: { response: "E2E_REVERSE_DRAFT_PLAN_READY", needs_more_exploration: false },
                expectedRequestIncludes: ["E2E_REVERSE_SWITCH_DRAFT", "PLAN MODE"],
                expectedRequestExcludes: [INTERNAL_MODE_RESPONSE],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const { sidebar } = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_REVERSE_DRAFT_TASK")
            await expect(sidebar.getByText("E2E_REVERSE_DRAFT_QUESTION", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })

            const input = sidebar.getByTestId("chat-input")
            await input.fill("E2E_REVERSE_SWITCH_DRAFT")
            await sidebar.getByTestId("mode-switch").evaluate((element) => (element as HTMLElement).click())
            await expectPlanMode(sidebar)
            await expectComposerText(input, "")
            await expect.poll(() => server.getRequestCount("openai-compatible-chat"), { timeout: 20_000 }).toBe(2)
            await expect(sidebar.getByText("E2E_REVERSE_DRAFT_PLAN_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })

            await expect(sidebar.getByText("E2E_REVERSE_SWITCH_DRAFT", { exact: true })).toHaveCount(1)
            const continuationRequest = server.getMockConsumptions("openai-compatible-chat")[1]
            const continuationText = JSON.stringify(continuationRequest.requestBody)
            expect(continuationText.match(/E2E_REVERSE_SWITCH_DRAFT/g)).toHaveLength(1)
            expect(continuationRequest.contractError).toBeUndefined()
            await expectNoInternalCompactionEcho(sidebar)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Mode switch interaction - a pasted command in the switch draft reaches the awaiting question as inert text",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(120_000)
        await configureModeProfiles(dlineDir, {
            actProfile: E2E_PROFILE_NAMES.mockOpenAi,
            actContextWindow: 131_072,
            planProfile: E2E_PROFILE_NAMES.mockOpenAi,
            planContextWindow: 131_072,
        })
        const pasted = "/compact E2E_SWITCH_PASTED_LITERAL"
        server.enqueueResponses(
            "openai-compatible-chat",
            {
                type: "tool",
                id: "call_pasted_draft_question",
                name: "qna_respond",
                arguments: { response: "E2E_PASTED_DRAFT_QUESTION" },
            },
            {
                type: "tool",
                id: "call_pasted_draft_plan",
                name: "make_plan",
                arguments: { response: "E2E_PASTED_DRAFT_PLAN_READY", needs_more_exploration: false },
                // The reply keeps the pasted text inert: a re-parse of the captured string would run /compact.
                expectedRequestIncludes: [pasted, "PLAN MODE"],
                expectedRequestExcludes: [INTERNAL_MODE_RESPONSE, COMPACT_INSTRUCTION_MARKER],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const { sidebar } = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_PASTED_DRAFT_TASK")
            await expect(sidebar.getByText("E2E_PASTED_DRAFT_QUESTION", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })

            const input = sidebar.getByTestId("chat-input")
            await input.click()
            await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), pasted)
            await input.press(process.platform === "darwin" ? "Meta+V" : "Control+V")
            await expectComposerText(input, pasted)
            await sidebar.getByTestId("mode-switch").evaluate((element) => (element as HTMLElement).click())
            await expectPlanMode(sidebar)
            // The switch reported the draft delivered, so the composer let it go.
            await expectComposerText(input, "")
            await expect.poll(() => server.getRequestCount("openai-compatible-chat"), { timeout: 20_000 }).toBe(2)
            await expect(sidebar.getByText("E2E_PASTED_DRAFT_PLAN_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })

            const continuationRequest = server.getMockConsumptions("openai-compatible-chat")[1]
            expect(continuationRequest.contractError).toBeUndefined()
            expect(JSON.stringify(continuationRequest.requestBody).match(/E2E_SWITCH_PASTED_LITERAL/g)).toHaveLength(1)
            await expectNoInternalCompactionEcho(sidebar)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Mode switch context - a smaller target switches directly when current usage fits",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(150_000)
        await configureModeProfiles(dlineDir, {
            actProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
            actContextWindow: 272_000,
            planProfile: E2E_PROFILE_NAMES.mockOpenAi,
            planContextWindow: 131_072,
        })
        server.enqueueResponses("openai-compatible-responses", {
            type: "tool",
            id: "call_smaller_fits_completion",
            name: "attempt_completion",
            arguments: { result: "E2E_SMALLER_FITS_READY" },
            usage: { inputTokens: 50_000, outputTokens: 100 },
        })
        server.enqueueResponses("openai-compatible-chat", {
            type: "tool",
            id: "call_smaller_fits_plan",
            name: "make_plan",
            arguments: { response: "E2E_SMALLER_FITS_PLAN_OK", needs_more_exploration: false },
            expectedRequestIncludes: ["E2E_SMALLER_FITS_PLAN_DRAFT", "PLAN MODE"],
            expectedRequestExcludes: [COMPACT_SIGNAL, COMPACT_INSTRUCTION_MARKER],
        })

        const app = await openVSCode(workspaceDir)
        try {
            const { sidebar } = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_SMALLER_FITS_TASK")
            await expect(sidebar.getByText("E2E_SMALLER_FITS_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await waitForCompletionDialog(sidebar)

            await sidebar.getByTestId("chat-input").fill("E2E_SMALLER_FITS_PLAN_DRAFT")
            await sidebar.getByTestId("mode-switch").evaluate((element) => (element as HTMLElement).click())
            await expectPlanMode(sidebar)
            await expect(sidebar.getByRole("heading", { name: "Switch to a smaller context window?" })).toHaveCount(0)
            await expect(sidebar.getByText("E2E_SMALLER_FITS_PLAN_OK", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })

            await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(1)
            await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(1)
            const targetRequest = server.getMockConsumptions("openai-compatible-chat")[0]
            expect(requestToolNames(targetRequest)).not.toEqual(["summarize_task"])
            expect(targetRequest.contractError).toBeUndefined()
            await expectNoInternalCompactionEcho(sidebar)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Mode switch context - cancelling required compaction keeps the source mode and draft",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(150_000)
        await configureModeProfiles(dlineDir, {
            actProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
            actContextWindow: 272_000,
            planProfile: E2E_PROFILE_NAMES.mockOpenAi,
            planContextWindow: 131_072,
        })
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_cancel_compaction_history",
                name: "qna_respond",
                arguments: { response: "E2E_CANCEL_COMPACTION_HISTORY_READY" },
                expectedRequestIncludes: ["E2E_CANCEL_COMPACTION_TASK"],
            },
            {
                type: "tool",
                id: "call_cancel_compaction_completion",
                name: "attempt_completion",
                arguments: { result: "E2E_CANCEL_COMPACTION_READY" },
                usage: { inputTokens: 140_000, outputTokens: 100 },
                expectedRequestIncludes: ["E2E_CANCEL_COMPACTION_LATEST"],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const { sidebar } = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_CANCEL_COMPACTION_TASK")
            await expect(sidebar.getByText("E2E_CANCEL_COMPACTION_HISTORY_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await sendTask(sidebar, "E2E_CANCEL_COMPACTION_LATEST")
            await expect(sidebar.getByText("E2E_CANCEL_COMPACTION_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })

            const input = sidebar.getByTestId("chat-input")
            await input.fill("E2E_CANCEL_COMPACTION_DRAFT")
            await sidebar.getByTestId("mode-switch").evaluate((element) => (element as HTMLElement).click())
            const dialog = sidebar.getByRole("dialog")
            await expect(dialog.getByRole("heading", { name: "Compact context before switching?" })).toBeVisible()
            await dialog.getByRole("button", { name: "Cancel" }).click()

            await expect(dialog).toHaveCount(0)
            await expect(sidebar.getByRole("switch", { name: "Act" })).toHaveAttribute("aria-checked", "true")
            await expect(sidebar.getByRole("switch", { name: "Plan" })).toHaveAttribute("aria-checked", "false")
            await expectComposerText(input, "E2E_CANCEL_COMPACTION_DRAFT")
            await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(2)
            await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(0)
            await expectNoInternalCompactionEcho(sidebar)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Mode switch context - smaller target confirms, compacts, and continues with the target mode",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configureModeProfiles(dlineDir, {
            actProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
            actContextWindow: 272_000,
            planProfile: E2E_PROFILE_NAMES.mockOpenAi,
            planContextWindow: 131_072,
        })
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_smaller_target_history",
                name: "qna_respond",
                arguments: { response: "E2E_SMALLER_TARGET_HISTORY_READY" },
                expectedRequestIncludes: ["E2E_SMALLER_TARGET_TASK"],
            },
            {
                type: "tool",
                id: "call_smaller_target_completion",
                name: "qna_respond",
                arguments: { response: "E2E_SMALLER_TARGET_READY" },
                usage: { inputTokens: 140_000, outputTokens: 100 },
                expectedRequestIncludes: ["E2E_SMALLER_TARGET_LATEST"],
            },
        )
        server.enqueueResponses(
            "openai-compatible-chat",
            {
                type: "tool",
                id: "call_mode_switch_summary",
                name: "summarize_task",
                arguments: {
                    context: "E2E_MODE_SWITCH_SUMMARY preserves E2E_SMALLER_TARGET_TASK and E2E_SMALLER_TARGET_LATEST.",
                },
                expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER, "E2E_SMALLER_TARGET_TASK"],
                expectedRequestExcludes: [COMPACT_SIGNAL, "E2E_SMALLER_TARGET_LATEST", "E2E_SMALLER_TARGET_PLAN_DRAFT"],
            },
            {
                type: "tool",
                id: "call_smaller_target_plan",
                name: "make_plan",
                arguments: { response: "E2E_SMALLER_TARGET_PLAN_OK", needs_more_exploration: false },
                expectedRequestIncludes: [
                    "E2E_MODE_SWITCH_SUMMARY",
                    "E2E_SMALLER_TARGET_LATEST",
                    "E2E_SMALLER_TARGET_PLAN_DRAFT",
                    "PLAN MODE",
                ],
                expectedRequestExcludes: [COMPACT_SIGNAL],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const { sidebar } = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_SMALLER_TARGET_TASK")
            await expect(sidebar.getByText("E2E_SMALLER_TARGET_HISTORY_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await sendTask(sidebar, "E2E_SMALLER_TARGET_LATEST")
            await expect(sidebar.getByText("E2E_SMALLER_TARGET_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })

            const input = sidebar.getByTestId("chat-input")
            await input.fill("E2E_SMALLER_TARGET_PLAN_DRAFT")
            await startInputValueObserver(sidebar)
            await sidebar.getByTestId("mode-switch").evaluate((element) => (element as HTMLElement).click())
            const dialog = sidebar.getByRole("dialog")
            await expect(dialog.getByRole("heading", { name: "Compact context before switching?" })).toBeVisible()
            await expect(dialog.getByText("Source", { exact: true })).toBeVisible()
            await expect(
                dialog.getByText(`${E2E_PROFILE_NAMES.mockOpenAiResponses} · 272,000 tokens`, { exact: true }),
            ).toBeVisible()
            await expect(dialog.getByText("Target", { exact: true })).toBeVisible()
            await expect(dialog.getByText(`${E2E_PROFILE_NAMES.mockOpenAi} · 131,072 tokens`, { exact: true })).toBeVisible()
            await expectComposerText(input, "E2E_SMALLER_TARGET_PLAN_DRAFT")
            await dialog.getByRole("button", { name: "Compact & Switch" }).click()

            await expectPlanMode(sidebar)
            await expect(sidebar.getByText("E2E_SMALLER_TARGET_PLAN_OK", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            const observedValues = await stopInputValueObserver(sidebar)
            expect(observedValues).not.toContain(COMPACT_SIGNAL)
            await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(2)
            await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(2)
            const targetRequests = server.getMockConsumptions("openai-compatible-chat")
            const summaryRequest = targetRequests[0]
            expect(summaryRequest).toMatchObject({ responseType: "tool", toolName: "summarize_task" })
            expect(requestToolNames(summaryRequest)).not.toContain("summarize_task")
            expect(summaryRequest.contractError).toBeUndefined()
            const targetRequest = targetRequests[1]
            expect(requestToolNames(targetRequest)).toContain("make_plan")
            expect(requestToolNames(targetRequest)).not.toContain("act_mode_respond")
            expect(requestToolNames(targetRequest)).not.toEqual(["summarize_task"])
            expect(targetRequest.contractError).toBeUndefined()
            await expectCompactionSummary(
                sidebar,
                "E2E_MODE_SWITCH_SUMMARY preserves E2E_SMALLER_TARGET_TASK and E2E_SMALLER_TARGET_LATEST.",
            )
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Mode switch context - an over-limit summary truncates safely and retries before switching",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(210_000)
        await configureModeProfiles(dlineDir, {
            actProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
            actContextWindow: 272_000,
            planProfile: E2E_PROFILE_NAMES.mockOpenAi,
            planContextWindow: 131_072,
        })
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_over_limit_round_one",
                name: "qna_respond",
                arguments: { response: "E2E_OVER_LIMIT_ROUND_ONE" },
            },
            {
                type: "tool",
                id: "call_over_limit_middle_one",
                name: "qna_respond",
                arguments: { response: "E2E_OVER_LIMIT_MIDDLE_ONE_RESPONSE" },
            },
            {
                type: "tool",
                id: "call_over_limit_middle_two",
                name: "qna_respond",
                arguments: { response: "E2E_OVER_LIMIT_MIDDLE_TWO_RESPONSE" },
            },
            {
                type: "tool",
                id: "call_over_limit_late_turn",
                name: "qna_respond",
                arguments: { response: "E2E_OVER_LIMIT_LATE_RESPONSE" },
                usage: { inputTokens: 299_000, outputTokens: 1_000 },
                expectedRequestIncludes: ["E2E_OVER_LIMIT_LATE_TURN"],
            },
        )
        server.enqueueResponses(
            "openai-compatible-chat",
            {
                type: "error",
                status: 400,
                code: "context_length_exceeded",
                message: "Maximum context length is 131072 tokens; this request contains 300000 tokens.",
                requestId: "req_mode_switch_context_limit",
            },
            {
                type: "tool",
                id: "call_over_limit_summary",
                name: "summarize_task",
                arguments: {
                    context:
                        "E2E_OVER_LIMIT_SUMMARY preserves E2E_OVER_LIMIT_TASK, both middle turns, and E2E_OVER_LIMIT_LATE_TURN.",
                },
                expectedRequestIncludes: [
                    COMPACT_INSTRUCTION_MARKER,
                    "E2E_OVER_LIMIT_TASK",
                    "E2E_OVER_LIMIT_MIDDLE_ONE",
                    "E2E_OVER_LIMIT_MIDDLE_TWO",
                ],
                expectedRequestExcludes: [COMPACT_SIGNAL, "E2E_OVER_LIMIT_LATE_TURN", "E2E_OVER_LIMIT_PLAN_DRAFT"],
            },
            {
                type: "tool",
                id: "call_over_limit_plan",
                name: "make_plan",
                arguments: { response: "E2E_OVER_LIMIT_PLAN_OK", needs_more_exploration: false },
                expectedRequestIncludes: [
                    "E2E_OVER_LIMIT_SUMMARY",
                    "E2E_OVER_LIMIT_LATE_TURN",
                    "E2E_OVER_LIMIT_PLAN_DRAFT",
                    "PLAN MODE",
                ],
                expectedRequestExcludes: [COMPACT_SIGNAL],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const { sidebar } = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_OVER_LIMIT_TASK")
            await expect(sidebar.getByText("E2E_OVER_LIMIT_ROUND_ONE", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await sendTask(sidebar, "E2E_OVER_LIMIT_MIDDLE_ONE")
            await expect(sidebar.getByText("E2E_OVER_LIMIT_MIDDLE_ONE_RESPONSE", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await sendTask(sidebar, "E2E_OVER_LIMIT_MIDDLE_TWO")
            await expect(sidebar.getByText("E2E_OVER_LIMIT_MIDDLE_TWO_RESPONSE", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await sendTask(sidebar, "E2E_OVER_LIMIT_LATE_TURN")
            await expect(sidebar.getByText("E2E_OVER_LIMIT_LATE_RESPONSE", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })

            const input = sidebar.getByTestId("chat-input")
            await input.fill("E2E_OVER_LIMIT_PLAN_DRAFT")
            await startInputValueObserver(sidebar)
            await sidebar.getByTestId("mode-switch").evaluate((element) => (element as HTMLElement).click())
            const dialog = sidebar.getByRole("dialog")
            await expect(dialog.getByRole("heading", { name: "Compact context before switching?" })).toBeVisible()
            await dialog.getByRole("button", { name: "Compact & Switch" }).click()

            await expect(dialog.getByRole("heading", { name: "Switch not completed" })).toBeVisible({ timeout: 60_000 })
            await expect(dialog).toContainText("Mode switch compaction failed.")
            await expect(dialog).toContainText("remains active. The target settings were not adopted.")
            await expectComposerText(input, "E2E_OVER_LIMIT_PLAN_DRAFT")
            await dialog.getByRole("button", { name: "Retry", exact: true }).click()
            await expect(dialog.getByRole("heading", { name: "Compact context before switching?" })).toBeVisible({
                timeout: 60_000,
            })
            await dialog.getByRole("button", { name: "Compact & Switch" }).click()

            await expectPlanMode(sidebar)
            await expect(sidebar.getByText("E2E_OVER_LIMIT_PLAN_OK", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            const observedValues = await stopInputValueObserver(sidebar)
            expect(observedValues).not.toContain(COMPACT_SIGNAL)
            await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(4)
            await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(3)
            const targetRequests = server.getMockConsumptions("openai-compatible-chat")
            const firstSummary = targetRequests[0]
            const retriedSummary = targetRequests[1]
            for (const request of [firstSummary, retriedSummary]) {
                const requestText = JSON.stringify(request.requestBody)
                expect(requestToolNames(request)).not.toContain("summarize_task")
                expect(requestText).toContain("E2E_OVER_LIMIT_TASK")
                expect(requestText).toContain("E2E_OVER_LIMIT_MIDDLE_ONE")
                expect(requestText).toContain("E2E_OVER_LIMIT_MIDDLE_TWO")
                expect(requestText).not.toContain("E2E_OVER_LIMIT_LATE_TURN")
            }
            expect(requestToolNames(firstSummary)).toEqual(requestToolNames(retriedSummary))
            expect(firstSummary).toMatchObject({ responseType: "error" })
            expect(retriedSummary).toMatchObject({ responseType: "tool", toolName: "summarize_task" })
            expect(retriedSummary.contractError).toBeUndefined()
            expect(sidebar.getByText("E2E_OVER_LIMIT_TASK", { exact: true }).first()).toBeVisible()
            await expectCompactionSummary(
                sidebar,
                "E2E_OVER_LIMIT_SUMMARY preserves E2E_OVER_LIMIT_TASK, both middle turns, and E2E_OVER_LIMIT_LATE_TURN.",
            )
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/context length/i])
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Automatic compaction - enabled renders the API summary without internal instruction echo",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configureAutoCompact(dlineDir, true)
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_auto_compact_history",
                name: "qna_respond",
                arguments: { response: "E2E_AUTO_COMPACT_HISTORY_READY" },
                expectedRequestIncludes: ["E2E_AUTO_COMPACT_TASK"],
            },
            {
                type: "tool",
                id: "call_auto_compact_ready",
                name: "qna_respond",
                arguments: { response: "E2E_AUTO_COMPACT_READY" },
                usage: { inputTokens: 125_000, outputTokens: 100 },
                expectedRequestIncludes: ["E2E_AUTO_COMPACT_LATEST"],
            },
            {
                type: "tool",
                id: "call_auto_compact_summary",
                name: "summarize_task",
                arguments: { context: "E2E_AUTO_COMPACT_SUMMARY preserves the task and latest user request." },
                expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER],
                expectedRequestExcludes: [COMPACT_SIGNAL, "E2E_AUTO_COMPACT_CONTINUE"],
            },
            {
                type: "tool",
                id: "call_auto_compact_completion",
                name: "attempt_completion",
                arguments: { result: "E2E_AUTO_COMPACT_OK" },
                expectedRequestIncludes: ["E2E_AUTO_COMPACT_SUMMARY", "E2E_AUTO_COMPACT_CONTINUE"],
                expectedRequestExcludes: [COMPACT_SIGNAL, COMPACT_INSTRUCTION_MARKER],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const { sidebar } = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_AUTO_COMPACT_TASK")
            await expect(sidebar.getByText("E2E_AUTO_COMPACT_HISTORY_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await sendTask(sidebar, "E2E_AUTO_COMPACT_LATEST")
            await expect(sidebar.getByText("E2E_AUTO_COMPACT_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await sendTask(sidebar, "E2E_AUTO_COMPACT_CONTINUE")
            await expect(
                sidebar
                    .getByText("E2E_AUTO_COMPACT_SUMMARY preserves the task and latest user request.", { exact: false })
                    .last(),
            ).toBeVisible({ timeout: 60_000 })
            await expect(sidebar.locator('vscode-button[aria-label="Condense Conversation"]')).toHaveCount(0)
            await expect(sidebar.locator('vscode-button[aria-label="Regenerate Summary"]')).toHaveCount(0)

            await expect.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 60_000 }).toBe(4)
            const requests = server.getMockConsumptions("openai-compatible-responses")
            expect(requests[2]).toMatchObject({ responseType: "tool", toolName: "summarize_task" })
            expect(requestToolNames(requests[2])).toEqual(requestToolNames(requests[1]))
            expect(requestToolNames(requests[2])).not.toContain("summarize_task")
            expect(requests[2].contractError).toBeUndefined()
            expect(requests[3].contractError).toBeUndefined()
            await expect(sidebar.getByText("E2E_AUTO_COMPACT_OK", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await expectCompactionSummary(sidebar, "E2E_AUTO_COMPACT_SUMMARY preserves the task and latest user request.")
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Manual compaction - explicit /compact takes priority over an enabled automatic trigger",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(210_000)
        await configureAutoCompact(dlineDir, true)
        server.resetOpenAiMock()
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_manual_priority_history",
                name: "qna_respond",
                arguments: { response: "E2E_MANUAL_PRIORITY_HISTORY_READY" },
                expectedRequestIncludes: ["E2E_MANUAL_PRIORITY_TASK"],
            },
            {
                type: "tool",
                id: "call_manual_priority_ready",
                name: "qna_respond",
                arguments: { response: "E2E_MANUAL_PRIORITY_READY" },
                usage: { inputTokens: 70_000, outputTokens: 100 },
                expectedRequestIncludes: ["E2E_MANUAL_PRIORITY_LATEST"],
            },
            {
                type: "tool",
                id: "call_manual_priority_summary",
                name: "summarize_task",
                arguments: { context: "E2E_MANUAL_PRIORITY_SUMMARY preserves the latest manual guidance." },
                expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER, "E2E_MANUAL_PRIORITY_GUIDANCE"],
                expectedRequestExcludes: ["/compact"],
            },
            {
                type: "tool",
                id: "call_manual_priority_done",
                name: "attempt_completion",
                arguments: { result: "E2E_MANUAL_PRIORITY_DONE" },
                expectedRequestIncludes: ["E2E_MANUAL_PRIORITY_SUMMARY", "E2E_MANUAL_PRIORITY_REPLY"],
                expectedRequestExcludes: [COMPACT_INSTRUCTION_MARKER],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const { sidebar } = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_MANUAL_PRIORITY_TASK")
            await expect(sidebar.getByText("E2E_MANUAL_PRIORITY_HISTORY_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await sendTask(sidebar, "E2E_MANUAL_PRIORITY_LATEST")
            await expect(sidebar.getByText("E2E_MANUAL_PRIORITY_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })

            await sendTask(sidebar, "/compact E2E_MANUAL_PRIORITY_GUIDANCE")
            await expectManualCompactionLanded(sidebar, "E2E_MANUAL_PRIORITY_SUMMARY preserves the latest manual guidance.")
            expect(server.getRequestCount("openai-compatible-responses")).toBe(3)
            await sendTask(sidebar, "E2E_MANUAL_PRIORITY_REPLY")
            await expect(sidebar.getByText("E2E_MANUAL_PRIORITY_DONE", { exact: false }).last()).toBeVisible({ timeout: 60_000 })

            await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(4)
            const requests = server.getMockConsumptions("openai-compatible-responses")
            expect(requests[2]).toMatchObject({ responseType: "tool", toolName: "summarize_task" })
            expect(requestToolNames(requests[2])).toEqual(requestToolNames(requests[1]))
            expect(requestToolNames(requests[2])).not.toContain("summarize_task")
            expect(requests.slice(2).every((request) => request.contractError === undefined)).toBe(true)
            await expectCompactionSummary(sidebar, "E2E_MANUAL_PRIORITY_SUMMARY preserves the latest manual guidance.")
            await expect(sidebar.locator('vscode-button[aria-label="Condense Conversation"]')).toHaveCount(0)
            await expect(sidebar.locator('vscode-button[aria-label="Regenerate Summary"]')).toHaveCount(0)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Manual compaction - applies a returned summary without starting a second automatic compaction",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(210_000)
        await configureAutoCompact(dlineDir, true)
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_manual_accept_history",
                name: "qna_respond",
                arguments: { response: "E2E_MANUAL_ACCEPT_HISTORY_READY" },
                expectedRequestIncludes: ["E2E_MANUAL_ACCEPT_TASK"],
            },
            {
                type: "tool",
                id: "call_manual_accept_ready",
                name: "qna_respond",
                arguments: { response: "E2E_MANUAL_ACCEPT_READY" },
                usage: { inputTokens: 70_000, outputTokens: 100 },
                expectedRequestIncludes: ["E2E_MANUAL_ACCEPT_LATEST"],
            },
            {
                type: "tool",
                id: "call_manual_accept_summary",
                name: "summarize_task",
                arguments: { context: "E2E_MANUAL_ACCEPT_SUMMARY replaces the original high-context history." },
                usage: { inputTokens: 75_000, outputTokens: 100 },
                expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER, "E2E_MANUAL_ACCEPT_GUIDANCE"],
                expectedRequestExcludes: ["/compact"],
            },
            {
                type: "tool",
                id: "call_manual_accept_done",
                name: "attempt_completion",
                arguments: { result: "E2E_MANUAL_ACCEPT_DONE" },
                expectedRequestIncludes: ["E2E_MANUAL_ACCEPT_SUMMARY", "E2E_MANUAL_ACCEPT_REPLY"],
                expectedRequestExcludes: [COMPACT_INSTRUCTION_MARKER],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const { sidebar } = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_MANUAL_ACCEPT_TASK")
            await expect(sidebar.getByText("E2E_MANUAL_ACCEPT_HISTORY_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await sendTask(sidebar, "E2E_MANUAL_ACCEPT_LATEST")
            await expect(sidebar.getByText("E2E_MANUAL_ACCEPT_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })

            await sendTask(sidebar, "/compact E2E_MANUAL_ACCEPT_GUIDANCE")
            await expectManualCompactionLanded(sidebar, "E2E_MANUAL_ACCEPT_SUMMARY replaces the original high-context history.")
            expect(server.getRequestCount("openai-compatible-responses")).toBe(3)
            await sendTask(sidebar, "E2E_MANUAL_ACCEPT_REPLY")
            await expect(sidebar.getByText("E2E_MANUAL_ACCEPT_DONE", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(4)
            const requests = server.getMockConsumptions("openai-compatible-responses")

            expect(requests.slice(2).every((request) => request.contractError === undefined)).toBe(true)
            expect(requestToolNames(requests[3])).toEqual(requestToolNames(requests[2]))
            expect(requestToolNames(requests[3])).not.toContain("summarize_task")
            await expectCompactionSummary(sidebar, "E2E_MANUAL_ACCEPT_SUMMARY replaces the original high-context history.")
            await expect(sidebar.locator('vscode-button[aria-label="Condense Conversation"]')).toHaveCount(0)
            await expect(sidebar.locator('vscode-button[aria-label="Regenerate Summary"]')).toHaveCount(0)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Manual compaction - incomplete summary shows failure without exposing a partial preview",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(150_000)
        await configureAutoCompact(dlineDir, false)
        const partialSummary = "E2E_MANUAL_INCOMPLETE_PARTIAL_MUST_NOT_RENDER"
        // The whole summary streams, but neither </context> nor </summarize_task> ever arrives.
        const streamedCallPrefix = `<summarize_task>\n<context>\n${partialSummary}\n`
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_manual_incomplete_history",
                name: "qna_respond",
                arguments: { response: "E2E_MANUAL_INCOMPLETE_HISTORY_READY" },
                expectedRequestIncludes: ["E2E_MANUAL_INCOMPLETE_TASK"],
            },
            {
                type: "tool",
                id: "call_manual_incomplete_ready",
                name: "qna_respond",
                arguments: { response: "E2E_MANUAL_INCOMPLETE_READY" },
                usage: { inputTokens: 70_000, outputTokens: 100 },
                expectedRequestIncludes: ["E2E_MANUAL_INCOMPLETE_LATEST"],
            },
            {
                type: "truncated-tool",
                id: "call_manual_incomplete_summary",
                name: "summarize_task",
                arguments: { context: partialSummary },
                truncateAfter: streamedCallPrefix.length,
                expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER, "E2E_MANUAL_INCOMPLETE_GUIDANCE"],
                expectedRequestExcludes: ["/compact"],
            },
            // The max-output replay of the cut summary fails at the Provider, which ends the hidden Pass.
            {
                type: "error",
                status: 400,
                message: "E2E_MANUAL_INCOMPLETE_REPLAY_FAILURE",
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const { sidebar } = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_MANUAL_INCOMPLETE_TASK")
            await expect(sidebar.getByText("E2E_MANUAL_INCOMPLETE_HISTORY_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await sendTask(sidebar, "E2E_MANUAL_INCOMPLETE_LATEST")
            await expect(sidebar.getByText("E2E_MANUAL_INCOMPLETE_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await sendTask(sidebar, "/compact E2E_MANUAL_INCOMPLETE_GUIDANCE")

            await expect(sidebar.getByTestId("compaction-failure").last()).toBeVisible({
                timeout: 60_000,
            })
            await expect(sidebar.getByText(partialSummary, { exact: false })).not.toBeVisible()
            await expect(sidebar.locator('vscode-button[aria-label="Condense Conversation"]')).toHaveCount(0)
            await expect(sidebar.locator('vscode-button[aria-label="Regenerate Summary"]')).toHaveCount(0)
            await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(4)
            const requests = server.getMockConsumptions("openai-compatible-responses")
            expect(requests[2].responseType).toBe("truncated-tool")
            expect(requests[2].contractError).toBeUndefined()
            expect(requests[3].responseType).toBe("error")
            expect(JSON.stringify(requests[3].requestBody)).toContain("# Retry Reminder")
            expect(requests[2].requestToolResults).not.toContainEqual(
                expect.objectContaining({ callId: "call_manual_incomplete_summary" }),
            )

            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/max_output_tokens/])
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Automatic compaction - disabled sends the next turn directly",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(150_000)
        await configureAutoCompact(dlineDir, false)
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_auto_compact_disabled_ready",
                name: "qna_respond",
                arguments: { response: "E2E_AUTO_COMPACT_DISABLED_READY" },
                usage: { inputTokens: 125_000, outputTokens: 100 },
            },
            {
                type: "tool",
                id: "call_auto_compact_disabled_completion",
                name: "attempt_completion",
                arguments: { result: "E2E_AUTO_COMPACT_DISABLED_OK" },
                expectedRequestIncludes: ["E2E_AUTO_COMPACT_DISABLED_CONTINUE"],
                expectedRequestExcludes: [COMPACT_SIGNAL, COMPACT_INSTRUCTION_MARKER],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const { sidebar } = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_AUTO_COMPACT_DISABLED_TASK")
            await expect(sidebar.getByText("E2E_AUTO_COMPACT_DISABLED_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await sendTask(sidebar, "E2E_AUTO_COMPACT_DISABLED_CONTINUE")
            await expect(sidebar.getByText("E2E_AUTO_COMPACT_DISABLED_OK", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })

            await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(2)
            const secondRequest = server.getMockConsumptions("openai-compatible-responses")[1]
            expect(requestToolNames(secondRequest)).not.toEqual(["summarize_task"])
            expect(secondRequest.contractError).toBeUndefined()
            await expectNoInternalCompactionEcho(sidebar)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Manual compaction - header control dispatches once and reduces context usage",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configureAutoCompact(dlineDir, false)
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_manual_compact_history",
                name: "qna_respond",
                arguments: { response: "E2E_MANUAL_COMPACT_HISTORY_READY" },
                expectedRequestIncludes: ["E2E_MANUAL_COMPACT_TASK"],
            },
            {
                type: "tool",
                id: "call_manual_compact_ready",
                name: "qna_respond",
                arguments: { response: "E2E_MANUAL_COMPACT_READY" },
                usage: { inputTokens: 80_000, outputTokens: 100 },
                expectedRequestIncludes: ["E2E_MANUAL_COMPACT_LATEST"],
            },
            {
                type: "tool",
                id: "call_manual_compact_summary",
                name: "summarize_task",
                arguments: { context: "E2E_MANUAL_COMPACT_SUMMARY preserves the task and current intent." },
                delayMs: 1_500,
                expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER, "E2E_MANUAL_COMPACT_TASK"],
                expectedRequestExcludes: [COMPACT_SIGNAL, "/compact"],
            },
            {
                // The question stays open after the summary, so the draft the user
                // kept in the composer is its answer.
                type: "tool",
                id: "call_manual_compact_completion",
                name: "attempt_completion",
                arguments: { result: "E2E_MANUAL_COMPACT_DONE" },
                usage: { inputTokens: 1_200, outputTokens: 100 },
                expectedRequestIncludes: ["E2E_MANUAL_COMPACT_SUMMARY", "E2E_MANUAL_COMPACT_PRESERVED_DRAFT"],
                expectedRequestExcludes: [COMPACT_SIGNAL, COMPACT_INSTRUCTION_MARKER],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const { page, sidebar } = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_MANUAL_COMPACT_TASK")
            await expect(sidebar.getByText("E2E_MANUAL_COMPACT_HISTORY_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await sendTask(sidebar, "E2E_MANUAL_COMPACT_LATEST")
            await expect(sidebar.getByText("E2E_MANUAL_COMPACT_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })

            const input = sidebar.getByTestId("chat-input")
            await input.fill("E2E_MANUAL_COMPACT_PRESERVED_DRAFT")
            // A delayed activity-bar hover can cover the header after the pointer has left it.
            await E2ETestHelper.dismissWorkbenchHover(page)
            const expandTaskHeader = sidebar.getByLabel("Expand task header")
            if (await expandTaskHeader.isVisible()) await expandTaskHeader.click()
            const progress = sidebar.getByRole("progressbar", { name: "Context window usage progress" })
            await expect.poll(async () => Number(await progress.getAttribute("aria-valuenow"))).toBeGreaterThan(60_000)
            const beforeCompact = Number(await progress.getAttribute("aria-valuenow"))

            const compactButton = sidebar.locator("button").filter({
                has: sidebar.locator("svg.lucide-fold-vertical"),
            })
            await expect(compactButton).toBeVisible()
            await compactButton.click()
            await expect(sidebar.getByText("Compact the current task?", { exact: true })).toBeVisible()
            await sidebar.getByTitle("Yes, compact the task").click()
            await expect(compactButton).toBeVisible()
            await expect(compactButton).toHaveAttribute("aria-disabled", "true")
            await expectManualCompactionLanded(sidebar, "E2E_MANUAL_COMPACT_SUMMARY preserves the task and current intent.")
            await expectComposerText(input, "E2E_MANUAL_COMPACT_PRESERVED_DRAFT")
            await expect(compactButton).toHaveAttribute("aria-disabled", "false")
            // The header compacted beside the open question and started no round of its own.
            expect(server.getRequestCount("openai-compatible-responses")).toBe(3)
            const compactedRequests = server.getMockConsumptions("openai-compatible-responses")
            expect(compactedRequests[2]).toMatchObject({ responseType: "tool", toolName: "summarize_task" })
            expect(requestToolNames(compactedRequests[2])).toEqual(requestToolNames(compactedRequests[1]))
            expect(requestToolNames(compactedRequests[2])).not.toContain("summarize_task")
            expect(compactedRequests[2].contractError).toBeUndefined()
            await sidebar.getByTestId("send-button").click()

            await expect(sidebar.getByText("E2E_MANUAL_COMPACT_DONE", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(4)
            expect(server.getMockConsumptions("openai-compatible-responses")[3].contractError).toBeUndefined()
            await expectCompactionSummary(sidebar, "E2E_MANUAL_COMPACT_SUMMARY preserves the task and current intent.")
            await expect(sidebar.getByText("/compact", { exact: true })).toHaveCount(0)
            await expect.poll(async () => Number(await progress.getAttribute("aria-valuenow"))).toBeLessThan(beforeCompact)
            await expectComposerText(input, "")
            await expect(compactButton).toBeVisible()
            await expect(compactButton).toHaveAttribute("aria-disabled", "false")
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Manual compaction - /compact applies once and the next Enter is a normal user turn",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(210_000)
        await configureAutoCompact(dlineDir, false)
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_manual_followup_history",
                name: "qna_respond",
                arguments: { response: "E2E_MANUAL_FOLLOWUP_HISTORY_READY" },
                expectedRequestIncludes: ["E2E_MANUAL_FOLLOWUP_TASK"],
            },
            {
                type: "tool",
                id: "call_manual_followup_ready",
                name: "qna_respond",
                arguments: { response: "E2E_MANUAL_FOLLOWUP_READY" },
                expectedRequestIncludes: ["E2E_MANUAL_FOLLOWUP_LATEST"],
            },
            {
                type: "tool",
                id: "call_manual_followup_summary",
                name: "summarize_task",
                arguments: { context: "E2E_MANUAL_FOLLOWUP_SUMMARY keeps the command decisions and unresolved failures." },
                expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER, "E2E_MANUAL_FOLLOWUP_GUIDANCE"],
                expectedRequestExcludes: ["/compact"],
            },
            {
                type: "tool",
                id: "call_manual_followup_done",
                name: "attempt_completion",
                arguments: { result: "E2E_MANUAL_FOLLOWUP_DONE" },
                expectedRequestIncludes: ["E2E_MANUAL_FOLLOWUP_SUMMARY", "E2E_MANUAL_FOLLOWUP_MESSAGE"],
                expectedRequestExcludes: [COMPACT_INSTRUCTION_MARKER],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const { sidebar } = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_MANUAL_FOLLOWUP_TASK")
            await expect(sidebar.getByText("E2E_MANUAL_FOLLOWUP_HISTORY_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await sendTask(sidebar, "E2E_MANUAL_FOLLOWUP_LATEST")
            await expect(sidebar.getByText("E2E_MANUAL_FOLLOWUP_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })

            await sendTask(sidebar, "/compact E2E_MANUAL_FOLLOWUP_GUIDANCE")
            await expectManualCompactionLanded(
                sidebar,
                "E2E_MANUAL_FOLLOWUP_SUMMARY keeps the command decisions and unresolved failures.",
            )
            // Landing starts no round: the open question waits for the next Enter.
            expect(server.getRequestCount("openai-compatible-responses")).toBe(3)
            await expectCompactionSummary(
                sidebar,
                "E2E_MANUAL_FOLLOWUP_SUMMARY keeps the command decisions and unresolved failures.",
            )
            await expect(sidebar.locator('vscode-button[aria-label="Condense Conversation"]')).toHaveCount(0)
            await expect(sidebar.locator('vscode-button[aria-label="Regenerate Summary"]')).toHaveCount(0)

            const input = sidebar.getByTestId("chat-input")
            await input.fill("E2E_MANUAL_FOLLOWUP_MESSAGE")
            await input.press("Enter")
            await expectComposerText(input, "")
            await expect(sidebar.getByText("E2E_MANUAL_FOLLOWUP_MESSAGE", { exact: true }).last()).toBeVisible()
            await expect(sidebar.getByText("E2E_MANUAL_FOLLOWUP_DONE", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(4)
            const requests = server.getMockConsumptions("openai-compatible-responses")
            expect(requests.slice(1).every((request) => request.contractError === undefined)).toBe(true)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)
