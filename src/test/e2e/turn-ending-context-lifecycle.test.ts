import { readdir, readFile } from "node:fs/promises"
import * as path from "node:path"
import { expect, type Frame } from "@playwright/test"
import type { ClineApiServerMock } from "./fixtures/server"
import { E2E_PROFILE_NAMES } from "./utils/api-profile"
import { E2ETestHelper, e2e } from "./utils/helpers"

interface StoredTurnEndingSnapshot {
	phase?: string
	completion?: { completionId?: string }
	interaction?: {
		taskId?: string
		turnId?: string
		interactionId?: string
		kind?: string
		status?: string
	}
	anchor?: {
		turnId?: string
		interactionId?: string
	}
	turn?: {
		turnId?: string
		blocks?: Array<{
			dlineTid?: string
			phase?: string
			toolName?: string
		}>
	}
}

interface TurnEndingSnapshotState {
	phase?: string
	completionId?: string
	interactionId?: string
	interactionKind?: string
	interactionStatus?: string
	interactionTurnId?: string
	anchorInteractionId?: string
	anchorTurnId?: string
	turnId?: string
	blockId?: string
	blockPhase?: string
}

interface ContextWindowVisualState {
	contextWindow: number
	minorFactor: number
	phase?: string
	totalTokens: number
	segmentKinds: string[]
}

const CONTEXT_TOTAL = 630_100
const CONTEXT_WINDOW = 1_000_000
const CONTEXT_SEGMENTS = ["durable", "active", "staged", "environment"]

async function selectProfile(sidebar: Frame, profileName: string): Promise<void> {
	const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
	if ((await modelSwitcher.innerText()).trim() === profileName) return
	await modelSwitcher.click()
	await expect(sidebar.getByText("Available Models", { exact: true })).toBeVisible()
	const profileOption = sidebar.getByRole("option").filter({ has: sidebar.getByText(profileName, { exact: true }) })
	await expect(profileOption).toHaveCount(1)
	await profileOption.click()
	await expect(modelSwitcher).toHaveText(profileName)
}

async function submitText(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled({ timeout: 30_000 })
	await input.fill(text)
	await input.press("Enter")
	await expect(input).toHaveValue("")
	await expectSingleUserFeedback(sidebar, text)
}

async function expectSingleUserFeedback(sidebar: Frame, text: string): Promise<void> {
	const feedback = sidebar.getByTestId(/^(?:user|queued)-input-markdown-scroll$/).filter({ hasText: text })
	await expect(feedback).toHaveCount(1)
	await expect(feedback).toHaveText(text)
}

async function onlyTaskId(dlineDocsDir: string): Promise<string> {
	return E2ETestHelper.waitForValue(async () => {
		try {
			const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true })
			const taskIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
			return taskIds.length === 1 ? taskIds[0] : undefined
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
			throw error
		}
	}, 30_000)
}

async function readSnapshot(dlineDocsDir: string, taskId: string): Promise<StoredTurnEndingSnapshot> {
	return JSON.parse(await readFile(path.join(dlineDocsDir, "tasks", taskId, "snapshot.json"), "utf8"))
}

function snapshotState(snapshot: StoredTurnEndingSnapshot, toolName: string): TurnEndingSnapshotState {
	const block = snapshot.turn?.blocks?.find((candidate) => candidate.toolName === toolName)
	return {
		phase: snapshot.phase,
		completionId: snapshot.completion?.completionId,
		interactionId: snapshot.interaction?.interactionId,
		interactionKind: snapshot.interaction?.kind,
		interactionStatus: snapshot.interaction?.status,
		interactionTurnId: snapshot.interaction?.turnId,
		anchorInteractionId: snapshot.anchor?.interactionId,
		anchorTurnId: snapshot.anchor?.turnId,
		turnId: snapshot.turn?.turnId,
		blockId: block?.dlineTid,
		blockPhase: block?.phase,
	}
}

async function readContextWindowVisual(sidebar: Frame): Promise<ContextWindowVisualState> {
	return sidebar.getByTestId("context-window-segmented-progress").evaluate((progress) => {
		const element = progress as HTMLElement
		const segments = Array.from(element.querySelectorAll<HTMLElement>("[data-segment]"))
		return {
			contextWindow: Number(element.dataset.contextWindow ?? 0),
			minorFactor: Number(element.dataset.minorFactor ?? 1),
			phase: element.dataset.phase,
			totalTokens: segments.reduce((total, segment) => total + Number(segment.dataset.authoritativeTokens ?? 0), 0),
			segmentKinds: segments.map((segment) => segment.dataset.segment ?? ""),
		}
	})
}

