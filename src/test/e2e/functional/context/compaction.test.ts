import { readFile, writeFile } from "node:fs/promises"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import {
    closeCurrentTask,
    configureAutoCompaction,
    configureResponsesAutoCompaction,
    configureTriggerBoundary,
    onlyTaskId,
    openSidebar,
    profilesPath,
    reopenTask,
    type StoredCompactionProfile as StoredProfile,
    seedLargeCompactionHistory,
    sendTask,
    settingsPath,
    submitTask,
} from "@e2e/utils/compaction-fixture"
import { countOccurrences, estimateTokens, expectCompactionBudgetFormula } from "@e2e/utils/compaction-request-oracle"
import { PASTED_PNG_CHIP_NAME } from "@e2e/utils/composer"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { readTaskConversation } from "@e2e/utils/task-instance-store"
import { expect, type Locator } from "@playwright/test"
import type { ElectronApplication } from "playwright"

interface OpenAiChatRequestBody {
    messages?: unknown[]
    tools?: Array<{ function?: { name?: string } }>
    prompt_cache_key?: string
    prompt_cache_options?: unknown
}

interface ContextWindowProjectionDiagnostic {
    apiIndex: number
    contextWindow: number
    candidateEstimatedTokens: number
    baselineTokens: number
    pendingDeltaTokens: number
    candidateDeltaTokens: number
    projectedUsageTokens: number
    pressureSource: string
    shouldCompact: boolean
}

const TRUNCATED_SUMMARY_MARKER = "E2E_CHAT_COMPACTION_TRUNCATED_RESPONSE_SHOULD_NOT_SURVIVE"
const HIGH_CONTEXT_PRESSURE_MARKER = "# High Context Pressure"
const RETRY_REMINDER_HEADING = "# Retry Reminder"

/** A retry appends one reminder text block to the frozen compaction request; everything else must stay identical. */
function withoutRetryReminder(body: Record<string, unknown>): Record<string, unknown> {
    if (!Array.isArray(body.input)) return body
    return {
        ...body,
        input: body.input.map((item) => {
            const content = (item as { content?: unknown }).content
            if (!Array.isArray(content)) return item
            return {
                ...(item as Record<string, unknown>),
                content: content.filter(
                    (part) => !String((part as { text?: unknown }).text ?? "").includes(RETRY_REMINDER_HEADING),
                ),
            }
        }),
    }
}
const ONE_PIXEL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
const ONE_PIXEL_PNG_BASE64_PREFIX = ONE_PIXEL_PNG_BASE64.slice(0, -4)

function estimateCommonPrefixTokens(left: unknown, right: unknown): number {
    const leftText = JSON.stringify(left)
    const rightText = JSON.stringify(right)
    const limit = Math.min(leftText.length, rightText.length)
    let index = 0
    while (index < limit && leftText[index] === rightText[index]) index++
    return Math.ceil(Buffer.byteLength(leftText.slice(0, index), "utf8") / 4)
}

function getToolNames(body: OpenAiChatRequestBody): string[] {
    return (body.tools ?? []).flatMap((tool) => (tool.function?.name ? [tool.function.name] : []))
}

function stripPromptCacheAnnotations(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(stripPromptCacheAnnotations)
    }
    if (typeof value !== "object" || value === null) {
        return value
    }

    return Object.fromEntries(
        Object.entries(value)
            .filter(([key]) => key !== "cache_control" && key !== "prompt_cache_breakpoint")
            .map(([key, nested]) => [key, stripPromptCacheAnnotations(nested)]),
    )
}

function commonMessageCount(left: readonly unknown[], right: readonly unknown[]): number {
    const limit = Math.min(left.length, right.length)
    let index = 0
    while (index < limit && JSON.stringify(left[index]) === JSON.stringify(right[index])) index++
    return index
}

async function configureChatAutoCompaction(dlineDir: string): Promise<void> {
    await configureAutoCompaction(dlineDir, E2E_PROFILE_NAMES.mockOpenAi)
}

async function configureReducedCapScenario(dlineDir: string): Promise<void> {
    const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
    const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
    if (!profile?.openai?.capabilities) throw new Error("Missing configurable OpenAI Responses E2E profile")
    profile.modelId = "gpt-5.6-sol"
    profile.openai.capabilities.contextWindow = 1_000_000
    profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
    await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

    const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
    await writeFile(
        settingsPath(dlineDir),
        `${JSON.stringify(
            {
                ...settings,
                actModeProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
                planModeProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
                useAutoCondense: true,
                autoCondenseTriggerPercent: 60,
                autoCondenseMaxContextTokens: 272_000,
            },
            null,
            2,
        )}\n`,
        "utf8",
    )
}

async function setAutoCompactionEnabled(dlineDir: string, enabled: boolean): Promise<void> {
    const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
    await writeFile(settingsPath(dlineDir), `${JSON.stringify({ ...settings, useAutoCondense: enabled }, null, 2)}\n`, "utf8")
}

async function configureResponsesContextPressure(dlineDir: string): Promise<void> {
    const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
    const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
    if (!profile?.openai?.capabilities) throw new Error("Missing configurable OpenAI Responses E2E profile")
    profile.modelId = "gpt-5.6-sol"
    profile.openai.capabilities.contextWindow = 100_000
    profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
    await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

    const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
    await writeFile(
        settingsPath(dlineDir),
        `${JSON.stringify(
            {
                ...settings,
                actModeProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
                planModeProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
                useAutoCondense: false,
            },
            null,
            2,
        )}\n`,
        "utf8",
    )
}

function parseContextWindowProjection(output: string, apiIndex: number): ContextWindowProjectionDiagnostic | undefined {
    const prefix = "final context-window projection "
    for (const line of output.split(/\r?\n/).reverse()) {
        const projectionStart = line.indexOf(prefix)
        if (projectionStart < 0) continue
        try {
            const candidate = JSON.parse(
                line.slice(projectionStart + prefix.length),
            ) as Partial<ContextWindowProjectionDiagnostic>
            if (
                candidate.apiIndex !== apiIndex ||
                typeof candidate.contextWindow !== "number" ||
                typeof candidate.candidateEstimatedTokens !== "number" ||
                typeof candidate.baselineTokens !== "number" ||
                typeof candidate.pendingDeltaTokens !== "number" ||
                typeof candidate.candidateDeltaTokens !== "number" ||
                typeof candidate.projectedUsageTokens !== "number" ||
                typeof candidate.pressureSource !== "string" ||
                typeof candidate.shouldCompact !== "boolean"
            ) {
                continue
            }
            return candidate as ContextWindowProjectionDiagnostic
        } catch {}
    }
    return undefined
}

async function pastePngWithTrailingBytes(input: Locator, trailingBytes: number): Promise<void> {
    await input.evaluate(
        (element, payload) => {
            const binary = atob(payload.encodedPng)
            const png = Uint8Array.from(binary, (character) => character.charCodeAt(0))
            const bytes = new Uint8Array(png.length + payload.trailingBytes)
            bytes.set(png)
            const screenshot = new File([bytes], "large-valid-screenshot.png", { type: "image/png" })
            const clipboardData = new DataTransfer()
            clipboardData.items.add(screenshot)
            const pasteEvent = new ClipboardEvent("paste", {
                bubbles: true,
                cancelable: true,
                clipboardData,
            })
            element.dispatchEvent(pasteEvent)
        },
        { encodedPng: ONE_PIXEL_PNG_BASE64, trailingBytes },
    )
}

