import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { readTaskRuntimeState, waitForTaskRelease } from "@e2e/utils/task-instance-store"
import { expect, type Frame } from "@playwright/test"
import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import type { ElectronApplication } from "playwright"

async function configure(root: string, overrides: Record<string, unknown> = {}): Promise<void> {
    const file = path.join(root, "data", "settings", "settings.json")
    const settings = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>
    Object.assign(settings, {
        mode: "act",
        focusChainSettings: { enabled: true, remindClineInterval: 6 },
        doubleCheckCompletionEnabled: false,
        useAutoCondense: false,
        enableCheckpointsSetting: false,
        ...overrides,
    })
    await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8")
}

async function open(app: ElectronApplication, helper: E2ETestHelper): Promise<Frame> {
    const page = await app.firstWindow()
    await E2ETestHelper.openClineSidebar(page)
    const sidebar = await helper.getSidebar(page)
    await E2ETestHelper.dismissWhatsNewModal(sidebar)
    await helper.signin(sidebar)
    return sidebar
}

async function send(sidebar: Frame, text: string): Promise<void> {
    const input = sidebar.getByTestId("chat-input")
    await expect(input).toBeEnabled({ timeout: 30_000 })
    await input.fill(text)
    await input.press("Enter")
}

async function onlyTask(docs: string): Promise<string> {
    return E2ETestHelper.waitForValue(async () => {
        const entries = await readdir(path.join(docs, "tasks"), { withFileTypes: true }).catch(() => [])
        const ids = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
        return ids.length === 1 ? ids[0] : undefined
    }, 30_000)
}

/** Read the test task's actual persisted item states, independently of the runtime parser. */
async function items(docs: string, task: string): Promise<Array<{ text: string; done: boolean }>> {
    const markdown = await readFile(path.join(docs, "tasks", task, `focus_chain_taskid_${task}.md`), "utf8").catch(() => "")
    return [...markdown.matchAll(/^\s*-\s+\[([ xX])\]\s+([^\r\n]+)$/gm)].map((match) => ({
        text: match[2].trim(),
        done: match[1].toLowerCase() === "x",
    }))
}

function latestEnvironment(body: unknown): string {
    if (!body || typeof body !== "object" || !("messages" in body) || !Array.isArray(body.messages)) return ""
    const texts = body.messages.flatMap((message: unknown) => {
        if (!message || typeof message !== "object" || !("role" in message) || message.role !== "user" || !("content" in message))
            return []
        if (typeof message.content === "string") return [message.content]
        if (!Array.isArray(message.content)) return []
        return message.content.flatMap((part: unknown) =>
            part && typeof part === "object" && "text" in part && typeof part.text === "string" ? [part.text] : [],
        )
    })
    return texts.filter((text: string) => text.includes("<environment_details>")).at(-1) ?? ""
}