async function expandTaskHeader(sidebar: Frame): Promise<void> {
	const expand = sidebar.getByLabel("Expand task header")
	if (await expand.isVisible()) await expand.click()
	await expect(sidebar.getByTestId("context-window-indicator")).toBeVisible({ timeout: 60_000 })
}

async function expectWaitingInteraction(input: {
	dlineDocsDir: string
	expectedKind: string
	sidebar: Frame
	taskId: string
	toolName: string
}): Promise<TurnEndingSnapshotState> {
	await expect
		.poll(async () => snapshotState(await readSnapshot(input.dlineDocsDir, input.taskId), input.toolName), {
			timeout: 30_000,
		})
		.toMatchObject({
			phase: "executing",
			interactionKind: input.expectedKind,
			interactionStatus: "awaiting",
			blockPhase: "auto_executing",
		})

	const state = snapshotState(await readSnapshot(input.dlineDocsDir, input.taskId), input.toolName)
	expect(state.interactionId).toBeTruthy()
	expect(state.interactionId).toBe(state.anchorInteractionId)
	expect(state.interactionId).toBe(state.blockId)
	expect(state.interactionTurnId).toBe(state.anchorTurnId)
	expect(state.interactionTurnId).toBe(state.turnId)

	const progress = input.sidebar.getByTestId("context-window-segmented-progress")
	await expect(progress).toHaveAttribute("data-phase", "receiving", { timeout: 30_000 })
	await expect(progress).toHaveAttribute("aria-valuenow", String(CONTEXT_TOTAL))
	await expect(progress).toHaveAttribute("aria-valuemax", String(CONTEXT_WINDOW))
	await expect(progress).toHaveAttribute("aria-valuetext", `${CONTEXT_TOTAL} of ${CONTEXT_WINDOW} tokens; phase receiving`)
	const visual = await readContextWindowVisual(input.sidebar)
	expect(visual).toMatchObject({
		contextWindow: CONTEXT_WINDOW,
		phase: "receiving",
		segmentKinds: CONTEXT_SEGMENTS,
		totalTokens: CONTEXT_TOTAL,
	})
	expect(visual.minorFactor).toBeGreaterThanOrEqual(1)
	expect(visual.minorFactor).toBeLessThanOrEqual(3)
	return state
}

async function expectStreamingContinuation(input: {
	anchorInteractionId: string | undefined
	dlineDocsDir: string
	previousInteractionId?: string
	requestCount: number
	server: ClineApiServerMock
	sidebar: Frame
	taskId: string
	toolName: string
}): Promise<void> {
	await expect.poll(() => input.server.getRequestCount("deepseek-chat"), { timeout: 30_000 }).toBe(input.requestCount)
	await expect
		.poll(async () => snapshotState(await readSnapshot(input.dlineDocsDir, input.taskId), input.toolName), {
			timeout: 4_000,
		})
		.toMatchObject({
			phase: "streaming",
			interactionId: undefined,
			interactionKind: undefined,
			interactionStatus: undefined,
			anchorInteractionId: input.anchorInteractionId,
			blockId: input.previousInteractionId,
			blockPhase: "completed",
		})

	const progress = input.sidebar.getByTestId("context-window-segmented-progress")
	await expect(progress).toHaveAttribute("data-phase", "sending", { timeout: 4_000 })
	const visual = await readContextWindowVisual(input.sidebar)
	expect(visual.phase).toBe("sending")
	expect(visual.contextWindow).toBe(CONTEXT_WINDOW)
	expect(visual.segmentKinds).toEqual(CONTEXT_SEGMENTS)
	expect(visual.minorFactor).toBeGreaterThanOrEqual(1)
	expect(visual.minorFactor).toBeLessThanOrEqual(3)
	expect(visual.totalTokens).toBeGreaterThan(600_000)
	expect(visual.totalTokens).toBeLessThan(CONTEXT_WINDOW)
}

