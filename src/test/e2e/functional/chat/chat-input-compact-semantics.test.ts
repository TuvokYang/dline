import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { MockApiConsumption } from "@e2e/fixtures/server"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { expectComposerText, PASTED_PNG_CHIP_NAME } from "@e2e/utils/composer"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Locator } from "@playwright/test"
import type { ElectronApplication } from "playwright"

/**
 * WS-041 lifecycle barrier semantics for `/compact`, observed at the provider.
 *
 * The contract is about which request carries which text, so every test reads
 * what the mock provider received: the command itself never reaches the model,
 * its premessage is guidance for the summary only, and nothing typed later may
 * overtake the compaction it asked for.
 */

const PROVIDER = "anthropic-messages"
const COMPACT_INSTRUCTION_MARKER = "The current conversation is rapidly running out of context"
/** The wrapper the compaction request puts around the user's premessage. */
const GUIDANCE_WRAPPER = "<user_guidance>"
const ONE_PIXEL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
const ONE_PIXEL_PNG_BASE64_PREFIX = ONE_PIXEL_PNG_BASE64.slice(0, 24)

interface StoredProfile {
    name: string
    modelId?: string
    webToolsMode?: "WEB_TOOLS_MODE_FORCE_OFF"
}

const profilesPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "api_profiles.json")
const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")

/** Route both modes to the Anthropic mock and keep compaction strictly user-initiated. */
async function configureAnthropicManualCompact(dlineDir: string): Promise<void> {
    const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
    const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockAnthropic)
    if (!profile) throw new Error("Missing configurable Anthropic E2E profile")
    profile.modelId = "claude-sonnet-4-6"
    profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
    await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

    const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
    const next = {
        ...settings,
        actModeProfile: E2E_PROFILE_NAMES.mockAnthropic,
        planModeProfile: E2E_PROFILE_NAMES.mockAnthropic,
        useAutoCondense: false,
    }
    await writeFile(settingsPath(dlineDir), `${JSON.stringify(next, null, 2)}\n`, "utf8")
}

async function openSidebar(app: ElectronApplication, helper: E2ETestHelper): Promise<Frame> {
    const page = await app.firstWindow()
    await E2ETestHelper.openClineSidebar(page)
    const sidebar = await helper.getSidebar(page)
    await E2ETestHelper.dismissWhatsNewModal(sidebar)
    await helper.signin(sidebar)
    return sidebar
}

async function sendText(sidebar: Frame, text: string): Promise<void> {
    const input = sidebar.getByTestId("chat-input")
    await expect(input).toBeEnabled({ timeout: 60_000 })
    await input.fill(text)
    await expect(sidebar.getByTestId("send-button")).toHaveAttribute("data-action", /^(?:send|resume|queue)$/, {
        timeout: 60_000,
    })
    await input.press("Enter")
    await expectComposerText(input, "")
    await expect(sidebar.getByText(text, { exact: true }).last()).toBeVisible()
}

/** Paste a screenshot the way the clipboard handler receives one. */
async function pasteScreenshot(input: Locator): Promise<void> {
    await input.evaluate((element, encodedPng) => {
        const binary = atob(encodedPng)
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
        const clipboardData = new DataTransfer()
        clipboardData.items.add(new File([bytes], "compact-premessage.png", { type: "image/png" }))
        element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }))
    }, ONE_PIXEL_PNG_BASE64)
}

/**
 * Accept the summary under review, then wait for it to land.
 *
 * The review is drawn on the run's own card, so the landed summary remains the
 * one compaction card and no confirm control is left behind.
 */
