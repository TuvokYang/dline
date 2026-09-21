import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it, vi } from "vitest"
import { MAX_AUTO_RETRY_ATTEMPTS } from "../auto-retry"
import { Task } from "../index"

/**
 * Minimal message-state double that records the updates the presentation
 * helpers apply, so the assertions describe visible chat state instead of
 * mocked call counts.
 */
function createMessageState(clineMessages: ClineMessage[]) {
	return {
		clineMessages,
		removeMessagesByTs: vi.fn(async (tsList: number[]) => {
			for (const ts of tsList) {
				const index = clineMessages.findIndex((message) => message.ts === ts)
				if (index !== -1) clineMessages.splice(index, 1)
			}
		}),
		updateClineMessage: vi.fn(async (index: number, updates: Partial<ClineMessage>) => {
			clineMessages[index] = { ...clineMessages[index], ...updates }
		}),
		flushMessageUpdate: vi.fn(async () => undefined),
	}
}

function retryCard(ts: number, attempt: number): ClineMessage {
	return {
		ts,
		type: "say",
		say: "error_retry",
		text: JSON.stringify({ attempt, maxAttempts: MAX_AUTO_RETRY_ATTEMPTS, delaySeconds: 3, errorMessage: "boom" }),
	}
}

describe("Task API failure presentation", () => {
	it("keeps one live retry card for the whole automatic sequence", async () => {
		const clineMessages: ClineMessage[] = [{ ts: 100, type: "say", say: "api_req_started", text: "{}" }, retryCard(101, 1)]
		const messageStateHandler = createMessageState(clineMessages)
		const say = vi.fn(async (_type: string, text: string) => {
			clineMessages.push({ ts: 200, type: "say", say: "error_retry", text })
			return 200
		})
		const task = Object.assign(Object.create(Task.prototype), { messageStateHandler, say }) as Task

		await (
			task as unknown as {
				sayAutoRetryStatus(status: { attempt: number; delay: number; errorMessage: string }): Promise<void>
			}
		).sayAutoRetryStatus({ attempt: 2, delay: 5_000, errorMessage: "boom" })

		const retryCards = clineMessages.filter((message) => message.say === "error_retry")
		expect(retryCards).toHaveLength(1)
		expect(JSON.parse(retryCards[0].text ?? "{}")).toMatchObject({
			attempt: 2,
			maxAttempts: MAX_AUTO_RETRY_ATTEMPTS,
			delaySeconds: 5,
		})
	})

	it("retires the superseded failure card and request failure details when a retry is accepted", async () => {
		const clineMessages: ClineMessage[] = [
			{
				ts: 100,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					request: "prompt",
					cancelReason: "streaming_failed",
					streamingFailedMessage: '{"message":"Service temporarily unavailable"}',
					retryStatus: { attempt: 1, maxAttempts: 2, delaySec: 3 },
				}),
			},
			retryCard(101, MAX_AUTO_RETRY_ATTEMPTS),
		]
		const messageStateHandler = createMessageState(clineMessages)
		const task = Object.assign(Object.create(Task.prototype), { messageStateHandler }) as Task

		await (
			task as unknown as { clearSupersededApiFailurePresentation(): Promise<void> }
		).clearSupersededApiFailurePresentation()

		expect(clineMessages.some((message) => message.say === "error_retry")).toBe(false)
		const requestInfo = JSON.parse(clineMessages[0].text ?? "{}")
		expect(requestInfo).toEqual({ request: "prompt" })
	})

	it("preserves a request outcome that the retry does not supersede", async () => {
		const clineMessages: ClineMessage[] = [
			{
				ts: 100,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ request: "prompt", cancelReason: "user_cancelled" }),
			},
		]
		const messageStateHandler = createMessageState(clineMessages)
		const task = Object.assign(Object.create(Task.prototype), { messageStateHandler }) as Task

		await (
			task as unknown as { clearSupersededApiFailurePresentation(): Promise<void> }
		).clearSupersededApiFailurePresentation()

		expect(messageStateHandler.updateClineMessage).not.toHaveBeenCalled()
		expect(JSON.parse(clineMessages[0].text ?? "{}")).toEqual({ request: "prompt", cancelReason: "user_cancelled" })
	})
})
