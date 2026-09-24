import type { ActiveInteractionView, ClineMessage, TaskViewState } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { isActiveInteractionSynchronized } from "../types"

const ANCHOR_TS = 1_790_143_490_985

function interaction(overrides: Partial<ActiveInteractionView> = {}): ActiveInteractionView {
	return {
		taskId: "task-1",
		turnId: "turn:interaction-1",
		interactionId: "interaction-1",
		kind: "completion",
		status: "awaiting",
		stateRevision: 18,
		taskAsk: "completion_result",
		presentationKind: "completion",
		askMessageTs: ANCHOR_TS,
		...overrides,
	}
}

function view(activeInteraction: ActiveInteractionView | undefined): TaskViewState {
	return {
		taskId: "task-1",
		phase: "between_turns",
		stateRevision: 18,
		activeInteraction,
		input: { enabled: true, acceptsText: true, acceptsImages: true, acceptsFiles: true, enterAction: "reply" },
		footer: { actions: [] },
	}
}

function anchorRow(overrides: Partial<ClineMessage> = {}): ClineMessage {
	return {
		ts: ANCHOR_TS,
		type: "ask",
		ask: "completion_result",
		interactionId: "interaction-1",
		partial: false,
		...overrides,
	}
}

describe("active interaction synchronization", () => {
	it("treats a view without an active interaction as synchronized", () => {
		expect(isActiveInteractionSynchronized([], view(undefined))).toBe(true)
	})

	it("accepts the backend anchor verification when the row is outside the loaded window", () => {
		// The composer must follow the same evidence the footer dispatches on.
		// Requiring a locally loaded row disabled input beneath a usable footer.
		expect(isActiveInteractionSynchronized([], view(interaction({ anchorVerified: true })))).toBe(true)
	})

	it("accepts the loaded row when the projection carries no verification flag", () => {
		expect(isActiveInteractionSynchronized([anchorRow()], view(interaction()))).toBe(true)
	})

	it("rejects an unverified interaction whose row is absent", () => {
		expect(isActiveInteractionSynchronized([], view(interaction()))).toBe(false)
	})

	it("rejects an unverified interaction whose row is still streaming", () => {
		const streaming = [anchorRow({ partial: true })]
		expect(isActiveInteractionSynchronized(streaming, view(interaction()))).toBe(false)
	})

	it("rejects an unverified interaction with ambiguous duplicate rows", () => {
		const duplicated = [anchorRow(), anchorRow()]
		expect(isActiveInteractionSynchronized(duplicated, view(interaction()))).toBe(false)
	})

	it("rejects an unverified interaction whose row belongs to another interaction", () => {
		const foreign = [anchorRow({ interactionId: "interaction-2" })]
		expect(isActiveInteractionSynchronized(foreign, view(interaction()))).toBe(false)
	})
})
