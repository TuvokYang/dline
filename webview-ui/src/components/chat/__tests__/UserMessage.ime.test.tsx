/**
 * UserMessage – IME composition Enter test
 * --------------------------------------------------
 * Confirm that sendMessageFromChatRow is not called
 * even if you confirm the IME conversion (Enter) in message re-edit mode.
 */

import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const mockedContext = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
const usageServiceMocks = vi.hoisted(() => ({
	consumeAccountUsageResetCredit: vi.fn(),
	getProviderUsage: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	__esModule: true,
	useExtensionState: () => mockedContext.value,
}))
vi.mock("@/services/grpc-client", () => ({
	AccountServiceClient: usageServiceMocks,
}))

class TestResizeObserver implements ResizeObserver {
	disconnect = vi.fn()
	observe = vi.fn()
	unobserve = vi.fn()
}

beforeAll(() => {
	globalThis.ResizeObserver = TestResizeObserver
	Object.defineProperties(HTMLElement.prototype, {
		hasPointerCapture: { configurable: true, value: () => false },
		releasePointerCapture: { configurable: true, value: () => undefined },
		setPointerCapture: { configurable: true, value: () => undefined },
	})
})

import { useChatState } from "../chat-view/hooks/useChatState"
import { runNewTaskSubmission } from "../chat-view/hooks/useMessageHandlers"
import { UsageBar } from "../UsageBar"
import UserMessage from "../UserMessage"

describe("UserMessage – IME composition handling", () => {
	it("does NOT send when IME composition Enter is pressed while editing", () => {
		const sendMessageFromChatRow = vi.fn()

		const { getByText } = render(
			<UserMessage images={[]} messageTs={Date.now()} sendMessageFromChatRow={sendMessageFromChatRow} text="変換テスト" />,
		)

		const editable = getByText("変換テスト") as HTMLElement
		editable.setAttribute("contenteditable", "true")
		editable.focus()

		fireEvent.compositionStart(editable)
		fireEvent.keyDown(editable, {
			key: "Enter",
			keyCode: 13,
			nativeEvent: { isComposing: true },
		})
		fireEvent.compositionEnd(editable)

		expect(sendMessageFromChatRow).not.toHaveBeenCalled()
	})
})