e2e(
    "TODO - make_plan commits full and incremental progress before feedback",
    async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configure(dlineDir)
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                id: "plan-full",
                name: "make_plan",
                arguments: { response: "BUG266_PLAN_FIRST", task_progress: "# Presentation plan\n- [ ] Inspect\n- [ ] Verify" },
            },
            {
                type: "tool",
                id: "plan-increment",
                name: "make_plan",
                arguments: { response: "BUG266_PLAN_SECOND", task_progress: "- [x] Inspect\n- [ ] Verify" },
            },
            {
                type: "tool",
                id: "plan-forbidden-replace",
                name: "make_plan",
                arguments: {
                    response: "BUG266_PLAN_REPLACEMENT_REFUSED",
                    task_progress: "# Unauthorized replacement\n- [ ] Different work",
                },
            },
        )
        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await open(app, helper)
            await send(sidebar, "Present the implementation plan and track its steps")
            await expect(sidebar.getByText("BUG266_PLAN_FIRST", { exact: true }).last()).toBeVisible({ timeout: 60_000 })
            const task = await onlyTask(dlineDocsDir)
            // No response is sent until both the persisted state and TODO header are correct.
            await expect
                .poll(() => items(dlineDocsDir, task), { timeout: 10_000 })
                .toEqual([
                    { text: "Inspect", done: false },
                    { text: "Verify", done: false },
                ])
            await expect(sidebar.getByTitle("Presentation plan").getByText("0/2", { exact: true })).toBeVisible()
            expect(server.getMockConsumptions("openai-compatible-chat")).toHaveLength(1)
            await send(sidebar, "Continue planning and report the completed inspection")
            await expect(sidebar.getByText("BUG266_PLAN_SECOND", { exact: true }).last()).toBeVisible({ timeout: 60_000 })
            await expect
                .poll(() => items(dlineDocsDir, task), { timeout: 10_000 })
                .toEqual([
                    { text: "Inspect", done: true },
                    { text: "Verify", done: false },
                ])
            await expect(sidebar.getByTitle("Presentation plan").getByText("1/2", { exact: true })).toBeVisible()
            expect(server.getMockConsumptions("openai-compatible-chat")).toHaveLength(2)
            await send(sidebar, "Present another plan without requesting replacement approval")
            await expect(sidebar.getByText("BUG266_PLAN_REPLACEMENT_REFUSED", { exact: true }).last()).toBeVisible({
                timeout: 60_000,
            })
            expect(await items(dlineDocsDir, task)).toEqual([
                { text: "Inspect", done: true },
                { text: "Verify", done: false },
            ])
            await expect(sidebar.getByTitle("Presentation plan").getByText("1/2", { exact: true })).toBeVisible()
            expect(server.getMockConsumptions("openai-compatible-chat")).toHaveLength(3)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "TODO - indented completed list accepts the next phase without feedback",
    async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configure(dlineDir)
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                id: "seed-indent",
                name: "read_file",
                arguments: { path: "README.md", task_progress: "# Previous phase\n  - [ ] Inspect" },
            },
            {
                type: "tool",
                id: "done-indent",
                name: "read_file",
                arguments: { path: "README.md", task_progress: "- [x] Inspect" },
            },
            {
                type: "tool",
                id: "next-phase",
                name: "make_plan",
                arguments: { response: "BUG266_NEXT_PHASE", task_progress: "# Next phase\n- [ ] Implement" },
            },
            { type: "tool", id: "phase-ready", name: "qna_respond", arguments: { response: "BUG266_PHASE_READY" } },
        )
        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await open(app, helper)
            await send(sidebar, "Inspect then present the next phase")
            await expect(sidebar.getByText("BUG266_NEXT_PHASE", { exact: true }).last()).toBeVisible({ timeout: 60_000 })
            const task = await onlyTask(dlineDocsDir)
            await expect.poll(() => items(dlineDocsDir, task), { timeout: 10_000 }).toEqual([{ text: "Implement", done: false }])
            await expect(sidebar.getByTitle("Next phase").getByText("0/1", { exact: true })).toBeVisible()
            const history = await readFile(
                path.join(dlineDocsDir, "tasks", task, `focus_chain_taskid_${task}_history.md`),
                "utf8",
            )
            expect([...history.matchAll(/^## Completed — /gm)]).toHaveLength(1)
            expect([...history.matchAll(/^\s*- \[x\] (.+)$/gm)].map((match) => match[1])).toEqual(["Inspect"])
            await send(sidebar, "Continue the new phase")
            await expect(sidebar.getByText("BUG266_PHASE_READY", { exact: true }).last()).toBeVisible({ timeout: 60_000 })
            const calls = server.getMockConsumptions("openai-compatible-chat")
            expect(calls).toHaveLength(4)
            expect([...latestEnvironment(calls[3].requestBody).matchAll(/<focus_chain_reminder\s+kind="completed">/g)]).toEqual(
                [],
            )
        } finally {
            await app.close()
        }
    },
)

