import type { ClineMessage, TaskViewState } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import {
	findGroupedMessageByTs,
	groupLowStakesTools,
	groupMessages,
	isToolGroup,
	resolveApiErrorMessage,
	resolveMessageRowExpanded,
	toggleMessageRowExpansion,
} from "./messageUtils"

const createTextMessage = (ts: number, text: string): ClineMessage => ({
	type: "say",
	say: "text",
	text,
	ts,
})

const createToolMessage = (ts: number, tool: string): ClineMessage => ({
	type: "say",
	say: "tool",
	text: JSON.stringify({ tool, path: "src/file.ts" }),
	ts,
})

const createReasoningMessage = (ts: number, text: string): ClineMessage => ({
	type: "say",
	say: "reasoning",
	text,
	ts,
})

/**
 * Create an error-recovery task UI state for message resolution tests.
 */
const createErrorTaskViewState = (): TaskViewState => ({
	taskId: "task-1",
	phase: "paused",
	stateRevision: 2,
	activeInteraction: {
		taskId: "task-1",
		turnId: "turn-1",
		interactionId: "interaction-1",
		kind: "error_retry",
		status: "awaiting",
		stateRevision: 2,
		taskAsk: "api_req_failed",
		presentationKind: "api_req_failed",
		askMessageTs: 2,
	},
	input: { enabled: false, acceptsText: false, acceptsImages: false, acceptsFiles: false },
	footer: { actions: [] },
})

describe("resolveApiErrorMessage", () => {
	it("uses the projected error interaction with the current presentation message", () => {
		const resolved = resolveApiErrorMessage({
			isLast: true,
			lastModifiedMessage: { type: "ask", ask: "api_req_failed", text: "API request failed", ts: 2 },
			taskViewState: createErrorTaskViewState(),
		})

		expect(resolved).toBe("API request failed")
	})

	it("does not attach the projected error interaction to an earlier request row", () => {
		const resolved = resolveApiErrorMessage({
			isLast: false,
			lastModifiedMessage: { type: "ask", ask: "api_req_failed", text: "API request failed", ts: 2 },
			taskViewState: createErrorTaskViewState(),
		})

		expect(resolved).toBeUndefined()
	})

	it("does not attach a projected error before its presentation message is synchronized", () => {
		const resolved = resolveApiErrorMessage({
			isLast: true,
			lastModifiedMessage: { type: "ask", ask: "api_req_failed", text: "Previous API error", ts: 1 },
			taskViewState: createErrorTaskViewState(),
		})

		expect(resolved).toBeUndefined()
	})

	it("clears both persisted API error carriers when canonical Task state has recovered", () => {
		const recoveredView: TaskViewState = {
			taskId: "task-1",
			phase: "between_turns",
			stateRevision: 3,
			input: { enabled: true, acceptsText: true, acceptsImages: true, acceptsFiles: true, enterAction: "reply" },
			footer: { actions: [] },
		}
		const resolved = resolveApiErrorMessage({
			isLast: true,
			lastModifiedMessage: { type: "ask", ask: "api_req_failed", text: "Profile not valid", ts: 2 },
			streamingFailedMessage: "Profile not valid",
			taskViewState: recoveredView,
		})

		expect(resolved).toBeUndefined()
	})

	it("keeps a streaming failure that is not owned by an api_req_failed interaction", () => {
		const resolved = resolveApiErrorMessage({
			isLast: true,
			lastModifiedMessage: { type: "say", say: "text", text: "Partial response", ts: 2 },
			streamingFailedMessage: "Connection interrupted",
			taskViewState: {
				taskId: "task-1",
				phase: "paused",
				stateRevision: 3,
				input: { enabled: true, acceptsText: true, acceptsImages: true, acceptsFiles: true, enterAction: "reply" },
				footer: { actions: [] },
			},
		})

		expect(resolved).toBe("Connection interrupted")
	})

	it("keeps legacy api_req_failed message when snapshot-first message is unavailable", () => {
		const resolved = resolveApiErrorMessage({
			isLast: true,
			lastModifiedMessage: { type: "ask", ask: "api_req_failed", text: "Legacy API error", ts: 1 },
		})

		expect(resolved).toBe("Legacy API error")
	})

	it("does not show stale legacy api_req_failed message on non-last rows", () => {
		const resolved = resolveApiErrorMessage({
			isLast: false,
			lastModifiedMessage: { type: "ask", ask: "api_req_failed", text: "Legacy API error", ts: 1 },
		})

		expect(resolved).toBeUndefined()
	})
})

