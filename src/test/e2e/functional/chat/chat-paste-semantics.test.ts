import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Locator } from "@playwright/test"
import type { ElectronApplication } from "playwright"

/**
 * WS-041 paste semantics, driven through the real clipboard.
 *
 * A synthetic ClipboardEvent is untrusted, so the browser never inserts its
 * text; only a keyboard paste exercises the native insertion the composer
 * tracks. The clipboard is written in the Electron main process for that reason.
 */

const COMPACT_INSTRUCTION_MARKER = "The current conversation is rapidly running out of context"
const PASTED_CANDIDATE_NOTICE = "pasted-candidate-notice"

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

async function startTask(sidebar: Frame, text: string): Promise<Locator> {
    const input = sidebar.getByTestId("chat-input")
    await expect(input).toBeEnabled()
    await input.fill(text)
    await input.press("Enter")
    await expect(input).toHaveValue("")
    await expect(sidebar.getByText(text, { exact: true }).last()).toBeVisible()
    return input
}

/** Paste `text` into the composer the way a user does: clipboard, then the paste shortcut. */
async function pasteFromClipboard(app: ElectronApplication, input: Locator, text: string): Promise<void> {
    await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text)
    await input.press(process.platform === "darwin" ? "Meta+V" : "Control+V")
}

async function attachScreenshot(app: ElectronApplication, name: string): Promise<void> {
    const screenshotPath = e2e.info().outputPath(`${name}.png`)
    try {
        await (await app.firstWindow()).screenshot({ path: screenshotPath, timeout: 5_000 })
        await e2e.info().attach(name, { path: screenshotPath, contentType: "image/png" })
    } catch (error) {
        await e2e.info().attach(`${name}-screenshot-error.txt`, {
            body: Buffer.from(error instanceof Error ? (error.stack ?? error.message) : String(error), "utf8"),
            contentType: "text/plain",
        })
    }
}

/**
 * Build one line of exactly `bytes` UTF-8 bytes, starting with `marker`.
 *
 * The padding is mostly three-byte characters, so the UTF-16 length stays far
 * below the byte count: a size check that measured string length instead of
 * UTF-8 bytes would keep this text inline.
 */
function singleLineOfUtf8Bytes(marker: string, bytes: number): string {
    const wide = "中"
    const remaining = bytes - Buffer.byteLength(marker, "utf8")
    const wideCount = Math.floor(remaining / Buffer.byteLength(wide, "utf8"))
    const text = `${marker}${wide.repeat(wideCount)}${"x".repeat(remaining - wideCount * Buffer.byteLength(wide, "utf8"))}`
    if (Buffer.byteLength(text, "utf8") !== bytes) throw new Error(`Expected ${bytes} UTF-8 bytes`)
    return text
}

async function attachJson(name: string, value: unknown): Promise<void> {
    await e2e.info().attach(`${name}.json`, {
        body: Buffer.from(JSON.stringify(value, null, 2), "utf8"),
        contentType: "application/json",
    })
}