e2e(
    "TODO - attempt ignores progress and cannot finish its own unchecked list",
    async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configure(dlineDir)
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                id: "seed-pending",
                name: "read_file",
                arguments: { path: "README.md", task_progress: "# Completion gate\n- [ ] Verify" },
            },
            {
                type: "tool",
                id: "illegal-completion",
                name: "attempt_completion",
                arguments: { result: "BUG266_MUST_NOT_COMPLETE", task_progress: "- [x] Verify" },
            },
            { type: "tool", id: "inspect-blocked", name: "qna_respond", arguments: { response: "BUG266_COMPLETION_REFUSED" } },
        )
        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await open(app, helper)
            await send(sidebar, "Verify the completion gate")
            await expect(sidebar.getByText("BUG266_COMPLETION_REFUSED", { exact: true }).last()).toBeVisible({ timeout: 60_000 })
            const task = await onlyTask(dlineDocsDir)
            expect(await items(dlineDocsDir, task)).toEqual([{ text: "Verify", done: false }])
            await expect(sidebar.getByTitle("Completion gate").getByText("0/1", { exact: true })).toBeVisible()
            await expect(sidebar.getByText(/task_progress.*ignored/i).last()).toBeVisible()
            const calls = server.getMockConsumptions("openai-compatible-chat")
            expect(calls).toHaveLength(3)
            expect(calls.every((call) => call.contractError === undefined)).toBe(true)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "TODO - completed phase reminds on real requests 1 2 8 and 14",
    async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configure(dlineDir)
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                id: "cadence-seed",
                name: "read_file",
                arguments: { path: "README.md", task_progress: "# Cadence\n- [ ] Inspect" },
            },
            {
                type: "tool",
                id: "cadence-complete",
                name: "read_file",
                arguments: { path: "README.md", task_progress: "- [x] Inspect" },
            },
            ...Array.from({ length: 13 }, (_, index) => ({
                type: "tool" as const,
                id: `cadence-${index + 1}`,
                name: "read_file",
                arguments: {
                    path: "README.md",
                    start_line: 1,
                    end_line: index + 4,
                    // Neither a rejected repeated completion nor an unchanged full report resets the cadence.
                    ...(index === 2
                        ? { task_progress: "- [x] Inspect" }
                        : index === 4
                          ? { task_progress: "# Cadence\n- [x] Inspect" }
                          : {}),
                },
            })),
            { type: "tool", id: "cadence-end", name: "qna_respond", arguments: { response: "BUG266_CADENCE_RECORDED" } },
        )
        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await open(app, helper)
            await send(sidebar, "Inspect and continue gathering evidence")
            await expect(sidebar.getByText("BUG266_CADENCE_RECORDED", { exact: true }).last()).toBeVisible({ timeout: 90_000 })
            const task = await onlyTask(dlineDocsDir)
            expect(await items(dlineDocsDir, task)).toEqual([{ text: "Inspect", done: true }])
            const calls = server.getMockConsumptions("openai-compatible-chat")
            expect(calls).toHaveLength(16)
            const reminderRounds = calls.slice(2).flatMap((call, index) => {
                const env = latestEnvironment(call.requestBody)
                // This structural marker is the dynamic reminder boundary, not prose or the always-present checklist.
                const reminders = [...env.matchAll(/<focus_chain_reminder\s+kind="([^"]+)">/g)].map((match) => match[1])
                return reminders.includes("completed") ? [index + 1] : []
            })
            expect(reminderRounds).toEqual([1, 2, 8, 14])
            expect(calls.every((call) => call.contractError === undefined)).toBe(true)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "TODO - YOLO plan carries progress through automatic Act switch",
    async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configure(dlineDir, { mode: "plan", yoloModeToggled: true })
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                id: "automatic-plan",
                name: "make_plan",
                arguments: { response: "BUG266_AUTOMATIC_PLAN", task_progress: "# Automatic plan\n- [ ] Implement" },
            },
            { type: "tool", id: "automatic-end", name: "qna_respond", arguments: { response: "BUG266_AUTOMATIC_READY" } },
        )
        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await open(app, helper)
            await send(sidebar, "Plan then switch automatically to Act")
            await expect(sidebar.getByText("BUG266_AUTOMATIC_READY", { exact: true }).last()).toBeVisible({ timeout: 60_000 })
            const task = await onlyTask(dlineDocsDir)
            expect(await items(dlineDocsDir, task)).toEqual([{ text: "Implement", done: false }])
            await expect(sidebar.getByTitle("Automatic plan").getByText("0/1", { exact: true })).toBeVisible()
            expect(server.getMockConsumptions("openai-compatible-chat")).toHaveLength(2)
        } finally {
            await app.close()
        }
    },
)

