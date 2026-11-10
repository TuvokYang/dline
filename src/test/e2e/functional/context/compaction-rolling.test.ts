import { readFile, writeFile } from "node:fs/promises"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import {
    closeCurrentTask,
    configureResponsesAutoCompaction,
    configureTriggerBoundary,
    onlyTaskId,
    openSidebar,
    profilesPath,
    readPersistedCompactionCards,
    reopenTask,
    type StoredCompactionProfile as StoredProfile,
    seedLargeCompactionHistory,
    sendTask,
    settingsPath,
    submitTask,
} from "@e2e/utils/compaction-fixture"
import {
    countOccurrences,
    estimateTokens,
    expectCompactedContinuation,
    expectCompactionSource,
    expectCompleteToolPairing,
    expectLatestUserOnce,
} from "@e2e/utils/compaction-request-oracle"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { readTaskConversation, readTaskUiMessagesText } from "@e2e/utils/task-instance-store"
import { expect } from "@playwright/test"
import type { ElectronApplication } from "playwright"

interface RollingMergeProviderCase {
    label: string
    profileName: string
    target: "openai-compatible-chat" | "openai-compatible-responses" | "anthropic-messages" | "deepseek-chat"
    modelId: string
    providerConfigKey: "openai" | "anthropic" | "deepseek"
}

const ROLLING_MERGE_PROVIDER_CASES: readonly RollingMergeProviderCase[] = [
    {
        label: "OpenAI Chat Completion",
        profileName: E2E_PROFILE_NAMES.mockOpenAi,
        target: "openai-compatible-chat",
        modelId: "gpt-5.6-sol",
        providerConfigKey: "openai",
    },
    {
        label: "OpenAI Responses",
        profileName: E2E_PROFILE_NAMES.mockOpenAiResponses,
        target: "openai-compatible-responses",
        modelId: "gpt-5.6-sol",
        providerConfigKey: "openai",
    },
    {
        label: "Anthropic Messages",
        profileName: E2E_PROFILE_NAMES.mockAnthropic,
        target: "anthropic-messages",
        modelId: "claude-sonnet-4-6",
        providerConfigKey: "anthropic",
    },
    {
        label: "DeepSeek Chat",
        profileName: E2E_PROFILE_NAMES.mockDeepSeek,
        target: "deepseek-chat",
        modelId: "deepseek-v4-flash",
        providerConfigKey: "deepseek",
    },
]

async function configureRollingMergeTarget(dlineDir: string, providerCase: RollingMergeProviderCase): Promise<void> {
    const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
    const profile = profiles.find((candidate) => candidate.name === providerCase.profileName)
    if (!profile) throw new Error(`Missing configurable E2E profile: ${providerCase.profileName}`)
    profile.modelId = providerCase.modelId
    const providerConfig = profile[providerCase.providerConfigKey] ?? {}
    profile[providerCase.providerConfigKey] = {
        ...providerConfig,
        capabilities: {
            ...(providerConfig.capabilities ?? {}),
            contextWindow: 1_000_000,
            maxTokens: 8_192,
        },
    }
    profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
    await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

    const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
    await writeFile(
        settingsPath(dlineDir),
        `${JSON.stringify(
            {
                ...settings,
                actModeProfile: providerCase.profileName,
                planModeProfile: providerCase.profileName,
                useAutoCondense: true,
                autoCondenseTriggerPercent: 97,
                autoCondenseMaxContextTokens: 272_000,
            },
            null,
            2,
        )}\n`,
        "utf8",
    )
}

