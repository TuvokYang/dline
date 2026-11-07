import { mkdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import type { ClineApiServerMock, MockApiConsumption } from "@e2e/fixtures/server"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { e2e as base, E2ETestHelper } from "@e2e/utils/helpers"
import { showSubagentOutput, subagentCardByTask } from "@e2e/utils/subagent-card"
import { expect, type Frame } from "@playwright/test"

const AGENT = "e2e-auto-compaction"
const TASK = "E2E_SUBAGENT_AUTO_COMPACTION_TASK"
const EVIDENCE_FILE = "compaction-evidence.txt"
const EVIDENCE = "E2E_SUBAGENT_COMPACTION_READ_EVIDENCE"
const SUMMARY = "E2E_SUBAGENT_COMPACTION_SUMMARY preserves the evidence and pending directory inspection."
const CHILD_DONE = "E2E_SUBAGENT_COMPACTION_CHILD_DONE"
const PARENT_DONE = "E2E_SUBAGENT_COMPACTION_PARENT_DONE"
const COMPACT_INSTRUCTION = "The current conversation is rapidly running out of context"
const SUBAGENT_CALL = "call_compaction_subagent"
const READ_CALL = "call_compaction_read"
const SELECTED_RULE = "E2E_SUBAGENT_COMPACTION_SELECTED_RULE_BODY"
const UNSELECTED_RULE = "E2E_SUBAGENT_COMPACTION_UNSELECTED_RULE_BODY"
const RULE_FILE = "compaction-selected.md"

const e2e = base.extend({
    dlineDir: async ({ dlineDir, workspaceDir }, use) => {
        const settingsPath = path.join(dlineDir, "data", "settings", "settings.json")
        const settings = JSON.parse(await readFile(settingsPath, "utf8"))
        await writeFile(
            settingsPath,
            JSON.stringify({
                ...settings,
                useAutoCondense: true,
                autoCondenseTriggerPercent: 60,
                autoCondenseMinReserveTokens: 5_000,
                autoCondenseMaxReserveTokens: 30_000,
                autoCondenseMaxContextTokens: 200_000,
            }),
        )
        const profilesPath = path.join(dlineDir, "data", "settings", "api_profiles.json")
        const profiles = JSON.parse(await readFile(profilesPath, "utf8"))
        const child = profiles.find((profile: { name: string }) => profile.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
        if (!child?.openai?.capabilities) throw new Error("Missing configurable child E2E Profile")
        // A custom model proves compaction does not depend on a model-family whitelist.
        child.modelId = "e2e-ordinary-subagent-model"
        child.openai.capabilities.contextWindow = 200_000
        child.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
        await writeFile(profilesPath, JSON.stringify(profiles))
        const directory = path.join(workspaceDir, ".agents", "subagents")
        const rulesDirectory = path.join(workspaceDir, ".agents", "rules")
        await Promise.all([mkdir(directory, { recursive: true }), mkdir(rulesDirectory, { recursive: true })])
        await Promise.all([
            writeFile(path.join(rulesDirectory, RULE_FILE), SELECTED_RULE),
            writeFile(path.join(rulesDirectory, "compaction-unselected.md"), UNSELECTED_RULE),
        ])
        await writeFile(
            path.join(directory, `${AGENT}.yml`),
            `---
name: ${AGENT}
description: E2E automatic in-memory compaction
profile: ${E2E_PROFILE_NAMES.mockOpenAiResponses}
tools:
  - read_file
  - list_files
  - attempt_completion
rules:
  - scope: workspace
    path: ${RULE_FILE}
---

Inspect the evidence and directory before completing the delegated task.`,
        )
        await writeFile(path.join(workspaceDir, EVIDENCE_FILE), EVIDENCE)
        await use(dlineDir)
    },
})

e2e.afterEach(async ({ server, userDataDir }, testInfo) => {
    await testInfo.attach("subagent-compaction-provider-requests", {
        body: JSON.stringify({
            parent: server.getMockConsumptions("openai-compatible-chat"),
            child: server.getMockConsumptions("openai-compatible-responses"),
        }),
        contentType: "application/json",
    })
    await testInfo.attach("subagent-compaction-dline-output", {
        body: E2ETestHelper.readDlineOutputIfPresent(userDataDir) ?? "Dline Output log unavailable.",
        contentType: "text/plain",
    })
})

function enqueueParent(server: ClineApiServerMock, expectedResult: string | readonly string[]): void {
    server.resetOpenAiMock()
    server.enqueueOpenAiResponses(
        {
            type: "tool",
            id: SUBAGENT_CALL,
            name: "use_subagent",
            arguments: {
                agent_name: AGENT,
                task: TASK,
                context: "Read evidence, inspect files, then return findings.",
                timeout: 60,
            },
            usage: { inputTokens: 1_000, outputTokens: 100 },
        },
        {
            type: "tool",
            id: "call_compaction_parent_done",
            name: "attempt_completion",
            arguments: { result: PARENT_DONE },
            expectedToolResults: [{ callId: SUBAGENT_CALL, contentIncludes: expectedResult }],
            requireCompleteToolPairing: true,
        },
    )
    server.enqueueResponses("openai-compatible-responses", {
        type: "tool",
        id: READ_CALL,
        name: "read_file",
        arguments: { path: EVIDENCE_FILE },
        usage: { inputTokens: 190_000, outputTokens: 1_000 },
        requireCompleteToolPairing: true,
    })
}

async function startSubagent(sidebar: Frame): Promise<void> {
    const input = sidebar.getByTestId("chat-input")
    await expect(input).toBeEnabled()
    await input.fill("Delegate the evidence inspection to the configured compaction subagent.")
    await sidebar.getByTestId("send-button").click()
    const approve = sidebar.getByText("Approve", { exact: true })
    const card = subagentCardByTask(sidebar, TASK)
    await expect(approve.or(card)).toBeVisible({ timeout: 30_000 })
    if (await approve.isVisible()) await approve.click()
}

function expectValidRequests(requests: readonly MockApiConsumption[], count: number): void {
    expect(requests).toHaveLength(count)
    for (const request of requests) {
        expect(request.contractError).toBeUndefined()
        expect(request.requestToolPairing.complete).toBe(true)
    }
}

/** The hidden summary and continuation must reuse the original child system, not re-inject Rules. */
function expectRulesPreserved(requests: readonly MockApiConsumption[]): void {
    const systems = requests.map(({ requestBody }) => {
        const body = requestBody as { instructions?: string; input: { role?: string; content?: unknown }[] }
        expect(Array.isArray(body.input)).toBe(true)
        const system = JSON.stringify({
            instructions: body.instructions,
            input: body.input.filter((item) => item.role === "system" || item.role === "developer"),
        })
        expect(system.split(SELECTED_RULE)).toHaveLength(2)
        expect(system).not.toContain(UNSELECTED_RULE)
        // Inspect the complete request too: the marker must not be copied into ordinary input.
        expect(JSON.stringify(requestBody).split(SELECTED_RULE)).toHaveLength(2)
        expect(JSON.stringify(requestBody)).not.toContain(UNSELECTED_RULE)
        return system
    })
    expect(new Set(systems).size).toBe(1)
}

e2e(
    "Subagent auto compaction - summarizes above 80 percent and continues real tools",
    async ({ helper, server, sidebar, userDataDir }, testInfo) => {
        await helper.signin(sidebar)
        enqueueParent(server, CHILD_DONE)
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "message",
                text: `<summarize_task><context>${SUMMARY}</context></summarize_task>`,
                expectedRequestIncludes: [COMPACT_INSTRUCTION, TASK],
                expectedToolResults: [{ callId: READ_CALL, contentIncludes: EVIDENCE }],
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_compaction_list",
                name: "list_files",
                arguments: { path: ".", recursive: false },
                expectedRequestIncludes: [SUMMARY, "previous_task_compaction_summary"],
                expectedRequestExcludes: [READ_CALL, COMPACT_INSTRUCTION],
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_compaction_child_done",
                name: "attempt_completion",
                arguments: { result: CHILD_DONE },
                expectedToolResults: [{ callId: "call_compaction_list", contentIncludes: ["README.md", EVIDENCE_FILE] }],
                requireCompleteToolPairing: true,
            },
        )
        await startSubagent(sidebar)
        await expect(sidebar.getByText(PARENT_DONE, { exact: false }).last()).toBeVisible({ timeout: 30_000 })
        const card = subagentCardByTask(sidebar, TASK)
        await expect(await showSubagentOutput(card)).toContainText(CHILD_DONE)
        await expect(card.getByTestId("subagent-tool-step-name")).toHaveText(["read_file", "list_files", "attempt_completion"])
        // Hidden summaries are not ordinary tool rows or separate Task compaction cards.
        await expect(sidebar.getByText(SUMMARY, { exact: false })).toHaveCount(0)
        const child = server.getMockConsumptions("openai-compatible-responses")
        expectValidRequests(child, 4)
        expectRulesPreserved(child)
        expectValidRequests(server.getMockConsumptions("openai-compatible-chat"), 2)
        expect(child.map(({ responseType, toolName }) => toolName ?? responseType)).toEqual([
            "read_file",
            "message",
            "list_files",
            "attempt_completion",
        ])
        const first = child[0].requestBody as { tools: unknown[]; model: string }
        expect(child[1].requestBody).toMatchObject({ tools: first.tools, model: first.model })
        await testInfo.attach("subagent-compaction-completed", { body: await card.screenshot(), contentType: "image/png" })
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)

e2e(
    "Subagent auto compaction - a rejected summary fails the child without an oversized continuation",
    async ({ helper, server, sidebar, userDataDir }) => {
        await helper.signin(sidebar)
        enqueueParent(server, ["stopped without producing a result", "Retry control on the subagent activity"])
        const diagnostic = "E2E_SUBAGENT_COMPACTION_REJECTED"
        server.enqueueResponses("openai-compatible-responses", {
            type: "error",
            status: 400,
            code: "e2e_compaction_rejected",
            message: diagnostic,
        })
        await startSubagent(sidebar)
        await expect(sidebar.getByText(PARENT_DONE, { exact: false }).last()).toBeVisible({ timeout: 30_000 })
        const card = subagentCardByTask(sidebar, TASK)
        await expect(card.getByRole("button", { name: "Retry", exact: true })).toBeVisible()
        await expect(card.getByRole("button", { name: "Finish", exact: true })).toHaveCount(0)
        const child = server.getMockConsumptions("openai-compatible-responses")
        expectValidRequests(child, 2)
        expectRulesPreserved(child)
        expectValidRequests(server.getMockConsumptions("openai-compatible-chat"), 2)
        expect(child[1]).toMatchObject({ responseType: "error", status: 400 })
        expect(JSON.stringify(child[1].requestBody)).toContain(COMPACT_INSTRUCTION)
        const parentResult = server.getMockConsumptions("openai-compatible-chat")[1].requestToolResults
        expect(JSON.stringify(parentResult)).not.toContain(diagnostic)
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [new RegExp(diagnostic)])
    },
)