for (const restore of [false, true]) {
    e2e(
        `TODO - valid completion warns before feedback and preserves ignored warning in its ${restore ? "restored" : "live"} result`,
        async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, workspaceDir }) => {
            e2e.setTimeout(180_000)
            await configure(dlineDir)
            server.resetOpenAiMock()
            server.enqueueOpenAiResponses(
                {
                    type: "tool",
                    id: "warning-seed",
                    name: "read_file",
                    arguments: { path: "README.md", task_progress: "# Finished work\n- [ ] Verify" },
                },
                {
                    type: "tool",
                    id: "warning-done",
                    name: "read_file",
                    arguments: { path: "README.md", task_progress: "- [x] Verify" },
                },
                {
                    type: "tool",
                    id: "warning-completion",
                    name: "attempt_completion",
                    arguments: { result: "BUG266_VALID_COMPLETION", task_progress: "# Must be ignored\n- [ ] Unrequested" },
                },
                {
                    type: "tool",
                    id: "warning-followup",
                    name: "qna_respond",
                    arguments: { response: "BUG266_WARNING_RETAINED" },
                    expectedToolResults: [{ callId: "warning-completion", contentIncludes: ["task_progress", "ignored"] }],
                },
            )
            const app = await openVSCode(workspaceDir)
            try {
                const sidebar = await open(app, helper)
                await send(sidebar, "Complete the verified work")
                await expect(sidebar.getByText("BUG266_VALID_COMPLETION", { exact: true }).last()).toBeVisible({
                    timeout: 60_000,
                })
                await expect(sidebar.getByText(/task_progress.*ignored/i).last()).toBeVisible()
                const task = await onlyTask(dlineDocsDir)
                expect(await items(dlineDocsDir, task)).toEqual([{ text: "Verify", done: true }])
                expect(server.getMockConsumptions("openai-compatible-chat")).toHaveLength(3)
                if (restore) {
                    await sidebar.getByRole("button", { name: "Close Task", exact: true }).click()
                    await waitForTaskRelease(dlineDocsDir, task)
                    const recent = sidebar.getByText("Complete the verified work", { exact: true }).last()
                    await expect(recent).toBeVisible({ timeout: 30_000 })
                    await recent.click()
                    await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({
                        timeout: 30_000,
                    })
                }
                await send(sidebar, "Explain the retained result")
                await expect(sidebar.getByText("BUG266_WARNING_RETAINED", { exact: true }).last()).toBeVisible({
                    timeout: 60_000,
                })
                const calls = server.getMockConsumptions("openai-compatible-chat")
                expect(calls).toHaveLength(4)
                expect(calls[3].contractError).toBeUndefined()
                expect(await items(dlineDocsDir, task)).toEqual([{ text: "Verify", done: true }])
            } finally {
                await app.close()
            }
        },
    )
}

