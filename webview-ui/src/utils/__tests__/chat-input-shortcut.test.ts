import { type ChatInputSendShortcut, getChatInputSendShortcutLabel } from "@shared/ChatInputSendShortcut"
import { describe, expect, it } from "vitest"
import { type ChatInputKeyEvent, shouldCompleteMenuSelection, shouldSendChatInput } from "../chat-input-shortcut"

const enterEvent = (overrides: Partial<ChatInputKeyEvent> = {}): ChatInputKeyEvent => ({
	key: "Enter",
	altKey: false,
	ctrlKey: false,
	metaKey: false,
	shiftKey: false,
	...overrides,
})

describe("shouldSendChatInput", () => {
	it.each([
		["enter", enterEvent()],
		["ctrlEnter", enterEvent({ ctrlKey: true })],
		["shiftEnter", enterEvent({ shiftKey: true })],
	] satisfies Array<[ChatInputSendShortcut, ChatInputKeyEvent]>)("sends for %s", (shortcut, event) => {
		expect(shouldSendChatInput(event, shortcut, false)).toBe(true)
	})

	it.each([
		["enter", enterEvent({ ctrlKey: true })],
		["enter", enterEvent({ shiftKey: true })],
		["ctrlEnter", enterEvent()],
		["ctrlEnter", enterEvent({ ctrlKey: true, shiftKey: true })],
		["shiftEnter", enterEvent()],
		["shiftEnter", enterEvent({ ctrlKey: true, shiftKey: true })],
	] satisfies Array<
		[ChatInputSendShortcut, ChatInputKeyEvent]
	>)("does not send unmatched Enter combination for %s", (shortcut, event) => {
		expect(shouldSendChatInput(event, shortcut, false)).toBe(false)
	})

	it("does not send while composing", () => {
		expect(shouldSendChatInput(enterEvent(), "enter", true)).toBe(false)
	})

	it("does not send for other keys or Alt/Meta combinations", () => {
		expect(shouldSendChatInput(enterEvent({ key: "a" }), "enter", false)).toBe(false)
		expect(shouldSendChatInput(enterEvent({ altKey: true }), "enter", false)).toBe(false)
		expect(shouldSendChatInput(enterEvent({ metaKey: true }), "enter", false)).toBe(false)
	})
})

describe("shouldCompleteMenuSelection", () => {
	it("leaves the configured send shortcut to the send path", () => {
		// The typed command used to stay in the input: the open suggestion list
		// consumed Ctrl+Enter as a completion, so no request was ever made.
		expect(shouldCompleteMenuSelection(enterEvent({ ctrlKey: true }), "ctrlEnter", false)).toBe(false)
		expect(shouldCompleteMenuSelection(enterEvent({ shiftKey: true }), "shiftEnter", false)).toBe(false)
	})

	it("completes the highlighted suggestion on Tab and on a bare Enter", () => {
		expect(shouldCompleteMenuSelection(enterEvent({ key: "Tab" }), "ctrlEnter", false)).toBe(true)
		expect(shouldCompleteMenuSelection(enterEvent(), "ctrlEnter", false)).toBe(true)
	})

	it("keeps completion first when Enter is itself the send shortcut", () => {
		expect(shouldCompleteMenuSelection(enterEvent(), "enter", false)).toBe(true)
	})

	it("ignores composition and unrelated keys", () => {
		expect(shouldCompleteMenuSelection(enterEvent(), "enter", true)).toBe(false)
		expect(shouldCompleteMenuSelection(enterEvent({ key: "a" }), "enter", false)).toBe(false)
	})
})

describe("chat input send shortcut labels", () => {
	it.each([
		["enter", "Enter"],
		["ctrlEnter", "Ctrl + Enter"],
		["shiftEnter", "Shift + Enter"],
	] as const)("renders the %s label", (shortcut, label) => {
		expect(getChatInputSendShortcutLabel(shortcut)).toBe(label)
	})

	it("defaults to Enter when the setting is missing", () => {
		expect(getChatInputSendShortcutLabel()).toBe("Enter")
	})
})