e2e(
    "Subagent auto compaction - row Cancel aborts the hidden summary and settles the parent",
    async ({ helper, server, sidebar, userDataDir }) => {
        await helper.signin(sidebar)
        enqueueParent(server, [
            "stopped without producing a result (Cancelled by the user)",
            "Retry control on the subagent activity",
        ])
        server.enqueueResponses("openai-compatible-responses", {
            type: "message",
            text: `<summarize_task><context>${SUMMARY}</context></summarize_task>`,
            delayMs: 30_000,
            expectedRequestIncludes: [COMPACT_INSTRUCTION],
            expectedToolResults: [{ callId: READ_CALL, contentIncludes: EVIDENCE }],
            requireCompleteToolPairing: true,
        })
        await startSubagent(sidebar)
        await expect.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 30_000 }).toBe(2)
        const card = subagentCardByTask(sidebar, TASK)
        await card.getByTestId("subagent-item-header").getByRole("button", { name: "Cancel", exact: true }).click()
        await expect(sidebar.getByText(PARENT_DONE, { exact: false }).last()).toBeVisible({ timeout: 30_000 })
        await expect.poll(() => server.getMockConsumptions("openai-compatible-responses")[1]?.abortedAtMs).toBeDefined()
        await expect(card.getByRole("button", { name: "Retry", exact: true })).toBeVisible()
        await expect(card.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0)
        await expect(sidebar.getByText(SUMMARY, { exact: false })).toHaveCount(0)
        expectValidRequests(server.getMockConsumptions("openai-compatible-responses"), 2)
        expectRulesPreserved(server.getMockConsumptions("openai-compatible-responses"))
        expectValidRequests(server.getMockConsumptions("openai-compatible-chat"), 2)
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)