e2e(
    "TODO - question and report commit before feedback and restored feedback never replays progress",
    async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configure(dlineDir)
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                id: "question-progress",
                name: "ask_followup_question",
                arguments: {
                    question: "BUG266_QUESTION",
                    options: "[]",
                    task_progress: "# Interactive work\n- [ ] Inspect\n- [ ] Verify",
                },
            },
            {
                type: "tool",
                id: "report-progress",
                name: "generate_report",
                arguments: {
                    title: "BUG266_REPORT",
                    content: "Inspection evidence",
                    task_progress: "- [x] Inspect\n- [ ] Verify",
                },
            },
            { type: "tool", id: "restored-feedback", name: "qna_respond", arguments: { response: "BUG266_RESTORED_FEEDBACK" } },
        )
        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await open(app, helper)
            const taskText = "Track question and report lifecycle"
            await send(sidebar, taskText)
            await expect(sidebar.getByText("BUG266_QUESTION", { exact: true }).last()).toBeVisible({ timeout: 60_000 })
            const task = await onlyTask(dlineDocsDir)
            await expect
                .poll(() => items(dlineDocsDir, task))
                .toEqual([
                    { text: "Inspect", done: false },
                    { text: "Verify", done: false },
                ])
            await expect(sidebar.getByTitle("Interactive work").getByText("0/2", { exact: true })).toBeVisible()
            await send(sidebar, "Inspect and report")
            await expect(sidebar.getByText("BUG266_REPORT", { exact: true }).last()).toBeVisible({ timeout: 60_000 })
            await expect
                .poll(() => items(dlineDocsDir, task))
                .toEqual([
                    { text: "Inspect", done: true },
                    { text: "Verify", done: false },
                ])
            await expect(sidebar.getByTitle("Interactive work").getByText("1/2", { exact: true })).toBeVisible()
            await sidebar.getByRole("button", { name: "Close Task", exact: true }).click()
            await waitForTaskRelease(dlineDocsDir, task)
            // An actual external edit while closed must win over the old report's parameters.
            await writeFile(
                path.join(dlineDocsDir, "tasks", task, `focus_chain_taskid_${task}.md`),
                "# User revision\n- [ ] Keep user work\n",
                "utf8",
            )
            const recent = sidebar.getByText(taskText, { exact: true }).last()
            await expect(recent).toBeVisible({ timeout: 30_000 })
            await recent.click()
            await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({ timeout: 30_000 })
            await send(sidebar, "Continue from the restored report")
            await expect(sidebar.getByText("BUG266_RESTORED_FEEDBACK", { exact: true }).last()).toBeVisible({ timeout: 60_000 })
            expect(await items(dlineDocsDir, task)).toEqual([{ text: "Keep user work", done: false }])
            await expect(sidebar.getByTitle("User revision").getByText("0/1", { exact: true })).toBeVisible()
            expect(server.getMockConsumptions("openai-compatible-chat")).toHaveLength(3)
        } finally {
            await app.close()
        }
    },
)

