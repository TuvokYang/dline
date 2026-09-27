import type { UiMessage } from "@shared/ExtensionMessage"

import { buildMessageRowKey, getBottomFollowIntent, mergeMessageWindow, shouldRestoreBottom } from "./messageWindowUtils"

const createMessage = (ts: number, text = `message-${ts}`, partial = false): UiMessage => ({
	ts,
	type: "say",
	say: "text",
	text,
	partial,
})

describe("mergeMessageWindow", () => {
	it("replaces overlapping fetched messages by ts instead of duplicating the last row", () => {
		const existing = [createMessage(100, "first"), createMessage(200, "streaming old", true)]
		const incoming = [createMessage(200, "streaming final", false), createMessage(300, "next")]

		const result = mergeMessageWindow({
			existing,
			incoming,
			existingStartIndex: 10,
			incomingStartIndex: 11,
		})

		expect(result.merged).toBe(true)
		expect(result.firstItemIndex).toBe(10)
		expect(result.messages.map((message) => message.ts)).toEqual([100, 200, 300])
		expect(result.messages[1]?.text).toBe("streaming final")
		expect(result.messages[1]?.partial).toBe(false)
	})

	it("prepends earlier messages while preserving the existing anchor message", () => {
		const existing = [createMessage(300), createMessage(400)]
		const incoming = [createMessage(100), createMessage(200)]

		const result = mergeMessageWindow({
			existing,
			incoming,
			existingStartIndex: 2,
			incomingStartIndex: 0,
		})

		expect(result.merged).toBe(true)
		expect(result.firstItemIndex).toBe(0)
		expect(result.messages.map((message) => message.ts)).toEqual([100, 200, 300, 400])
	})

	it("returns the existing array when fetched messages are identical", () => {
		const existing = [createMessage(100), createMessage(200, "same", true)]
		const incoming = [createMessage(100), createMessage(200, "same", true)]

		const result = mergeMessageWindow({
			existing,
			incoming,
			existingStartIndex: 0,
			incomingStartIndex: 0,
		})

		expect(result.merged).toBe(false)
		expect(result.firstItemIndex).toBe(0)
		expect(result.messages).toBe(existing)
	})
})

describe("buildMessageRowKey", () => {
	it("builds stable keys from message timestamps rather than row index", () => {
		const keyBefore = buildMessageRowKey([createMessage(100), createMessage(200, "draft", true)], 9)
		const keyAfter = buildMessageRowKey([createMessage(100), createMessage(200, "final", false)], 9)

		expect(keyBefore).toBe("group:100-200:2")
		expect(keyAfter).toBe(keyBefore)
	})

	it("builds a stable key for a single final row", () => {
		expect(buildMessageRowKey(createMessage(500), 3)).toBe("message:500")
	})
})

describe("bottom scroll decisions", () => {
	it("keeps following the bottom when the latest message changes while auto-scroll is enabled", () => {
		expect(
			getBottomFollowIntent({
				disableAutoScroll: false,
				absoluteBottomLoaded: true,
				lastMessageTsChanged: false,
				lastMessageContentChanged: true,
			}),
		).toBe("follow")
	})

	it("keeps following when a newly appended row temporarily moves the viewport off the bottom", () => {
		expect(
			getBottomFollowIntent({
				disableAutoScroll: false,
				absoluteBottomLoaded: true,
				lastMessageTsChanged: true,
				lastMessageContentChanged: true,
			}),
		).toBe("follow")
	})

	it("does not follow appended rows after the user disables auto-scroll", () => {
		expect(
			getBottomFollowIntent({
				disableAutoScroll: true,
				absoluteBottomLoaded: true,
				lastMessageTsChanged: true,
				lastMessageContentChanged: true,
			}),
		).toBe("none")
	})

	it("does not force bottom restore after visibility changes when the user intentionally scrolled up", () => {
		expect(
			shouldRestoreBottom({
				wasHidden: true,
				isVisible: true,
				disableAutoScroll: true,
				wasAtBottom: false,
			}),
		).toBe(false)
	})

	it("restores bottom after visibility changes when auto-scroll is still active", () => {
		expect(
			shouldRestoreBottom({
				wasHidden: true,
				isVisible: true,
				disableAutoScroll: false,
				wasAtBottom: true,
			}),
		).toBe(true)
	})
})