async function expectCompleted(input: {
	dlineDocsDir: string
	sidebar: Frame
	taskId: string
}): Promise<TurnEndingSnapshotState> {
	await expect
		.poll(async () => snapshotState(await readSnapshot(input.dlineDocsDir, input.taskId), "attempt_completion"), {
			timeout: 30_000,
		})
		.toMatchObject({
			phase: "completed",
			interactionKind: "completion",
			interactionStatus: "awaiting",
		})

	const state = snapshotState(await readSnapshot(input.dlineDocsDir, input.taskId), "attempt_completion")
	expect(state.interactionId).toBeTruthy()
	expect(state.completionId).toBe(state.interactionId)
	expect(state.anchorInteractionId).toBe(state.interactionId)
	expect(state.blockId).toBe(state.interactionId)
	expect(state.interactionTurnId).toBe(state.anchorTurnId)
	expect(state.interactionTurnId).toBe(state.turnId)

	const progress = input.sidebar.getByTestId("context-window-segmented-progress")
	await expect(progress).toHaveAttribute("data-phase", "stable", { timeout: 30_000 })
	await expect(progress).toHaveAttribute("aria-valuenow", String(CONTEXT_TOTAL))
	await expect(progress).toHaveAttribute("aria-valuetext", `${CONTEXT_TOTAL} of ${CONTEXT_WINDOW} tokens; phase stable`)
	const visual = await readContextWindowVisual(input.sidebar)
	expect(visual).toMatchObject({
		contextWindow: CONTEXT_WINDOW,
		phase: "stable",
		segmentKinds: CONTEXT_SEGMENTS,
		totalTokens: CONTEXT_TOTAL,
	})
	expect(visual.minorFactor).toBeGreaterThanOrEqual(1)
	expect(visual.minorFactor).toBeLessThanOrEqual(3)
	return state
}

