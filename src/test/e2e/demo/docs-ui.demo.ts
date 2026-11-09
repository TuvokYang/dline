import { appendFile, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { expectComposerText } from "@e2e/utils/composer"
import { expect, type Frame, type Locator, type Page } from "@playwright/test"
import type { ClineApiServerMock } from "../fixtures/server"
import { getE2EMockProviderBaseUrl } from "../fixtures/server/api"
import { E2E_PROFILE_NAMES } from "../utils/api-profile"
import { E2ETestHelper } from "../utils/helpers"
import { resizePrimarySidebar } from "../utils/resize-primary-sidebar"
import { capabilityRow, toggleCapability } from "./scenarios/capabilities"
import {
    COMPACTION_COMPLETION_TEXT,
    COMPACTION_CONTINUE_TEXT,
    configureAutoCompaction,
    enqueueAutoCompaction,
    primeContextNearLimit,
    selectProfile,
} from "./scenarios/compaction"
import { fillMockOpenAiProfile, MOCK_PROFILE_NAME, waitForStoredProfileName } from "./scenarios/profile-setup"
import { enqueueSubagentReview, PARENT_RESULT, SUBAGENT_ITEMS, startSubagentReview } from "./scenarios/subagent-review"
import { DEMO_VIEWPORT, demo } from "./utils/demo-fixture"
import { captureDocScreenshot } from "./utils/doc-capture"
import { dismissDemoNotifications } from "./utils/png-asset"
import { SIDEBAR_RECORDING, STEP_SETTLE_MS, WINDOW_RECORDING } from "./utils/recording-presets"

/**
 * Documentation captures for the docs site (`assets/docs/ui`).
 *
 * Stills are cropped from live bounding boxes and numbered in reading order.
 * GIFs are recorded full-frame and reframed afterwards by `npm run demo:media`
 * with the camera keyframes emitted by `focusCamera`.
 */

const WORKFLOW_NAME = "release-review"
const MCP_NAME = "release-tools"
const HEADER_TASK_TEXT = "Summarize the release checklist for this workspace."
const HEADER_TASK_RESULT = "Release checklist summarized."
// Three columns, one story: a multi-turn conversation edits the file in the middle column and pulls a
// workspace workflow in by name, while a second task reviews the same file with a subagent that runs
// a real command on the right.
const MIDDLE_FILE = "README.md"
/**
 * Keeps the file column alive while a tool edit closes README.md's tab to open its diff. Without a
 * second tab the column empties, VS Code closes it, and the panels merge into one set of tabs.
 */
const LEFT_TURN_ONE_FILE = "index.html"
const LEFT_TURN_ONE = "Read the workspace README and describe it."
const LEFT_TURN_ONE_DONE = "README read: a controlled test workspace."
const LEFT_TURN_TWO = "Add a Release section with the two release steps."
const LEFT_TURN_TWO_DONE = "Release section added to README.md."
const README_RELEASE_LINE = "This workspace is used for testing the extension in a controlled environment."
const README_RELEASE_SECTION = [
    README_RELEASE_LINE,
    "",
    "## Release",
    "",
    "1. Run the test suite.",
    "2. Tag the verified commit.",
].join("\n")
const README_EDIT_DIFF = [
    "------- SEARCH",
    README_RELEASE_LINE,
    "=======",
    ...README_RELEASE_SECTION.split("\n"),
    "+++++++ REPLACE",
].join("\n")
/** Third turn: the workspace workflow, pulled in by name through the slash menu. */
const LEFT_TURN_FOUR_HINT = "release-review"
const LEFT_TURN_FOUR_DONE = "Release review recorded in the closing turn."
const RIGHT_TASK = "Review the release changes in this repository."
const RIGHT_CHILD_TASK = "Check the documented release steps."
const RIGHT_CHILD_RESULT = "Documented steps review complete."
/**
 * The review task runs this against the workspace before delegating. The command tool has to be
 * visible in the capture, and only the parent may run it: the built-in subagent is readonly.
 */
const RIGHT_REVIEW_COMMAND =
    "node -e \"console.log(require('fs').readFileSync('README.md','utf8').split('\\n').filter(l=>l.startsWith('#')).join(' | '))\""
const RIGHT_REVIEW_COMMAND_OUTPUT = "# Test Workspace | ## Release"
const RIGHT_DONE = "Review complete: no blocking risks."
/** Delay before the delegated child answers; long enough to read as work, short enough to shoot. */
const CHILD_REVIEW_DELAY_MS = 400
/**
 * Every scripted request must report a cache read, or the task header replaces the capture area with
 * "Prompt cache is not improving": the health monitor treats three consecutive requests with a 0%
 * cache hit as a stalled cache. A real prompt-cached provider answers most of a growing conversation
 * from cache, so the recorded usage carries that hit instead of an empty one.
 */
/** Share of a request's prompt a warmed provider serves from cache. Above the monitor's 30% floor. */
const CACHE_READ_SHARE = 0.7
/**
 * Per-character delay for the review prompt. The capture has to show the task being written; a
 * `fill` puts the whole sentence on screen between two frames and reads as a paste.
 */
const PROMPT_TYPING_DELAY_MS = 3
/** Split an input-token budget into the uncached remainder and the tokens served from cache. */
const CACHED_INPUT = (inputTokens: number): { inputTokens: number; cacheReadTokens: number } => {
    const cachedTokens = Math.round(inputTokens * CACHE_READ_SHARE)
    return { inputTokens: inputTokens - cachedTokens, cacheReadTokens: cachedTokens }
}
/** Size of the recorded video, which is what the camera's crop is expressed in. */
const DEMO_VIDEO_WIDTH = 1_920
const DEMO_VIDEO_HEIGHT = 1_080
/** GIF width. Wide enough to stay sharp, narrow enough that the camera can still push in. */
const DEMO_GIF_WIDTH = 1_200
/**
 * The camera's narrowest viewport, held at the GIF width.
 *
 * This is a resolution floor, not a framing hint. A crop narrower than the output is upscaled into
 * the GIF, so a 392 px chat column written to a 1200 px frame is stretched about three times and its
 * text turns to mush — which is exactly what a lower floor produced. At one source pixel per output
 * pixel the capture is only ever downscaled, and a narrow component simply shares the frame with the
 * neighbouring editor column instead of being magnified.
 */
const DEMO_CAMERA_MIN_WIDTH = DEMO_GIF_WIDTH
/**
 * How long one camera move takes.
 *
 * The shared preset settles in 0.4 s, which is a jump cut when the move spans the whole
 * workbench: the eye cannot follow the frame from the sidebar to the review column. Half a
 * second longer reads as a deliberate pan at normal viewing speed.
 */
const DEMO_CAMERA_TRANSITION_SECONDS = 0.9
/** Narrow enough that the three columns share the frame instead of the sidebar taking most of it. */
const THREE_COLUMN_SIDEBAR_WIDTH = 420
// View-title actions contributed by package.json `menus.view/title`, in their display order. Account is
// left out: it shows only while the account rollout includes the device, which a capture does not.
const PANEL_TITLE_ACTIONS = ["New Task", "MCP Servers", "History", "Settings"] as const

async function seedWorkspaceCapabilities(workspaceDir: string): Promise<void> {
    const files: Record<string, string> = {
        "rules/release-policy.md": "Keep release reviews focused on actionable risks and the next decision.",
        [`workflows/${WORKFLOW_NAME}.md`]: [
            "---",
            `name: ${WORKFLOW_NAME}`,
            "description: Run a focused release-readiness review.",
            "---",
            "Inspect release readiness, summarize findings, and identify the next action.",
        ].join("\n"),
        "skills/release-checklist/SKILL.md": [
            "---",
            "name: release-checklist",
            "description: Review a release checklist and summarize remaining risks.",
            "---",
            "Review the requested release checklist and report actionable risks.",
        ].join("\n"),
        "subagents/code-researcher.yml": [
            "---",
            "name: code-researcher",
            "description: Read-only codebase research",
            "tools:",
            "  - read_file",
            "  - search_files",
            "---",
            "Research the codebase and report findings with file references.",
        ].join("\n"),
        [`mcp/${MCP_NAME}.json`]: JSON.stringify(
            {
                name: MCP_NAME,
                description: "Demo release tooling for documentation captures.",
                type: "stdio",
                command: process.execPath,
                args: [path.join(E2ETestHelper.E2E_TESTS_DIR, "fixtures", "workspace-mcp-server.mjs")],
            },
            null,
            2,
        ),
    }
    for (const [relativePath, content] of Object.entries(files)) {
        const target = path.join(workspaceDir, ".agents", relativePath)
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, `${content}\n`, "utf8")
    }
}