e2e(
    "Chat input - a pasted /compact stays literal text until the user picks it from the menu",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(240_000)
        await configureAnthropicManualCompact(dlineDir)
        const literal = "/compact E2E_PASTE_LITERAL"
        const guidance = "E2E_PASTE_CONFIRMED_GUIDANCE"
        const summary = "E2E_PASTE_CONFIRMED_SUMMARY keeps the pasted-candidate requirement."
        server.enqueueResponses(
            "anthropic-messages",
            {
                type: "tool",
                id: "call_paste_ready",
                name: "qna_respond",
                arguments: { response: "E2E_PASTE_READY" },
                usage: { inputTokens: 80_000, outputTokens: 100 },
            },
            {
                // The pasted command reaches the model verbatim and never starts a compaction.
                type: "tool",
                id: "call_paste_literal_ack",
                name: "qna_respond",
                arguments: { response: "E2E_PASTE_LITERAL_ACK" },
                expectedRequestIncludes: [literal],
                expectedRequestExcludes: [COMPACT_INSTRUCTION_MARKER],
            },
            {
                // Picking the candidate from the menu is the confirmation: the barrier runs and
                // its pre-message becomes compaction guidance, not conversation text.
                type: "tool",
                id: "call_paste_confirmed_summary",
                name: "summarize_task",
                arguments: { context: summary },
                expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER, "E2E_PASTE_TASK", guidance],
                expectedRequestExcludes: ["/cmd:compact"],
            },
            {
                type: "tool",
                id: "call_paste_confirmed_completion",
                name: "attempt_completion",
                arguments: { result: "E2E_PASTE_DONE" },
                expectedRequestIncludes: [summary],
                expectedRequestExcludes: [COMPACT_INSTRUCTION_MARKER, guidance],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await openSidebar(app, helper)
            const input = await startTask(sidebar, "E2E_PASTE_TASK")
            await expect(sidebar.getByText("E2E_PASTE_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })

            // AC-09: a pasted candidate is held and named without relying on color.
            await pasteFromClipboard(app, input, literal)
            await expect(input).toHaveValue(literal)
            const notice = sidebar.getByTestId(PASTED_CANDIDATE_NOTICE)
            await expect(notice).toBeVisible()
            await expect(notice).toContainText("/compact")
            await expect(notice).toContainText("plain text")
            await attachScreenshot(app, "paste-literal-held")

            await input.press("Enter")
            await expect(input).toHaveValue("")
            await expect(sidebar.getByText("E2E_PASTE_LITERAL_ACK", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await expect(sidebar.locator('vscode-button[aria-label="Condense Conversation"]')).toHaveCount(0)
            await expect(notice).toHaveCount(0)
            expect(server.getRequestCount("anthropic-messages")).toBe(2)

            // Confirming the pasted candidate through the menu releases it.
            await pasteFromClipboard(app, input, `/compact ${guidance}`)
            await expect(notice).toBeVisible()
            // The narrow sidebar wraps the draft, so a Home key would land on a visual
            // line rather than the command; place the caret after "/compact" directly.
            const commandEnd = "/compact".length
            await input.evaluate(
                (element, offset) => (element as HTMLTextAreaElement).setSelectionRange(offset, offset),
                commandEnd,
            )
            await input.press("Backspace")
            await expect(input).toHaveValue(`/compac ${guidance}`)
            const menu = sidebar.getByTestId("slash-commands-menu")
            await expect(menu).toBeVisible()
            await menu.getByText("compact", { exact: true }).click()
            await expect(input).toHaveValue(`/cmd:compact ${guidance}`)
            await expect(notice).toHaveCount(0)
            await attachScreenshot(app, "paste-candidate-confirmed")

            await input.press("Enter")
            await expect(sidebar.getByText(summary, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            const confirmButton = sidebar.locator('vscode-button[aria-label="Condense Conversation"]')
            await expect(confirmButton).toBeVisible()
            await expect.poll(() => server.getRequestCount("anthropic-messages")).toBe(3)

            await confirmButton.click()
            await expect(sidebar.getByText("E2E_PASTE_DONE", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await expect.poll(() => server.getRequestCount("anthropic-messages")).toBe(4)

            const requests = server.getMockConsumptions("anthropic-messages")
            await attachJson("paste-semantics-provider-consumptions", requests)
            expect(requests.map((request) => request.toolCallId)).toEqual([
                "call_paste_ready",
                "call_paste_literal_ack",
                "call_paste_confirmed_summary",
                "call_paste_confirmed_completion",
            ])
            for (const request of requests) expect(request.contractError).toBeUndefined()
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Chat input - a pasted file mention is sent as text and never reads the file",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configureAnthropicManualCompact(dlineDir)
        const targetFile = "e2e-paste-secret.txt"
        const secretMarker = "E2E_PASTED_MENTION_SECRET_MUST_NOT_LEAK"
        const mention = `@/${targetFile}`
        // Trailing prose keeps the caret away from the mention, so no completion menu opens.
        const pasted = `A log line mentions ${mention} in passing.`
        await writeFile(path.join(workspaceDir, targetFile), `${secretMarker}\n`, "utf8")
        server.enqueueResponses(
            "anthropic-messages",
            {
                type: "tool",
                id: "call_mention_ready",
                name: "qna_respond",
                arguments: { response: "E2E_MENTION_READY" },
            },
            {
                type: "tool",
                id: "call_mention_literal_done",
                name: "attempt_completion",
                arguments: { result: "E2E_MENTION_LITERAL_DONE" },
                expectedRequestIncludes: [pasted],
                expectedRequestExcludes: [secretMarker],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await openSidebar(app, helper)
            const input = await startTask(sidebar, "E2E_MENTION_TASK")
            await expect(sidebar.getByText("E2E_MENTION_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })

            await pasteFromClipboard(app, input, pasted)
            await expect(input).toHaveValue(pasted)
            const notice = sidebar.getByTestId(PASTED_CANDIDATE_NOTICE)
            await expect(notice).toBeVisible()
            await expect(notice).toContainText(mention)
            await attachScreenshot(app, "paste-mention-held")

            await input.press("Enter")
            await expect(sidebar.getByText("E2E_MENTION_LITERAL_DONE", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })

            const requests = server.getMockConsumptions("anthropic-messages")
            await attachJson("paste-mention-provider-consumptions", requests)
            expect(requests.map((request) => request.toolCallId)).toEqual(["call_mention_ready", "call_mention_literal_done"])
            for (const request of requests) expect(request.contractError).toBeUndefined()
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Chat input - an oversized paste becomes a task-owned text resource",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configureAnthropicManualCompact(dlineDir)
        // AC-11: twenty lines is the first size that leaves the composer.
        const lines = Array.from({ length: 20 }, (_, index) => `E2E_OVERSIZED_LINE_${index + 1}`)
        server.enqueueResponses(
            "anthropic-messages",
            {
                type: "tool",
                id: "call_oversized_ready",
                name: "qna_respond",
                arguments: { response: "E2E_OVERSIZED_READY" },
            },
            {
                type: "tool",
                id: "call_oversized_done",
                name: "attempt_completion",
                arguments: { result: "E2E_OVERSIZED_DONE" },
                expectedRequestIncludes: [lines[0], lines[19]],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await openSidebar(app, helper)
            const input = await startTask(sidebar, "E2E_OVERSIZED_TASK")
            await expect(sidebar.getByText("E2E_OVERSIZED_READY", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })

            await pasteFromClipboard(app, input, lines.join("\n"))
            await expect(sidebar.getByText(/^input_.+\.txt$/).first()).toBeVisible({ timeout: 30_000 })
            await expect(input).toHaveValue("")
            await attachScreenshot(app, "oversized-paste-resource")

            await sidebar.getByTestId("send-button").click()
            await expect(sidebar.getByText("E2E_OVERSIZED_DONE", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })

            const requests = server.getMockConsumptions("anthropic-messages")
            await attachJson("oversized-paste-provider-consumptions", requests)
            expect(requests).toHaveLength(2)
            for (const request of requests) expect(request.contractError).toBeUndefined()
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Chat input - a single-line paste leaves the composer at exactly 5000 UTF-8 bytes",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configureAnthropicManualCompact(dlineDir)
        // AC-11: the byte budget is inclusive, so 4999 bytes stay inline and 5000 do not.
        const inlineMarker = "E2E_BYTES_INLINE_4999_"
        const resourceMarker = "E2E_BYTES_RESOURCE_5000_"
        const inlineText = singleLineOfUtf8Bytes(inlineMarker, 4999)
        const resourceText = singleLineOfUtf8Bytes(resourceMarker, 5000)
        server.enqueueResponses(
            "anthropic-messages",
            {
                type: "tool",
                id: "call_bytes_ready",
                name: "qna_respond",
                arguments: { response: "E2E_BYTES_READY" },
            },
            {
                type: "tool",
                id: "call_bytes_done",
                name: "attempt_completion",
                arguments: { result: "E2E_BYTES_DONE" },
                expectedRequestIncludes: [resourceMarker],
                expectedRequestExcludes: [inlineMarker],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await openSidebar(app, helper)
            const input = await startTask(sidebar, "E2E_BYTES_TASK")
            await expect(sidebar.getByText("E2E_BYTES_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            const resourceChip = sidebar.getByText(/^input_.+\.txt$/)

            await pasteFromClipboard(app, input, inlineText)
            await expect(input).toHaveValue(inlineText)
            await expect(resourceChip).toHaveCount(0)

            await input.fill("")
            await expect(input).toHaveValue("")
            await pasteFromClipboard(app, input, resourceText)
            await expect(resourceChip.first()).toBeVisible({ timeout: 30_000 })
            await expect(input).toHaveValue("")
            await attachScreenshot(app, "byte-boundary-paste-resource")

            await sidebar.getByTestId("send-button").click()
            await expect(sidebar.getByText("E2E_BYTES_DONE", { exact: false }).last()).toBeVisible({ timeout: 60_000 })

            const requests = server.getMockConsumptions("anthropic-messages")
            await attachJson("byte-boundary-provider-consumptions", requests)
            expect(requests).toHaveLength(2)
            for (const request of requests) expect(request.contractError).toBeUndefined()
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)
