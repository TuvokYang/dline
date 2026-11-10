import { mkdir, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { openSubagentCard, subagentCardByTask } from "@e2e/utils/subagent-card"
import { sendTask, setAutoApproveAction } from "@e2e/utils/task-tool-fixture"
import { expect } from "@playwright/test"

e2e(
    "Tools - local subagent YAML controls its system prompt and final output token budget",
    async ({ helper, server, sidebar, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        const subagentDirectory = path.join(workspaceDir, ".agents", "subagents")
        const yamlSystemPromptMarker = "E2E_SUBAGENT_YAML_SYSTEM_PROMPT"
        // Stay above the minimum so the configured allowance is the value under test.
        const truncatedResultMarker = "...[truncated to 1,024 tokens"
        const omittedTailMarker = "E2E_SUBAGENT_BUDGET_TAIL"
        const longChildResult = `E2E_SUBAGENT_BUDGET_PREFIX_${"A".repeat(8_192)}_${omittedTailMarker}`
        await mkdir(subagentDirectory, { recursive: true })
        await writeFile(
            path.join(subagentDirectory, "e2e-output-budget.yml"),
            `---
name: e2e-output-budget
description: E2E subagent output budget
profile: ${E2E_PROFILE_NAMES.mockOpenAiResponses}
tools:
  - attempt_completion
maxOutputTokens: 1024
---

${yamlSystemPromptMarker}
Return only the highest-value findings.`,
            "utf8",
        )

        await helper.signin(sidebar)
        await setAutoApproveAction(sidebar, "Read project files", false)
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                id: "call_subagent_output_budget",
                name: "use_subagent",
                arguments: {
                    agent_name: "e2e-output-budget",
                    task: "E2E_SUBAGENT_OUTPUT_BUDGET_TASK",
                    context: "Verify the configured final response budget.",
                    timeout: 60,
                },
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_subagent_output_budget_parent_complete",
                name: "attempt_completion",
                arguments: { result: "E2E_SUBAGENT_OUTPUT_BUDGET_DONE" },
                expectedToolResults: [
                    {
                        callId: "call_subagent_output_budget",
                        contentIncludes: ["E2E_SUBAGENT_BUDGET_PREFIX_", truncatedResultMarker],
                    },
                ],
                expectedRequestExcludes: [omittedTailMarker],
                requireCompleteToolPairing: true,
            },
        )
        server.enqueueResponses("openai-compatible-responses", {
            type: "tool",
            id: "call_subagent_output_budget_child_complete",
            name: "attempt_completion",
            arguments: { result: longChildResult },
            expectedRequestIncludes: [yamlSystemPromptMarker, "E2E_SUBAGENT_OUTPUT_BUDGET_TASK"],
            requireCompleteToolPairing: true,
        })

        await sendTask(sidebar, "Run the configured output-budget subagent.")
        const approveButton = sidebar.getByText("Approve", { exact: true })
        await expect(approveButton).toBeVisible({ timeout: 60_000 })
        await approveButton.click()
        await expect(sidebar.getByText("E2E_SUBAGENT_OUTPUT_BUDGET_DONE", { exact: false }).last()).toBeVisible({
            timeout: 60_000,
        })

        await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(2)
        await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(1)
        const childRequest = server.getMockConsumptions("openai-compatible-responses")[0]
        expect(childRequest.contractError).toBeUndefined()
        const childBody = childRequest.requestBody as {
            instructions?: string
            input?: Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>
        }
        expect(childBody.instructions).toContain(yamlSystemPromptMarker)
        const userText = (childBody.input ?? [])
            .filter((message) => message.role === "user")
            .flatMap((message) => message.content ?? [])
            .filter((block) => block.type === "input_text")
            .map((block) => block.text ?? "")
            .join("\n")
        const allowances = [...userText.matchAll(/\bwithin about ([\d,]+) tokens\b/g)].map((match) =>
            Number(match[1].replaceAll(",", "")),
        )
        expect(allowances).toEqual([1_024])

        const parentContinuation = server.getMockConsumptions("openai-compatible-chat")[1]
        expect(parentContinuation.contractError).toBeUndefined()
        const results = parentContinuation.requestToolResults.filter((result) => result.callId === "call_subagent_output_budget")
        expect(results).toHaveLength(1)
        const returnedResult = results[0].content
        expect(returnedResult).toContain("E2E_SUBAGENT_BUDGET_PREFIX_")
        expect(returnedResult).toContain(truncatedResultMarker)
        expect(returnedResult).not.toContain(omittedTailMarker)
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)

e2e(
    "Tools - subagent aligns header actions, wraps context, and orders Tools before output",
    async ({ helper, server, sidebar, userDataDir }) => {
        e2e.setTimeout(180_000)
        const subagentTask = "E2E_SUBAGENT_RENDERING_TASK"
        const subagentContext = [
            "Inspect the workspace in the exact order requested.",
            "Keep this second context line hidden until the user expands it.",
            "Keep this third context line hidden as well.",
        ].join("\n")

        await helper.signin(sidebar)
        await setAutoApproveAction(sidebar, "Read project files", false)
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                id: "call_subagent_rendering",
                name: "use_subagent",
                arguments: {
                    agent_name: "default",
                    task: subagentTask,
                    context: subagentContext,
                    timeout: 60,
                },
            },
            {
                type: "tool",
                id: "call_subagent_rendering_read",
                name: "read_file",
                arguments: { path: "README.md" },
            },
            {
                type: "tool",
                id: "call_subagent_rendering_list",
                name: "list_files",
                arguments: { path: ".", recursive: false },
                expectedToolResults: [{ callId: "call_subagent_rendering_read", contentIncludes: "# Test Workspace" }],
            },
            {
                type: "tool",
                id: "call_subagent_rendering_complete",
                name: "attempt_completion",
                arguments: { result: "E2E_SUBAGENT_RENDERING_CHILD_DONE" },
                expectedToolResults: [{ callId: "call_subagent_rendering_list", contentIncludes: "README.md" }],
            },
            {
                type: "tool",
                id: "call_subagent_rendering_parent_complete",
                name: "attempt_completion",
                arguments: { result: "E2E_SUBAGENT_RENDERING_DONE" },
                expectedToolResults: [
                    { callId: "call_subagent_rendering", contentIncludes: "E2E_SUBAGENT_RENDERING_CHILD_DONE" },
                ],
            },
        )

        await sendTask(sidebar, "Ask a subagent to inspect the workspace in order.")
        const approveButton = sidebar.getByText("Approve", { exact: true })
        await expect(approveButton).toBeVisible({ timeout: 60_000 })
        await approveButton.click()
        await expect(sidebar.getByText("E2E_SUBAGENT_RENDERING_DONE", { exact: false }).last()).toBeVisible({
            timeout: 60_000,
        })

        const subagentCard = subagentCardByTask(sidebar, subagentTask)
        await expect(subagentCard).toBeVisible()
        await expect(subagentCard.getByTestId("subagent-name")).toHaveText("default")
        // A single foreground run is identified by its agent name; the "#n" index
        // only distinguishes items inside a batch.
        await expect(subagentCard).not.toContainText("subagent_1")
        const itemHeader = subagentCard.getByTestId("subagent-item-header")
        const executionMode = itemHeader.getByTestId("subagent-execution-mode")
        await expect(executionMode).toHaveText("Foreground")
        await expect(itemHeader.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0)
        await expect(subagentCard.getByRole("button", { name: "Continue in Background", exact: true })).toHaveCount(0)

        // The card opens folded to its header; its Work sections render once opened.
        await expect(subagentCard.getByTestId("subagent-item-body")).toHaveCount(0)
        await openSubagentCard(subagentCard)

        // TODO(BUGFIX-049): the Task block layout contract predates the
        // SubagentStatusRow popover rework and no longer matches the rendered DOM.
        // Redefine it against the current component before re-enabling.
        await expect(subagentCard.getByRole("heading", { name: subagentTask, exact: true })).toBeVisible()

        const context = subagentCard.getByTestId("subagent-context")
        await expect(context).toContainText("Context")
        const contextContent = context.getByTestId("subagent-context-content")
        // The row truncates to one line and reveals the full context through a
        // popover, so the trigger no longer carries a title attribute.
        await expect(contextContent).toContainText("Inspect the workspace in the exact order requested")
        await expect(contextContent).not.toHaveAttribute("title", subagentContext)
        const contextLayout = await context.evaluate((element) => {
            const style = getComputedStyle(element)
            return {
                clientHeight: element.clientHeight,
                scrollWidth: element.scrollWidth,
                clientWidth: element.clientWidth,
                overflowX: style.overflowX,
            }
        })
        expect(contextLayout.clientHeight).toBeGreaterThan(0)
        expect(contextLayout.scrollWidth).toBeLessThanOrEqual(contextLayout.clientWidth + 1)
        expect(contextLayout.overflowX).toBe("hidden")
        const contextTextLayout = await contextContent.evaluate((element) => {
            const style = getComputedStyle(element)
            return {
                overflowWrap: style.overflowWrap,
                whiteSpace: style.whiteSpace,
            }
        })
        // The trigger truncates to a single line; the wrapped, pre-formatted copy
        // lives in the popover that "Context" opens.
        expect(contextTextLayout.whiteSpace).toBe("nowrap")

        // The wrapped, pre-formatted copy lives in the popover the trigger opens.
        const showFullContext = subagentCard.getByRole("button", { name: "Show full subagent context", exact: true })
        await expect(showFullContext).toHaveCount(1)
        await showFullContext.click()
        const contextPopover = sidebar.getByTestId("subagent-context-popover-content")
        await expect(contextPopover).toBeVisible()
        await expect(contextPopover).toContainText("Keep this second context line hidden until the user expands it.")
        await expect(contextPopover).toContainText("Keep this third context line hidden as well.")
        const popoverTextLayout = await contextPopover.evaluate((element) => {
            const style = getComputedStyle(element)
            return { overflowWrap: style.overflowWrap, whiteSpace: style.whiteSpace }
        })
        expect(popoverTextLayout.whiteSpace).toBe("pre-wrap")
        expect(["anywhere", "break-word"]).toContain(popoverTextLayout.overflowWrap)
        // Close the popover so it cannot cover the sections asserted below.
        await showFullContext.click()
        await expect(contextPopover).toHaveCount(0)

        // The tools section is expanded by default and lists each executed step.
        const toolRows = subagentCard.getByTestId("subagent-tool-step")
        await expect(toolRows).toHaveCount(3)
        expect(await subagentCard.getByTestId("subagent-tool-step-name").allTextContents()).toEqual([
            "read_file",
            "list_files",
            "attempt_completion",
        ])
        expect(await toolRows.allTextContents()).toEqual([
            expect.stringContaining("README.md"),
            expect.stringContaining("list_files"),
            expect.stringContaining("attempt_completion"),
        ])
        await expect(subagentCard.getByRole("button", { name: "Collapse subagent tools", exact: true })).toHaveCount(1)
        const toolsScroll = subagentCard.getByTestId("subagent-tools-scroll")
        expect(
            await toolsScroll.evaluate((element) => {
                const style = getComputedStyle(element)
                return { overflowX: style.overflowX, overflowY: style.overflowY }
            }),
        ).toEqual({ overflowX: "hidden", overflowY: "auto" })

        // The output section stays collapsed until requested, and is ordered after Tools.
        const showOutput = subagentCard.getByRole("button", { name: "Show subagent output", exact: true })
        await expect(showOutput).toHaveCount(1)
        await expect(subagentCard.getByTestId("subagent-output")).toHaveCount(0)
        expect(
            await subagentCard.evaluate((card) => {
                const tools = card.querySelector<HTMLElement>('[aria-label="Collapse subagent tools"]')
                const toggle = card.querySelector<HTMLElement>('[aria-label="Show subagent output"]')
                if (!tools || !toggle) throw new Error("Subagent Tools or output toggle is missing")
                return Boolean(tools.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING)
            }),
        ).toBe(true)

        // The list bounds the complete subagent collection at 60vh and owns outer scrolling.
        const itemsContainer = sidebar.getByTestId("subagent-list-scroll")
        const itemsLayout = await itemsContainer.evaluate((element) => {
            const style = getComputedStyle(element)
            return {
                maxHeight: Number.parseFloat(style.maxHeight),
                overflowY: style.overflowY,
                viewportHeight: window.innerHeight,
            }
        })
        expect(itemsLayout.overflowY).toBe("auto")
        expect(itemsLayout.maxHeight).toBeCloseTo(itemsLayout.viewportHeight * 0.6, 0)
        // The card itself is height-bounded (30vh) so a long run cannot grow the chat.
        const cardLayout = await subagentCard.evaluate((element) => {
            const style = getComputedStyle(element)
            return {
                maxHeight: Number.parseFloat(style.maxHeight),
                overflowY: style.overflowY,
                viewportHeight: window.innerHeight,
            }
        })
        expect(cardLayout.overflowY).toBe("hidden")
        expect(cardLayout.maxHeight).toBeCloseTo(cardLayout.viewportHeight * 0.3, 0)

        await showOutput.click()
        const output = subagentCard.getByTestId("subagent-output")
        expect(
            await subagentCard.evaluate((card) => {
                const toggle = card.querySelector<HTMLElement>('[aria-label="Hide subagent output"]')
                const result = card.querySelector<HTMLElement>('[data-testid="subagent-output"]')
                if (!toggle || !result) throw new Error("Subagent output hierarchy is incomplete")
                return Boolean(toggle.compareDocumentPosition(result) & Node.DOCUMENT_POSITION_FOLLOWING)
            }),
        ).toBe(true)
        await expect(output).toContainText("E2E_SUBAGENT_RENDERING_CHILD_DONE")
        expect(
            await subagentCard.getByTestId("subagent-output-scroll").evaluate((element) => {
                const style = getComputedStyle(element)
                return { overflowX: style.overflowX, overflowY: style.overflowY }
            }),
        ).toEqual({ overflowX: "hidden", overflowY: "auto" })
        await subagentCard.screenshot({ path: e2e.info().outputPath("subagent-bounded-sections.png") })
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)