for (const cancel of [false, true]) {
    e2e(
        `TODO - parallel progress ${cancel ? "is fenced on cancel" : "commits in block order without holding execution slots"}`,
        async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, workspaceDir }) => {
            e2e.setTimeout(180_000)
            await configure(dlineDir, {
                enableParallelToolCalling: true,
                maxParallelToolCalls: 2,
                autoApprovalSettings: { ...DEFAULT_AUTO_APPROVAL_SETTINGS, ceilings: { edit_workspace: "manual_only" } },
            })
            server.resetOpenAiMock()
            server.enqueueOpenAiResponses(
                {
                    type: "tools",
                    tools: [
                        {
                            id: "ordered-slow",
                            name: "write_to_file",
                            arguments: {
                                path: "ordered-write.txt",
                                content: "approved write\n",
                                task_progress: "# Parallel work\n- [ ] Inspect\n- [ ] Verify",
                            },
                        },
                        {
                            id: "ordered-fast",
                            name: "read_file",
                            arguments: { path: "README.md", task_progress: "- [x] Inspect\n- [ ] Verify" },
                        },
                    ],
                },
                { type: "tool", id: "ordered-end", name: "qna_respond", arguments: { response: "BUG266_PARALLEL_SETTLED" } },
            )
            const app = await openVSCode(workspaceDir)
            try {
                const sidebar = await open(app, helper)
                const taskText = "Run an approval-gated write and inspection in parallel"
                await send(sidebar, taskText)
                const task = await onlyTask(dlineDocsDir)
                // The later read must release its execution slot while the earlier write awaits approval.
                await expect
                    .poll(async () => (await readTaskRuntimeState(dlineDocsDir, task))?.turn.blocks.map((block) => block.phase), {
                        timeout: 30_000,
                    })
                    .toEqual(["awaiting_approval", "completed"])
                expect(await items(dlineDocsDir, task)).toEqual([])
                if (cancel) {
                    await sidebar.getByRole("button", { name: "Close Task", exact: true }).click()
                    await waitForTaskRelease(dlineDocsDir, task)
                    const recent = sidebar.getByText(taskText, { exact: true }).last()
                    await expect(recent).toBeVisible({ timeout: 30_000 })
                    await recent.click()
                    await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({
                        timeout: 30_000,
                    })
                    await send(sidebar, "Resume without replaying cancelled progress")
                } else {
                    await sidebar.getByRole("contentinfo").getByRole("button", { name: "Approve", exact: true }).first().click()
                }
                await expect(sidebar.getByText("BUG266_PARALLEL_SETTLED", { exact: true }).last()).toBeVisible({
                    timeout: 60_000,
                })
                expect(await items(dlineDocsDir, task)).toEqual(
                    cancel
                        ? []
                        : [
                              { text: "Inspect", done: true },
                              { text: "Verify", done: false },
                          ],
                )
                if (!cancel) {
                    await expect(sidebar.getByTitle("Parallel work").getByText("1/2", { exact: true })).toBeVisible()
                    expect(await readFile(path.join(workspaceDir, "ordered-write.txt"), "utf8")).toBe("approved write\n")
                } else {
                    await expect(readFile(path.join(workspaceDir, "ordered-write.txt"), "utf8")).rejects.toMatchObject({
                        code: "ENOENT",
                    })
                }
                expect(server.getMockConsumptions("openai-compatible-chat")).toHaveLength(2)
            } finally {
                await app.close()
            }
        },
    )
}

e2e(
    "TODO - failed checklist write preserves committed state and the successful file result",
    async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configure(dlineDir)
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                id: "storage-seed",
                name: "make_plan",
                arguments: { response: "BUG266_STORAGE_READY", task_progress: "# Durable work\n- [ ] Inspect" },
            },
            {
                type: "tool",
                id: "storage-read",
                name: "read_file",
                arguments: { path: "README.md", task_progress: "- [x] Inspect" },
            },
            {
                type: "tool",
                id: "storage-end",
                name: "qna_respond",
                arguments: { response: "BUG266_STORAGE_FAILURE_REPORTED" },
                expectedToolResults: [{ callId: "storage-read", contentIncludes: ["# Test Workspace", "TODO update failed"] }],
            },
        )
        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await open(app, helper)
            await send(sidebar, "Keep the file result when TODO storage fails")
            await expect(sidebar.getByText("BUG266_STORAGE_READY", { exact: true }).last()).toBeVisible({ timeout: 60_000 })
            const task = await onlyTask(dlineDocsDir)
            await expect.poll(() => items(dlineDocsDir, task)).toEqual([{ text: "Inspect", done: false }])
            const file = path.join(dlineDocsDir, "tasks", task, `focus_chain_taskid_${task}.md`)
            const saved = await readFile(file, "utf8")
            await rename(file, `${file}.fixture-backup`)
            await mkdir(file)
            try {
                await send(sidebar, "Read the evidence and report progress")
                await expect(sidebar.getByText("BUG266_STORAGE_FAILURE_REPORTED", { exact: true }).last()).toBeVisible({
                    timeout: 60_000,
                })
                await expect(sidebar.getByTitle("Durable work").getByText("0/1", { exact: true })).toBeVisible()
                expect(await readFile(`${file}.fixture-backup`, "utf8")).toBe(saved)
                const calls = server.getMockConsumptions("openai-compatible-chat")
                expect(calls).toHaveLength(3)
                expect(calls[2].contractError).toBeUndefined()
            } finally {
                await rm(file, { recursive: true })
                await rename(`${file}.fixture-backup`, file)
            }
        } finally {
            await app.close()
        }
    },
)