function showCapabilitiesButton(sidebar: Frame): Locator {
    return sidebar.getByRole("button", { name: "Show Dline Rules & Workflows", exact: true }).first()
}

function showMcpButton(sidebar: Frame): Locator {
    return sidebar.getByRole("button", { name: "Show MCP Servers", exact: true }).first()
}

function autoApproveToggle(sidebar: Frame, open: boolean): Locator {
    return sidebar.locator(`[aria-label="${open ? "Close" : "Open"} auto-approve settings"]`)
}

async function selectCapabilityTab(popup: Locator, tab: string): Promise<void> {
    const tabButton = popup.getByRole("button", { name: tab, exact: true })
    await tabButton.click()
    await expect(tabButton).toHaveAttribute("aria-pressed", "true")
}

/** The task header card is the parent of its expand/collapse row. */
async function expandedTaskHeader(sidebar: Frame): Promise<Locator> {
    const toggle = sidebar.locator('[aria-label="Expand task header"], [aria-label="Collapse task header"]')
    await expect(toggle).toHaveCount(1)
    if ((await toggle.getAttribute("aria-label")) === "Expand task header") await toggle.click()
    await expect(toggle).toHaveAttribute("aria-label", "Collapse task header")
    return toggle.locator("xpath=..")
}

function taskHeaderIconButton(header: Locator, icon: string): Locator {
    return header.locator(`button:has(svg.lucide-${icon})`).first()
}

/**
 * The workbench area the camera may frame: the sidebar plus the editor group, with the activity
 * bar, title bar and status bar excluded so no frame can include editor chrome.
 *
 * The height comes from the recorded video, not `innerHeight`: the page may be shorter than the
 * captured frame, and a focus target below the live height would otherwise be clamped onto empty
 * space.
 */
async function workbenchContentRect(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
    const sidebar = await page.locator('[id="workbench.parts.sidebar"]').boundingBox()
    if (!sidebar) throw new Error("Cannot resolve the workbench content area")
    const left = Math.floor(sidebar.x)
    const top = Math.floor(sidebar.y)
    // Measured from the recorded viewport, not from an editor container: the container is narrow
    // before a panel opens, and the second task's panel then sits well outside that width, which
    // left the focused panel outside the crop and squashed every frame.
    return {
        x: left,
        y: top,
        width: DEMO_VIDEO_WIDTH - left,
        height: DEMO_VIDEO_HEIGHT - top,
    }
}

/**
 * Open the sidebar's task history and return the row whose preview starts with `preview`.
 *
 * The camera stays on the sidebar, so the row is the only thing that moves.
 */
async function openHistoryRow(page: Page, sidebar: Frame, preview: string): Promise<Locator> {
    // The History button lives in the VS Code sidebar title, outside the webview frame.
    await page.getByRole("button", { name: "History", exact: true }).click()
    await E2ETestHelper.dismissWhatsNewModal(sidebar)
    const row = sidebar.getByText(preview, { exact: false }).first()
    await expect(row).toBeVisible({ timeout: 30_000 })
    return row
}

/**
 * Scroll a task frame to the end of its conversation.
 *
 * The panel renders only the rows near the viewport, so a result that arrived while the camera was
 * elsewhere is not in the DOM until the conversation is scrolled down; the wheel is used because
 * the task surface owns the scroll container.
 */
async function scrollToEnd(frame: Frame, target: Locator, anchor: Locator): Promise<void> {
    if ((await target.count()) > 0) return
    const box = await anchor.boundingBox()
    if (!box) throw new Error("The scroll anchor does not have a bounding box")
    const page = frame.page()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    for (let attempt = 0; attempt < 15; attempt += 1) {
        await page.mouse.wheel(0, 800)
        await page.waitForTimeout(200)
        if ((await target.count()) > 0) return
    }
}

/**
 * Resolve the live review panel frame.
 *
 * A webview reload replaces the frame object, so the capture re-reads the current frame that holds the
 * task composer instead of trusting the reference taken when the panel first opened.
 */
async function findReviewFrame(page: Page, fallback: Frame, sidebar: Frame): Promise<Frame> {
    // Both columns host a composer, so "some frame has a chat input" cannot tell them apart: the
    // first match is the left conversation. The review column is every frame except that one, and
    // the panel taken when it opened is preferred because it is already known to be the right one.
    if (
        !fallback.isDetached() &&
        (await fallback
            .getByTestId("chat-input")
            .count()
            .catch(() => 0)) > 0
    ) {
        return fallback
    }
    for (const frame of page.frames()) {
        if (frame.isDetached() || frame === sidebar || frame === fallback) continue
        if (!frame.url().startsWith("vscode-webview://")) continue
        try {
            if ((await frame.getByTestId("chat-input").count()) > 0) return frame
        } catch {}
    }
    return fallback
}