e2e(
    "OpenAI compaction - Chat request after summarize_task has no orphan tool output",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }, testInfo) => {
        e2e.setTimeout(180_000)
        await configureChatAutoCompaction(dlineDir)
        const summaryMarker = "E2E_CHAT_SUMMARY_AFTER_LITERAL_CLOSE"
        const summaryText =
            `E2E_CHAT_COMPACTION_SUMMARY preserves the task and latest user request. ` +
            `The literal payload \`</context></summarize_task>\` is part of the summary. ${summaryMarker}`
        server.enqueueResponses(
            "openai-compatible-chat",
            {
                type: "tool",
                id: "call_chat_compaction_ready",
                name: "qna_respond",
                arguments: { response: "E2E_CHAT_COMPACTION_READY" },
                usage: { inputTokens: 125_000, outputTokens: 100 },
            },
            {
                type: "message",
                text: `<thinking>E2E summary analysis</thinking><summarize_task><context>${summaryText}</context></summarize_task>`,
                expectedRequestIncludes: [
                    "The current conversation is rapidly running out of context",
                    "# Compaction Window Budget",
                    "Estimated available context-window remainder:",
                    "Hard limit for the complete response:",
                    "Recommended total response range:",
                ],
                expectedRequestExcludes: ["E2E_CHAT_COMPACTION_CONTINUE"],
            },
            {
                type: "tool",
                id: "call_chat_compaction_complete",
                name: "attempt_completion",
                arguments: { result: "E2E_CHAT_COMPACTION_OK" },
                expectedRequestIncludes: ["E2E_CHAT_COMPACTION_SUMMARY", "E2E_CHAT_COMPACTION_CONTINUE"],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_CHAT_COMPACTION_TASK")
            await expect(sidebar.getByText("E2E_CHAT_COMPACTION_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await sendTask(sidebar, "E2E_CHAT_COMPACTION_CONTINUE")
            await expect(sidebar.getByText("E2E_CHAT_COMPACTION_OK", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })

            const summaryToggle = sidebar.getByRole("button", { name: "Expand summary" }).filter({ hasText: summaryMarker })
            await expect(summaryToggle).toBeVisible()
            await summaryToggle.click()
            const summaryScrollContainer = sidebar.getByTestId("summary-scroll-container").filter({ hasText: summaryMarker })
            await expect(summaryScrollContainer).toContainText(summaryText)
            await expect(sidebar.getByText(summaryMarker, { exact: false })).toHaveCount(1)

            await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(3)
            const requests = server.getMockConsumptions("openai-compatible-chat")
            expect(requests[1].contractError).toBeUndefined()
            expect(requests[2].contractError).toBeUndefined()

            const initialBody = requests[0].requestBody as OpenAiChatRequestBody
            const summaryBody = requests[1].requestBody as OpenAiChatRequestBody
            const initialRequestTokens = estimateTokens(initialBody)
            const summaryRequestTokens = estimateTokens(summaryBody)
            const initialMessageTokens = estimateTokens(initialBody.messages ?? [])
            const summaryMessageTokens = estimateTokens(summaryBody.messages ?? [])
            const initialToolTokens = estimateTokens(initialBody.tools ?? [])
            const summaryToolTokens = estimateTokens(summaryBody.tools ?? [])
            const messagePrefixTokens = estimateCommonPrefixTokens(initialBody.messages ?? [], summaryBody.messages ?? [])
            const normalizedInitialMessages = stripPromptCacheAnnotations(initialBody.messages ?? []) as unknown[]
            const normalizedSummaryMessages = stripPromptCacheAnnotations(summaryBody.messages ?? []) as unknown[]
            const normalizedCommonMessageCount = commonMessageCount(normalizedInitialMessages, normalizedSummaryMessages)
            const projectedSummaryTokens = 350_600 + summaryRequestTokens - initialRequestTokens
            const cacheEvidence = {
                actual: {
                    initialRequestTokens,
                    summaryRequestTokens,
                    initialMessageTokens,
                    summaryMessageTokens,
                    initialToolTokens,
                    summaryToolTokens,
                    messagePrefixTokens,
                    initialMessageCount: initialBody.messages?.length ?? 0,
                    summaryMessageCount: summaryBody.messages?.length ?? 0,
                    normalizedCommonMessageCount,
                    initialMessageTokensByIndex: (initialBody.messages ?? []).map(estimateTokens),
                    summaryMessageTokensByIndex: (summaryBody.messages ?? []).map(estimateTokens),
                },
                projected: {
                    initialRequestTokens: 350_600,
                    summaryRequestTokens: projectedSummaryTokens,
                },
                initialToolNames: getToolNames(initialBody),
                summaryToolNames: getToolNames(summaryBody),
                initialPromptCacheKey: initialBody.prompt_cache_key,
                summaryPromptCacheKey: summaryBody.prompt_cache_key,
            }
            const evidencePath = testInfo.outputPath("openai-compaction-cache-evidence.json")
            await writeFile(evidencePath, `${JSON.stringify(cacheEvidence, null, 2)}\n`, "utf8")
            await testInfo.attach("openai-compaction-cache-evidence.json", {
                path: evidencePath,
                contentType: "application/json",
            })

            expect(summaryMessageTokens).toBeGreaterThan(initialMessageTokens)
            expect(normalizedCommonMessageCount).toBe(normalizedInitialMessages.length)
            expect(normalizedSummaryMessages.slice(0, normalizedInitialMessages.length)).toEqual(normalizedInitialMessages)
            expect(summaryBody.tools).toEqual(initialBody.tools)
            expect(getToolNames(summaryBody)).toEqual(getToolNames(initialBody))
            expect(getToolNames(summaryBody)).not.toContain("summarize_task")
            expect(summaryBody.prompt_cache_key).toBe(initialBody.prompt_cache_key)
            expect(projectedSummaryTokens).toBeGreaterThan(350_600)
            const summaryRequestText = JSON.stringify(summaryBody)
            expect(summaryRequestText).toMatch(/Estimated available context-window remainder: [1-9][0-9]* tokens/)
            expect(summaryRequestText).toMatch(/Hard limit for the complete response: [1-9][0-9]* tokens/)
            expect(summaryRequestText).toMatch(/Recommended total response range: [0-9]+[–-][1-9][0-9]* tokens/)

            const finalBody = requests[2].requestBody as {
                messages?: Array<{ role?: string; tool_call_id?: string; content?: unknown }>
            }
            const orphanSummaryOutputs = (finalBody.messages ?? []).filter(
                (message) => message.role === "tool" && JSON.stringify(message.content).includes("E2E_CHAT_COMPACTION_SUMMARY"),
            )
            expect(orphanSummaryOutputs).toEqual([])
            expect(JSON.stringify(finalBody)).toContain(summaryText)

            for (const request of requests) {
                const body = request.requestBody as { prompt_cache_key?: unknown; prompt_cache_options?: unknown } | undefined
                expect(body?.prompt_cache_key).toBeTruthy()
                expect(body?.prompt_cache_options).toBeUndefined()
                expect(JSON.stringify(request.requestBody)).not.toContain("prompt_cache_breakpoint")
            }
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "OpenAI compaction - a large encoded image does not trigger early compaction from a 240K Provider baseline",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configureTriggerBoundary(dlineDir, 472_000, 0, 5_000, 30_000, 95)
        const continuationMarker = "E2E_IMAGE_PROJECTION_CONTINUE"
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_image_projection_ready",
                name: "qna_respond",
                arguments: { response: "E2E_IMAGE_PROJECTION_READY" },
                usage: { inputTokens: 240_000, outputTokens: 100 },
                matchRequestContract: true,
            },
            {
                type: "tool",
                id: "call_image_projection_complete",
                name: "attempt_completion",
                arguments: { result: "E2E_IMAGE_PROJECTION_OK" },
                expectedRequestIncludes: [continuationMarker, "image/png", ONE_PIXEL_PNG_BASE64_PREFIX],
                expectedRequestExcludes: ["The current conversation is rapidly running out of context"],
                matchRequestContract: true,
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_IMAGE_PROJECTION_TASK")
            await expect(sidebar.getByText("E2E_IMAGE_PROJECTION_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })

            const input = sidebar.getByTestId("chat-input")
            await input.fill(continuationMarker)
            await pastePngWithTrailingBytes(input, 675_000)
            // A resource still being staged holds the send back; wait until it may go.
            await expect(input.getByRole("group", { name: PASTED_PNG_CHIP_NAME })).toHaveAttribute("data-status", "ready", {
                timeout: 30_000,
            })
            await sidebar.getByTestId("send-button").click()
            await expect(sidebar.getByText("E2E_IMAGE_PROJECTION_OK", { exact: false }).last()).toBeVisible({ timeout: 60_000 })

            await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(2)
            await expect(sidebar.getByTestId("compaction-pass")).toHaveCount(0)
            const requests = server.getMockConsumptions("openai-compatible-responses")
            expect(requests.every((request) => request.contractError === undefined)).toBe(true)
            const imageRequest = JSON.stringify(requests[1].requestBody)
            expect(imageRequest).toContain('"type":"function_call_output"')
            expect(imageRequest).toContain("image/png")
            expect(imageRequest).toContain(ONE_PIXEL_PNG_BASE64_PREFIX)
            expect(imageRequest.length).toBeGreaterThan(800_000)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "OpenAI compaction - a 442.7K Provider baseline admits the current candidate only after automatic compaction",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configureTriggerBoundary(dlineDir, 472_000, 0, 5_000, 30_000, 95)
        const continuationMarker = `E2E_442_7K_FINAL_ADMISSION:${"x".repeat(4_000)}`
        const summaryMarker = "E2E_442_7K_SUMMARY"
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_442_7k_ready",
                name: "qna_respond",
                arguments: { response: "E2E_442_7K_READY" },
                usage: { inputTokens: 442_600, outputTokens: 100 },
                matchRequestContract: true,
            },
            {
                type: "tool",
                id: "call_442_7k_summary",
                name: "summarize_task",
                arguments: { context: `${summaryMarker} preserves the complete prior turn.` },
                delayMs: 2_000,
                expectedRequestIncludes: ["The current conversation is rapidly running out of context", "E2E_442_7K_TASK"],
                expectedRequestExcludes: [continuationMarker],
                matchRequestContract: true,
            },
            {
                type: "tool",
                id: "call_442_7k_complete",
                name: "attempt_completion",
                arguments: { result: "E2E_442_7K_OK" },
                expectedRequestIncludes: [summaryMarker, continuationMarker],
                expectedRequestExcludes: ["The current conversation is rapidly running out of context"],
                matchRequestContract: true,
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_442_7K_TASK")
            await expect(sidebar.getByText("E2E_442_7K_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            const expandTaskHeader = sidebar.getByLabel("Expand task header")
            if (await expandTaskHeader.isVisible()) await expandTaskHeader.click()
            await expect(sidebar.getByTestId("context-window-indicator")).toBeVisible({ timeout: 60_000 })
            const progress = sidebar.getByTestId("context-window-segmented-progress")
            const occupancy = () =>
                progress.evaluate((element) => {
                    const segments = Array.from(element.querySelectorAll<HTMLElement>("[data-segment]"))
                    const tokens = (kind: string) =>
                        Number(segments.find((segment) => segment.dataset.segment === kind)?.dataset.authoritativeTokens ?? 0)
                    return {
                        activeTokens: tokens("active"),
                        durableTokens: tokens("durable"),
                        totalTokens: segments.reduce(
                            (total, segment) => total + Number(segment.dataset.authoritativeTokens ?? 0),
                            0,
                        ),
                    }
                })
            // A question is part of the run (isRunAtRest), so the figure stays in flight on the
            // Provider's measured count until the reply continues the same conversation.
            await expect.poll(async () => (await occupancy()).totalTokens, { timeout: 30_000 }).toBeGreaterThanOrEqual(442_600)
            await expect(progress).toHaveAttribute("data-phase", "receiving")
            const measured = await occupancy()

            await sendTask(sidebar, continuationMarker)
            await expect(progress).toHaveAttribute("data-phase", "sending", { timeout: 30_000 })
            // The hidden Pass sends the conversation the Provider measured, so the bar keeps that
            // figure rather than a smaller local estimate of the same history, and adds no staged tail.
            const hiddenPass = await occupancy()
            expect(hiddenPass.activeTokens).toBe(0)
            expect(hiddenPass.totalTokens).toBe(measured.totalTokens)

            await expect(sidebar.getByText("E2E_442_7K_OK", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            // Only the landed summary lowers the figure.
            await expect.poll(async () => (await occupancy()).totalTokens, { timeout: 30_000 }).toBeLessThan(measured.totalTokens)

            await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(3)
            const requests = server.getMockConsumptions("openai-compatible-responses")
            expect(requests[0]).toMatchObject({ usage: { inputTokens: 442_600, outputTokens: 100 } })
            expect(requests[1]).toMatchObject({ responseType: "tool", toolName: "summarize_task" })
            expect(requests[2]).toMatchObject({ responseType: "tool", toolName: "attempt_completion" })
            expect(requests.every((request) => request.contractError === undefined)).toBe(true)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "OpenAI compaction - calibrated source keeps the oldest complete turn whole in one hidden Pass",
    async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }, testInfo) => {
        e2e.setTimeout(360_000)
        await configureTriggerBoundary(dlineDir, 472_000, 420_000, 5_000, 30_000, 95)
        await setAutoCompactionEnabled(dlineDir, false)

        const taskText = "E2E_CALIBRATED_COMPLETE_SOURCE_TASK"
        const turnAMarker = "E2E_CALIBRATED_COMPLETE_SOURCE_TURN_A"
        const turnBMarker = "E2E_CALIBRATED_COMPLETE_SOURCE_TURN_B"
        const calibrationMarkers = [
            "E2E_CALIBRATED_SAMPLE_ONE",
            "E2E_CALIBRATED_SAMPLE_TWO",
            "E2E_CALIBRATED_SAMPLE_THREE",
        ] as const
        const continuationMarker = "E2E_CALIBRATED_COMPLETE_SOURCE_CONTINUE"
        const summaryMarker = "E2E_CALIBRATED_COMPLETE_SOURCE_SUMMARY"
        const completionMarker = "E2E_CALIBRATED_COMPLETE_SOURCE_OK"
        const turnAResponse = `${turnAMarker}:${"A".repeat(1_750_000)}`
        const turnBResponse = `${turnBMarker}:${"B".repeat(350_000)}`

        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_calibrated_source_setup",
                name: "qna_respond",
                arguments: { response: "E2E_CALIBRATED_COMPLETE_SOURCE_SETUP_READY" },
                usage: { inputTokens: 1_000, outputTokens: 100 },
                matchRequestContract: true,
            },
            ...calibrationMarkers.map((marker, index) => ({
                type: "tool" as const,
                id: `call_calibrated_source_sample_${index + 1}`,
                name: "qna_respond",
                arguments: { response: `${marker}_READY` },
                // Three matching large-body samples dominate the setup sample's ratio.
                usage: { inputTokens: 430_000, outputTokens: 100 },
                matchRequestContract: true,
            })),
            {
                type: "tool",
                id: "call_calibrated_source_summary",
                name: "summarize_task",
                arguments: { context: `${summaryMarker} preserves every complete seeded and calibration turn.` },
                matchRequestContract: true,
            },
            {
                type: "tool",
                id: "call_calibrated_source_complete",
                name: "attempt_completion",
                arguments: { result: completionMarker },
                expectedRequestIncludes: [summaryMarker, continuationMarker],
                matchRequestContract: true,
            },
        )

        let firstApp: ElectronApplication | undefined
        let resumedApp: ElectronApplication | undefined
        try {
            firstApp = await openVSCode(workspaceDir)
            const first = await openSidebar(firstApp, helper)
            await sendTask(first, taskText)
            await expect(first.getByText("E2E_CALIBRATED_COMPLETE_SOURCE_SETUP_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await closeCurrentTask(first)
            await firstApp.close()
            firstApp = undefined
            helper.clearCachedFrame()

            const taskId = await onlyTaskId(dlineDocsDir)
            const seededTokens = await seedLargeCompactionHistory(dlineDocsDir, taskId, [
                { user: `${turnAMarker}_USER`, assistant: turnAResponse },
                { user: `${turnBMarker}_USER`, assistant: turnBResponse },
            ])
            expect(seededTokens).toBeGreaterThan(510_000)
            expect(seededTokens).toBeLessThan(550_000)

            resumedApp = await openVSCode(workspaceDir)
            let page = await resumedApp.firstWindow()
            await E2ETestHelper.openClineSidebar(page)
            let sidebar = await helper.getSidebar(page)
            await E2ETestHelper.dismissWhatsNewModal(sidebar)
            await helper.signin(sidebar)
            await reopenTask(page, sidebar, taskText)

            for (const marker of calibrationMarkers) {
                await submitTask(sidebar, marker)
                await expect(sidebar.getByText(`${marker}_READY`, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            }

            await closeCurrentTask(sidebar)
            await resumedApp.close()
            resumedApp = undefined
            helper.clearCachedFrame()
            await setAutoCompactionEnabled(dlineDir, true)

            resumedApp = await openVSCode(workspaceDir)
            page = await resumedApp.firstWindow()
            await E2ETestHelper.openClineSidebar(page)
            sidebar = await helper.getSidebar(page)
            await E2ETestHelper.dismissWhatsNewModal(sidebar)
            await helper.signin(sidebar)
            await reopenTask(page, sidebar, taskText)
            await submitTask(sidebar, continuationMarker)
            await expect(sidebar.getByText(completionMarker, { exact: true }).last()).toBeVisible({ timeout: 180_000 })

            await expect.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 180_000 }).toBe(6)
            const requests = server.getMockConsumptions("openai-compatible-responses")
            expect(requests.every((request) => request.contractError === undefined)).toBe(true)
            expect(requests.slice(1, 4).every((request) => request.usage?.inputTokens === 430_000)).toBe(true)
            expect(requests[4]).toMatchObject({ responseType: "tool", toolName: "summarize_task" })
            expect(requests[5]).toMatchObject({ responseType: "tool", toolName: "attempt_completion" })

            const hiddenPassText = JSON.stringify(requests[4].requestBody)
            const continuedRequestText = JSON.stringify(requests[5].requestBody)
            const evidence = {
                seededTokens,
                hiddenPassBytes: Buffer.byteLength(hiddenPassText, "utf8"),
                hiddenPassContainsTurnA: hiddenPassText.includes(turnAMarker),
                hiddenPassContainsTurnB: hiddenPassText.includes(turnBMarker),
                continuedRequestContainsTurnA: continuedRequestText.includes(turnAMarker),
                continuedRequestContainsTurnB: continuedRequestText.includes(turnBMarker),
            }
            const evidencePath = testInfo.outputPath("calibrated-complete-source-evidence.json")
            await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8")
            await testInfo.attach("calibrated-complete-source-evidence.json", {
                path: evidencePath,
                contentType: "application/json",
            })

            // The Pass input is bounded by the trigger line of the 420K Maximum context. Only the
            // calibrated estimate lets the oldest complete turn fit in one Pass; an uncalibrated estimate
            // would split it and need a second Pass. After that Pass the candidate is below 80 percent of
            // the configured window, so the newer complete turn stays verbatim.
            expect(hiddenPassText).toContain(turnAMarker)
            expect(hiddenPassText).not.toContain(turnBMarker)
            expect(continuedRequestText).not.toContain(turnAMarker)
            expect(continuedRequestText).toContain(turnBMarker)
            expect(requests.filter((request) => request.toolName === "summarize_task")).toHaveLength(1)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await firstApp?.close()
            await resumedApp?.close()
        }
    },
)

e2e(
    "OpenAI compaction - accepted summary continues before delayed usage tail settles",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configureResponsesAutoCompaction(dlineDir)
        const continuationMarker = "E2E_SETTLEMENT_CONTINUE"
        const summaryMarker = "E2E_SETTLEMENT_ACCEPTED_SUMMARY"
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_settlement_ready",
                name: "qna_respond",
                arguments: { response: "E2E_SETTLEMENT_READY" },
                usage: { inputTokens: 125_000, outputTokens: 100 },
            },
            {
                type: "tool-with-completion-snapshots",
                id: "call_settlement_summary",
                name: "summarize_task",
                arguments: { context: `${summaryMarker} preserves the pending continuation.` },
                beforeUsageDelayMs: 30_000,
                expectedRequestIncludes: ["The current conversation is rapidly running out of context"],
                expectedRequestExcludes: [continuationMarker],
            },
            {
                type: "tool",
                id: "call_settlement_complete",
                name: "attempt_completion",
                arguments: { result: "E2E_SETTLEMENT_CONTINUED" },
                expectedRequestIncludes: [summaryMarker, continuationMarker],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_SETTLEMENT_TASK")
            await expect(sidebar.getByText("E2E_SETTLEMENT_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await submitTask(sidebar, continuationMarker)

            await expect.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 10_000 }).toBe(3)
            await expect(sidebar.getByText("E2E_SETTLEMENT_CONTINUED", { exact: false }).last()).toBeVisible({ timeout: 30_000 })
            const requests = server.getMockConsumptions("openai-compatible-responses")
            expect(requests[1].responseType).toBe("tool-with-completion-snapshots")
            expect(requests[2].toolName).toBe("attempt_completion")
            expect(requests[2].receivedAtMs - requests[1].receivedAtMs).toBeLessThan(10_000)
            expect(requests.every((request) => request.contractError === undefined)).toBe(true)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Context compaction - terminal hidden Pass failure stops the task and explains the outcome",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configureReducedCapScenario(dlineDir)
        const turnAMarker = "E2E_TERMINAL_FAILURE_TURN_A"
        const turnBMarker = "E2E_TERMINAL_FAILURE_TURN_B"
        const continuationMarker = "E2E_TERMINAL_FAILURE_CONTINUE"
        const retryDraft = "E2E_TERMINAL_FAILURE_RETRY_DRAFT"
        const completionMarker = "E2E_TERMINAL_FAILURE_COMPLETED_AFTER_RETRY"
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_terminal_failure_turn_a",
                name: "qna_respond",
                arguments: { response: `${turnAMarker}:${"A".repeat(20_000)}` },
                usage: { inputTokens: 120_000, outputTokens: 100 },
                matchRequestContract: true,
            },
            {
                type: "tool",
                id: "call_terminal_failure_turn_b",
                name: "qna_respond",
                arguments: { response: `${turnBMarker}:${"B".repeat(20_000)}` },
                usage: { inputTokens: 300_000, outputTokens: 100 },
                matchRequestContract: true,
            },
            // A deterministic client error fails this immutable hidden Pass once.
            { type: "error", status: 400, message: "E2E_TERMINAL_FAILURE_ATTEMPT_0" },
            {
                type: "tool",
                id: "call_terminal_failure_recovered_summary",
                name: "summarize_task",
                arguments: {
                    context: "E2E_TERMINAL_FAILURE_RECOVERED_SUMMARY preserves the failed turn and the pending continuation.",
                },
                expectedRequestIncludes: ["The current conversation is rapidly running out of context"],
                expectedRequestExcludes: ["E2E_TERMINAL_FAILURE_CONTINUE", retryDraft],
            },
            {
                type: "tool",
                id: "call_terminal_failure_recovered_complete",
                name: "attempt_completion",
                arguments: { result: completionMarker },
                expectedRequestIncludes: ["E2E_TERMINAL_FAILURE_RECOVERED_SUMMARY", continuationMarker, retryDraft],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_TERMINAL_FAILURE_TASK")
            await expect(sidebar.getByText(turnAMarker, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await submitTask(sidebar, "E2E_TERMINAL_FAILURE_USER_TURN_B")
            await expect(sidebar.getByText(turnBMarker, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await submitTask(sidebar, continuationMarker)

            // Deterministic 400s surface the canonical Retry interaction without claiming
            // that transient retry attempts were consumed. The raw Provider diagnostic remains in logs.
            await expect(sidebar.getByTestId("compaction-failure")).toBeVisible({
                timeout: 120_000,
            })
            const compactionError = sidebar.getByTestId("compaction-error-box")
            await expect(compactionError).toBeVisible()
            await expect(compactionError).toContainText("E2E_TERMINAL_FAILURE_ATTEMPT_0")
            await expect(sidebar.getByText("Automatic retry stopped", { exact: true })).toHaveCount(0)
            await expect(sidebar.getByText(/All .* automatic attempts were used\./)).toHaveCount(0)

            await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(3)
            // Cross the former 2-second first retry delay and prove the immutable request stays terminal.
            await sidebar.page().waitForTimeout(3_000)
            expect(server.getRequestCount("openai-compatible-responses")).toBe(3)
            const requestsBeforeManualRetry = server.getMockConsumptions("openai-compatible-responses")
            expect(requestsBeforeManualRetry.slice(2)).toHaveLength(1)
            expect(requestsBeforeManualRetry[2].responseType).toBe("error")

            const retry = sidebar.getByRole("button", { name: "Retry", exact: true }).last()
            await expect(retry).toBeVisible()
            await expect(retry).toBeEnabled()
            await sidebar.getByTestId("chat-input").fill(retryDraft)
            const retryClickedAt = Date.now()
            await retry.click()

            await expect
                .poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 3_000 })
                .toBeGreaterThanOrEqual(4)
            const firstRecoveryRequest = server.getMockConsumptions("openai-compatible-responses")[3]
            expect(firstRecoveryRequest.receivedAtMs - retryClickedAt).toBeLessThan(3_000)
            expect(firstRecoveryRequest.responseType).toBe("tool")
            expect(firstRecoveryRequest.toolName).toBe("summarize_task")

            await expect(sidebar.getByText(completionMarker, { exact: true }).last()).toBeVisible({ timeout: 60_000 })
            await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(5)
            const recoveredRequests = server.getMockConsumptions("openai-compatible-responses")
            expect(recoveredRequests[4].responseType).toBe("tool")
            expect(recoveredRequests[4].toolName).toBe("attempt_completion")
            expect(recoveredRequests.every((request) => request.contractError === undefined)).toBe(true)
            await expect(sidebar.getByTestId("error-retry-box")).toHaveCount(0)
            await expect(sidebar.getByTestId("chat-input")).toBeEnabled()

            // No delayed automatic retry may fire after the manual recovery has completed.
            await sidebar.page().waitForTimeout(9_000)
            expect(server.getRequestCount("openai-compatible-responses")).toBe(5)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)
e2e(
    "OpenAI compaction - Responses retry removes the interrupted summary and its thinking",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configureResponsesAutoCompaction(dlineDir)
        const damagedSummary = "E2E_RESPONSES_DAMAGED_SUMMARY_MUST_NOT_SURVIVE"
        const interruptedThinking = "E2E_RESPONSES_INTERRUPTED_THINKING_MUST_NOT_SURVIVE"
        const recoveredSummary = "E2E_RESPONSES_RETRIED_SUMMARY preserves the original continuation."
        const serializedArguments = JSON.stringify({ context: damagedSummary })
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_responses_retry_ready",
                name: "qna_respond",
                arguments: { response: "E2E_RESPONSES_RETRY_READY" },
                usage: { inputTokens: 125_000, outputTokens: 100 },
            },
            {
                type: "truncated-tool",
                id: "call_responses_damaged_summary",
                name: "summarize_task",
                arguments: { context: damagedSummary },
                reasoning: interruptedThinking,
                truncateAfter: serializedArguments.length - 1,
                expectedRequestIncludes: ["The current conversation is rapidly running out of context"],
                expectedRequestExcludes: ["E2E_RESPONSES_RETRY_CONTINUE"],
            },
            {
                type: "tool",
                id: "call_responses_recovered_summary",
                name: "summarize_task",
                arguments: { context: recoveredSummary },
                expectedRequestIncludes: ["The current conversation is rapidly running out of context"],
                expectedRequestExcludes: [damagedSummary, interruptedThinking, "E2E_RESPONSES_RETRY_CONTINUE"],
            },
            {
                type: "message",
                text: "E2E_RESPONSES_CONTINUATION_MUST_WAIT_FOR_RECOVERED_SUMMARY",
                delayMs: 120_000,
                expectedRequestIncludes: [recoveredSummary, "E2E_RESPONSES_RETRY_CONTINUE"],
                expectedRequestExcludes: [damagedSummary, interruptedThinking],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_RESPONSES_RETRY_TASK")
            await expect(sidebar.getByText("E2E_RESPONSES_RETRY_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await submitTask(sidebar, "E2E_RESPONSES_RETRY_CONTINUE")
            await expect
                .poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 60_000 })
                .toBeGreaterThanOrEqual(4)
            await expect(
                sidebar.getByText("E2E_RESPONSES_CONTINUATION_MUST_WAIT_FOR_RECOVERED_SUMMARY", { exact: false }),
            ).toHaveCount(0)

            const requests = server.getMockConsumptions("openai-compatible-responses")
            expect(requests[1]).toMatchObject({
                responseType: "truncated-tool",
                responseReasoning: interruptedThinking,
            })
            expect(requests[2]).toMatchObject({ responseType: "tool", toolName: "summarize_task" })
            expect(requests[1].contractError).toBeUndefined()
            expect(requests[2].contractError).toBeUndefined()
            const firstRequestBody = requests[1].requestBody as Record<string, unknown>
            const retryRequestBody = requests[2].requestBody as Record<string, unknown>
            expect(firstRequestBody).not.toHaveProperty("max_output_tokens")
            expect(retryRequestBody).not.toHaveProperty("max_output_tokens")
            expect(JSON.stringify(retryRequestBody)).toContain(RETRY_REMINDER_HEADING)
            expect(withoutRetryReminder(retryRequestBody)).toEqual(firstRequestBody)
            expect(JSON.stringify(requests[2].requestBody)).not.toContain(damagedSummary)
            expect(JSON.stringify(requests[2].requestBody)).not.toContain(interruptedThinking)
            expect(JSON.stringify(requests[3].requestBody)).toContain(recoveredSummary)
            expect(JSON.stringify(requests[3].requestBody)).toContain("E2E_RESPONSES_RETRY_CONTINUE")
            expect(JSON.stringify(requests[3].requestBody)).not.toContain(damagedSummary)
            expect(JSON.stringify(requests[3].requestBody)).not.toContain(interruptedThinking)
            await expect(sidebar.getByText(damagedSummary, { exact: false })).toHaveCount(0)
            await expect(sidebar.getByText(interruptedThinking, { exact: false })).toHaveCount(0)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/max_output_tokens/])
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Auto compact trigger - equal maximum context uses percentage reserve and the shared 2K tolerance",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configureTriggerBoundary(dlineDir, 272_000, 272_000)
        const belowFeedback = "E2E_EQUAL_CAP_BELOW_CONTINUE"
        const triggerFeedback = "E2E_EQUAL_CAP_TRIGGER_CONTINUE"
        const compactTriggerTokens = 260_340
        // Keep the first complete candidate outside the shared 2K tolerance, then
        // place the second baseline well inside it. The real Provider request delta
        // includes the complete tool-result envelope, not only the feedback text.
        const belowPreviousTokens = compactTriggerTokens - 3_000
        const triggerPreviousTokens = compactTriggerTokens - 1_000
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_equal_cap_below",
                name: "qna_respond",
                arguments: { response: "E2E_EQUAL_CAP_BELOW_READY" },
                usage: { inputTokens: belowPreviousTokens - 100, outputTokens: 100 },
            },
            {
                type: "tool",
                id: "call_equal_cap_exact",
                name: "qna_respond",
                arguments: { response: "E2E_EQUAL_CAP_EXACT_READY" },
                usage: { inputTokens: triggerPreviousTokens - 100, outputTokens: 100 },
                expectedRequestExcludes: ["The current conversation is rapidly running out of context"],
            },
            {
                type: "tool",
                id: "call_equal_cap_summary",
                name: "summarize_task",
                arguments: { context: "E2E_EQUAL_CAP_SUMMARY" },
                expectedRequestIncludes: ["The current conversation is rapidly running out of context"],
                expectedRequestExcludes: [triggerFeedback],
            },
            {
                type: "tool",
                id: "call_equal_cap_complete",
                name: "attempt_completion",
                arguments: { result: "E2E_EQUAL_CAP_OK" },
                expectedRequestIncludes: ["E2E_EQUAL_CAP_SUMMARY", triggerFeedback],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_EQUAL_CAP_TASK")
            await expect(sidebar.getByText("E2E_EQUAL_CAP_BELOW_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await submitTask(sidebar, belowFeedback)
            await expect(sidebar.getByText("E2E_EQUAL_CAP_EXACT_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await submitTask(sidebar, triggerFeedback)
            await expect(sidebar.getByText("E2E_EQUAL_CAP_OK", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(4)
            expect(
                server.getMockConsumptions("openai-compatible-responses").every((request) => request.contractError === undefined),
            ).toBe(true)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Auto compact trigger - absolute cap applies the shared 2K tolerance",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configureTriggerBoundary(dlineDir, 1_000_000, 272_000)
        const belowFeedback = "E2E_ABSOLUTE_BELOW_CONTINUE"
        const triggerFeedback = "E2E_ABSOLUTE_TRIGGER_CONTINUE"
        // The reserve comes from the effective window W = 272K, not the 1M model window.
        const compactTriggerTokens = 260_340
        // Keep the first complete candidate outside the shared 2K tolerance, then
        // place the second baseline well inside it. The real Provider request delta
        // includes the complete tool-result envelope, not only the feedback text.
        const belowPreviousTokens = compactTriggerTokens - 3_000
        const triggerPreviousTokens = compactTriggerTokens - 1_000
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_absolute_below",
                name: "qna_respond",
                arguments: { response: "E2E_ABSOLUTE_BELOW_READY" },
                usage: { inputTokens: belowPreviousTokens - 100, outputTokens: 100 },
            },
            {
                type: "tool",
                id: "call_absolute_exact",
                name: "qna_respond",
                arguments: { response: "E2E_ABSOLUTE_EXACT_READY" },
                usage: { inputTokens: triggerPreviousTokens - 100, outputTokens: 100 },
                expectedRequestExcludes: ["The current conversation is rapidly running out of context"],
            },
            {
                type: "tool",
                id: "call_absolute_summary",
                name: "summarize_task",
                arguments: { context: "E2E_ABSOLUTE_TOLERANCE_SUMMARY" },
                expectedRequestIncludes: ["The current conversation is rapidly running out of context"],
                expectedRequestExcludes: [triggerFeedback],
            },
            {
                type: "tool",
                id: "call_absolute_complete",
                name: "attempt_completion",
                arguments: { result: "E2E_ABSOLUTE_TOLERANCE_OK" },
                expectedRequestIncludes: ["E2E_ABSOLUTE_TOLERANCE_SUMMARY", triggerFeedback],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_ABSOLUTE_TRIGGER_TASK")
            await expect(sidebar.getByText("E2E_ABSOLUTE_BELOW_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await sendTask(sidebar, belowFeedback)
            await expect(sidebar.getByText("E2E_ABSOLUTE_EXACT_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await sendTask(sidebar, triggerFeedback)
            await expect(sidebar.getByText("E2E_ABSOLUTE_TOLERANCE_OK", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(4)
            expect(
                server.getMockConsumptions("openai-compatible-responses").every((request) => request.contractError === undefined),
            ).toBe(true)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Auto compact trigger - first over-cap request exposes the local no-turn failure before Provider admission",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configureTriggerBoundary(dlineDir, 752_000, 1)

        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_NO_COMPLETE_TURN_TASK")

            await expect(sidebar.getByText("Conversation Compaction Failed", { exact: true }).last()).toBeVisible({
                timeout: 60_000,
            })
            await expect(
                sidebar.getByText("No complete logical turn is available for context compaction.", { exact: false }).last(),
            ).toBeVisible()
            expect(server.getRequestCount("openai-compatible-responses")).toBe(0)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/No complete logical turn/i])
        } finally {
            await app.close()
        }
    },
)

/**
 * A completed compaction starts a new context-pressure boundary. When the first
 * ordinary request after it fails transiently and the user retries manually, the
 * retry must replay that persisted request. Re-reading the pre-compaction
 * Provider usage would compact again a history that only holds the summary and
 * fail with "No complete logical turn", repeating on every later Retry.
 */
e2e(
    "Auto compact - manual retry after a post-compaction Provider failure replays the request without recompacting",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(360_000)
        await configureTriggerBoundary(dlineDir, 1_000_000, 272_000)
        const compactionInstruction = "The current conversation is rapidly running out of context"
        const belowFeedback = "E2E_POST_COMPACTION_RETRY_BELOW_CONTINUE"
        const triggerFeedback = "E2E_POST_COMPACTION_RETRY_TRIGGER_CONTINUE"
        const summaryMarker = "E2E_POST_COMPACTION_RETRY_SUMMARY"
        const completionMarker = "E2E_POST_COMPACTION_RETRY_OK"
        const failureMarker = "E2E_POST_COMPACTION_RETRY_503"
        const failureCode = "e2e_post_compaction_retry_503"
        const compactTriggerTokens = 260_340
        // The last pre-compaction Provider usage stays inside the shared 2K tolerance,
        // so any gate that ignores the compaction boundary would compact again.
        const belowPreviousTokens = compactTriggerTokens - 3_000
        const triggerPreviousTokens = compactTriggerTokens - 1_000
        // Transport-level retries may consume several responses per Task attempt, so
        // queue more failures than one automatic sequence can use and drop the rest
        // before the manual Retry.
        const queuedFailures = 40
        const setupRequests = 3
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_post_compaction_retry_below",
                name: "qna_respond",
                arguments: { response: "E2E_POST_COMPACTION_RETRY_BELOW_READY" },
                usage: { inputTokens: belowPreviousTokens - 100, outputTokens: 100 },
            },
            {
                type: "tool",
                id: "call_post_compaction_retry_exact",
                name: "qna_respond",
                arguments: { response: "E2E_POST_COMPACTION_RETRY_EXACT_READY" },
                usage: { inputTokens: triggerPreviousTokens - 100, outputTokens: 100 },
                expectedRequestExcludes: [compactionInstruction],
            },
            {
                type: "tool",
                id: "call_post_compaction_retry_summary",
                name: "summarize_task",
                arguments: { context: summaryMarker },
                expectedRequestIncludes: [compactionInstruction],
                expectedRequestExcludes: [triggerFeedback],
            },
            ...Array.from({ length: queuedFailures }, () => ({
                type: "error" as const,
                status: 503,
                code: failureCode,
                message: failureMarker,
            })),
        )

        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_POST_COMPACTION_RETRY_TASK")
            await expect(sidebar.getByText("E2E_POST_COMPACTION_RETRY_BELOW_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await sendTask(sidebar, belowFeedback)
            await expect(sidebar.getByText("E2E_POST_COMPACTION_RETRY_EXACT_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await sendTask(sidebar, triggerFeedback)

            // Compaction succeeds; the first ordinary request after it exhausts the automatic budget.
            await expect(sidebar.getByTestId("error-retry-countdown")).toContainText("automatic attempts were used", {
                timeout: 240_000,
            })
            server.clearPendingResponses("openai-compatible-responses")
            const requestsBeforeRetry = server.getMockConsumptions("openai-compatible-responses")
            const failedRequestCount = requestsBeforeRetry.length
            expect(failedRequestCount).toBeGreaterThan(setupRequests)
            expect(requestsBeforeRetry[2]).toMatchObject({ responseType: "tool", toolName: "summarize_task" })
            expect(requestsBeforeRetry.slice(setupRequests).every((request) => request.status === 503)).toBe(true)
            const failedRequestText = JSON.stringify(requestsBeforeRetry[setupRequests].requestBody)
            expect(failedRequestText).toContain(summaryMarker)
            expect(failedRequestText).not.toContain(compactionInstruction)
            const failedFeedbackCount = countOccurrences(failedRequestText, triggerFeedback)
            expect(failedFeedbackCount).toBeGreaterThan(0)

            server.enqueueResponses("openai-compatible-responses", {
                type: "tool",
                id: "call_post_compaction_retry_complete",
                name: "attempt_completion",
                arguments: { result: completionMarker },
                expectedRequestIncludes: [summaryMarker, triggerFeedback],
                expectedRequestExcludes: [compactionInstruction],
            })
            const retry = sidebar.locator('vscode-button[aria-label="Retry"]').last()
            await expect(retry).toBeVisible()
            await retry.click()

            await expect(sidebar.getByText(completionMarker, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await expect(sidebar.getByText("Conversation Compaction Failed", { exact: true })).toHaveCount(0)
            await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(failedRequestCount + 1)
            const requests = server.getMockConsumptions("openai-compatible-responses")
            expect(requests.filter((request) => request.toolName === "summarize_task")).toHaveLength(1)
            // The manual Retry replays the persisted request; it must not append a second copy of the feedback.
            const replayedRequestText = JSON.stringify(requests[failedRequestCount].requestBody)
            expect(countOccurrences(replayedRequestText, triggerFeedback)).toBe(failedFeedbackCount)
            expect(requests.every((request) => request.contractError === undefined)).toBe(true)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [new RegExp(failureMarker), new RegExp(failureCode)])
        } finally {
            await app.close()
        }
    },
)

e2e(
    "OpenAI compaction budget - automatic request follows the available-remainder formula",
    async ({ dlineDir, helper, openVSCode, server, workspaceDir }) => {
        e2e.setTimeout(120_000)
        await configureResponsesAutoCompaction(dlineDir)
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_auto_budget_ready",
                name: "qna_respond",
                arguments: { response: "E2E_AUTO_BUDGET_READY" },
                usage: { inputTokens: 125_000, outputTokens: 100 },
            },
            {
                type: "message",
                text: "E2E_AUTO_BUDGET_PENDING",
                delayMs: 120_000,
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_AUTO_BUDGET_TASK")
            await expect(sidebar.getByText("E2E_AUTO_BUDGET_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await submitTask(sidebar, "E2E_AUTO_BUDGET_CONTINUE")
            await expect
                .poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 60_000 })
                .toBeGreaterThanOrEqual(2)

            const compactionRequest = server.getMockConsumptions("openai-compatible-responses")[1]
            expectCompactionBudgetFormula(compactionRequest.requestBody)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "OpenAI compaction budget - manual request uses the same formula and preserves guidance",
    async ({ dlineDir, helper, openVSCode, server, workspaceDir }) => {
        e2e.setTimeout(120_000)
        await configureResponsesContextPressure(dlineDir)
        server.enqueueResponses(
            "openai-compatible-responses",
            // An answered exchange before the dialog: /compact beside an open
            // dialog condenses only answered history, never the turn it waits on.
            {
                type: "tool",
                id: "call_manual_budget_read",
                name: "read_file",
                arguments: { path: "README.md" },
                expectedRequestIncludes: ["E2E_MANUAL_BUDGET_TASK"],
            },
            {
                type: "tool",
                id: "call_manual_budget_ready",
                name: "qna_respond",
                arguments: { response: "E2E_MANUAL_BUDGET_READY" },
                usage: { inputTokens: 50_000, outputTokens: 100 },
                expectedToolResults: [{ callId: "call_manual_budget_read", contentIncludes: "# Test Workspace" }],
            },
            {
                type: "message",
                text: "E2E_MANUAL_BUDGET_PENDING",
                delayMs: 120_000,
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_MANUAL_BUDGET_TASK")
            await expect(sidebar.getByText("E2E_MANUAL_BUDGET_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await sendTask(sidebar, "/compact E2E_MANUAL_BUDGET_FEEDBACK")
            await expect
                .poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 60_000 })
                .toBeGreaterThanOrEqual(3)

            const compactionRequest = server.getMockConsumptions("openai-compatible-responses")[2]
            const requestText = JSON.stringify(compactionRequest.requestBody)
            expectCompactionBudgetFormula(compactionRequest.requestBody)
            expect(requestText).toContain("E2E_MANUAL_BUDGET_FEEDBACK")
            expect(requestText).not.toContain("/compact")
        } finally {
            await app.close()
        }
    },
)

e2e(
    "OpenAI context pressure - below 10 percent remaining injects one environment warning",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(120_000)
        await configureResponsesContextPressure(dlineDir)
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_pressure_below_ready",
                name: "qna_respond",
                arguments: { response: "E2E_PRESSURE_BELOW_READY" },
                usage: { inputTokens: 89_901, outputTokens: 100 },
            },
            {
                type: "message",
                text: "E2E_PRESSURE_BELOW_PENDING",
                delayMs: 120_000,
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_PRESSURE_BELOW_TASK")
            await expect(sidebar.getByText("E2E_PRESSURE_BELOW_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await sendTask(sidebar, "E2E_PRESSURE_BELOW_CONTINUE")
            await expect
                .poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 60_000 })
                .toBeGreaterThanOrEqual(2)

            const requests = server.getMockConsumptions("openai-compatible-responses")
            const requestText = JSON.stringify(requests[1].requestBody)
            const projection = await E2ETestHelper.waitForValue(async () =>
                parseContextWindowProjection(await E2ETestHelper.readDlineOutput(userDataDir), 2),
            )
            const providerUsage = requests[0].usage
            expect(providerUsage).toBeDefined()
            const providerBaseline =
                providerUsage!.inputTokens +
                providerUsage!.outputTokens +
                (providerUsage!.cacheReadTokens ?? 0) +
                (providerUsage!.cacheWriteTokens ?? 0)
            expect(projection.baselineTokens).toBe(providerBaseline)
            expect(projection.projectedUsageTokens).toBe(
                projection.baselineTokens + projection.pendingDeltaTokens + projection.candidateDeltaTokens,
            )
            expect(projection.contextWindow).toBe(100_000)
            expect(projection.pressureSource).toBe("provider")
            expect(projection.projectedUsageTokens).toBeGreaterThan(projection.contextWindow * 0.9)
            expect(countOccurrences(requestText, HIGH_CONTEXT_PRESSURE_MARKER)).toBe(1)
            expect(requestText).toContain("Avoid launching too many parallel tool calls that may produce large results")
            expect(requestText).toContain("Do not skip information or verification required to complete the current task")
        } finally {
            await app.close()
        }
    },
)

e2e(
    "OpenAI context pressure - at least 10 percent remaining does not inject the environment warning",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(120_000)
        await configureResponsesContextPressure(dlineDir)
        // Exact equality is owned by environment-context.test.ts. Keep the live E2E near the threshold
        // without freezing prompt/tool/environment tokenization or the resulting candidate delta.
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_pressure_boundary_ready",
                name: "qna_respond",
                arguments: { response: "E2E_PRESSURE_BOUNDARY_READY" },
                usage: { inputTokens: 89_000, outputTokens: 100 },
            },
            {
                type: "message",
                text: "E2E_PRESSURE_BOUNDARY_PENDING",
                delayMs: 120_000,
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_PRESSURE_BOUNDARY_TASK")
            await expect(sidebar.getByText("E2E_PRESSURE_BOUNDARY_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await sendTask(sidebar, "E2E_PRESSURE_BOUNDARY_CONTINUE")
            await expect
                .poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 60_000 })
                .toBeGreaterThanOrEqual(2)

            const requests = server.getMockConsumptions("openai-compatible-responses")
            const requestText = JSON.stringify(requests[1].requestBody)
            const projection = await E2ETestHelper.waitForValue(async () =>
                parseContextWindowProjection(await E2ETestHelper.readDlineOutput(userDataDir), 2),
            )
            const providerUsage = requests[0].usage
            expect(providerUsage).toBeDefined()
            const providerBaseline =
                providerUsage!.inputTokens +
                providerUsage!.outputTokens +
                (providerUsage!.cacheReadTokens ?? 0) +
                (providerUsage!.cacheWriteTokens ?? 0)
            expect(projection.baselineTokens).toBe(providerBaseline)
            expect(projection.projectedUsageTokens).toBe(
                projection.baselineTokens + projection.pendingDeltaTokens + projection.candidateDeltaTokens,
            )
            expect(projection.contextWindow).toBe(100_000)
            expect(projection.pressureSource).toBe("provider")
            expect(projection.candidateDeltaTokens).toBeGreaterThan(0)
            expect(projection.projectedUsageTokens).toBeGreaterThan(89_000)
            expect(projection.projectedUsageTokens).toBeLessThanOrEqual(projection.contextWindow * 0.9)
            expect(requestText).not.toContain(HIGH_CONTEXT_PRESSURE_MARKER)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "OpenAI compaction - interrupted summary response is removed before retry",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configureChatAutoCompaction(dlineDir)
        server.enqueueResponses(
            "openai-compatible-chat",
            {
                type: "tool",
                id: "call_chat_compaction_retry_ready",
                name: "qna_respond",
                arguments: { response: "E2E_CHAT_COMPACTION_RETRY_READY" },
                usage: { inputTokens: 125_000, outputTokens: 100 },
            },
            {
                type: "truncated-message",
                text: `<thinking>incomplete summary</thinking><summarize_task><context>${TRUNCATED_SUMMARY_MARKER}`,
                usage: { inputTokens: 125_000, outputTokens: 100 },
                expectedRequestIncludes: [
                    "The current conversation is rapidly running out of context",
                    "Hard limit for the complete response:",
                ],
            },
            {
                type: "message",
                text: "<thinking>recovered summary</thinking><summarize_task><context>E2E_CHAT_COMPACTION_RETRY_SUMMARY is complete.</context></summarize_task>\nLet me know if anything else is needed.",
                delayMs: 2_000,
                usage: { inputTokens: 125_000, outputTokens: 100 },
                expectedRequestIncludes: [
                    "The current conversation is rapidly running out of context",
                    "Hard limit for the complete response:",
                ],
                expectedRequestExcludes: [TRUNCATED_SUMMARY_MARKER],
            },
            {
                type: "tool",
                id: "call_chat_compaction_retry_complete",
                name: "attempt_completion",
                arguments: { result: "E2E_CHAT_COMPACTION_RETRY_OK" },
                expectedRequestIncludes: ["E2E_CHAT_COMPACTION_RETRY_SUMMARY", "E2E_CHAT_COMPACTION_RETRY_CONTINUE"],
                expectedRequestExcludes: [TRUNCATED_SUMMARY_MARKER],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_CHAT_COMPACTION_RETRY_TASK")
            await expect(sidebar.getByText("E2E_CHAT_COMPACTION_RETRY_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await sendTask(sidebar, "E2E_CHAT_COMPACTION_RETRY_CONTINUE")
            await expect(sidebar.getByText("Compaction was interrupted; retrying:", { exact: true })).toBeVisible({
                timeout: 60_000,
            })
            await expect
                .poll(() => server.getRequestCount("openai-compatible-chat"), { timeout: 60_000 })
                .toBeGreaterThanOrEqual(3)
            await expect(sidebar.getByText("E2E_CHAT_COMPACTION_RETRY_OK", { exact: false }).last()).toBeVisible({
                timeout: 90_000,
            })

            await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(4)
            const requests = server.getMockConsumptions("openai-compatible-chat")
            expect(requests[1].contractError).toBeUndefined()
            expect(requests[1].responseType).toBe("truncated-message")
            expect(requests[1].abortedAtMs).toBeTruthy()
            expect(requests[2].contractError).toBeUndefined()
            expect(requests[2].responseType).toBe("message")
            expect(requests[3].contractError).toBeUndefined()
            expect(JSON.stringify(requests[2].requestBody)).not.toContain(TRUNCATED_SUMMARY_MARKER)
            expect(JSON.stringify(requests[3].requestBody)).not.toContain(TRUNCATED_SUMMARY_MARKER)
            await expect(sidebar.getByText(TRUNCATED_SUMMARY_MARKER, { exact: false })).toHaveCount(0)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/Connection error|ECONNRESET|fetch failed/])
        } finally {
            await app.close()
        }
    },
)

// Regression for task 1791122313218: the summary ended at </context> without </summarize_task>.
e2e(
    "OpenAI compaction - unclosed summarize_task retries with a reminder and accepts a closed call with trailing text",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configureChatAutoCompaction(dlineDir)
        const unclosedMarker = "E2E_CHAT_UNCLOSED_SUMMARY_MARKER"
        server.enqueueResponses(
            "openai-compatible-chat",
            {
                type: "tool",
                id: "call_chat_unclosed_ready",
                name: "qna_respond",
                arguments: { response: "E2E_CHAT_UNCLOSED_READY" },
                usage: { inputTokens: 125_000, outputTokens: 100 },
            },
            {
                type: "message",
                text: `<summarize_task>\n<context>\n${unclosedMarker}\n</context>\n`,
                usage: { inputTokens: 125_000, outputTokens: 100 },
                expectedRequestIncludes: ["The current conversation is rapidly running out of context"],
                expectedRequestExcludes: ["# Retry Reminder"],
            },
            {
                type: "message",
                text: "<summarize_task>\n<context>\nE2E_CHAT_UNCLOSED_RECOVERED_SUMMARY is complete.\n</context>\n</summarize_task>\nDone.",
                usage: { inputTokens: 125_000, outputTokens: 100 },
                expectedRequestIncludes: ["The current conversation is rapidly running out of context", "# Retry Reminder"],
                expectedRequestExcludes: [unclosedMarker],
            },
            {
                type: "tool",
                id: "call_chat_unclosed_complete",
                name: "attempt_completion",
                arguments: { result: "E2E_CHAT_UNCLOSED_OK" },
                expectedRequestIncludes: ["E2E_CHAT_UNCLOSED_RECOVERED_SUMMARY", "E2E_CHAT_UNCLOSED_CONTINUE"],
                expectedRequestExcludes: [unclosedMarker, "# Retry Reminder"],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_CHAT_UNCLOSED_TASK")
            await expect(sidebar.getByText("E2E_CHAT_UNCLOSED_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await sendTask(sidebar, "E2E_CHAT_UNCLOSED_CONTINUE")
            await expect(sidebar.getByText("E2E_CHAT_UNCLOSED_OK", { exact: false }).last()).toBeVisible({ timeout: 120_000 })

            await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(4)
            for (const request of server.getMockConsumptions("openai-compatible-chat")) {
                expect(request.contractError).toBeUndefined()
            }
            await expect(sidebar.getByText(unclosedMarker, { exact: false })).toHaveCount(0)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/did not return a usable <summarize_task>/i])
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Context compaction - hidden Pass preserves immutable Responses wire across max-output and normal retries",
    async ({ dlineDir, helper, openVSCode, server, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configureReducedCapScenario(dlineDir)
        const turnAMarker = "E2E_REDUCED_CAP_TURN_A"
        const turnBMarker = "E2E_REDUCED_CAP_TURN_B"
        const damagedSummary = "E2E_REDUCED_CAP_DAMAGED_SUMMARY"
        const recoveredSummary = "E2E_REDUCED_CAP_RECOVERED_SUMMARY"
        const serializedArguments = JSON.stringify({ context: damagedSummary })
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_reduced_cap_turn_a",
                name: "qna_respond",
                arguments: { response: `${turnAMarker}:${"A".repeat(20_000)}` },
                usage: { inputTokens: 120_000, outputTokens: 100 },
                matchRequestContract: true,
            },
            {
                type: "tool",
                id: "call_reduced_cap_turn_b",
                name: "qna_respond",
                arguments: { response: `${turnBMarker}:${"B".repeat(20_000)}` },
                usage: { inputTokens: 300_000, outputTokens: 100 },
                matchRequestContract: true,
            },
            {
                type: "truncated-tool",
                id: "call_reduced_cap_max_output",
                name: "summarize_task",
                arguments: { context: damagedSummary },
                truncateAfter: serializedArguments.length - 1,
                expectedRequestIncludes: ["The current conversation is rapidly running out of context"],
                usage: { inputTokens: 500_000, outputTokens: 100 },
            },
            {
                type: "error",
                status: 400,
                message: "E2E_REDUCED_CAP_NETWORK_FAILURE",
            },
            {
                type: "tool",
                id: "call_reduced_cap_recovered",
                name: "summarize_task",
                arguments: { context: recoveredSummary },
                expectedRequestIncludes: ["The current conversation is rapidly running out of context"],
                usage: { inputTokens: 400_000, outputTokens: 100 },
            },
            {
                type: "message",
                text: "E2E_REDUCED_CAP_OK",
                expectedRequestIncludes: [recoveredSummary, "E2E_REDUCED_CAP_CONTINUE"],
                usage: { inputTokens: 100_000, outputTokens: 100 },
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_REDUCED_CAP_TASK")
            await expect(sidebar.getByText(turnAMarker, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await submitTask(sidebar, "E2E_REDUCED_CAP_USER_TURN_B")
            await expect(sidebar.getByText(turnBMarker, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await submitTask(sidebar, "E2E_REDUCED_CAP_CONTINUE")
            await expect(sidebar.getByTestId("compaction-failure")).toBeVisible({ timeout: 120_000 })
            await sidebar.getByRole("button", { name: "Retry", exact: true }).last().click()

            // Request #3 is truncated, #4 replays it with the output-limit reminder and fails at the Provider,
            // and #5 is the fresh hidden Pass started by Retry. Assert ordering and immutable wire input there.
            await expect
                .poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 120_000 })
                .toBeGreaterThanOrEqual(5)
            const requests = server.getMockConsumptions("openai-compatible-responses")
            expect(requests[2].responseType).toBe("truncated-tool")
            expect(requests[3].responseType).toBe("error")
            expect(requests[4]).toMatchObject({ responseType: "tool", toolName: "summarize_task" })
            // Responses intentionally omits max_output_tokens. The runner unit test owns the exact reduced-cap
            // sequence; at the provider E2E boundary, verify immutable wire input across both retry kinds.
            const maxOutputReplayBody = requests[2].requestBody as Record<string, unknown>
            const normalRetryBody = requests[3].requestBody as Record<string, unknown>
            const successfulRetryBody = requests[4].requestBody as Record<string, unknown>
            for (const requestBody of [maxOutputReplayBody, normalRetryBody, successfulRetryBody]) {
                expect(requestBody).not.toHaveProperty("max_output_tokens")
            }
            expect(JSON.stringify(maxOutputReplayBody)).not.toContain(RETRY_REMINDER_HEADING)
            expect(JSON.stringify(normalRetryBody)).toContain(RETRY_REMINDER_HEADING)
            expect(JSON.stringify(successfulRetryBody)).not.toContain(RETRY_REMINDER_HEADING)
            expect(withoutRetryReminder(normalRetryBody)).toEqual(maxOutputReplayBody)
            expect(successfulRetryBody).toEqual(maxOutputReplayBody)
            expect(JSON.stringify(requests[4].requestBody)).not.toContain(damagedSummary)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Context compaction - automatic failure does not truncate until Force Truncate is confirmed",
    async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configureReducedCapScenario(dlineDir)
        const turnAMarker = "E2E_FORCE_TRUNCATE_TURN_A"
        const turnBMarker = "E2E_FORCE_TRUNCATE_TURN_B"
        const middleMarker = "E2E_FORCE_TRUNCATE_MIDDLE"
        const continueMarker = "E2E_FORCE_TRUNCATE_CONTINUE"
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_force_truncate_turn_a",
                name: "qna_respond",
                arguments: { response: `${turnAMarker}:${"A".repeat(20_000)}` },
                usage: { inputTokens: 120_000, outputTokens: 100 },
                matchRequestContract: true,
            },
            {
                type: "tool",
                id: "call_force_truncate_turn_b",
                name: "qna_respond",
                arguments: { response: `${turnBMarker}:${"B".repeat(20_000)}` },
                usage: { inputTokens: 300_000, outputTokens: 100 },
                matchRequestContract: true,
            },
            { type: "error", status: 400, message: "E2E_FORCE_TRUNCATE_COMPACTION_ATTEMPT_0" },
            {
                type: "tool",
                id: "call_force_truncate_recovered",
                name: "attempt_completion",
                arguments: { result: "E2E_FORCE_TRUNCATE_RECOVERED" },
                expectedRequestIncludes: [
                    continueMarker,
                    "[NOTE] Some previous conversation history with the user has been removed",
                ],
                expectedRequestExcludes: [middleMarker],
            },
        )

        let app: ElectronApplication | undefined
        try {
            app = await openVSCode(workspaceDir)
            let sidebar = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_FORCE_TRUNCATE_TASK")
            await expect(sidebar.getByText(turnAMarker, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await submitTask(sidebar, middleMarker)
            await expect(sidebar.getByText(turnBMarker, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await submitTask(sidebar, continueMarker)

            await expect(sidebar.getByTestId("compaction-failure")).toBeVisible({
                timeout: 120_000,
            })
            await expect(sidebar.getByText("Automatic retry stopped", { exact: true })).toHaveCount(0)
            await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(3)
            // Force Truncate must remain an explicit recovery choice, not an automatic retry side effect.
            await sidebar.page().waitForTimeout(3_000)
            expect(server.getRequestCount("openai-compatible-responses")).toBe(3)
            const failedRequests = server.getMockConsumptions("openai-compatible-responses")
            expect(failedRequests.slice(2)).toHaveLength(1)
            expect(failedRequests[2].responseType).toBe("error")
            expect(JSON.stringify(failedRequests[2].requestBody)).not.toContain(
                "[NOTE] Some previous conversation history with the user has been removed",
            )

            await app.close()
            helper.clearCachedFrame()
            app = undefined
            app = await openVSCode(workspaceDir)
            const reopenedPage = await app.firstWindow()
            await E2ETestHelper.openClineSidebar(reopenedPage)
            sidebar = await helper.getSidebar(reopenedPage)
            await reopenTask(reopenedPage, sidebar, "E2E_FORCE_TRUNCATE_TASK")
            await expect(sidebar.getByTestId("compaction-failure")).toBeVisible({ timeout: 60_000 })

            const expandTaskHeader = sidebar.getByLabel("Expand task header")
            if (await expandTaskHeader.isVisible()) await expandTaskHeader.click()
            const moreContextActions = sidebar.getByRole("button", { name: "More context actions" })
            await expect(moreContextActions).toBeVisible()
            await moreContextActions.click()
            const forceTruncateMenuItem = sidebar.getByRole("button", {
                name: "Force truncate conversation history",
                exact: true,
            })
            await expect(forceTruncateMenuItem).toBeVisible()
            await forceTruncateMenuItem.click()
            await expect(sidebar.getByText("Force truncate conversation history?", { exact: true })).toBeVisible()
            await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(3)
            const forceTruncateConfirmation = sidebar.getByLabel("Type TRUNCATE to confirm")
            await forceTruncateConfirmation.fill("TRUNCATE")
            await sidebar.getByText("Force truncate conversation history", { exact: true }).last().click()
            await expect(sidebar.getByRole("dialog")).not.toBeVisible()
            const taskId = await onlyTaskId(dlineDocsDir)
            const truncatedConversation = await E2ETestHelper.waitForValue(async () => {
                const projected = JSON.stringify(await readTaskConversation(dlineDocsDir, taskId))
                return projected.includes("[NOTE] Some previous conversation history with the user has been removed")
                    ? projected
                    : undefined
            })
            // A pre-round failure leaves the reply in pending round material;
            // Retry journals it when the next provider draft is composed.
            expect(truncatedConversation).not.toContain(middleMarker)
            await sidebar.getByRole("button", { name: "Retry", exact: true }).last().click()

            await expect
                .poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 60_000 })
                .toBeGreaterThanOrEqual(4)
            const recoveredRequest = server.getMockConsumptions("openai-compatible-responses")[3]
            expect(recoveredRequest.contractError).toBeUndefined()
            expect(recoveredRequest.responseType).toBe("tool")
            await expect(sidebar.getByText("E2E_FORCE_TRUNCATE_RECOVERED", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(4)
            const recoveredRequestText = JSON.stringify(recoveredRequest.requestBody)
            expect(recoveredRequestText).toContain(continueMarker)
            expect(recoveredRequestText).toContain("[NOTE] Some previous conversation history with the user has been removed")
            expect(recoveredRequestText).not.toContain(middleMarker)
            const recoveredConversation = JSON.stringify(await readTaskConversation(dlineDocsDir, taskId))
            expect(recoveredConversation).toContain(continueMarker)
            expect(recoveredConversation).toContain("[NOTE] Some previous conversation history with the user has been removed")
            expect(recoveredConversation).not.toContain(middleMarker)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/context window/i])
        } finally {
            await app?.close()
            helper.clearCachedFrame()
        }
    },
)