describe("UsageBar", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		usageServiceMocks.consumeAccountUsageResetCredit.mockResolvedValue({
			profileId: "profile-a",
			outcome: "reset",
			quotaTypesReset: ["primary"],
			usage: undefined,
		})
	})

	it("renders one neutral trigger for the controlling quota", () => {
		mockedContext.value = {
			accountUsage: {
				profileId: "profile-a",
				providerId: "openai-codex",
				currency: "",
				// Codex supplies its own compact labels; the bar no longer derives them.
				quotas: [
					{ type: "5hour", label: "5 hour", shortLabel: "5h", used: 0, limit: 100 },
					{ type: "weekly", label: "7 day", shortLabel: "7d", used: 22, limit: 100 },
				],
				resetCreditsAvailableCount: 1,
				resetCredits: [{ id: "credit-a", expiresAt: "2030-03-25T00:00:00.000Z" }],
			},
		}

		const { container } = render(<UsageBar />)
		const trigger = screen.getByRole("button", { name: "Provider usage" })

		expect(trigger).toHaveTextContent("7d: 78%")
		expect(trigger).toHaveClass("text-foreground")
		expect(trigger).not.toHaveClass("text-success", "text-editor-warning-foreground", "text-error")
		expect(trigger.querySelector("svg")).toBeNull()
		expect(container.querySelectorAll('[data-chat-input-slot="provider-usage"]')).toHaveLength(1)
		expect(container.querySelector('[data-chat-input-slot="codex-usage"]')).toBeNull()
	})

	it("shows the five-hour quota when it is controlling", () => {
		mockedContext.value = {
			accountUsage: {
				profileId: "profile-a",
				providerId: "openai-codex",
				currency: "",
				quotas: [
					{ type: "5hour", label: "5 hour", shortLabel: "5h", used: 95, limit: 100 },
					{ type: "weekly", label: "7 day", shortLabel: "7d", used: 83, limit: 100 },
				],
			},
		}

		render(<UsageBar />)
		expect(screen.getByRole("button", { name: "Provider usage" })).toHaveTextContent("5h: 5%")
	})

	it("uses the shared tooltip, details renderer, and reset-credit action", async () => {
		const user = userEvent.setup()
		mockedContext.value = {
			accountUsage: {
				profileId: "profile-a",
				providerId: "openai-codex",
				currency: "",
				planType: "plus",
				quotas: [
					{ type: "5hour", label: "5 hour", used: 20, limit: 100, windowSeconds: 18_000 },
					{ type: "weekly", label: "7 day", used: 83, limit: 100, windowSeconds: 604_800 },
				],
				resetCreditsAvailableCount: 1,
				resetCredits: [{ id: "credit-a", expiresAt: "2030-03-25T00:00:00.000Z" }],
			},
		}
		render(<UsageBar />)
		const trigger = screen.getByRole("button", { name: "Provider usage" })

		await user.hover(trigger)
		expect((await screen.findAllByText("80% remaining")).length).toBeGreaterThan(0)
		expect(screen.getAllByText("17% remaining").length).toBeGreaterThan(0)
		expect(screen.getAllByText("Reset cards: 1").length).toBeGreaterThan(0)

		await user.click(trigger)
		expect(screen.getByLabelText("Provider usage details")).toBeInTheDocument()
		expect(screen.getByRole("progressbar", { name: "7 day usage" })).toHaveAttribute("data-usage-tone", "caution")
		await user.click(screen.getByRole("button", { name: "Use reset card 1" }))
		expect(screen.getByRole("dialog", { name: "Use a rate-limit reset card?" })).toBeInTheDocument()
		await user.click(screen.getByRole("button", { name: "Use reset card" }))

		await waitFor(() =>
			expect(usageServiceMocks.consumeAccountUsageResetCredit).toHaveBeenCalledWith(
				expect.objectContaining({ profileId: "profile-a", creditId: "credit-a" }),
			),
		)
	})

	it("does not render when the active profile has no usage or balance", () => {
		mockedContext.value = {}
		const { container } = render(<UsageBar />)
		expect(container).toBeEmptyDOMElement()
		expect(screen.queryByText("--")).not.toBeInTheDocument()
	})

	it("keeps a zero balance visible", () => {
		mockedContext.value = {
			accountUsage: {
				profileId: "profile-a",
				providerId: "deepseek",
				currency: "USD",
				remainingBalance: 0,
			},
		}
		render(<UsageBar />)
		expect(screen.getByRole("button", { name: "Provider usage" })).toHaveTextContent("$0.00")
	})
})

describe("task-owned chat drafts", () => {
	it("clears a submitted welcome draft when the created task becomes active", () => {
		const { result, rerender } = renderHook(({ taskId }: { taskId: string | undefined }) => useChatState([], taskId), {
			initialProps: { taskId: undefined },
		})

		act(() => {
			result.current.setInputValue("submitted task")
			result.current.setSelectedFiles(["file.txt"])
		})
		rerender({ taskId: "task-1" })

		expect(result.current.inputValue).toBe("")
		expect(result.current.selectedFiles).toEqual([])
	})

	it("does not carry a draft from one active task into another", () => {
		const { result, rerender } = renderHook(({ taskId }: { taskId: string | undefined }) => useChatState([], taskId), {
			initialProps: { taskId: "task-1" as string | undefined },
		})

		act(() => {
			result.current.setInputValue("task one draft")
			result.current.setSelectedImages(["image.png"])
		})
		rerender({ taskId: "task-2" })

		expect(result.current.inputValue).toBe("")
		expect(result.current.selectedImages).toEqual([])
	})
})

describe("new task draft submission", () => {
	it("clears the draft before the new task request finishes", async () => {
		let finishRequest: (() => void) | undefined
		const request = new Promise<void>((resolve) => {
			finishRequest = resolve
		})
		const clearDraft = vi.fn()
		const restoreDraft = vi.fn()

		const submission = runNewTaskSubmission(() => request, clearDraft, restoreDraft)

		expect(clearDraft).toHaveBeenCalledOnce()
		expect(restoreDraft).not.toHaveBeenCalled()
		finishRequest?.()
		await submission
	})

	it("restores the draft when new task creation fails", async () => {
		const clearDraft = vi.fn()
		const restoreDraft = vi.fn()

		await expect(
			runNewTaskSubmission(() => Promise.reject(new Error("new task failed")), clearDraft, restoreDraft),
		).rejects.toThrow("new task failed")

		expect(clearDraft).toHaveBeenCalledOnce()
		expect(restoreDraft).toHaveBeenCalledOnce()
	})
})
