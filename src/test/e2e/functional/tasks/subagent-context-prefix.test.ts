import { mkdir, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

async function setAutoApproveAction(sidebar: Frame, label: string, enabled: boolean): Promise<void> {
    await sidebar.getByLabel("Open auto-approve settings").click()
    const checkbox = sidebar.locator("vscode-checkbox").filter({ hasText: label })
    await expect(checkbox).toHaveCount(1)
    const isChecked = () => checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))
    if ((await isChecked()) !== enabled) {
        await sidebar.getByText(label, { exact: true }).click()
    }
    await expect.poll(isChecked).toBe(enabled)
    await sidebar.getByLabel("Close auto-approve settings").click()
}

async function sendTask(sidebar: Frame, text: string): Promise<void> {
    const input = sidebar.getByTestId("chat-input")
    await input.fill(text)
    await sidebar.getByTestId("send-button").click()
    await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

function responsesInput(requestBody: unknown): readonly unknown[] {
    if (!requestBody || typeof requestBody !== "object") {
        throw new Error("OpenAI Responses request body is not an object")
    }
    const input = Reflect.get(requestBody, "input")
    if (!Array.isArray(input)) {
        throw new Error("OpenAI Responses request body does not contain an input array")
    }
    return input
}

function encryptedReasoningCount(input: readonly unknown[]): number {
    return input.filter(
        (item) =>
            item !== null &&
            typeof item === "object" &&
            Reflect.get(item, "type") === "reasoning" &&
            typeof Reflect.get(item, "encrypted_content") === "string",
    ).length
}

function expectReasoningSummary(input: readonly unknown[], text: string): void {
    expect(input).toEqual(
        expect.arrayContaining([
            expect.objectContaining({
                type: "reasoning",
                summary: expect.arrayContaining([expect.objectContaining({ type: "summary_text", text })]),
            }),
        ]),
    )
}

e2e(
    "Tools - subagent provider input remains append-only across rounds with reasoning",
    async ({ helper, server, sidebar, workspaceDir }) => {
        e2e.setTimeout(180_000)
        const agentName = "e2e-context-prefix"
        const completion = "E2E_SUBAGENT_CONTEXT_PREFIX_DONE"
        const firstReasoning = "E2E_SUBAGENT_REASONING_ROUND_ONE"
        const secondReasoning = "E2E_SUBAGENT_REASONING_ROUND_TWO"
        const encryptedReasoningSize = 48
        const subagentDirectory = path.join(workspaceDir, ".agents", "subagents")

        await mkdir(subagentDirectory, { recursive: true })
        await writeFile(
            path.join(subagentDirectory, `${agentName}.yml`),
            `---
name: ${agentName}
description: Verify append-only provider context across subagent rounds
profile: ${E2E_PROFILE_NAMES.mockOpenAiResponses}
tools:
  - attempt_completion
---

Complete only after two feedback rounds.`,
            "utf8",
        )

        await helper.signin(sidebar)
        await setAutoApproveAction(sidebar, "Read project files", false)
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                id: "call_subagent_context_prefix",
                name: "use_subagent",
                arguments: {
                    agent_name: agentName,
                    task: "Verify that every provider request extends the previous request without rewriting it.",
                    context: "Preserve both ordinary and redacted reasoning while the runner requests a usable tool call.",
                    timeout: 60,
                },
            },
            {
                type: "tool",
                id: "call_subagent_context_prefix_parent_complete",
                name: "attempt_completion",
                arguments: { result: completion },
                expectedToolResults: [{ callId: "call_subagent_context_prefix", contentIncludes: completion }],
            },
        )
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "message",
                text: "First round intentionally returns prose so the runner appends feedback.",
                reasoning: firstReasoning,
                encryptedReasoningItemCount: 1,
                encryptedReasoningChunkSize: encryptedReasoningSize,
            },
            {
                type: "message",
                text: "Second round intentionally returns prose so the runner appends feedback again.",
                reasoning: secondReasoning,
                encryptedReasoningItemCount: 1,
                encryptedReasoningChunkSize: encryptedReasoningSize,
                expectedRequestIncludes: [firstReasoning, "# Context Window Usage"],
            },
            {
                type: "tool",
                id: "call_subagent_context_prefix_child_complete",
                name: "attempt_completion",
                arguments: { result: completion },
                expectedRequestIncludes: [firstReasoning, secondReasoning, "# Context Window Usage"],
            },
        )

        await sendTask(sidebar, "Run the append-only subagent context verification.")
        const approveButton = sidebar.getByText("Approve", { exact: true })
        await expect(approveButton).toBeVisible({ timeout: 60_000 })
        await approveButton.click()
        await expect(sidebar.getByText(completion, { exact: false }).last()).toBeVisible({ timeout: 60_000 })

        await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(2)
        await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(3)

        const childConsumptions = server.getMockConsumptions("openai-compatible-responses")
        expect(childConsumptions).toHaveLength(3)
        expect(childConsumptions.every(({ contractError }) => contractError === undefined)).toBe(true)

        const firstInput = responsesInput(childConsumptions[0].requestBody)
        const secondInput = responsesInput(childConsumptions[1].requestBody)
        const thirdInput = responsesInput(childConsumptions[2].requestBody)

        expect(secondInput.length).toBeGreaterThan(firstInput.length)
        expect(secondInput.slice(0, firstInput.length)).toEqual(firstInput)
        expect(thirdInput.length).toBeGreaterThan(secondInput.length)
        expect(thirdInput.slice(0, secondInput.length)).toEqual(secondInput)

        expectReasoningSummary(secondInput, firstReasoning)
        expectReasoningSummary(thirdInput, firstReasoning)
        expectReasoningSummary(thirdInput, secondReasoning)
        expect(encryptedReasoningCount(secondInput)).toBe(1)
        expect(encryptedReasoningCount(thirdInput)).toBe(2)

        const parentConsumptions = server.getMockConsumptions("openai-compatible-chat")
        expect(parentConsumptions).toHaveLength(2)
        expect(parentConsumptions.every(({ contractError }) => contractError === undefined)).toBe(true)
    },
)
