import { readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { expectOwnedUserFeedback } from "@e2e/utils/compaction-request-oracle"
import {
    COMPACT_INSTRUCTION_MARKER,
    COMPACT_SIGNAL,
    captureContextWindowEvidence,
    captureLocatorEvidence,
    expectCompactionSummary,
    expectContextVisualAllocation,
    expectFourContextSegments,
    openSidebar,
    readContextWindowVisual,
    requestToolNames,
    sendTask,
    taskDirectoryIds,
} from "@e2e/utils/context-window-fixture"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import {
    readTaskConversationText,
    readTaskInteractionView,
    readTaskUiMessagesText,
    type TaskInteractionView,
} from "@e2e/utils/task-instance-store"
import { expect } from "@playwright/test"
import { MAX_TOOL_RESULT_TEXT_BYTES } from "@shared/content-limits"

interface StoredProfile {
    id: string
    name: string
    webToolsMode?: "WEB_TOOLS_MODE_FORCE_OFF"
}

const profilesPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "api_profiles.json")
const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")

async function configureDeepSeekAutoCompact(dlineDir: string, useAutoCondense = true): Promise<void> {
    const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
    const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockDeepSeek)
    if (!profile) throw new Error("Missing configurable DeepSeek E2E profile")
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
                useAutoCondense,
                autoCondenseTriggerPercent: 97,
                autoCondenseMinReserveTokens: 5_000,
                autoCondenseMaxReserveTokens: 30_000,
                autoCondenseMaxContextTokens: 0,
            },
            null,
            2,
        )}\n`,
        "utf8",
    )
}

async function readCompletionSnapshot(dlineDocsDir: string, taskId: string): Promise<TaskInteractionView> {
    return readTaskInteractionView(dlineDocsDir, taskId)
}

// The completion turns here call only `attempt_completion`, so it is the turn-ending block.
function completionSnapshotState(snapshot: TaskInteractionView) {
    return {
        phase: snapshot.phase,
        completionId: snapshot.completionId,
        interactionId: snapshot.interactionId,
        interactionKind: snapshot.interactionKind,
        interactionStatus: snapshot.interactionStatus,
        anchorInteractionId: snapshot.anchorInteractionId,
        completionBlockId: snapshot.blockId,
    }
}

e2e(
    "DeepSeek context - 630K usage remains at 63 percent of 1M without an early recovery truncation",
    async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configureDeepSeekAutoCompact(dlineDir)
        server.enqueueResponses(
            "deepseek-chat",
            {
                type: "tool",
                id: "call_deepseek_context_round_one",
                name: "qna_respond",
                arguments: { response: "E2E_DEEPSEEK_CONTEXT_ROUND_ONE" },
            },
            {
                type: "tool",
                id: "call_deepseek_context_round_two",
                name: "qna_respond",
                arguments: { response: "E2E_DEEPSEEK_CONTEXT_ROUND_TWO" },
                expectedRequestIncludes: ["E2E_DEEPSEEK_CONTEXT_MIDDLE_ONE"],
            },
            {
                type: "tool",
                id: "call_deepseek_context_ready",
                name: "qna_respond",
                arguments: { response: "E2E_DEEPSEEK_CONTEXT_READY" },
                usage: { inputTokens: 630_000, outputTokens: 100 },
                expectedRequestIncludes: ["E2E_DEEPSEEK_CONTEXT_LATE_TURN"],
            },
            {
                type: "tool",
                id: "call_deepseek_context_direct_completion",
                name: "attempt_completion",
                arguments: { result: "E2E_DEEPSEEK_CONTEXT_DIRECT_OK" },
                usage: { inputTokens: 630_000, outputTokens: 100 },
                delayMs: 5_000,
                expectedRequestIncludes: ["E2E_DEEPSEEK_CONTEXT_CONTINUE"],
            },
            {
                type: "tool",
                id: "call_deepseek_context_final_completion",
                name: "attempt_completion",
                arguments: { result: "E2E_DEEPSEEK_CONTEXT_FINAL_OK" },
                usage: { inputTokens: 630_000, outputTokens: 100 },
                delayMs: 5_000,
                expectedRequestIncludes: ["E2E_DEEPSEEK_CONTEXT_POST_COMPLETION_FEEDBACK"],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const { sidebar } = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_DEEPSEEK_CONTEXT_TASK")
            await expect(sidebar.getByText("E2E_DEEPSEEK_CONTEXT_ROUND_ONE", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await sendTask(sidebar, "E2E_DEEPSEEK_CONTEXT_MIDDLE_ONE")
            await expect(sidebar.getByText("E2E_DEEPSEEK_CONTEXT_ROUND_TWO", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await sendTask(sidebar, "E2E_DEEPSEEK_CONTEXT_LATE_TURN")
            await expect(sidebar.getByText("E2E_DEEPSEEK_CONTEXT_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })

            const expandTaskHeader = sidebar.getByLabel("Expand task header")
            if (await expandTaskHeader.isVisible()) await expandTaskHeader.click()
            await expect(sidebar.locator('[title="Current tokens used in this request"]')).toHaveText("630.1k")
            await expect(sidebar.locator('[title="Maximum context window size for this model"]')).toHaveText("1.0m")
            const progress = sidebar.getByRole("progressbar", { name: "Context window usage progress" })
            await expect(progress).toHaveAttribute("aria-valuenow", "630100")
            await expect(progress).toHaveAttribute("aria-valuemax", "1000000")
            await expect(progress).toHaveAttribute("aria-valuetext", "630100 of 1000000 tokens; phase receiving")
            const receivingVisual = await readContextWindowVisual(sidebar)
            expectFourContextSegments(receivingVisual)
            expect(receivingVisual.phase).toBe("receiving")
            expectContextVisualAllocation(receivingVisual)
            expect(receivingVisual.segments.reduce((total, segment) => total + segment.authoritativeTokens, 0)).toBe(630100)

            const focusableContextSegment = sidebar.getByTestId("context-window-tooltip-trigger")
            await focusableContextSegment.hover()
            const hoverCardContent = sidebar.locator('[data-slot="hover-card-content"]')
            await expect(hoverCardContent).toBeVisible()
            const contextWindowSummary = hoverCardContent.getByText("Context Window", { exact: true })
            await expect(contextWindowSummary).toBeVisible()
            await contextWindowSummary.click()
            const segmentDetails = hoverCardContent.getByTestId("context-window-segment-details")
            await expect(segmentDetails).toBeVisible()
            for (const kind of ["durable", "active", "staged", "environment"] as const) {
                await expect(segmentDetails.locator(`[data-segment-detail="${kind}"]`)).toBeVisible()
            }
            await captureLocatorEvidence(hoverCardContent, e2e.info(), "deepseek-context-630k")

            const [taskId] = await E2ETestHelper.waitForValue(async () => {
                const ids = await taskDirectoryIds(dlineDocsDir)
                return ids.length === 1 ? ids : undefined
            })
            if (!taskId) throw new Error("DeepSeek Context E2E task directory was not created")

            await sendTask(sidebar, "E2E_DEEPSEEK_CONTEXT_CONTINUE")
            await expect(sidebar.getByText("E2E_DEEPSEEK_CONTEXT_DIRECT_OK", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await expect.poll(() => server.getRequestCount("deepseek-chat"), { timeout: 30_000 }).toBe(4)
            await expect
                .poll(async () => completionSnapshotState(await readCompletionSnapshot(dlineDocsDir, taskId)), {
                    timeout: 30_000,
                })
                .toMatchObject({
                    phase: "completed",
                    interactionKind: "completion",
                    interactionStatus: "awaiting",
                })
            const firstCompletion = completionSnapshotState(await readCompletionSnapshot(dlineDocsDir, taskId))
            expect(firstCompletion.completionId).toBe(firstCompletion.interactionId)
            expect(firstCompletion.anchorInteractionId).toBe(firstCompletion.interactionId)
            expect(firstCompletion.completionBlockId).toBe(firstCompletion.interactionId)
            await expect(progress).toHaveAttribute("data-phase", "stable")
            await expect(progress).toHaveAttribute("aria-valuenow", "630100")
            await expect(progress).toHaveAttribute("aria-valuetext", "630100 of 1000000 tokens; phase stable")

            await sendTask(sidebar, "E2E_DEEPSEEK_CONTEXT_POST_COMPLETION_FEEDBACK")
            await expect.poll(() => server.getRequestCount("deepseek-chat"), { timeout: 30_000 }).toBe(5)
            await expect
                .poll(async () => completionSnapshotState(await readCompletionSnapshot(dlineDocsDir, taskId)), {
                    timeout: 4_000,
                })
                .toMatchObject({
                    phase: "streaming",
                    completionId: undefined,
                    interactionId: undefined,
                    interactionKind: undefined,
                    interactionStatus: undefined,
                })
            await expect(sidebar.getByText("E2E_DEEPSEEK_CONTEXT_FINAL_OK", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })

            const requests = server.getMockConsumptions("deepseek-chat")
            expect(requests).toHaveLength(5)
            expect(requests[3]).toMatchObject({ responseType: "tool", toolName: "attempt_completion" })
            expect(requests[4]).toMatchObject({ responseType: "tool", toolName: "attempt_completion" })
            await expect(progress).toHaveAttribute("data-phase", "stable")
            await expect(progress).toHaveAttribute("aria-valuenow", "630100")
            await expect(progress).toHaveAttribute("aria-valuetext", "630100 of 1000000 tokens; phase stable")
            await expect
                .poll(async () => completionSnapshotState(await readCompletionSnapshot(dlineDocsDir, taskId)), {
                    timeout: 30_000,
                })
                .toMatchObject({
                    phase: "completed",
                    interactionKind: "completion",
                    interactionStatus: "awaiting",
                })
            const finalCompletion = completionSnapshotState(await readCompletionSnapshot(dlineDocsDir, taskId))
            expect(finalCompletion.completionId).toBe(finalCompletion.interactionId)
            expect(finalCompletion.anchorInteractionId).toBe(finalCompletion.interactionId)
            expect(finalCompletion.completionBlockId).toBe(finalCompletion.interactionId)
            const stableVisual = await readContextWindowVisual(sidebar)
            expectFourContextSegments(stableVisual)
            expect(stableVisual.phase).toBe("stable")
            expect(stableVisual.segments.reduce((total, segment) => total + segment.authoritativeTokens, 0)).toBe(630100)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "DeepSeek context - 930K plus bounded completed tool turns compacts under the real 1M window",
    async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(300_000)
        await configureDeepSeekAutoCompact(dlineDir)

        const buildLargeFile = (marker: string, fill: string) =>
            [marker, ...Array.from({ length: 998 }, (_, index) => `${String(index).padStart(4, "0")}:${fill.repeat(355)}`)].join(
                "\n",
            )
        const seedFiles = Array.from({ length: 6 }, (_, index) => ({
            callId: `call_deepseek_pressure_seed_${index}`,
            marker: `E2E_DEEPSEEK_PRESSURE_SEED_${index}`,
            path: `deepseek-pressure-seed-${index}.txt`,
        }))
        const protectedFiles = Array.from({ length: 4 }, (_, index) => ({
            callId: `call_deepseek_pressure_protected_${index}`,
            marker: `E2E_DEEPSEEK_PRESSURE_PROTECTED_${index}`,
            path: `deepseek-pressure-protected-${index}.txt`,
        }))
        await Promise.all([
            ...seedFiles.map((file, index) =>
                writeFile(path.join(workspaceDir, file.path), buildLargeFile(file.marker, String(index)), "utf8"),
            ),
            ...protectedFiles.map((file, index) =>
                writeFile(path.join(workspaceDir, file.path), buildLargeFile(file.marker, String(index + 6)), "utf8"),
            ),
        ])

        const summary = "E2E_DEEPSEEK_PRESSURE_SUMMARY preserves the task while the protected tool-result turn is replayed."
        server.enqueueResponses(
            "deepseek-chat",
            {
                type: "tools",
                tools: seedFiles.map((file) => ({ id: file.callId, name: "read_file", arguments: { path: file.path } })),
                expectedRequestIncludes: ["E2E_DEEPSEEK_PRESSURE_TASK"],
            },
            {
                type: "tools",
                tools: protectedFiles.map((file) => ({ id: file.callId, name: "read_file", arguments: { path: file.path } })),
                usage: { inputTokens: 930_000, outputTokens: 100 },
                expectedToolResults: seedFiles.map((file) => ({ callId: file.callId, contentIncludes: file.marker })),
            },
            {
                type: "tool",
                id: "call_deepseek_pressure_summary",
                name: "summarize_task",
                arguments: { context: summary },
                delayMs: 5_000,
                expectedRequestIncludes: [
                    COMPACT_INSTRUCTION_MARKER,
                    ...seedFiles.map((file) => file.marker),
                    ...protectedFiles.map((file) => file.marker),
                ],
            },
            {
                type: "tool",
                id: "call_deepseek_pressure_complete",
                name: "attempt_completion",
                arguments: { result: "E2E_DEEPSEEK_PRESSURE_COMPLETE" },
                expectedRequestIncludes: [summary],
                expectedRequestExcludes: [
                    COMPACT_INSTRUCTION_MARKER,
                    ...seedFiles.map((file) => file.marker),
                    ...protectedFiles.map((file) => file.marker),
                ],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const { page, sidebar } = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_DEEPSEEK_PRESSURE_TASK", 60_000)

            await expect.poll(() => server.getRequestCount("deepseek-chat"), { timeout: 120_000 }).toBeGreaterThanOrEqual(3)
            const requestsAtSummary = server.getMockConsumptions("deepseek-chat")
            const ordinaryRequest = requestsAtSummary[1]
            const summaryRequest = requestsAtSummary[2]
            const ordinaryEstimatedTokens = Math.ceil(Buffer.byteLength(JSON.stringify(ordinaryRequest.requestBody), "utf8") / 4)
            expect(ordinaryEstimatedTokens).toBeLessThan(800_000)
            expect(ordinaryRequest).toMatchObject({ responseType: "tools", usage: { inputTokens: 930_000 } })
            const seedResults = ordinaryRequest.requestToolResults.filter((result) =>
                seedFiles.some((file) => file.callId === result.callId),
            )
            expect(seedResults).toHaveLength(seedFiles.length)
            for (const result of seedResults) {
                expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(MAX_TOOL_RESULT_TEXT_BYTES)
                expect(/Use start_line=\d+ to continue reading/.test(result.content)).toBe(true)
            }
            expect(summaryRequest.contractError).toBeUndefined()
            expect(summaryRequest).toMatchObject({ responseType: "tool", toolName: "summarize_task" })
            const summarizedResults = summaryRequest.requestToolResults.filter((result) =>
                [...seedFiles, ...protectedFiles].some((file) => file.callId === result.callId),
            )
            expect(summarizedResults).toHaveLength(seedFiles.length + protectedFiles.length)
            for (const result of summarizedResults) {
                expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(MAX_TOOL_RESULT_TEXT_BYTES)
                expect(/Use start_line=\d+ to continue reading/.test(result.content)).toBe(true)
            }

            const expandTaskHeader = sidebar.getByLabel("Expand task header")
            if (await expandTaskHeader.isVisible()) await expandTaskHeader.click()
            await expect(sidebar.locator('[title="Maximum context window size for this model"]')).toHaveText("1.0m")
            const contextProgress = sidebar.getByRole("progressbar", { name: "Context window usage progress" })
            // The hidden Pass sends the conversation the Provider measured at 930K, so while it is
            // in flight the bar keeps that figure instead of a local estimate of the same history.
            let measuredTokens = 0
            await expect
                .poll(async () => {
                    const phase = await contextProgress.getAttribute("data-phase")
                    measuredTokens = Number(await contextProgress.getAttribute("aria-valuenow"))
                    return {
                        inFlight: phase === "sending" || phase === "receiving",
                        measured: measuredTokens >= 930_000,
                    }
                })
                .toEqual({ inFlight: true, measured: true })

            await expect(sidebar.getByText("E2E_DEEPSEEK_PRESSURE_COMPLETE", { exact: false }).last()).toBeVisible({
                timeout: 120_000,
            })
            await expect.poll(() => server.getRequestCount("deepseek-chat"), { timeout: 60_000 }).toBe(4)
            const requests = server.getMockConsumptions("deepseek-chat")
            const finalRequest = requests[3]
            const finalEstimatedTokens = Math.ceil(Buffer.byteLength(JSON.stringify(finalRequest.requestBody), "utf8") / 4)
            expect(finalRequest).toMatchObject({ responseType: "tool", toolName: "attempt_completion" })
            expect(finalRequest.contractError).toBeUndefined()
            expect(finalEstimatedTokens).toBeLessThan(800_000)
            const summarizedResultIds = new Set<string | undefined>([...seedFiles, ...protectedFiles].map((file) => file.callId))
            expect(finalRequest.requestToolResults.filter((result) => summarizedResultIds.has(result.callId))).toHaveLength(0)
            expect(requests.every((request) => request.status === undefined && request.contractError === undefined)).toBe(true)
            await expectCompactionSummary(sidebar, summary)
            await expect
                .poll(async () => Number(await contextProgress.getAttribute("aria-valuenow")))
                .toBeLessThan(measuredTokens)

            await captureContextWindowEvidence(sidebar, e2e.info(), "deepseek-context-1m-large-tool-result")

            const [taskId] = await taskDirectoryIds(dlineDocsDir)
            if (!taskId) throw new Error("DeepSeek pressure E2E task directory was not created")
            const apiHistory = await readTaskConversationText(dlineDocsDir, taskId)
            const uiMessages = await readTaskUiMessagesText(dlineDocsDir, taskId)
            expect(apiHistory).not.toContain(summary)
            for (const file of [...seedFiles, ...protectedFiles]) expect(apiHistory).toContain(file.marker)
            expect(uiMessages).toContain(summary)
            const persistedCompactionTools = uiMessages
                .split(/\r?\n/)
                .filter(Boolean)
                .flatMap((line): Array<{ tool?: string; compactionStatus?: string }> => {
                    const message = JSON.parse(line) as { say?: string; text?: string }
                    if (message.say !== "tool" || !message.text) return []
                    try {
                        return [JSON.parse(message.text) as { tool?: string; compactionStatus?: string }]
                    } catch {
                        return []
                    }
                })
            expect(persistedCompactionTools).toContainEqual(
                expect.objectContaining({ tool: "summarizeTask", compactionStatus: "completed" }),
            )
            expect(uiMessages).not.toMatch(/"conversationHistoryDeletedRange":\s*\[/)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "DeepSeek context - usage near 1M auto condenses with enough output budget for the summary",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configureDeepSeekAutoCompact(dlineDir)
        server.enqueueResponses(
            "deepseek-chat",
            {
                type: "tool",
                id: "call_deepseek_near_limit_ready",
                name: "qna_respond",
                arguments: { response: "E2E_DEEPSEEK_NEAR_LIMIT_READY" },
                usage: { inputTokens: 980_000, outputTokens: 100 },
            },
            {
                type: "tool",
                id: "call_deepseek_near_limit_summary",
                name: "summarize_task",
                arguments: { context: "E2E_DEEPSEEK_NEAR_LIMIT_SUMMARY preserves the task and latest request." },
                expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER],
                expectedRequestExcludes: [COMPACT_SIGNAL, "E2E_DEEPSEEK_NEAR_LIMIT_CONTINUE"],
            },
            {
                type: "tool",
                id: "call_deepseek_near_limit_completion",
                name: "attempt_completion",
                arguments: { result: "E2E_DEEPSEEK_NEAR_LIMIT_OK" },
                expectedRequestIncludes: ["E2E_DEEPSEEK_NEAR_LIMIT_SUMMARY", "E2E_DEEPSEEK_NEAR_LIMIT_CONTINUE"],
                expectedRequestExcludes: [COMPACT_SIGNAL, COMPACT_INSTRUCTION_MARKER],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const { sidebar } = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_DEEPSEEK_NEAR_LIMIT_TASK")
            await expect(sidebar.getByText("E2E_DEEPSEEK_NEAR_LIMIT_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })

            const expandTaskHeader = sidebar.getByLabel("Expand task header")
            if (await expandTaskHeader.isVisible()) await expandTaskHeader.click()
            await expect(sidebar.locator('[title="Current tokens used in this request"]')).toHaveText("980.1k")
            await expect(sidebar.locator('[title="Maximum context window size for this model"]')).toHaveText("1.0m")
            await expect(sidebar.getByRole("progressbar", { name: "Context window usage progress" })).toHaveAttribute(
                "aria-valuenow",
                "980100",
            )

            await sendTask(sidebar, "E2E_DEEPSEEK_NEAR_LIMIT_CONTINUE")
            await expect.poll(() => server.getRequestCount("deepseek-chat"), { timeout: 60_000 }).toBeGreaterThanOrEqual(2)
            const requests = server.getMockConsumptions("deepseek-chat")
            const summaryRequest = requests[1]
            const summaryBody = summaryRequest.requestBody as { max_completion_tokens?: number }
            // The model output ceiling is independent from the input-context compaction trigger.
            expect(summaryBody.max_completion_tokens).toBe(384_000)
            expect(summaryRequest).toMatchObject({ responseType: "tool", toolName: "summarize_task" })
            expect(requestToolNames(summaryRequest)).toEqual(requestToolNames(requests[0]))
            expect(requestToolNames(summaryRequest)).not.toContain("summarize_task")

            await expect(sidebar.getByText("E2E_DEEPSEEK_NEAR_LIMIT_OK", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await expect.poll(() => server.getRequestCount("deepseek-chat")).toBe(3)
            const finalRequest = server.getMockConsumptions("deepseek-chat")[2]
            expect(finalRequest.contractError).toBeUndefined()
            // The unseen reply remains protected continuation, carried once as user
            // input while its paired tool result stays neutral.
            const reply = "E2E_DEEPSEEK_NEAR_LIMIT_CONTINUE"
            expect(JSON.stringify(summaryRequest.requestBody)).not.toContain(reply)
            expectOwnedUserFeedback(finalRequest, ["call_deepseek_near_limit_ready"], [reply])
            expect(finalRequest.requestToolPairing.complete).toBe(true)
            expect(JSON.stringify(finalRequest.requestBody).split(reply)).toHaveLength(2)
            await expectCompactionSummary(sidebar, "E2E_DEEPSEEK_NEAR_LIMIT_SUMMARY preserves the task and latest request.")
            await expect
                .poll(async () =>
                    Number(
                        await sidebar
                            .getByRole("progressbar", { name: "Context window usage progress" })
                            .getAttribute("aria-valuenow"),
                    ),
                )
                .toBeLessThan(980_100)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "DeepSeek context - context-limit recovery tells the model that history was truncated",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configureDeepSeekAutoCompact(dlineDir, false)
        server.enqueueResponses(
            "deepseek-chat",
            {
                type: "tool",
                id: "call_deepseek_truncation_round_one",
                name: "qna_respond",
                arguments: { response: "E2E_DEEPSEEK_TRUNCATION_ROUND_ONE" },
            },
            {
                type: "tool",
                id: "call_deepseek_truncation_round_two",
                name: "qna_respond",
                arguments: { response: "E2E_DEEPSEEK_TRUNCATION_ROUND_TWO" },
                expectedRequestIncludes: ["E2E_DEEPSEEK_TRUNCATION_MIDDLE"],
            },
            {
                type: "tool",
                id: "call_deepseek_truncation_ready",
                name: "qna_respond",
                arguments: { response: "E2E_DEEPSEEK_TRUNCATION_READY" },
                expectedRequestIncludes: ["E2E_DEEPSEEK_TRUNCATION_LATE"],
            },
            {
                type: "error",
                status: 400,
                code: "context_length_exceeded",
                message: "The DeepSeek request exceeded its context window.",
                requestId: "req_deepseek_truncation_notice",
            },
            {
                type: "tool",
                id: "call_deepseek_truncation_recovered",
                name: "attempt_completion",
                arguments: { result: "E2E_DEEPSEEK_TRUNCATION_RECOVERED" },
                expectedRequestIncludes: [
                    "E2E_DEEPSEEK_TRUNCATION_TASK",
                    "E2E_DEEPSEEK_TRUNCATION_CONTINUE",
                    "[NOTE] Some previous conversation history with the user has been removed",
                ],
                expectedRequestExcludes: ["E2E_DEEPSEEK_TRUNCATION_MIDDLE"],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const { sidebar } = await openSidebar(app, helper)
            await sendTask(sidebar, "E2E_DEEPSEEK_TRUNCATION_TASK")
            await expect(sidebar.getByText("E2E_DEEPSEEK_TRUNCATION_ROUND_ONE", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await sendTask(sidebar, "E2E_DEEPSEEK_TRUNCATION_MIDDLE")
            await expect(sidebar.getByText("E2E_DEEPSEEK_TRUNCATION_ROUND_TWO", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await sendTask(sidebar, "E2E_DEEPSEEK_TRUNCATION_LATE")
            await expect(sidebar.getByText("E2E_DEEPSEEK_TRUNCATION_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await sendTask(sidebar, "E2E_DEEPSEEK_TRUNCATION_CONTINUE")

            await expect.poll(() => server.getRequestCount("deepseek-chat"), { timeout: 60_000 }).toBeGreaterThanOrEqual(5)
            const recoveryRequest = server.getMockConsumptions("deepseek-chat")[4]
            expect(JSON.stringify(recoveryRequest.requestBody)).toContain(
                "[NOTE] Some previous conversation history with the user has been removed",
            )
            expect(recoveryRequest).toMatchObject({ responseType: "tool", toolName: "attempt_completion" })
            await expect(sidebar.getByText("E2E_DEEPSEEK_TRUNCATION_RECOVERED", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/context window/i])
        } finally {
            await app.close()
        }
    },
)