async function condenseReviewedSummary(sidebar: Frame, summary: string): Promise<void> {
    await expect(sidebar.getByText(summary, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
    const confirmButton = sidebar.locator('vscode-button[aria-label="Condense Conversation"]')
    await expect(confirmButton).toBeVisible({ timeout: 60_000 })
    await confirmButton.click()
    await expect(confirmButton).toHaveCount(0)
    await expect(sidebar.getByTestId("compaction-pass")).toHaveCount(1)
    await expect(sidebar.getByTestId("compaction-pass")).toHaveAttribute("data-compaction-status", "completed", {
        timeout: 60_000,
    })
}

/**
 * Compaction beside an open dialog condenses the answered history before it, so
 * each dialog below follows one answered exchange besides the opening request.
 */
function answeredRead(callId: string, task: string) {
    return {
        type: "tool" as const,
        id: callId,
        name: "read_file",
        arguments: { path: "README.md" },
        expectedRequestIncludes: [task],
    }
}

async function attachJson(name: string, value: unknown): Promise<void> {
    await e2e.info().attach(`${name}.json`, {
        body: Buffer.from(JSON.stringify(value, null, 2), "utf8"),
        contentType: "application/json",
    })
}

/** Every string anywhere in a request body that mentions `needle`. */
function stringsMentioning(value: unknown, needle: string): string[] {
    if (typeof value === "string") return value.includes(needle) ? [value] : []
    if (Array.isArray(value)) return value.flatMap((item) => stringsMentioning(item, needle))
    if (value && typeof value === "object") return Object.values(value).flatMap((item) => stringsMentioning(item, needle))
    return []
}

function requestText(request: MockApiConsumption): string {
    return JSON.stringify(request.requestBody)
}

/**
 * A premessage is guidance for the summary, never a turn of its own: wherever
 * the provider sees it, it sits inside the compaction instruction.
 */
function expectOnlyInsideCompactionInstruction(request: MockApiConsumption, text: string): void {
    const carriers = stringsMentioning(request.requestBody, text)
    expect(carriers.length, `${text} must reach the compaction request`).toBeGreaterThan(0)
    for (const carrier of carriers) {
        expect(carrier).toContain(GUIDANCE_WRAPPER)
        expect(carrier).toContain(COMPACT_INSTRUCTION_MARKER)
    }
}

function expectCommandNeverSent(requests: readonly MockApiConsumption[]): void {
    for (const request of requests) expect(requestText(request)).not.toContain("/compact")
}

interface DialogCase {
    readonly kind: "plan" | "completion"
    readonly planMode: boolean
    readonly dialogTool: string
    readonly dialogArguments: (marker: string) => Record<string, unknown>
    /** Resolves once the dialog can take the reply rather than a new submission. */
    readonly awaitDialog: (sidebar: Frame) => Promise<void>
}

const DIALOG_CASES: readonly DialogCase[] = [
    {
        kind: "plan",
        planMode: true,
        dialogTool: "make_plan",
        dialogArguments: (marker) => ({ response: marker, needs_more_exploration: false }),
        awaitDialog: async () => {},
    },
    {
        kind: "completion",
        planMode: false,
        dialogTool: "attempt_completion",
        dialogArguments: (marker) => ({ result: marker }),
        // Completion text is published before its dialog opens; only the open
        // dialog takes the reply.
        awaitDialog: async (sidebar) => {
            await expect(sidebar.locator('vscode-button[aria-label="Start New Task"]')).toBeVisible({ timeout: 60_000 })
        },
    },
]

for (const dialogCase of DIALOG_CASES) {
    const tag = dialogCase.kind.toUpperCase()
    e2e(
        `Compact barrier - /compact sent to a ${dialogCase.kind} dialog compacts the history before it and keeps the dialog`,
        async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
            e2e.setTimeout(210_000)
            await configureAnthropicManualCompact(dlineDir)
            const task = `E2E_BARRIER_${tag}_TASK`
            const ready = `E2E_BARRIER_${tag}_READY`
            const reply = `E2E_BARRIER_${tag}_REPLY`
            const done = `E2E_BARRIER_${tag}_DONE`
            const guidance = `E2E_BARRIER_${tag}_GUIDANCE`
            const summary = `E2E_BARRIER_${tag}_SUMMARY keeps the ${dialogCase.kind} context.`
            const callIds = [
                `call_barrier_${dialogCase.kind}_read`,
                `call_barrier_${dialogCase.kind}_ready`,
                `call_barrier_${dialogCase.kind}_summary`,
                `call_barrier_${dialogCase.kind}_done`,
            ]
            server.enqueueResponses(
                PROVIDER,
                answeredRead(callIds[0], task),
                {
                    type: "tool",
                    id: callIds[1],
                    name: dialogCase.dialogTool,
                    arguments: dialogCase.dialogArguments(ready),
                    usage: { inputTokens: 80_000, outputTokens: 100 },
                    expectedToolResults: [{ callId: callIds[0], contentIncludes: "# Test Workspace" }],
                },
                {
                    type: "tool",
                    id: callIds[2],
                    name: "summarize_task",
                    arguments: { context: summary },
                    expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER, task, guidance],
                },
                {
                    // The user's own reply continues the task, after the summary.
                    type: "tool",
                    id: callIds[3],
                    name: dialogCase.dialogTool,
                    arguments: dialogCase.dialogArguments(done),
                    expectedRequestIncludes: [summary, reply],
                    expectedRequestExcludes: [COMPACT_INSTRUCTION_MARKER, guidance],
                },
            )

            const app = await openVSCode(workspaceDir)
            try {
                const sidebar = await openSidebar(app, helper)
                if (dialogCase.planMode) {
                    await sidebar.getByTestId("mode-switch").click()
                    await expect(sidebar.getByRole("switch", { name: "Plan" })).toHaveAttribute("aria-checked", "true", {
                        timeout: 60_000,
                    })
                }
                await sendText(sidebar, task)
                await expect(sidebar.getByText(ready, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
                await dialogCase.awaitDialog(sidebar)

                await sendText(sidebar, `/compact ${guidance}`)
                await condenseReviewedSummary(sidebar, summary)
                // The command answered nothing and no ordinary turn ran. The landed compaction
                // outlives the dialog, so its actions stay hidden while the composer still
                // takes the reply.
                await expect(sidebar.locator('vscode-button[aria-label="Start New Task"]')).toHaveCount(0)
                await expect(sidebar.getByTestId("chat-input")).toBeEnabled({ timeout: 60_000 })
                expect(server.getRequestCount(PROVIDER)).toBe(3)

                await sendText(sidebar, reply)
                await expect(sidebar.getByText(done, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
                await expect.poll(() => server.getRequestCount(PROVIDER)).toBe(4)

                const requests = server.getMockConsumptions(PROVIDER)
                await attachJson(`barrier-${dialogCase.kind}-provider-consumptions`, requests)
                expect(requests.map((request) => request.toolCallId)).toEqual(callIds)
                for (const request of requests) expect(request.contractError).toBeUndefined()
                expectOnlyInsideCompactionInstruction(requests[2], guidance)
                expect(stringsMentioning(requests[3].requestBody, guidance)).toEqual([])
                expectCommandNeverSent(requests)
                await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
            } finally {
                await app.close()
            }
        },
    )
}

e2e(
    "Compact barrier - a reply sent while the summary is pending reaches the model only after the summary",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(240_000)
        await configureAnthropicManualCompact(dlineDir)
        const guidance = "E2E_PENDING_GUIDANCE"
        const summary = "E2E_PENDING_SUMMARY keeps the pending-barrier context."
        const later = "E2E_PENDING_LATER_TEXT continue after the summary."
        server.enqueueResponses(
            PROVIDER,
            answeredRead("call_pending_read", "E2E_PENDING_TASK"),
            {
                type: "tool",
                id: "call_pending_ready",
                name: "qna_respond",
                arguments: { response: "E2E_PENDING_READY" },
                usage: { inputTokens: 80_000, outputTokens: 100 },
                expectedToolResults: [{ callId: "call_pending_read", contentIncludes: "# Test Workspace" }],
            },
            {
                // Held open long enough for the user to reply while the compaction runs.
                type: "tool",
                id: "call_pending_summary",
                name: "summarize_task",
                arguments: { context: summary },
                delayMs: 8_000,
                expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER, "E2E_PENDING_TASK", guidance],
                expectedRequestExcludes: [later],
            },
            {
                // The reply's round waited for the summary, so it carries both.
                type: "tool",
                id: "call_pending_later",
                name: "attempt_completion",
                arguments: { result: "E2E_PENDING_LATER_DONE" },
                expectedRequestIncludes: [summary, later],
                expectedRequestExcludes: [COMPACT_INSTRUCTION_MARKER, guidance],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await openSidebar(app, helper)
            await sendText(sidebar, "E2E_PENDING_TASK")
            await expect(sidebar.getByText("E2E_PENDING_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })

            await sendText(sidebar, `/compact ${guidance}`)
            await expect.poll(() => server.getRequestCount(PROVIDER), { timeout: 60_000 }).toBe(3)

            // The question is still open, so this text answers it; its round waits for the
            // summary and the user's verdict on it.
            await sendText(sidebar, later)
            expect(server.getRequestCount(PROVIDER)).toBe(3)
            await condenseReviewedSummary(sidebar, summary)
            await expect(sidebar.getByText("E2E_PENDING_LATER_DONE", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await expect.poll(() => server.getRequestCount(PROVIDER)).toBe(4)

            const requests = server.getMockConsumptions(PROVIDER)
            await attachJson("barrier-pending-provider-consumptions", requests)
            expect(requests.map((request) => request.toolCallId)).toEqual([
                "call_pending_read",
                "call_pending_ready",
                "call_pending_summary",
                "call_pending_later",
            ])
            for (const request of requests) expect(request.contractError).toBeUndefined()
            expect(requests.slice(0, 3).some((request) => requestText(request).includes(later))).toBe(false)
            expectOnlyInsideCompactionInstruction(requests[2], guidance)
            expectCommandNeverSent(requests)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    // The pasted image lands inline after the barrier. The words after /compact
    // steer the summary, but an attachment there is still the user's attachment:
    // it rides with the turn the command opens, never with the summary request.
    "Compact barrier - a mention after /compact guides the summary and an image after it reaches the next turn",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(210_000)
        await configureAnthropicManualCompact(dlineDir)
        const fileName = "e2e-compact-resource.txt"
        const fileMarker = "E2E_COMPACT_RESOURCE_FILE_BODY"
        const guidance = "E2E_RESOURCE_GUIDANCE"
        const trailing = "E2E_RESOURCE_TRAILING_TEXT"
        const summary = "E2E_RESOURCE_SUMMARY keeps the resource-barrier context."
        await writeFile(path.join(workspaceDir, fileName), `${fileMarker}\n`, "utf8")
        server.enqueueResponses(
            PROVIDER,
            {
                type: "tool",
                id: "call_resource_ready",
                name: "qna_respond",
                arguments: { response: "E2E_RESOURCE_READY" },
                usage: { inputTokens: 80_000, outputTokens: 100 },
            },
            {
                // Everything after the barrier is its premessage, the resolved mention included.
                type: "tool",
                id: "call_resource_summary",
                name: "summarize_task",
                arguments: { context: summary },
                expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER, "E2E_RESOURCE_TASK", guidance, fileMarker, trailing],
                expectedRequestExcludes: [ONE_PIXEL_PNG_BASE64_PREFIX],
            },
            {
                // The image is an attachment of the submission, not of the command,
                // so it reaches the model with the turn the submission opens.
                type: "tool",
                id: "call_resource_done",
                name: "attempt_completion",
                arguments: { result: "E2E_RESOURCE_DONE" },
                expectedRequestIncludes: [summary, "image/png", ONE_PIXEL_PNG_BASE64_PREFIX],
                expectedRequestExcludes: [COMPACT_INSTRUCTION_MARKER, guidance, fileMarker, trailing],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await openSidebar(app, helper)
            await sendText(sidebar, "E2E_RESOURCE_TASK")
            await expect(sidebar.getByText("E2E_RESOURCE_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })

            const input = sidebar.getByTestId("chat-input")
            // Trailing prose keeps the caret away from the mention, so no completion menu opens.
            const draft = `/compact ${guidance} @/${fileName} ${trailing}`
            await input.fill(draft)
            await pasteScreenshot(input)
            const chip = input.getByRole("group", { name: PASTED_PNG_CHIP_NAME })
            await expect(chip).toBeVisible({ timeout: 30_000 })
            await expect(chip.locator("img.composer-chip__thumbnail")).toBeVisible()
            await expectComposerText(input, draft)
            // A resource still being staged holds the send back; wait until it may go.
            await expect(chip).toHaveAttribute("data-status", "ready", { timeout: 30_000 })
            await input.press("Enter")
            await expectComposerText(input, "")

            // The image keeps this reply from being a bare command, so it still answers the
            // question: the round compacts first and then carries the image.
            await condenseReviewedSummary(sidebar, summary)
            await expect(sidebar.getByText("E2E_RESOURCE_DONE", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await expect.poll(() => server.getRequestCount(PROVIDER)).toBe(3)

            const requests = server.getMockConsumptions(PROVIDER)
            await attachJson("barrier-resource-provider-consumptions", requests)
            expect(requests.map((request) => request.toolCallId)).toEqual([
                "call_resource_ready",
                "call_resource_summary",
                "call_resource_done",
            ])
            for (const request of requests) expect(request.contractError).toBeUndefined()
            expectOnlyInsideCompactionInstruction(requests[1], guidance)
            expectOnlyInsideCompactionInstruction(requests[1], fileMarker)
            expectCommandNeverSent(requests)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)