describe("image generation row expansion", () => {
	const imageMessage: ClineMessage = {
		ts: 42,
		type: "say",
		say: "tool",
		text: JSON.stringify({
			tool: "generateImage",
			imageGeneration: {
				schemaVersion: 1,
				status: "completed",
				requestId: "request-1",
				prompt: "A blue owl",
				count: 1,
			},
		}),
	}

	it("defaults image rows to expanded and toggles from the effective state", () => {
		expect(resolveMessageRowExpanded(imageMessage, {})).toBe(true)
		const collapsed = toggleMessageRowExpansion(imageMessage, {})
		expect(collapsed).toEqual({ 42: false })
		expect(resolveMessageRowExpanded(imageMessage, collapsed)).toBe(false)
		expect(toggleMessageRowExpansion(imageMessage, collapsed)).toEqual({ 42: true })
	})

	it("keeps ordinary rows collapsed by default", () => {
		expect(resolveMessageRowExpanded(createTextMessage(7, "answer"), {})).toBe(false)
	})
})

describe("groupMessages", () => {
	it("finds expandable conversation messages nested in a browser-session row", () => {
		const reasoning = createReasoningMessage(3, "Browser reasoning")
		const grouped = groupMessages([
			{ ts: 1, type: "say", say: "browser_action_launch", text: "https://one.example" },
			{ ts: 2, type: "say", say: "browser_action_result", text: JSON.stringify({ currentUrl: "https://one.example" }) },
			reasoning,
		])

		expect(findGroupedMessageByTs(grouped, reasoning.ts)).toEqual({ groupIndex: 0, message: reasoning })
		expect(findGroupedMessageByTs(grouped, 999)).toBeUndefined()
	})

	it("keeps consecutive browser sessions in separate virtual rows", () => {
		const grouped = groupMessages([
			{ ts: 1, type: "say", say: "browser_action_launch", text: "https://one.example" },
			{ ts: 2, type: "say", say: "browser_action_result", text: JSON.stringify({ currentUrl: "https://one.example" }) },
			createReasoningMessage(3, "First session reasoning"),
			{ ts: 4, type: "say", say: "browser_action_launch", text: "https://two.example" },
			{ ts: 5, type: "say", say: "browser_action_result", text: JSON.stringify({ currentUrl: "https://two.example" }) },
		])

		expect(grouped).toHaveLength(2)
		expect(grouped.every(Array.isArray)).toBe(true)
		expect((grouped[0] as ClineMessage[]).map((message) => message.ts)).toEqual([1, 2, 3])
		expect((grouped[1] as ClineMessage[]).map((message) => message.ts)).toEqual([4, 5])
	})
})

describe("groupLowStakesTools", () => {
	it("ignores text that arrives after a low-stakes tool group has started", () => {
		const grouped = groupLowStakesTools([
			createTextMessage(1, "Initial text"),
			createToolMessage(2, "readFile"),
			createTextMessage(3, "Late text that should be ignored"),
		])

		expect(grouped).toHaveLength(2)
		expect(grouped[0]).toMatchObject({ type: "say", say: "text", text: "Initial text" })
		expect(isToolGroup(grouped[1])).toBe(true)

		if (isToolGroup(grouped[1])) {
			expect(grouped[1].every((message) => message.say !== "text")).toBe(true)
		}
	})

	it("keeps text when no low-stakes tool group is active", () => {
		const grouped = groupLowStakesTools([
			createTextMessage(1, "Initial text"),
			createToolMessage(2, "editedExistingFile"),
			createTextMessage(3, "Follow-up text"),
		])

		expect(grouped).toHaveLength(3)
		expect(grouped[0]).toMatchObject({ type: "say", say: "text", text: "Initial text" })
		expect(grouped[1]).toMatchObject({ type: "say", say: "tool" })
		expect(grouped[2]).toMatchObject({ type: "say", say: "text", text: "Follow-up text" })
	})

	it("keeps standalone reasoning when no low-stakes tool group follows", () => {
		const grouped = groupLowStakesTools([
			createReasoningMessage(1, "Thinking through options"),
			createTextMessage(2, "Answer text"),
		])

		expect(grouped).toHaveLength(2)
		expect(grouped[0]).toMatchObject({ type: "say", say: "reasoning", text: "Thinking through options" })
		expect(grouped[1]).toMatchObject({ type: "say", say: "text", text: "Answer text" })
	})

	it("keeps standalone reasoning before a non-low-stakes tool", () => {
		const grouped = groupLowStakesTools([
			createReasoningMessage(1, "Thinking through options"),
			createToolMessage(2, "editedExistingFile"),
		])

		expect(grouped).toHaveLength(2)
		expect(grouped[0]).toMatchObject({ type: "say", say: "reasoning", text: "Thinking through options" })
		expect(grouped[1]).toMatchObject({ type: "say", say: "tool" })
	})

	it("keeps reasoning visible when low-stakes tool group starts immediately after", () => {
		const grouped = groupLowStakesTools([createReasoningMessage(1, "Planning next read"), createToolMessage(2, "readFile")])

		expect(grouped).toHaveLength(2)
		expect(grouped[0]).toMatchObject({ type: "say", say: "reasoning", text: "Planning next read" })
		expect(isToolGroup(grouped[1])).toBe(true)
	})
})