async function expectVisible(sidebar: Frame, text: string): Promise<void> {
	await expect(sidebar.getByText(text, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
}

e2e(
	"Context indicator - every turn-ending tool preserves authoritative usage until ordered completion",
	async ({ dlineDocsDir, helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(300_000)
		await helper.signin(sidebar)
		await selectProfile(sidebar, E2E_PROFILE_NAMES.mockDeepSeek)
		server.resetOpenAiMock()

		server.enqueueResponses(
			"deepseek-chat",
			{
				type: "tool",
				id: "call_turn_end_plan",
				name: "make_plan",
				arguments: { response: "E2E_TURN_END_PLAN", needs_more_exploration: false },
				usage: { inputTokens: 630_000, outputTokens: 100 },
			},
			{
				type: "tool",
				id: "call_turn_end_followup",
				name: "ask_followup_question",
				arguments: {
					question: "E2E_TURN_END_FOLLOWUP",
					options: ["E2E_TURN_END_OPTION_A", "E2E_TURN_END_OPTION_B"],
				},
				usage: { inputTokens: 630_000, outputTokens: 100 },
				delayMs: 5_000,
				expectedRequestIncludes: ["E2E_TURN_END_PLAN_FEEDBACK"],
			},
			{
				type: "tool",
				id: "call_turn_end_report",
				name: "generate_report",
				arguments: { title: "E2E_TURN_END_REPORT", content: "E2E_TURN_END_REPORT_CONTENT" },
				usage: { inputTokens: 630_000, outputTokens: 100 },
				delayMs: 5_000,
				expectedRequestIncludes: ["E2E_TURN_END_OPTION_B"],
			},
			{
				type: "tool",
				id: "call_turn_end_qna",
				name: "qna_respond",
				arguments: { response: "E2E_TURN_END_QNA" },
				usage: { inputTokens: 630_000, outputTokens: 100 },
				delayMs: 5_000,
				expectedRequestIncludes: ["E2E_TURN_END_REPORT_FEEDBACK"],
			},
			{
				type: "tool",
				id: "call_turn_end_completion_first",
				name: "attempt_completion",
				arguments: { result: "E2E_TURN_END_COMPLETION_FIRST" },
				usage: { inputTokens: 630_000, outputTokens: 100 },
				delayMs: 5_000,
				expectedRequestIncludes: ["E2E_TURN_END_QNA_FEEDBACK"],
			},
			{
				type: "tool",
				id: "call_turn_end_completion_second",
				name: "attempt_completion",
				arguments: { result: "E2E_TURN_END_COMPLETION_SECOND" },
				usage: { inputTokens: 630_000, outputTokens: 100 },
				delayMs: 5_000,
				expectedRequestIncludes: ["E2E_TURN_END_COMPLETION_FEEDBACK"],
			},
		)

		await submitText(sidebar, "E2E_TURN_END_CONTEXT_TASK")
		await expectVisible(sidebar, "E2E_TURN_END_PLAN")
		await expandTaskHeader(sidebar)
		const taskId = await onlyTaskId(dlineDocsDir)

		const plan = await expectWaitingInteraction({
			dlineDocsDir,
			expectedKind: "make_plan",
			sidebar,
			taskId,
			toolName: "make_plan",
		})
		await submitText(sidebar, "E2E_TURN_END_PLAN_FEEDBACK")
		await expectStreamingContinuation({
			anchorInteractionId: plan.interactionId,
			dlineDocsDir,
			previousInteractionId: plan.interactionId,
			requestCount: 2,
			server,
			sidebar,
			taskId,
			toolName: "make_plan",
		})

		await expectVisible(sidebar, "E2E_TURN_END_FOLLOWUP")
		const followup = await expectWaitingInteraction({
			dlineDocsDir,
			expectedKind: "followup",
			sidebar,
			taskId,
			toolName: "ask_followup_question",
		})
		await sidebar.getByRole("button", { name: "E2E_TURN_END_OPTION_B", exact: true }).click()
		await expectSingleUserFeedback(sidebar, "E2E_TURN_END_OPTION_B")
		await expectStreamingContinuation({
			anchorInteractionId: followup.interactionId,
			dlineDocsDir,
			previousInteractionId: followup.interactionId,
			requestCount: 3,
			server,
			sidebar,
			taskId,
			toolName: "ask_followup_question",
		})

		await expectVisible(sidebar, "E2E_TURN_END_REPORT")
		await expectVisible(sidebar, "E2E_TURN_END_REPORT_CONTENT")
		const report = await expectWaitingInteraction({
			dlineDocsDir,
			expectedKind: "generate_report",
			sidebar,
			taskId,
			toolName: "generate_report",
		})
		await submitText(sidebar, "E2E_TURN_END_REPORT_FEEDBACK")
		await expectStreamingContinuation({
			anchorInteractionId: report.interactionId,
			dlineDocsDir,
			previousInteractionId: report.interactionId,
			requestCount: 4,
			server,
			sidebar,
			taskId,
			toolName: "generate_report",
		})

		await expectVisible(sidebar, "E2E_TURN_END_QNA")
		const qna = await expectWaitingInteraction({
			dlineDocsDir,
			expectedKind: "qna_response",
			sidebar,
			taskId,
			toolName: "qna_respond",
		})
		await submitText(sidebar, "E2E_TURN_END_QNA_FEEDBACK")
		await expectStreamingContinuation({
			anchorInteractionId: qna.interactionId,
			dlineDocsDir,
			previousInteractionId: qna.interactionId,
			requestCount: 5,
			server,
			sidebar,
			taskId,
			toolName: "qna_respond",
		})

		await expectVisible(sidebar, "E2E_TURN_END_COMPLETION_FIRST")
		const firstCompletion = await expectCompleted({ dlineDocsDir, sidebar, taskId })
		await submitText(sidebar, "E2E_TURN_END_COMPLETION_FEEDBACK")
		await expectStreamingContinuation({
			anchorInteractionId: undefined,
			dlineDocsDir,
			previousInteractionId: firstCompletion.interactionId,
			requestCount: 6,
			server,
			sidebar,
			taskId,
			toolName: "attempt_completion",
		})

		await expectVisible(sidebar, "E2E_TURN_END_COMPLETION_SECOND")
		const secondCompletion = await expectCompleted({ dlineDocsDir, sidebar, taskId })
		expect(secondCompletion.interactionId).not.toBe(firstCompletion.interactionId)

		const consumptions = server.getMockConsumptions("deepseek-chat")
		expect(consumptions).toHaveLength(6)
		expect(consumptions.map((entry) => entry.toolName)).toEqual([
			"make_plan",
			"ask_followup_question",
			"generate_report",
			"qna_respond",
			"attempt_completion",
			"attempt_completion",
		])
		expect(consumptions.every((entry) => entry.contractError === undefined)).toBe(true)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)