e2e(
    "OpenAI compaction - iterates until the projected context is below 80 percent",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(240_000)
        await configureResponsesAutoCompaction(dlineDir)
        const taskText = "E2E_ITERATIVE_TASK"
        const userB = "E2E_ITERATIVE_USER_TURN_B"
        const userC = "E2E_ITERATIVE_USER_TURN_C"
        const turnAMarker = "E2E_ITERATIVE_TURN_A"
        const turnBMarker = "E2E_ITERATIVE_TURN_B"
        const turnCMarker = "E2E_ITERATIVE_TURN_C"
        const continuationMarker = "E2E_ITERATIVE_CONTINUE"
        const latestMarker = "E2E_ITERATIVE_LATEST_USER_PROTECTED"
        const latestUser = continuationMarker + "\n" + latestMarker + ":" + "P".repeat(80_000)
        const firstSummary = "E2E_ITERATIVE_SUMMARY_ONE covers only turn A."
        const secondSummary = "E2E_ITERATIVE_SUMMARY_TWO cumulatively covers turns A, B and C."
        const turnAResponse = turnAMarker + ":" + "A".repeat(160_000)
        const turnBResponse = turnBMarker + ":" + "B".repeat(220_000)
        const turnCResponse = turnCMarker + ":" + "C".repeat(80_000)
        const turns = [
            { callId: "call_iterative_turn_a", user: taskText, response: turnAResponse },
            { callId: "call_iterative_turn_b", user: userB, response: turnBResponse },
            { callId: "call_iterative_turn_c", user: userC, response: turnCResponse },
        ]
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: turns[0].callId,
                name: "qna_respond",
                arguments: { response: turnAResponse },
                usage: { inputTokens: 20_000, outputTokens: 100 },
                expectedRequestIncludes: [taskText],
                matchRequestContract: true,
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: turns[1].callId,
                name: "qna_respond",
                arguments: { response: turnBResponse },
                usage: { inputTokens: 40_000, outputTokens: 100 },
                expectedRequestIncludes: [turnAMarker, userB],
                matchRequestContract: true,
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: turns[2].callId,
                name: "qna_respond",
                arguments: { response: turnCResponse },
                usage: { inputTokens: 55_000, outputTokens: 100 },
                expectedRequestIncludes: [firstSummary, turnBMarker, userC],
                expectedRequestExcludes: [turnAMarker],
                matchRequestContract: true,
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_iterative_summary_one",
                name: "summarize_task",
                arguments: { context: firstSummary },
                usage: { inputTokens: 112_000, outputTokens: 100 },
                expectedRequestIncludes: [taskText, turnAMarker],
                expectedRequestExcludes: [turnBMarker, turnCMarker, userC, latestMarker, continuationMarker],
                matchRequestContract: true,
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_iterative_summary_two",
                name: "summarize_task",
                arguments: { context: secondSummary },
                delayMs: 2_000,
                usage: { inputTokens: 75_000, outputTokens: 100 },
                expectedRequestIncludes: [firstSummary, userB, turnBMarker, userC, turnCMarker],
                expectedRequestExcludes: [turnAMarker, latestMarker, continuationMarker],
                matchRequestContract: true,
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_iterative_complete",
                name: "attempt_completion",
                arguments: { result: "E2E_ITERATIVE_OK" },
                expectedRequestIncludes: [secondSummary, latestMarker, continuationMarker],
                expectedRequestExcludes: [firstSummary, turnAMarker, turnBMarker, turnCMarker],
                matchRequestContract: true,
                requireCompleteToolPairing: true,
            },
        )
        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await openSidebar(app, helper)
            await sendTask(sidebar, taskText)
            await expect(sidebar.getByText(turnAMarker, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await submitTask(sidebar, userB)
            await expect(sidebar.getByText(turnBMarker, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await submitTask(sidebar, userC)
            await expect(sidebar.getByText(turnCMarker, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(4)
            const beforeContinuation = server.getMockConsumptions("openai-compatible-responses")
            const firstPass = beforeContinuation[2]
            const turnC = beforeContinuation[3]
            expectCompactionSource(firstPass, {
                turns: [turns[0]],
                excluded: [turnBMarker, turnCMarker, userB, userC, latestMarker, continuationMarker],
                contextWindow: 100_000,
            })
            expect(turnC).toMatchObject({ responseType: "tool", toolName: "qna_respond" })
            expectCompleteToolPairing(turnC, [turns[1].callId])
            expectLatestUserOnce(turnC, userC, userC)
            const ordinaryText = JSON.stringify(turnC.requestBody)
            expect(ordinaryText).toContain(firstSummary)
            expect(ordinaryText).toContain(turnBResponse)
            expect(ordinaryText).not.toContain(turnAMarker)
            expect(estimateTokens(turnC.requestBody)).toBeLessThan(80_000)

            await submitTask(sidebar, latestUser)
            await expect
                .poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 60_000 })
                .toBeGreaterThanOrEqual(5)
            const secondPass = server.getMockConsumptions("openai-compatible-responses")[4]
            expectCompactionSource(secondPass, {
                turns: [turns[1], turns[2]],
                carry: firstSummary,
                excluded: [turnAMarker, latestMarker, continuationMarker],
                contextWindow: 100_000,
            })
            await expect(sidebar.getByText("E2E_ITERATIVE_OK", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(6)
            expectCompactedContinuation(server.getMockConsumptions("openai-compatible-responses")[5], {
                summary: secondSummary,
                latestUser,
                latestMarker,
                excluded: [firstSummary, turnAMarker, turnBMarker, turnCMarker],
                tokenLimit: 80_000,
            })
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "BUG-011 compaction - approximately 800K source refits a 600K first projection and completes Pass 2",
    async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(360_000)
        await configureTriggerBoundary(dlineDir, 472_000, 0, 5_000, 30_000, 95)
        const taskText = "E2E_BUG011_800K_TASK"
        const turnAMarker = "E2E_BUG011_800K_TURN_A"
        const turnBMarker = "E2E_BUG011_800K_TURN_B"
        const continuationMarker = "E2E_BUG011_800K_CONTINUE"
        const firstSummaryMarker = "E2E_BUG011_800K_SUMMARY_ONE"
        const refitSummaryMarker = "E2E_BUG011_800K_REFITTED"
        const finalSummary = "E2E_BUG011_800K_FINAL_SUMMARY preserves both complete logical turns."
        const firstSummary = `${firstSummaryMarker}:${"S".repeat(800_000)}`
        const refittedSummary = `${refitSummaryMarker}:${"R".repeat(80_000)}`
        const turnPayload = "x".repeat(1_570_000)
        const textTurns = [
            { user: turnAMarker + "_USER", response: turnAMarker + ":" + turnPayload },
            { user: turnBMarker + "_USER", response: turnBMarker + ":" + turnPayload },
        ]

        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_bug011_800k_setup",
                name: "qna_respond",
                arguments: { response: "E2E_BUG011_800K_SETUP_READY" },
                usage: { inputTokens: 1_000, outputTokens: 100 },
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_bug011_800k_pass_1",
                name: "summarize_task",
                arguments: { context: firstSummary },
                expectedRequestIncludes: ["The current conversation is rapidly running out of context", turnAMarker],
                expectedRequestExcludes: [turnBMarker, continuationMarker, "# Summary Refit"],
                matchRequestContract: true,
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_bug011_800k_refit",
                name: "summarize_task",
                arguments: { context: refittedSummary },
                expectedRequestIncludes: ["# Summary Refit", firstSummaryMarker],
                expectedRequestExcludes: [turnAMarker, turnBMarker, continuationMarker],
                matchRequestContract: true,
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_bug011_800k_pass_2",
                name: "summarize_task",
                arguments: { context: finalSummary },
                expectedRequestIncludes: [
                    "The current conversation is rapidly running out of context",
                    refitSummaryMarker,
                    turnBMarker,
                ],
                expectedRequestExcludes: [turnAMarker, firstSummaryMarker, continuationMarker, "# Summary Refit"],
                matchRequestContract: true,
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_bug011_800k_complete",
                name: "attempt_completion",
                arguments: { result: "E2E_BUG011_800K_OK" },
                expectedRequestIncludes: [finalSummary, continuationMarker],
                expectedRequestExcludes: [turnAMarker, turnBMarker, firstSummaryMarker, refitSummaryMarker],
                matchRequestContract: true,
                requireCompleteToolPairing: true,
            },
        )

        let firstApp: ElectronApplication | undefined
        let resumedApp: ElectronApplication | undefined
        try {
            firstApp = await openVSCode(workspaceDir)
            const first = await openSidebar(firstApp, helper)
            await sendTask(first, taskText)
            await expect(first.getByText("E2E_BUG011_800K_SETUP_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await closeCurrentTask(first)
            await firstApp.close()
            firstApp = undefined
            helper.clearCachedFrame()

            const taskId = await onlyTaskId(dlineDocsDir)
            const seededTokens = await seedLargeCompactionHistory(
                dlineDocsDir,
                taskId,
                textTurns.map((turn) => ({ user: turn.user, assistant: turn.response })),
            )
            expect(seededTokens).toBeGreaterThan(780_000)
            expect(seededTokens).toBeLessThan(820_000)

            resumedApp = await openVSCode(workspaceDir)
            const page = await resumedApp.firstWindow()
            await E2ETestHelper.openClineSidebar(page)
            const sidebar = await helper.getSidebar(page)
            await E2ETestHelper.dismissWhatsNewModal(sidebar)
            await helper.signin(sidebar)
            await reopenTask(page, sidebar, taskText)
            await submitTask(sidebar, continuationMarker)
            await expect(sidebar.getByText("E2E_BUG011_800K_OK", { exact: false }).last()).toBeVisible({ timeout: 180_000 })

            await expect.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 180_000 }).toBe(5)
            const requests = server.getMockConsumptions("openai-compatible-responses")
            expect(requests.slice(1).map((request) => request.toolName)).toEqual([
                "summarize_task",
                "summarize_task",
                "summarize_task",
                "attempt_completion",
            ])
            expectCompactionSource(requests[1], {
                turns: [],
                textTurns: [textTurns[0]],
                excluded: [turnBMarker, continuationMarker, firstSummaryMarker, refitSummaryMarker],
                contextWindow: 472_000,
            })
            expectCompactionSource(requests[2], {
                turns: [],
                carry: firstSummary,
                excluded: [turnAMarker, turnBMarker, continuationMarker, refitSummaryMarker],
                contextWindow: 472_000,
            })
            expectCompactionSource(requests[3], {
                turns: [],
                textTurns: [textTurns[1]],
                carry: refittedSummary,
                excluded: [turnAMarker, firstSummaryMarker, continuationMarker],
                contextWindow: 472_000,
            })
            expectCompactedContinuation(requests[4], {
                summary: finalSummary,
                latestUser: continuationMarker,
                latestMarker: continuationMarker,
                excluded: [turnAMarker, turnBMarker, firstSummaryMarker, refitSummaryMarker],
                tokenLimit: 472_000 * 0.8,
            })
            const firstProjectionTokens = estimateTokens({
                systemPrompt: "",
                messages: [
                    { role: "user", content: [{ type: "text", text: firstSummary }] },
                    { role: "user", content: [{ type: "text", text: `${turnBMarker}_USER` }] },
                    { role: "assistant", content: [{ type: "text", text: `${turnBMarker}:${turnPayload}` }] },
                ],
                tools: [],
                serverTools: [],
            })
            expect(firstProjectionTokens).toBeGreaterThan(570_000)
            expect(firstProjectionTokens).toBeLessThan(630_000)

            const pass0 = sidebar.locator(
                '[data-testid="compaction-pass"][data-compaction-unit-kind="pass"][data-compaction-unit-index="0"]',
            )
            const refit0 = sidebar.locator(
                '[data-testid="compaction-pass"][data-compaction-unit-kind="summary_refit"][data-compaction-unit-index="0"]',
            )
            const pass1 = sidebar.locator(
                '[data-testid="compaction-pass"][data-compaction-unit-kind="pass"][data-compaction-unit-index="1"]',
            )
            await expect(pass0).toHaveAttribute("data-compaction-status", "completed")
            await expect(refit0).toHaveAttribute("data-compaction-status", "completed")
            await expect(pass1).toHaveAttribute("data-compaction-status", "completed")
            await expect(pass0).toContainText(firstSummaryMarker)
            await expect(refit0).toContainText(refitSummaryMarker)
            await expect(pass1).toContainText("E2E_BUG011_800K_FINAL_SUMMARY")

            const persistedCards = await E2ETestHelper.waitForValue(async () => {
                const cards = await readPersistedCompactionCards(dlineDocsDir, taskId)
                return cards.length >= 3 ? cards : undefined
            }, 30_000)
            expect(
                persistedCards.map((card) => ({
                    kind: card.compactionUnitKind,
                    index: card.compactionUnitIndex,
                    status: card.compactionStatus,
                })),
            ).toEqual(
                expect.arrayContaining([
                    { kind: "pass", index: 0, status: "completed" },
                    { kind: "summary_refit", index: 0, status: "completed" },
                    { kind: "pass", index: 1, status: "completed" },
                ]),
            )
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await firstApp?.close()
            await resumedApp?.close()
        }
    },
)

for (const providerCase of ROLLING_MERGE_PROVIDER_CASES) {
    e2e(
        "Context compaction - " + providerCase.label + " rolling merge preserves complete logical-turn request content",
        async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
            e2e.setTimeout(300_000)
            await configureRollingMergeTarget(dlineDir, providerCase)
            const taskText = "E2E_ROLLING_TASK"
            const userB = "E2E_ROLLING_USER_TURN_B"
            const userC = "E2E_ROLLING_USER_TURN_C"
            const turnAMarker = "E2E_ROLLING_TURN_A"
            const turnBMarker = "E2E_ROLLING_TURN_B"
            const turnCMarker = "E2E_ROLLING_TURN_C"
            const continuationMarker = "E2E_ROLLING_CONTINUATION"
            const latestMarker = "E2E_ROLLING_LATEST_USER_PROTECTED"
            const latestUser = continuationMarker + "\n" + latestMarker + ":" + "P".repeat(360_000)
            const firstSummary = "E2E_ROLLING_SUMMARY_ONE covers only turn A."
            const secondSummary = "E2E_ROLLING_SUMMARY_TWO cumulatively covers turns A, B and C."
            // W=272K, T=258,340, crossing allowance=262,420 and stop line=217,600.
            // A+B exceeds a Pass; B+C fits whole. The independent latest input keeps the first
            // projection over the stop line but must never enter either hidden source request.
            const turnAResponse = turnAMarker + ":" + "A".repeat(520_000)
            const turnBResponse = turnBMarker + ":" + "B".repeat(520_000)
            const turnCResponse = turnCMarker + ":" + "C".repeat(360_000)
            const turns = [
                { callId: "call_rolling_turn_a", user: taskText, response: turnAResponse },
                { callId: "call_rolling_turn_b", user: userB, response: turnBResponse },
                { callId: "call_rolling_turn_c", user: userC, response: turnCResponse },
            ]
            server.enqueueResponses(
                providerCase.target,
                {
                    type: "tool",
                    id: turns[0].callId,
                    name: "qna_respond",
                    arguments: { response: turnAResponse },
                    usage: { inputTokens: 120_000, outputTokens: 100 },
                    expectedRequestIncludes: [taskText],
                    matchRequestContract: true,
                    requireCompleteToolPairing: true,
                },
                {
                    type: "tool",
                    id: turns[1].callId,
                    name: "qna_respond",
                    arguments: { response: turnBResponse },
                    // Keep the next ordinary request under T while A+B remains too large for a Pass.
                    usage: { inputTokens: 100_000, outputTokens: 100 },
                    expectedRequestIncludes: [turnAMarker, userB],
                    matchRequestContract: true,
                    requireCompleteToolPairing: true,
                },
                {
                    type: "tool",
                    id: turns[2].callId,
                    name: "qna_respond",
                    arguments: { response: turnCResponse },
                    usage: { inputTokens: 380_000, outputTokens: 100 },
                    expectedRequestIncludes: [turnBMarker, userC],
                    matchRequestContract: true,
                    requireCompleteToolPairing: true,
                },
                {
                    type: "tool",
                    id: "call_rolling_summary_one",
                    name: "summarize_task",
                    arguments: { context: firstSummary },
                    usage: { inputTokens: 700_000, outputTokens: 100 },
                    expectedRequestIncludes: [taskText, turnAMarker],
                    expectedRequestExcludes: [userB, userC, turnBMarker, turnCMarker, latestMarker, continuationMarker],
                    matchRequestContract: true,
                    requireCompleteToolPairing: true,
                },
                {
                    type: "tool",
                    id: "call_rolling_summary_two",
                    name: "summarize_task",
                    arguments: { context: secondSummary },
                    ...(providerCase.target === "openai-compatible-responses" ? { delayMs: 8_000 } : {}),
                    usage: { inputTokens: 217_600, outputTokens: 100 },
                    expectedRequestIncludes: [firstSummary, userB, turnBMarker, userC, turnCMarker],
                    expectedRequestExcludes: [turnAMarker, latestMarker, continuationMarker],
                    matchRequestContract: true,
                    requireCompleteToolPairing: true,
                },
                {
                    type: "tool",
                    id: "call_rolling_complete",
                    name: "attempt_completion",
                    arguments: { result: "E2E_ROLLING_MERGE_OK" },
                    expectedRequestIncludes: [secondSummary, latestMarker, continuationMarker],
                    expectedRequestExcludes: [firstSummary, turnAMarker, turnBMarker, turnCMarker],
                    matchRequestContract: true,
                    requireCompleteToolPairing: true,
                },
            )
            const app = await openVSCode(workspaceDir)
            try {
                const sidebar = await openSidebar(app, helper)
                await sendTask(sidebar, taskText)
                await expect(sidebar.getByText(turnAMarker, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
                await submitTask(sidebar, userB)
                await expect(sidebar.getByText(turnBMarker, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
                await submitTask(sidebar, userC)
                await expect(sidebar.getByText(turnCMarker, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
                await submitTask(sidebar, latestUser)
                await expect
                    .poll(() => server.getRequestCount(providerCase.target), { timeout: 60_000 })
                    .toBeGreaterThanOrEqual(4)
                expectCompactionSource(server.getMockConsumptions(providerCase.target)[3], {
                    turns: [turns[0]],
                    excluded: [userB, userC, turnBMarker, turnCMarker, latestMarker, continuationMarker],
                    contextWindow: 272_000,
                })
                if (providerCase.target === "openai-compatible-responses") {
                    const taskId = await onlyTaskId(dlineDocsDir)
                    const checkpoint = await E2ETestHelper.waitForValue(async () => {
                        const conversation = JSON.stringify(await readTaskConversation(dlineDocsDir, taskId))
                        return conversation.includes(firstSummary) ? conversation : undefined
                    }, 30_000)
                    expect(checkpoint).not.toContain(turnAMarker)
                    expect(checkpoint).toContain(turnBResponse)
                    expect(checkpoint).toContain(turnCResponse)
                }
                await expect
                    .poll(() => server.getRequestCount(providerCase.target), { timeout: 60_000 })
                    .toBeGreaterThanOrEqual(5)
                expectCompactionSource(server.getMockConsumptions(providerCase.target)[4], {
                    turns: [turns[1], turns[2]],
                    carry: firstSummary,
                    excluded: [turnAMarker, latestMarker, continuationMarker],
                    contextWindow: 272_000,
                })
                await expect(sidebar.getByText("E2E_ROLLING_MERGE_OK", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
                await expect.poll(() => server.getRequestCount(providerCase.target)).toBe(6)
                expectCompactedContinuation(server.getMockConsumptions(providerCase.target)[5], {
                    summary: secondSummary,
                    latestUser,
                    latestMarker,
                    excluded: [firstSummary, turnAMarker, turnBMarker, turnCMarker],
                    tokenLimit: 217_600,
                })
                await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
            } finally {
                await app.close()
            }
        },
    )
}

e2e(
    "Context compaction - closing during Pass 2 resumes from the canonical Pass 1 checkpoint",
    async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(300_000)
        const providerCase = ROLLING_MERGE_PROVIDER_CASES.find((candidate) => candidate.target === "openai-compatible-responses")
        if (!providerCase) throw new Error("Missing OpenAI Responses rolling provider case")
        await configureRollingMergeTarget(dlineDir, providerCase)
        const taskText = "E2E_ROLLING_RESTART_TASK"
        const userB = "E2E_ROLLING_RESTART_USER_B"
        const userC = "E2E_ROLLING_RESTART_USER_C"
        const turnAMarker = "E2E_ROLLING_RESTART_TURN_A"
        const turnBMarker = "E2E_ROLLING_RESTART_TURN_B"
        const turnCMarker = "E2E_ROLLING_RESTART_TURN_C"
        const continuation = "E2E_ROLLING_RESTART_CONTINUE"
        const latestMarker = "E2E_ROLLING_RESTART_LATEST_USER_PROTECTED"
        // Preserve the original continuation volume at its actual user-input boundary, not in C's
        // already-complete assistant response. The restored Pass 1 candidate fits W, not the 80% stop line.
        const latestUser = continuation + "\n" + latestMarker + ":" + "P".repeat(300_000)
        const firstSummary = "E2E_ROLLING_RESTART_SUMMARY_ONE covers turn A."
        const abortedSummary = "E2E_ROLLING_RESTART_ABORTED_SUMMARY"
        const turnAResponse = turnAMarker + ":" + "A".repeat(520_000)
        const turnBResponse = turnBMarker + ":" + "B".repeat(520_000)
        // Calibrated B+C requires Pass 2, while B+C+latestUser still fits after restarting.
        const turnCResponse = turnCMarker + ":" + "C".repeat(100_000)
        const turns = [
            { callId: "call_rolling_restart_turn_a", user: taskText, response: turnAResponse },
            { callId: "call_rolling_restart_turn_b", user: userB, response: turnBResponse },
            { callId: "call_rolling_restart_turn_c", user: userC, response: turnCResponse },
        ]
        server.enqueueResponses(
            providerCase.target,
            {
                type: "tool",
                id: turns[0].callId,
                name: "qna_respond",
                arguments: { response: turnAResponse },
                usage: { inputTokens: 120_000, outputTokens: 100 },
                expectedRequestIncludes: [taskText],
                matchRequestContract: true,
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: turns[1].callId,
                name: "qna_respond",
                arguments: { response: turnBResponse },
                usage: { inputTokens: 130_000, outputTokens: 100 },
                expectedRequestIncludes: [turnAMarker, userB],
                matchRequestContract: true,
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: turns[2].callId,
                name: "qna_respond",
                arguments: { response: turnCResponse },
                // Preserve the A-only first Pass and the second Pass under usage-based token calibration.
                usage: { inputTokens: 500_000, outputTokens: 100 },
                expectedRequestIncludes: [turnBMarker, userC],
                matchRequestContract: true,
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_rolling_restart_summary_one",
                name: "summarize_task",
                arguments: { context: firstSummary },
                usage: { inputTokens: 700_000, outputTokens: 100 },
                expectedRequestIncludes: [turnAMarker],
                expectedRequestExcludes: [userB, userC, turnBMarker, turnCMarker, latestMarker, continuation],
                matchRequestContract: true,
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_rolling_restart_aborted_pass_two",
                name: "summarize_task",
                arguments: { context: abortedSummary },
                delayMs: 60_000,
                expectedRequestIncludes: [firstSummary, userB, turnBMarker, userC, turnCMarker],
                expectedRequestExcludes: [turnAMarker, latestMarker, continuation],
                matchRequestContract: true,
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_rolling_restart_complete",
                name: "attempt_completion",
                arguments: { result: "E2E_ROLLING_RESTART_OK" },
                expectedRequestIncludes: [firstSummary, turnBMarker, turnCMarker, latestMarker, continuation],
                expectedRequestExcludes: [turnAMarker, abortedSummary],
                matchRequestContract: true,
                requireCompleteToolPairing: true,
            },
        )
        let firstApp: ElectronApplication | undefined
        let resumedApp: ElectronApplication | undefined
        try {
            firstApp = await openVSCode(workspaceDir)
            const first = await openSidebar(firstApp, helper)
            await sendTask(first, taskText)
            await expect(first.getByText(turnAMarker, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await submitTask(first, userB)
            await expect(first.getByText(turnBMarker, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await submitTask(first, userC)
            await expect(first.getByText(turnCMarker, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await submitTask(first, latestUser)
            const taskId = await onlyTaskId(dlineDocsDir)
            const checkpoint = await E2ETestHelper.waitForValue(async () => {
                const projected = JSON.stringify(await readTaskConversation(dlineDocsDir, taskId))
                return projected.includes(firstSummary) && !projected.includes(turnAMarker) ? projected : undefined
            }, 30_000)
            expect(checkpoint).toContain(turnBResponse)
            expect(checkpoint).toContain(turnCResponse)
            expect(checkpoint).not.toContain(abortedSummary)
            await expect.poll(() => server.getRequestCount(providerCase.target), { timeout: 30_000 }).toBe(5)
            const beforeClose = server.getMockConsumptions(providerCase.target)
            expectCompactionSource(beforeClose[3], {
                turns: [turns[0]],
                excluded: [userB, userC, turnBMarker, turnCMarker, latestMarker, continuation],
                contextWindow: 272_000,
            })
            expectCompactionSource(beforeClose[4], {
                turns: [turns[1], turns[2]],
                carry: firstSummary,
                excluded: [turnAMarker, latestMarker, continuation],
                contextWindow: 272_000,
            })
            await firstApp.close()
            firstApp = undefined
            helper.clearCachedFrame()
            resumedApp = await openVSCode(workspaceDir)
            const page = await resumedApp.firstWindow()
            await E2ETestHelper.openClineSidebar(page)
            const resumed = await helper.getSidebar(page)
            await E2ETestHelper.dismissWhatsNewModal(resumed)
            await helper.signin(resumed)
            await reopenTask(page, resumed, taskText)
            const resume = resumed.getByRole("contentinfo").locator('[data-testid="send-button"][data-action="resume"]')
            await expect(resume).toBeVisible({ timeout: 30_000 })
            await resume.click()
            await expect(resumed.getByText("E2E_ROLLING_RESTART_OK", { exact: false }).last()).toBeVisible({ timeout: 120_000 })
            await expect.poll(() => server.getRequestCount(providerCase.target)).toBe(6)
            expectCompactedContinuation(server.getMockConsumptions(providerCase.target)[5], {
                summary: firstSummary,
                latestUser,
                latestMarker,
                retainedTurns: [turns[1], turns[2]],
                excluded: [turnAMarker, abortedSummary],
                tokenLimit: 272_000,
            })
            const uiHistory = await readTaskUiMessagesText(dlineDocsDir, taskId)
            expect(countOccurrences(uiHistory, firstSummary)).toBe(1)
            expect(uiHistory).not.toContain(abortedSummary)
            const finalConversation = JSON.stringify(await readTaskConversation(dlineDocsDir, taskId))
            expect(finalConversation).toContain(firstSummary)
            expect(finalConversation).not.toContain(turnAMarker)
            expect(finalConversation).toContain(turnBResponse)
            expect(finalConversation).toContain(turnCResponse)
            expect(finalConversation).toContain(JSON.stringify(latestUser).slice(1, -1))
            expect(finalConversation).not.toContain(abortedSummary)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await firstApp?.close()
            await resumedApp?.close()
        }
    },
)
