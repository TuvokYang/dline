import { createInitialTaskState, type DialogActionRule } from "@core/task/kernel"
import { projectCanonicalTaskView } from "@core/task/view/canonical/projectCanonicalTaskView"
import { matchesActiveInteractionAnchor } from "@shared/interaction-anchor"
import { describe, expect, it } from "vitest"
import { adaptCanonicalTaskView } from "../TaskViewMessageAdapter"

/**
 * Reply-only dialogs declare no footer buttons, so the composer is their only
 * way to answer. These cases pin the whole chain the composer depends on: the
 * canonical dialog, its message anchor, and the anchor identity the Webview
 * re-checks locally before it trusts the projection.
 */

const REPLY_RULES: readonly DialogActionRule[] = [{ actionId: "reply", payloadPolicy: "draft" }]

/** Project one awaiting reply dialog while a tool block is still executing. */
function awaitingReplyView(kind: "qna_response" | "followup", blockExecuting: boolean) {
	const initial = createInitialTaskState("task-1")
	return projectCanonicalTaskView({
		...initial,
		revision: 7,
		flow: { phase: "running" },
		turn: { ...initial.turn, executingBlockIds: blockExecuting ? ["block-1"] : [] },
		dialog: {
			approvalsByBlock: {},
			primary: {
				interactionId: "interaction-1",
				turnId: "turn-1",
				kind,
				status: "awaiting",
				createdRevision: 6,
				presentationRef: "presentation-1",
				receiverGeneration: 0,
				actionRules: REPLY_RULES,
			},
		},
	})
}

describe("adaptCanonicalTaskView reply input", () => {
	it("enables the composer for an awaiting qna_response that owns its anchor", () => {
		const view = adaptCanonicalTaskView(awaitingReplyView("qna_response", true), [
			{ type: "say", say: "task", ts: 10, text: "task" },
			{
				type: "ask",
				ask: "qna_respond",
				ts: 20,
				text: '{"response":"ready"}',
				interactionId: "interaction-1",
				partial: false,
			},
		])

		expect(view.activeInteraction).toMatchObject({
			interactionId: "interaction-1",
			taskAsk: "qna_respond",
			presentationKind: "qna_response",
			askMessageTs: 20,
		})
		expect(view.input).toMatchObject({ enabled: true, enterAction: "reply" })
	})

	it("keeps the projected anchor identity verifiable by the Webview", () => {
		const messages = [
			{ type: "say" as const, say: "task" as const, ts: 10, text: "task" },
			{
				type: "ask" as const,
				ask: "qna_respond" as const,
				ts: 20,
				text: '{"response":"ready"}',
				interactionId: "interaction-1",
				partial: false,
			},
		]
		const view = adaptCanonicalTaskView(awaitingReplyView("qna_response", true), messages)
		const interaction = view.activeInteraction
		if (!interaction) throw new Error("Expected an active interaction")

		// The Webview re-derives the anchor from its own message window, so a
		// projection it cannot confirm leaves the composer permanently disabled
		// even though the backend considers the dialog answerable.
		expect(messages.filter((message) => matchesActiveInteractionAnchor(message, interaction))).toHaveLength(1)
	})

	it("presents the awaiting approval instead of a primary that is already resolving", () => {
		const initial = createInitialTaskState("task-1")
		const projection = projectCanonicalTaskView({
			...initial,
			revision: 14,
			flow: { phase: "running" },
			turn: {
				...initial.turn,
				blocks: [
					{
						blockId: "block-approval",
						index: 0,
						phase: "awaiting_approval",
						attempt: "attempt-1",
						lanes: ["tool"],
						turnEnding: false,
						invocationRef: "invocation-1",
					},
				],
			},
			dialog: {
				primary: {
					interactionId: "interaction-spent",
					turnId: "turn-1",
					kind: "qna_response",
					// Answered already; it must not keep owning the footer.
					status: "resolving",
					createdRevision: 6,
					presentationRef: "presentation-1",
					receiverGeneration: 0,
					actionRules: REPLY_RULES,
				},
				approvalsByBlock: {
					"block-approval": {
						interactionId: "interaction-approval",
						turnId: "turn-1",
						kind: "tool_approval",
						status: "awaiting",
						createdRevision: 12,
						presentationRef: "presentation-2",
						receiverGeneration: 0,
						blockId: "block-approval",
						actionRules: [
							{ actionId: "approve", payloadPolicy: "draft" },
							{ actionId: "reject", payloadPolicy: "draft" },
						],
					},
				},
			},
		})

		const view = adaptCanonicalTaskView(projection, [
			{ type: "ask", ask: "qna_respond", ts: 20, text: "spent", interactionId: "interaction-spent", partial: false },
			{ type: "ask", ask: "tool", ts: 30, text: "approve?", interactionId: "interaction-approval", partial: false },
		])

		expect(view.activeInteraction).toMatchObject({ interactionId: "interaction-approval", askMessageTs: 30 })
		expect(view.footer.actions.map((action) => action.type)).toEqual(["approve", "reject"])
	})

	it("disables the composer while the anchor row is still partial", () => {
		const view = adaptCanonicalTaskView(awaitingReplyView("qna_response", true), [
			{ type: "ask", ask: "qna_respond", ts: 20, text: "partial", interactionId: "interaction-1", partial: true },
		])

		expect(view.activeInteraction).toBeUndefined()
		expect(view.input.enabled).toBe(false)
		expect(view.diagnostic).toMatchObject({ code: "interaction_anchor_missing" })
	})
})