e2e(
    "TODO - unreadable initial checklist refuses replacement and recovers without losing external edits",
    async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configure(dlineDir)
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                id: "load-seed",
                name: "make_plan",
                arguments: { response: "BUG266_LOAD_SEEDED", task_progress: "# Stored work\n- [ ] Inspect\n- [ ] Verify" },
            },
            {
                type: "tool",
                id: "load-failed-read",
                name: "read_file",
                arguments: { path: "README.md", task_progress: "# Unsafe replacement\n- [ ] Overwrite" },
            },
            {
                type: "tool",
                id: "load-failed-report",
                name: "qna_respond",
                arguments: { response: "BUG266_LOAD_FAILURE_REPORTED" },
                expectedToolResults: [{ callId: "load-failed-read", contentIncludes: ["# Test Workspace"] }],
            },
            {
                type: "tool",
                id: "load-recovered-plan",
                name: "make_plan",
                arguments: { response: "BUG266_LOAD_RECOVERED", task_progress: "- [x] Inspect\n- [ ] Verify" },
            },
        )
        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await open(app, helper)
            const taskText = "Recover the unreadable initial checklist safely"
            await send(sidebar, taskText)
            await expect(sidebar.getByText("BUG266_LOAD_SEEDED", { exact: true }).last()).toBeVisible({ timeout: 60_000 })
            const task = await onlyTask(dlineDocsDir)
            await expect
                .poll(() => items(dlineDocsDir, task))
                .toEqual([
                    { text: "Inspect", done: false },
                    { text: "Verify", done: false },
                ])
            await sidebar.getByRole("button", { name: "Close Task", exact: true }).click()
            await waitForTaskRelease(dlineDocsDir, task)
            const file = path.join(dlineDocsDir, "tasks", task, `focus_chain_taskid_${task}.md`)
            const saved = await readFile(file, "utf8")
            await rename(file, `${file}.fixture-backup`)
            await mkdir(file)
            try {
                const recent = sidebar.getByText(taskText, { exact: true }).last()
                await expect(recent).toBeVisible({ timeout: 30_000 })
                await recent.click()
                await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({ timeout: 30_000 })
                await send(sidebar, "Read evidence while the TODO storage is unavailable")
                await expect(sidebar.getByText("BUG266_LOAD_FAILURE_REPORTED", { exact: true }).last()).toBeVisible({
                    timeout: 60_000,
                })
                expect(await readFile(`${file}.fixture-backup`, "utf8")).toBe(saved)
                expect(await readdir(file)).toEqual([])
                const calls = server.getMockConsumptions("openai-compatible-chat")
                expect(calls).toHaveLength(3)
                expect(calls[2].contractError).toBeUndefined()
            } finally {
                await rm(file, { recursive: true })
                await rename(`${file}.fixture-backup`, file)
            }
            await send(sidebar, "Continue from the repaired stored checklist")
            await expect(sidebar.getByText("BUG266_LOAD_RECOVERED", { exact: true }).last()).toBeVisible({ timeout: 60_000 })
            await expect
                .poll(() => items(dlineDocsDir, task))
                .toEqual([
                    { text: "Inspect", done: true },
                    { text: "Verify", done: false },
                ])
            await expect(sidebar.getByTitle("Stored work").getByText("1/2", { exact: true })).toBeVisible()
            // Recovery must retain the watcher, not just make the next model update work.
            await writeFile(file, "# Recovered user edit\n- [ ] Keep user work\n", "utf8")
            await expect(sidebar.getByTitle("Recovered user edit").getByText("0/1", { exact: true })).toBeVisible({
                timeout: 10_000,
            })
            expect(server.getMockConsumptions("openai-compatible-chat")).toHaveLength(4)
        } finally {
            await app.close()
        }
    },
)