/** Send one left-column turn and wait for its answer, used before recording starts. */
async function sendLeftTurn(frame: Frame, input: Locator, prompt: string, result: string): Promise<void> {
    await expect(input).toBeEnabled({ timeout: 60_000 })
    await input.fill(prompt)
    await input.press("Enter")
    await expectComposerText(input, "")
    await expect(frame.getByText(result, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
}

/**
 * Open the review task in its own editor group.
 *
 * `New Task` splits the editor area by itself once a file is open, so the panel already arrives in a
 * group to the right of the file. Splitting again used to add an empty third group and, when the
 * panel landed in the file's group instead, produced the collapsed two-tab layout this capture
 * rejects. The layout is therefore asserted, never manufactured.
 */
async function createReviewPanel(page: Page): Promise<Frame> {
    const panel = await openNewTaskPanel(page)
    await expect(panel.getByTestId("chat-input")).toBeVisible({ timeout: 60_000 })

    const groups = page.locator(".editor-group-container")
    await expect(groups).toHaveCount(2, { timeout: 15_000 })

    // The panel must own its group: a group whose only tab is `Dline` leaves the file column intact.
    const dlineGroup = await groups.evaluateAll((elements) =>
        elements.findIndex((element) => {
            const tabs = Array.from(element.querySelectorAll(".tabs-container > .tab"))
            return tabs.length === 1 && (tabs[0].textContent ?? "").trim() === "Dline"
        }),
    )
    expect(dlineGroup).toBe(1)
    return panel
}

/**
 * Make the file's group the active one.
 *
 * `vscode.diff` opens in the active group, so a tool-driven edit lands in the review panel's column
 * whenever that panel holds focus. Activating the file's group before the conversation edits keeps
 * each column holding only its own content.
 */
async function activateFileGroup(page: Page): Promise<void> {
    const groups = page.locator(".editor-group-container")
    const fileGroup = await groups.evaluateAll((elements) =>
        elements.findIndex((element) => element.querySelector('.tab[aria-label*="README.md"]') !== null),
    )
    expect(fileGroup).toBe(0)
    if (!(await groups.nth(fileGroup).evaluate((element) => element.classList.contains("active")))) {
        await groups.nth(fileGroup).click({ position: { x: 40, y: 20 } })
    }
    await expect(groups.nth(fileGroup)).toHaveClass(/active/, { timeout: 10_000 })
}

/**
 * Assert the file owns the left column and the review owns the right one, then return the file view.
 *
 * The layout is asserted rather than repaired into place: reopening the file here would move it into
 * whichever group is active, which is how the two columns collapsed into one set of tabs.
 */
async function assertFileColumn(page: Page): Promise<Locator> {
    await dumpEditorLayout(page, "assert-file-column")

    // The review column's tab is titled after its task once the task starts, so the panel is
    // identified by owning a column alone rather than by a `Dline` title it no longer shows.
    const groups = page.locator(".editor-group-container")
    await expect(groups).toHaveCount(2, { timeout: 15_000 })
    await expect(groups.first().locator('.tabs-container > .tab[aria-label*="README.md"]')).toHaveCount(1)
    await expect(groups.last().locator(".tabs-container > .tab")).toHaveCount(1)
    await expect(groups.last().locator('.tabs-container > .tab[aria-label*="README.md"]')).toHaveCount(0)

    const editor = page.locator(".editor-group-container .monaco-editor").first()
    await expect(editor).toBeVisible({ timeout: 15_000 })
    return editor
}

/**
 * Locate the review task's own command row, with the output it produced, and return it for framing.
 *
 * A green checkmark in a folded summary does not show that a command ran, so the capture needs the
 * opened command block: its header names `execute_command` and its body carries the workspace output.
 * Requiring both keeps the capture honest — a script that stopped running the command fails here
 * instead of recording an unrelated row.
 */
async function revealReviewCommand(panel: Frame): Promise<Locator> {
    const command = panel.getByText(RIGHT_REVIEW_COMMAND, { exact: false }).first()
    await expect(command).toBeVisible({ timeout: 180_000 })

    // Opening the block adds the command's own output below it, which is what proves the run.
    const output = panel.getByText(RIGHT_REVIEW_COMMAND_OUTPUT, { exact: false }).first()
    if ((await output.count()) === 0) await command.click()
    await expect(output).toBeVisible({ timeout: 60_000 })

    // The camera frames the command and its output together: the header alone does not prove a run.
    return command
}

/**
 * Turn two adds the release section, inside the recording.
 *
 * It enqueues its own responses first, so a caller must not clear the queue after calling it. The
 * approval prompt is dismissed as it appears: the edit needs an approval the capture should not sit
 * through, and every response is matched by request content rather than queue position.
 *
 * `priorCallIds` names the tool calls earlier turns already completed. They reach this turn's request
 * through the conversation, so the opening round has to declare them: the round that has not seen its
 * own edit yet still carries everything that came before it.
 */
/**
 * Run the edit turn.
 *
 * The diff the edit opens is left in place on purpose: it is the edit's own display, and the
 * caller frames it before closing it. Closing it here is what made the recorded clip jump from
 * the composer straight to the already-applied file, with no shot of the edit at all.
 */
async function runTurnTwo(
    sidebar: Frame,
    input: Locator,
    server: ClineApiServerMock,
    approve: Locator,
    priorCallIds: string[],
): Promise<void> {
    await expect(sidebar.getByTestId("send-button")).toHaveAttribute("data-action", "send", { timeout: 60_000 })
    server.enqueueOpenAiResponses(
        {
            type: "tool",
            id: "call_docs_left_turn_two_edit",
            name: "replace_in_file",
            arguments: { path: MIDDLE_FILE, diff: README_EDIT_DIFF },
            reasoning: "Appending the two release steps.",
            usage: { ...CACHED_INPUT(12_200), outputTokens: 220 },
            matchRequestContract: true,
            expectedRequestIncludes: [LEFT_TURN_TWO],
            // The closing round of the same turn carries the edit's tool result, so this one owns the
            // request that has not seen it yet.
            expectedToolResults: priorCallIds.map((callId) => ({ callId, contentIncludes: [] })),
        },
        {
            type: "tool",
            id: "call_docs_left_turn_two",
            name: "attempt_completion",
            arguments: { result: LEFT_TURN_TWO_DONE },
            usage: { ...CACHED_INPUT(12_800), outputTokens: 230 },
            matchRequestContract: true,
            expectedRequestIncludes: [LEFT_TURN_TWO],
            // The closing round is the one whose request already carries the edit's tool result, named
            // by its call id so it cannot also match the opening round.
            expectedToolResults: [{ callId: "call_docs_left_turn_two_edit", contentIncludes: [] }],
        },
    )
    await sendPrompt(sidebar, input, LEFT_TURN_TWO)
    for (let step = 0; step < 2; step += 1) {
        try {
            await approve.waitFor({ state: "visible", timeout: step === 0 ? 60_000 : 15_000 })
        } catch {
            break
        }
        await approve.click()
        await expect(approve).toBeHidden({ timeout: 30_000 })
    }
    await expect(sidebar.getByText(LEFT_TURN_TWO_DONE, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
}

/** Turn three edits the file a second time; run before recording so its latency stays off camera. */
async function runTurnThree(sidebar: Frame, input: Locator, server: ClineApiServerMock): Promise<void> {
    // The previous turn must be fully idle before the queue is replaced: a request still in flight
    // would consume this turn's first response and end the run on an exhausted queue.
    await expect(sidebar.getByTestId("send-button")).toHaveAttribute("data-action", "send", { timeout: 60_000 })
    server.enqueueOpenAiResponses(
        {
            type: "tool",
            id: "call_docs_left_turn_three_edit",
            name: "replace_in_file",
            arguments: { path: MIDDLE_FILE, diff: README_EDIT_THREE_DIFF },
            reasoning: "Adding the rollback step.",
            usage: { ...CACHED_INPUT(13_600), outputTokens: 240 },
            matchRequestContract: true,
            expectedRequestIncludes: [LEFT_TURN_THREE],
        },
        {
            type: "tool",
            id: "call_docs_left_turn_three",
            name: "attempt_completion",
            arguments: { result: LEFT_TURN_THREE_DONE },
            usage: { ...CACHED_INPUT(14_600), outputTokens: 260 },
        },
    )
    await sendPrompt(sidebar, input, LEFT_TURN_THREE)
    const approve = sidebar.getByText("Approve", { exact: true })
    for (let step = 0; step < 2; step += 1) {
        try {
            await approve.waitFor({ state: "visible", timeout: step === 0 ? 60_000 : 15_000 })
        } catch {
            break
        }
        await approve.click()
        await expect(approve).toBeHidden({ timeout: 30_000 })
    }
    // This turn exists to give the conversation depth, so it only requires the edit to complete:
    // the approval prompt disappearing is that observable boundary.
    await expect(approve).toBeHidden({ timeout: 60_000 })
    await closeDiffTabs(sidebar.page())
    // A file edit opens a diff tab, which would replace the middle column for the rest of the capture.
    await closeDiffTabs(sidebar.page())
}

/**
 * Close the read-only diff tabs a tool-driven edit opens.
 *
 * The demo's middle column must keep showing the edited file itself, so the change is visible as
 * content rather than as a side-by-side diff.
 */
async function closeDiffTabs(page: Page): Promise<void> {
    const diffTabs = page.locator('.tabs-container > .tab[aria-label*="↔"]')
    for (let index = (await diffTabs.count()) - 1; index >= 0; index -= 1) {
        const close = diffTabs.nth(index).locator(".codicon-close")
        if ((await close.count()) > 0) await close.click({ force: true })
    }
}

/** Turn four invokes the workspace workflow through the slash menu. */
async function runTurnFour(sidebar: Frame, input: Locator, server: ClineApiServerMock, approve: Locator): Promise<void> {
    await expect(sidebar.getByTestId("send-button")).toHaveAttribute("data-action", "send", { timeout: 60_000 })
    server.enqueueOpenAiResponses({
        type: "tool",
        id: "call_docs_left_turn_four",
        name: "attempt_completion",
        arguments: { result: LEFT_TURN_FOUR_DONE },
        usage: { ...CACHED_INPUT(15_200), outputTokens: 270 },
    })
    await input.click()
    await input.pressSequentially(`/${LEFT_TURN_FOUR_HINT.slice(0, 4)}`, { delay: 60 })
    const menu = sidebar.getByLabel("Slash commands")
    await expect(menu).toBeVisible()
    await menu.getByText(WORKFLOW_NAME, { exact: false }).first().click()
    await expect(menu).toBeHidden()
    await expectComposerText(input, new RegExp(`^/workflow:${WORKFLOW_NAME}\\s*$`))
    await input.press("Enter")
    await expectComposerText(input, "")
    await expect(sidebar.getByText(LEFT_TURN_FOUR_DONE, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
    await expect(approve).toBeHidden()
}

/** Temporary: record the editor-group layout so a collapsed column can be traced to its step. */
async function dumpEditorLayout(page: Page, label: string): Promise<void> {
    const layout = await page.evaluate(() => {
        const groups = Array.from(document.querySelectorAll(".editor-group-container"))
        return groups.map((group, index) => {
            const rect = group.getBoundingClientRect()
            const tabs = Array.from(group.querySelectorAll(".tabs-container > .tab")).map((tab) => (tab.textContent ?? "").trim())
            return {
                index,
                active: group.classList.contains("active"),
                x: Math.round(rect.x),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                tabs,
            }
        })
    })
    const composer = await page.evaluate(() => {
        const dialog = document.querySelector('[id="workbench.parts.sidebar"]')
        return dialog ? { sidebarHeight: Math.round(dialog.getBoundingClientRect().height) } : null
    })
    await appendFile(
        path.join(E2ETestHelper.CODEBASE_ROOT_DIR, "tmp", "editor-layout.log"),
        `${label} ${JSON.stringify({ layout, composer })}\n`,
        "utf8",
    )
}

/** Send a prompt from a task panel without waiting for its answer. */
async function sendPrompt(frame: Frame, input: Locator, prompt: string): Promise<void> {
    await expect(input).toBeEnabled({ timeout: 60_000 })
    await input.fill(prompt)
    await input.press("Enter")
    await expectComposerText(input, "")
}

/**
 * Open `relativePath` in the active editor group and return its visible view.
 *
 * Quick Open resolves the workspace-relative path without touching the file tree, and the file
 * then occupies the middle column while both task panels keep their own columns.
 */
async function openMiddleFile(page: Page, relativePath: string): Promise<Locator> {
    await openInActiveGroup(page, relativePath)
    const editor = page.locator(".editor-group-container .monaco-editor").first()
    await expect(editor).toBeVisible({ timeout: 15_000 })
    return editor
}

/**
 * Open `relativePath` in the active editor group.
 *
 * Quick Open targets whichever group is active, so callers activate the intended column first.
 */
async function openInActiveGroup(page: Page, relativePath: string): Promise<void> {
    await page.keyboard.press("ControlOrMeta+p")
    const quickInput = page.locator(".quick-input-widget")
    await expect(quickInput).toBeVisible({ timeout: 15_000 })
    await page.keyboard.type(relativePath, { delay: 60 })
    const option = page.locator(".quick-input-list .monaco-list-row").filter({ hasText: relativePath }).first()
    await expect(option).toBeVisible({ timeout: 15_000 })
    await page.keyboard.press("Enter")
    await expect(quickInput).toBeHidden({ timeout: 15_000 })

    const tab = page.locator(`.tabs-container > .tab[aria-label*="${relativePath}"]`).first()
    await expect(tab).toBeVisible({ timeout: 15_000 })
}

/**
 * Open a second task in its own editor tab and return its webview frame.
 *
 * `New Task` reuses an existing panel when one is already open, so the frame that
 * appears is the one missing from the set captured before the click.
 */
async function openNewTaskPanel(page: Page): Promise<Frame> {
    const existingFrames = new Set(page.frames())
    await page.getByRole("button", { name: "New Task", exact: true }).click()
    let panel: Frame | undefined
    await expect
        .poll(
            async () => {
                for (const frame of page.frames()) {
                    if (existingFrames.has(frame) || frame.isDetached() || !frame.url().startsWith("vscode-webview://")) {
                        continue
                    }
                    try {
                        if ((await frame.locator("#root").count()) === 0) continue
                    } catch {
                        continue
                    }
                    panel = frame
                    return true
                }
                return false
            },
            { timeout: 60_000 },
        )
        .toBe(true)
    if (!panel) throw new Error("Dline editor panel frame was not created")
    await E2ETestHelper.dismissWhatsNewModal(panel)
    return panel
}

demo("docs UI stills", async ({ demoTheme, helper, page, server, sidebar, workspaceDir }) => {
    demo.setTimeout(240_000)
    await seedWorkspaceCapabilities(workspaceDir)
    await helper.signin(sidebar)

    const panelTitle = page.locator('[id="workbench.parts.sidebar"] .composite.title').first()
    await captureDocScreenshot(page, sidebar, "panel-title-bar", {
        theme: demoTheme,
        regions: [panelTitle],
        padding: 4,
        markers: PANEL_TITLE_ACTIONS.map((name, index) => ({
            label: String(index + 1),
            target: panelTitle.getByRole("button", { name, exact: true }),
        })),
    })

    const modeSwitch = sidebar.getByTestId("mode-switch")
    await captureDocScreenshot(page, sidebar, "chat-input-toolbar", {
        theme: demoTheme,
        regions: [autoApproveToggle(sidebar, false), sidebar.getByTestId("chat-input"), modeSwitch],
        markers: [
            { label: "1", target: sidebar.getByTestId("context-button") },
            { label: "2", target: sidebar.getByTestId("files-button") },
            { label: "3", target: showMcpButton(sidebar) },
            { label: "4", target: showCapabilitiesButton(sidebar) },
            { label: "5", target: sidebar.getByRole("button", { name: "Select model", exact: true }) },
            { label: "6", target: modeSwitch },
            { label: "7", target: sidebar.getByTestId("send-button") },
        ],
    })

    await showCapabilitiesButton(sidebar).click()
    const popup = sidebar.getByTestId("capabilities-popup")
    await expect(popup).toBeVisible()
    const capabilityTabs = [
        { tab: "Rules", id: "capabilities-rules", item: popup.getByText("release-policy.md", { exact: true }) },
        { tab: "Workflows", id: "capabilities-workflows", item: popup.getByText(`${WORKFLOW_NAME}.md`, { exact: true }) },
        { tab: "Skills", id: "capabilities-skills", item: popup.getByText("release-checklist", { exact: true }) },
        { tab: "Subagents", id: "capabilities-subagents", item: popup.getByText("code-researcher", { exact: false }).first() },
        { tab: "Environments", id: "capabilities-environments", item: sidebar.getByTestId("shell-environment-panel") },
    ]
    for (const { tab, id, item } of capabilityTabs) {
        await selectCapabilityTab(popup, tab)
        await expect(item).toBeVisible({ timeout: 30_000 })
        await captureDocScreenshot(page, sidebar, id, { theme: demoTheme, regions: [popup], padding: 4 })
    }
    await sidebar.getByRole("button", { name: "Hide Dline Rules & Workflows", exact: true }).first().click()
    await expect(popup).toBeHidden()

    await autoApproveToggle(sidebar, false).click()
    const autoApproveIntro = sidebar.getByText("Let Dline take these actions without asking for approval.", { exact: false })
    await expect(autoApproveIntro).toBeVisible()
    await captureDocScreenshot(page, sidebar, "auto-approve-menu", {
        theme: demoTheme,
        regions: [
            autoApproveIntro,
            sidebar.getByText("Notifications may show abbreviated tool details", { exact: false }),
            autoApproveToggle(sidebar, true),
        ],
        padding: 16,
    })
    await autoApproveToggle(sidebar, true).click()

    await showMcpButton(sidebar).click()
    const serverName = sidebar.getByText(MCP_NAME, { exact: true })
    await expect(serverName).toBeVisible({ timeout: 30_000 })
    await captureDocScreenshot(page, sidebar, "mcp-servers-popup", {
        theme: demoTheme,
        regions: [
            sidebar.getByText("MCP Servers", { exact: true }),
            sidebar.getByRole("button", { name: "Go to MCP server settings" }),
            serverName,
        ],
        padding: 16,
    })
    await sidebar.getByRole("button", { name: "Hide MCP Servers", exact: true }).first().click()
    await expect(serverName).toBeHidden()

    // The task header only exists while a task is open; run one short task with usage so
    // the metrics capsule and context bar have real values to show.
    server.resetOpenAiMock()
    server.enqueueOpenAiResponses({
        type: "tool",
        id: "call_docs_header_complete",
        name: "attempt_completion",
        arguments: { result: HEADER_TASK_RESULT },
        usage: { inputTokens: 18_400, outputTokens: 320, cacheReadTokens: 12_800 },
        expectedRequestIncludes: [HEADER_TASK_TEXT],
    })
    const input = sidebar.getByTestId("chat-input")
    await input.fill(HEADER_TASK_TEXT)
    await sidebar.getByTestId("send-button").click()
    await expect(sidebar.getByText(HEADER_TASK_RESULT, { exact: false }).last()).toBeVisible({ timeout: 60_000 })

    const header = await expandedTaskHeader(sidebar)
    const metrics = sidebar.getByTestId("task-rate-metrics")
    await expect(metrics).toBeVisible({ timeout: 30_000 })
    await expect(sidebar.getByTestId("context-window-indicator")).toBeVisible({ timeout: 30_000 })
    await captureDocScreenshot(page, sidebar, "task-header", {
        theme: demoTheme,
        regions: [header],
        padding: 8,
        markers: [
            { label: "1", target: metrics },
            { label: "2", target: sidebar.getByTestId("context-window-progress-track") },
            { label: "3", target: header.locator('[aria-label="Compact task"]') },
            { label: "4", target: taskHeaderIconButton(header, "copy") },
            { label: "5", target: taskHeaderIconButton(header, "refresh-cw") },
            { label: "6", target: taskHeaderIconButton(header, "trash") },
            { label: "7", target: header.locator('[aria-label="Close Task"]') },
        ],
    })
})

demo("docs mode switch", async ({ finishRecording, focusCamera, helper, pace, registerRecording, sidebar }) => {
    await helper.signin(sidebar)
    const modeSwitch = sidebar.getByTestId("mode-switch")
    await expect(sidebar.getByRole("switch", { name: "Act" })).toHaveAttribute("aria-checked", "true")

    await registerRecording("docs-mode-switch", SIDEBAR_RECORDING)
    await focusCamera(modeSwitch)
    await modeSwitch.getByText("Plan", { exact: true }).hover()
    await pace(1_400)
    await modeSwitch.click()
    await expect(sidebar.getByRole("switch", { name: "Plan" })).toHaveAttribute("aria-checked", "true")
    await pace(1_400)
    await modeSwitch.click()
    await expect(sidebar.getByRole("switch", { name: "Act" })).toHaveAttribute("aria-checked", "true")
    await pace(1_200)
    await finishRecording()
})

demo("docs slash workflow", async ({ finishRecording, focusCamera, helper, pace, registerRecording, sidebar, workspaceDir }) => {
    await seedWorkspaceCapabilities(workspaceDir)
    await helper.signin(sidebar)
    const input = sidebar.getByTestId("chat-input")

    await registerRecording("docs-slash-workflow", SIDEBAR_RECORDING)
    await focusCamera(input)
    await input.click()
    await input.pressSequentially("/rel", { delay: 140 })
    const menu = sidebar.getByLabel("Slash commands")
    await expect(menu).toBeVisible()
    await focusCamera([menu, input])
    await pace(1_200)
    await menu.getByText(WORKFLOW_NAME, { exact: false }).first().click()
    // Return to the input as soon as the menu closes so the spotlight never outlines empty space.
    await expect(menu).toBeHidden()
    await focusCamera(input, 0)
    await expectComposerText(input, new RegExp(`^/workflow:${WORKFLOW_NAME}\\s*$`))
    await pace(1_600)
    await finishRecording()
})

demo("docs context mention", async ({ finishRecording, focusCamera, helper, pace, registerRecording, sidebar }) => {
    await helper.signin(sidebar)
    const input = sidebar.getByTestId("chat-input")

    await registerRecording("docs-context-mention", SIDEBAR_RECORDING)
    await focusCamera(input)
    await input.click()
    await input.pressSequentially("Review @", { delay: 120 })
    const menu = sidebar.getByLabel("Context mentions")
    await expect(menu).toBeVisible()
    await focusCamera([menu, input])
    await pace(1_000)
    for (let step = 0; step < 2; step += 1) {
        await input.press("ArrowDown")
        await pace(700)
    }
    await pace(800)
    await input.press("Escape")
    await expect(menu).toBeHidden()
    await focusCamera(input, 0)
    await pace(1_200)
    await finishRecording()
})

demo("docs environment variable", async ({ finishRecording, focusCamera, helper, page, pace, registerRecording, sidebar }) => {
    await helper.signin(sidebar)

    await registerRecording("docs-environment-variable", SIDEBAR_RECORDING)
    const showCapabilities = showCapabilitiesButton(sidebar)
    await focusCamera(showCapabilities)
    await showCapabilities.click()
    const popup = sidebar.getByTestId("capabilities-popup")
    await expect(popup).toBeVisible()
    const environmentsTab = popup.getByRole("button", { name: "Environments", exact: true })
    await focusCamera(environmentsTab)
    await selectCapabilityTab(popup, "Environments")

    const panel = sidebar.getByTestId("shell-environment-panel")
    const addVariable = panel.getByRole("button", { name: "Add variable" })
    await expect(addVariable).toBeVisible({ timeout: 30_000 })
    await focusCamera(addVariable)
    await addVariable.click()
    // The editor autosaves 350 ms after the last change. Action annotations pause ~500 ms
    // before each action, which would save the blank new row and flash a validation error,
    // so start typing without an annotation pause and restore the pointer afterwards.
    const variableName = panel.getByLabel("Environment name 1")
    const variableValue = panel.getByLabel("Environment value 1")
    await page.screencast.hideActions()
    await variableName.pressSequentially("API_BASE_URL", { delay: 60 })
    await page.screencast.showActions({ cursor: "pointer", duration: 500, fontSize: 1 })
    // The first save inserts the status line above the tabs and shifts the rows down;
    // wait for it so the camera keyframe matches where the inputs finally rest.
    const saved = panel.getByText("Saved", { exact: true })
    await expect(saved).toBeVisible({ timeout: 20_000 })
    await focusCamera([variableName, variableValue], 0)
    await variableValue.pressSequentially("http://localhost:8080", { delay: 40 })
    await expect(saved).toBeVisible({ timeout: 20_000 })
    await expect(panel.getByText(/must be non-empty/)).toHaveCount(0)
    await pace(1_600)
    await finishRecording()
})

demo("docs auto approve", async ({ finishRecording, focusCamera, helper, pace, registerRecording, sidebar }) => {
    await helper.signin(sidebar)
    const editItem = sidebar.locator("vscode-checkbox").filter({ hasText: "Edit project files" })

    // Start from a disabled action so the recording shows the option turning on.
    await autoApproveToggle(sidebar, false).click()
    await expect(editItem).toBeVisible()
    if (await editItem.evaluate((element) => (element as HTMLInputElement).checked === true)) await editItem.click()
    await autoApproveToggle(sidebar, true).click()
    await expect(editItem).toBeHidden()

    await registerRecording("docs-auto-approve", SIDEBAR_RECORDING)
    const openToggle = autoApproveToggle(sidebar, false)
    await focusCamera(openToggle)
    await openToggle.click()
    await expect(editItem).toBeVisible()
    await focusCamera(editItem)
    await editItem.click()
    const editAllItem = sidebar.locator("vscode-checkbox").filter({ hasText: "Edit all files" })
    await expect(editAllItem).toBeVisible()
    await pace(900)
    await focusCamera(editAllItem)
    await pace(900)
    const closeToggle = autoApproveToggle(sidebar, true)
    await focusCamera(closeToggle)
    await closeToggle.click()
    await pace(1_200)
    await finishRecording()
})

demo(
    "docs capability toggles",
    async ({ finishRecording, focusCamera, helper, pace, registerRecording, sidebar, workspaceDir }) => {
        await seedWorkspaceCapabilities(workspaceDir)
        await helper.signin(sidebar)

        await registerRecording("docs-capability-toggles", SIDEBAR_RECORDING)
        const showCapabilities = showCapabilitiesButton(sidebar)
        await focusCamera(showCapabilities)
        await showCapabilities.click()
        const popup = sidebar.getByTestId("capabilities-popup")
        await expect(popup).toBeVisible()

        const steps = [
            { tab: "Rules", name: "release-policy.md" },
            { tab: "Skills", name: "release-checklist" },
            { tab: "Workflows", name: `${WORKFLOW_NAME}.md` },
        ]
        for (const { tab, name } of steps) {
            await focusCamera(popup.getByRole("button", { name: tab, exact: true }), STEP_SETTLE_MS)
            await selectCapabilityTab(popup, tab)
            const row = capabilityRow(sidebar, name)
            await expect(row).toBeVisible({ timeout: 30_000 })
            await focusCamera(row, STEP_SETTLE_MS)
            await toggleCapability(sidebar, name, false)
            await pace(700)
        }
        await finishRecording()
    },
)

demo(
    "docs profile setup",
    async ({ dlineDir, finishRecording, focusCamera, helper, page, pace, registerRecording, server, sidebar }) => {
        await helper.signin(sidebar)
        const focusStep = (target: Locator | Locator[]) => focusCamera(target, STEP_SETTLE_MS)

        await registerRecording("docs-profile-setup", SIDEBAR_RECORDING)
        const settingsButton = page.getByRole("button", { name: "Settings", exact: true })
        await focusStep(settingsButton)
        await settingsButton.click()
        const addProfile = sidebar.getByRole("button", { name: "Add profile", exact: true })
        await expect(addProfile).toBeVisible()
        await focusStep(addProfile)
        await addProfile.click()
        const profileCard = sidebar.getByTestId("api-profile-card").last()
        await expect(profileCard).toBeVisible()

        await fillMockOpenAiProfile(profileCard, getE2EMockProviderBaseUrl(server.baseUrl, "openai-compatible-chat"), focusStep)
        await waitForStoredProfileName(dlineDir, MOCK_PROFILE_NAME)

        const done = sidebar.getByRole("button", { name: "Done", exact: true })
        await focusStep(done)
        await done.click()
        const modelSwitcher = sidebar.getByRole("button", { name: "Select model", exact: true })
        await expect(modelSwitcher).toBeVisible()
        await focusStep(modelSwitcher)
        await modelSwitcher.click()
        const profileOption = sidebar.getByRole("option").filter({ has: sidebar.getByText(MOCK_PROFILE_NAME, { exact: true }) })
        await expect(profileOption).toHaveCount(1)
        await focusStep([profileOption, modelSwitcher])
        await profileOption.click()
        await expect(modelSwitcher).toHaveText(MOCK_PROFILE_NAME)
        await focusCamera(modelSwitcher, 0)
        await pace(1_200)
        await finishRecording()
    },
)

demo("docs subagents", async ({ finishRecording, focusCamera, helper, pace, page, registerRecording, server, sidebar }) => {
    demo.setTimeout(180_000)
    await helper.signin(sidebar)
    enqueueSubagentReview(server)
    // Clear startup toasts before the run: the command palette used to dismiss them
    // later loses focus to the live subagent updates and cannot be driven reliably.
    await dismissDemoNotifications(page)
    await startSubagentReview(sidebar, server)
    // Children finish 13-16 s after their last request; start a little later so the GIF stays under 20 s
    // while every child is still running when the Activities list first comes into view.
    await pace(2_000)

    await registerRecording("docs-subagents", SIDEBAR_RECORDING)
    const activitiesTab = sidebar.getByRole("tab", { name: /^Activities(?: \d+)?$/ })
    await focusCamera(activitiesTab, STEP_SETTLE_MS)
    await activitiesTab.click()
    await sidebar.getByTestId("activity-status-filter-all").click()
    await sidebar.getByTestId("activity-kind-filter-subagent").click()

    const cards = sidebar.getByTestId("activity-item")
    await expect(cards).toHaveCount(SUBAGENT_ITEMS.length)
    await focusCamera(sidebar.getByTestId("activity-list"), STEP_SETTLE_MS)
    // Collapsed cards show only the agent name; expand them so each child's task identifies its card.
    for (let index = 0; index < SUBAGENT_ITEMS.length; index += 1) {
        await cards.nth(index).getByTestId("activity-toggle").click()
    }
    const activities = SUBAGENT_ITEMS.map((item) => cards.filter({ hasText: item.task }))
    await Promise.all(activities.map((activity) => expect(activity).toHaveCount(1)))
    await pace(800)

    // Follow each child as it finishes so the status change is the focus of the frame.
    for (const activity of activities) {
        await focusCamera(activity, 0)
        await expect(activity).toHaveAttribute("data-activity-status", "completed", { timeout: 30_000 })
        await pace(600)
    }

    const workTab = sidebar.getByRole("tab", { name: "Work", exact: true })
    await focusCamera(workTab, STEP_SETTLE_MS)
    await workTab.click()
    const parentResult = sidebar.getByText(PARENT_RESULT, { exact: false }).last()
    await expect(parentResult).toBeVisible({ timeout: 30_000 })
    await focusCamera(parentResult, 0)
    await pace(1_400)
    await finishRecording()
})

demo(
    "docs auto compact",
    async ({ dlineDir, finishRecording, focusCamera, helper, pace, registerRecording, server, sidebar }) => {
        demo.setTimeout(180_000)
        await configureAutoCompaction(dlineDir)
        await helper.signin(sidebar)
        await selectProfile(sidebar, E2E_PROFILE_NAMES.mockOpenAiResponses)
        enqueueAutoCompaction(server)
        await primeContextNearLimit(sidebar)
        const contextIndicator = sidebar.getByTestId("context-window-indicator")
        const contextProgress = sidebar.getByTestId("context-window-segmented-progress")

        await registerRecording("docs-auto-compact", SIDEBAR_RECORDING)
        await focusCamera(contextIndicator)
        await pace(600)
        const input = sidebar.getByTestId("chat-input")
        await focusCamera(input, STEP_SETTLE_MS)
        await input.fill(COMPACTION_CONTINUE_TEXT)
        await input.press("Enter")
        await expectComposerText(input, "")

        const compactionPass = sidebar.getByTestId("compaction-pass").last()
        await expect(compactionPass).toBeVisible({ timeout: 60_000 })
        await focusCamera(compactionPass, 0)
        await expect(compactionPass).toHaveAttribute("data-compaction-status", "completed", { timeout: 60_000 })
        await pace(800)

        const completion = sidebar.getByText(COMPACTION_COMPLETION_TEXT, { exact: false }).last()
        await expect(completion).toBeVisible({ timeout: 60_000 })
        await focusCamera(completion, STEP_SETTLE_MS)
        await expect
            .poll(async () => Number((await contextProgress.getAttribute("aria-valuenow")) ?? Number.POSITIVE_INFINITY), {
                timeout: 30_000,
            })
            .toBeLessThan(40_000)
        await focusCamera(contextIndicator, 0)
        await pace(1_400)
        await finishRecording()
    },
)

demo(
    "docs parallel tasks",
    async ({ finishRecording, focusCamera, helper, page, pace, registerRecording, server, sidebar, workspaceDir }) => {
        // The left column runs a workspace workflow through the slash menu, so the capabilities are
        // seeded first. Four recorded turns keep the conversation moving instead of idling.
        demo.setTimeout(420_000)
        await seedWorkspaceCapabilities(workspaceDir)
        await helper.signin(sidebar)
        const input = sidebar.getByTestId("chat-input")

        // The default sidebar takes 720 px and squeezes the file column out of the three-column
        // shot. Narrowing it keeps all three columns legible at one camera width.
        await resizePrimarySidebar(page, THREE_COLUMN_SIDEBAR_WIDTH, DEMO_VIEWPORT)

        // The evidence column: a real file in the editor group, which the camera frames on its own.
        const editor = await openMiddleFile(page, MIDDLE_FILE)
        // A tool-driven edit closes README.md's tab before opening its diff. On its own that leaves
        // the column empty and VS Code closes it, which merged the file and the review panel into one
        // set of tabs. A second tab keeps the column alive while the file is being edited.
        await openInActiveGroup(page, LEFT_TURN_ONE_FILE)
        await openInActiveGroup(page, MIDDLE_FILE)
        await dumpEditorLayout(page, "after-open-file")

        // The review column opens as a second task and is moved into its own group so nothing shares a column.
        const panel = await createReviewPanel(page)
        await dumpEditorLayout(page, "after-review-panel")
        const panelInput = panel.getByTestId("chat-input")
        // Both columns run on the chat profile, so they share one mock queue and every scripted
        // response is selected by its request contract. A second protocol cannot be used here: the
        // model switcher writes the profile that a *new* task inherits, and `selectProfile` returns
        // without writing when the switcher already shows that name. With two protocols the column
        // chosen last would therefore decide the other column's queue, and a request that finds no
        // matching response still takes the queue head, fails its contract, and pays a full retry
        // backoff.
        for (const frame of [sidebar, panel]) {
            await selectProfile(frame, E2E_PROFILE_NAMES.mockOpenAi)
            await expect(frame.getByRole("button", { name: "Select model", exact: true })).toHaveText(
                E2E_PROFILE_NAMES.mockOpenAi,
            )
        }

        const bottomPanel = page.locator('[id="workbench.parts.panel"]')
        if (await bottomPanel.isVisible()) await page.keyboard.press("ControlOrMeta+j")
        await expect(bottomPanel).toBeHidden()

        for (const frame of [sidebar, panel]) {
            await expect(frame.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 })
        }
        await expect(sidebar.getByRole("button", { name: "Select model", exact: true })).toBeVisible({ timeout: 30_000 })

        const approve = sidebar.getByText("Approve", { exact: true })

        // The sidebar conversation runs entirely on camera. Starting a new task here would make the
        // clip open on an empty conversation and leave the work that follows as a single row, which
        // is not the multi-turn task the capture is meant to demonstrate.
        // The file's column owns focus first: a diff opens in the active group.
        await activateFileGroup(page)
        const middleColumn = await assertFileColumn(page)

        const reviewPanel = await findReviewFrame(page, panel, sidebar)
        const reviewInput = reviewPanel.getByTestId("chat-input")
        await expect(reviewInput).toBeVisible({ timeout: 30_000 })
        // The review column is still empty here: its prompt is sent inside the recording so the
        // pull-back lands on running work. Only the composer can be framed before that.
        await pace(400)

        // 1600 px wide: the three-column shot downscales instead of upscaling, and a single column
        // still renders at its own resolution.
        // Full-frame recording: a crop is expressed in the recorded viewport, while the camera track
        // is authored in the extracted frame, so combining both offsets the camera.
        // 8 fps keeps a ~20 s clip near 160 frames; the camera settles over 0.4 s, so this still reads
        // as continuous motion while staying inside the GIF frame budget.
        await registerRecording("dline-demo", {
            ...WINDOW_RECORDING,
            fps: 8,
            outputWidth: DEMO_GIF_WIDTH,
            camera: {
                ...WINDOW_RECORDING.camera,
                minWidth: DEMO_CAMERA_MIN_WIDTH,
                transitionSeconds: DEMO_CAMERA_TRANSITION_SECONDS,
            },
        })

        // 1. The first turn, typed inside the recording. The queue is reset here because the setup
        //    above left its own responses behind.
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses({
            type: "tool",
            id: "call_docs_left_turn_one",
            name: "attempt_completion",
            arguments: { result: LEFT_TURN_ONE_DONE },
            usage: { ...CACHED_INPUT(9_600), outputTokens: 180 },
            expectedRequestIncludes: [LEFT_TURN_ONE],
            matchRequestContract: true,
        })
        await focusCamera(input, STEP_SETTLE_MS)
        await input.click()
        await input.pressSequentially(LEFT_TURN_ONE, { delay: PROMPT_TYPING_DELAY_MS })
        await expectComposerText(input, LEFT_TURN_ONE)
        await pace(150)
        await input.press("Enter")

        // 1b. The chat area, so the clip shows the sentence leaving the composer and landing as a
        //     user row instead of jumping from the input straight to the answer. The composer and the
        //     new rows are framed together rather than the row alone: a single row is ~16 px tall, so
        //     framing it made the camera zoom until that line filled the output and pushed the rest of
        //     the column out of shot.
        const sentTurn = sidebar.getByText(LEFT_TURN_ONE, { exact: false }).last()
        await expect(sentTurn).toBeVisible({ timeout: 30_000 })
        const firstAnswer = sidebar.getByText(LEFT_TURN_ONE_DONE, { exact: false }).last()
        await expect(firstAnswer).toBeVisible({ timeout: 60_000 })
        await focusCamera([input, sentTurn, firstAnswer], STEP_SETTLE_MS)
        await pace(400)

        // 2. The second turn edits the file, recorded: the tool runs, the diff opens and closes, and
        //    the file column keeps its own tab so the three columns survive the edit. `runTurnTwo`
        //    enqueues its own responses after clearing the queue, so resetting here would drop them.
        await activateFileGroup(page)
        await runTurnTwo(sidebar, input, server, approve, ["call_docs_left_turn_one"])
        // 2a. The file the edit changed. This edit applies in place and leaves no diff tab, so the
        //     file column is the edit's own display. Framing the changed line alone made the camera
        //     clamp up to its floor and show a 17 px strip of text; the column keeps the change
        //     readable beside the conversation that asked for it.
        const editedLine = middleColumn.getByText("## Release", { exact: false }).first()
        await expect(editedLine).toBeVisible({ timeout: 60_000 })
        await focusCamera(middleColumn, STEP_SETTLE_MS)
        await pace(900)

        // 3. The third turn pulls the workspace workflow in by name through the slash menu.
        await runTurnFour(sidebar, input, server, approve)
        const slashTurn = sidebar.getByText(`/workflow:${WORKFLOW_NAME}`, { exact: false }).last()
        const leftLastDone = sidebar.getByText(LEFT_TURN_FOUR_DONE, { exact: false }).last()
        await expect(leftLastDone).toBeVisible({ timeout: 60_000 })
        await focusCamera([slashTurn, leftLastDone], STEP_SETTLE_MS)
        await pace(200)

        // 3. The right column
        //    rather than pre-filled, and nothing runs between clicking the composer and finishing the
        //    sentence: a camera move also clears toasts, and that can raise the command palette and
        //    take the keystrokes away from the composer. The typed text is then held long enough for
        //    several frames to show it before it is submitted.
        await focusCamera(panelInput, STEP_SETTLE_MS)
        await panelInput.click()
        await panelInput.pressSequentially(RIGHT_TASK, { delay: PROMPT_TYPING_DELAY_MS })
        await expectComposerText(panelInput, RIGHT_TASK)
        await pace(120)

        // The review starts before the camera pulls back, so the pull-back lands on running work.
        // The review task itself runs the workspace command: only the parent may call it, because the
        // default subagent is readonly and could not. Responses are selected by request contract
        // rather than by queue position, so the parent's command round and the child's completion
        // cannot consume each other's script.
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                id: "call_docs_review_command",
                name: "execute_command",
                arguments: { command: RIGHT_REVIEW_COMMAND, requires_approval: false },
                reasoning: "Listing the documented sections.",
                usage: { ...CACHED_INPUT(700), outputTokens: 70 },
                matchRequestContract: true,
                expectedRequestIncludes: [RIGHT_TASK],
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_docs_review_subagent",
                name: "use_subagents",
                arguments: {
                    subagents: [{ task: RIGHT_CHILD_TASK, context: "Inspect the workspace README." }],
                    timeout: 120,
                },
                usage: { ...CACHED_INPUT(1_100), outputTokens: 110 },
                matchRequestContract: true,
                expectedRequestIncludes: [RIGHT_TASK],
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_docs_review_child_done",
                name: "attempt_completion",
                arguments: { result: RIGHT_CHILD_RESULT },
                reasoning: "The documented steps are consistent.",
                usage: { ...CACHED_INPUT(900), outputTokens: 90 },
                // Short child latency: this wait happens while the camera sits on the terminal, so a
                // long delay would be spent staring at the shell instead of at the delegated work.
                delayMs: CHILD_REVIEW_DELAY_MS,
                matchRequestContract: true,
                expectedRequestIncludes: [RIGHT_CHILD_TASK],
                expectedToolResultCount: 0,
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_docs_review_done",
                name: "attempt_completion",
                arguments: { result: RIGHT_DONE },
                usage: { ...CACHED_INPUT(7_200), outputTokens: 150 },
                matchRequestContract: true,
                expectedRequestIncludes: [RIGHT_TASK],
                requireCompleteToolPairing: true,
            },
        )
        await panelInput.press("Enter")
        await expectComposerText(panelInput, "")

        // 3a. The second task's own interface. Every other shot in this column frames one card or
        //     the composer, so the clip never showed the second task as a task. Its first message
        //     and the composer are framed together: the panel is ~1000 px tall, and a frame that
        //     tall is clamped to the whole window, which is the same as no camera move at all.
        const rightSent = reviewPanel.getByText(RIGHT_TASK, { exact: false }).last()
        await expect(rightSent).toBeVisible({ timeout: 30_000 })
        await focusCamera([rightSent, reviewInput], STEP_SETTLE_MS)
        await pace(1_000)

        // Running the command opens the workbench terminal in the Panel. The camera stays on the
        // composer it is already framing: that spotlight is the review column's own, so it neither
        // sits on the new terminal nor needs another camera move to follow it.
        const terminalPanel = page.locator('[id="workbench.parts.panel"]')
        await expect(terminalPanel).toBeVisible({ timeout: 60_000 })

        // The review finishes here, before the pull-back. Opening its command block now keeps the
        // scroll and the expansion out of the recorded motion, like every other slow step. These
        // waits are deliberately resolved while the camera still holds the composer: a terminal shot
        // frames nearly the whole workbench, so every frame of a wait spent there re-encodes the
        // entire clip, which is what pushed this capture over its byte budget.
        const rightProof = reviewPanel.getByText(RIGHT_DONE, { exact: false }).last()
        await scrollToEnd(reviewPanel, rightProof, reviewInput)
        await expect(rightProof).toBeVisible({ timeout: 120_000 })
        await revealReviewCommand(reviewPanel)
        // Each shot frames a rendered component, not a sentence inside one: the camera clamps the
        // fitted frame up to its floor, so a 16 px text line becomes a box far wider than the column
        // it belongs to and the surrounding content is pushed out of frame.
        const rightCommand = reviewPanel.getByTestId("command-card").last()
        await expect(rightCommand).toBeVisible({ timeout: 60_000 })
        const subagentCard = reviewPanel.getByTestId("subagent-item").first()
        await expect(subagentCard).toBeVisible({ timeout: 60_000 })
        await dumpEditorLayout(page, "after-review-command")

        // 3b. The terminal gets no camera stop. Its command line is one escaped PowerShell
        //     expression that wraps across the whole panel, so the shot showed the longest, least
        //     legible content in the clip while the review that ran it was pushed out of frame.
        //     It is closed before the command card is measured: hiding the Panel resizes the column
        //     and moves every row in it, and a keyframe recorded while the Panel was open landed on
        //     the TODO counter instead of the card it named. Dismissing VS Code toasts does not
        //     touch it: it is the workbench Panel, not a notification.
        if (await bottomPanel.isVisible()) await page.keyboard.press("ControlOrMeta+j")
        await expect(bottomPanel).toBeHidden({ timeout: 15_000 })

        // 3c. The command card and its output: the row that proves a real command ran, framed after
        //     the column reached its final height so the recorded rectangle matches what renders.
        await focusCamera(rightCommand, STEP_SETTLE_MS)
        await pace(400)

        // 4. The delegated subagent in the review column: the work the parent handed off while it was
        //    still running the workspace command itself. This is where the time freed by the single,
        //    short command goes, so the parallel work is what the camera rests on. The card stays its
        //    own target: unioning it with the command row widened the shot without framing the card
        //    any better, and the wider rectangle encoded every frame of the move at a higher cost.
        await focusCamera(subagentCard, STEP_SETTLE_MS)
        await pace(1_800)

        // 5. The result: the edited file beside the review that produced it, with the command it ran.
        //    The hold is deliberately short: the clip must end on motion.
        await focusCamera([middleColumn, rightCommand], STEP_SETTLE_MS)
        await pace(250)
        await finishRecording()
    },
)
