import { describe, expect, it } from "vitest"
import { RECOVERY_ACTION_RULES } from "../../kernel/recovery"
import type { InteractionKind } from "../Interaction"
import { getInteraction, INTERACTION_KINDS } from "../InteractionRegistry"

interface InteractionCase {
	kind: InteractionKind
	taskAsk: string
	actions: string[]
	enterAction?: string
	continuation?: string
}

const CASES: InteractionCase[] = [
	{ kind: "tool_approval", taskAsk: "tool", actions: ["approve", "reject"], enterAction: "reject" },
	{
		kind: "hosted_web_approval",
		taskAsk: "tool",
		actions: ["approve", "reject"],
		enterAction: "reject",
		continuation: "api",
	},
	{ kind: "command_approval", taskAsk: "command", actions: ["approve", "reject"], enterAction: "reject" },
	{ kind: "change_todo_list", taskAsk: "change_todo_list", actions: ["approve", "reject"], enterAction: "reject" },
	{ kind: "new_task", taskAsk: "new_task", actions: ["approve", "reject"], enterAction: "reject" },
	{ kind: "followup", taskAsk: "followup", actions: [], enterAction: "reply", continuation: "handler" },
	{ kind: "make_plan", taskAsk: "make_plan", actions: [], enterAction: "reply", continuation: "handler" },
	{ kind: "qna_response", taskAsk: "qna_respond", actions: [], enterAction: "reply", continuation: "handler" },
	{ kind: "generate_report", taskAsk: "generate_report", actions: [], enterAction: "reply", continuation: "handler" },
	{ kind: "resume", taskAsk: "resume_task", actions: ["resume"], enterAction: "resume", continuation: "resume" },
	{
		kind: "cancelled_resume",
		taskAsk: "resume_task",
		actions: ["resume"],
		enterAction: "resume",
		continuation: "resume",
	},
	{ kind: "error_retry", taskAsk: "api_req_failed", actions: ["retry", "start_new_task"], enterAction: "retry" },
	{
		kind: "condense",
		taskAsk: "condense",
		actions: ["confirm_utility", "reject"],
		enterAction: "reject",
	},
	{
		kind: "mistake_limit",
		taskAsk: "mistake_limit_reached",
		actions: ["process_anyway", "start_new_task"],
	},
	{
		kind: "completion",
		taskAsk: "completion_result",
		actions: ["start_new_task"],
		enterAction: "reply",
		continuation: "completion",
	},
	{
		kind: "status_acknowledgment",
		taskAsk: "status_acknowledgment",
		actions: ["acknowledge", "stop"],
		enterAction: "acknowledge",
	},
]

describe("InteractionRegistry", () => {
	it.each(CASES)("defines $kind", ({ kind, taskAsk, actions, enterAction, continuation = "none" }) => {
		const definition = getInteraction(kind)

		expect(definition.taskAsk).toBe(taskAsk)
		expect(definition.actions.map((action) => action.type)).toEqual(actions)
		expect(definition.input.enterAction).toBe(enterAction)
		expect(definition.continuation).toBe(continuation)
	})

	it("registers every interaction kind exactly once", () => {
		expect(new Set(INTERACTION_KINDS).size).toBe(INTERACTION_KINDS.length)
		for (const kind of INTERACTION_KINDS) {
			expect(getInteraction(kind).kind).toBe(kind)
		}
	})

	it("renders a cancelled round through the resume presentation it shares", () => {
		expect(getInteraction("cancelled_resume")).toMatchObject({
			kind: "cancelled_resume",
			taskAsk: "resume_task",
			presentationKind: "resume",
		})
	})

	it("offers the actions the kernel plans for a recovery dialog", () => {
		// The kernel plans these rules without reading this registry, and the
		// surface only renders actions present in both. A recovery dialog whose
		// rules disagreed would render a Resume button that dispatches nothing.
		for (const kind of ["resume", "cancelled_resume"] as const) {
			expect(
				getInteraction(kind).actions.map((item) => ({ actionId: item.type, payloadPolicy: item.payloadPolicy })),
			).toEqual(RECOVERY_ACTION_RULES)
		}
	})

	it("projects Hosted Web approval through the registered tool approval renderer", () => {
		expect(getInteraction("hosted_web_approval")).toMatchObject({
			kind: "hosted_web_approval",
			taskAsk: "tool",
			presentationKind: "tool_approval",
		})
	})

	it("keeps tool approval draft-capable and defaults Enter to Reject", () => {
		const definition = getInteraction("tool_approval")

		expect(definition.input).toMatchObject({ enabled: true, acceptsText: true, enterAction: "reject" })
		expect(definition.actions[0].payloadPolicy).toBe("draft")
	})

	it("requires draft and selection for focus-chain approval", () => {
		const definition = getInteraction("change_todo_list")
		expect(definition.actions[0].payloadPolicy).toBe("draft_and_selection")
	})

	it("confirms New Task without draft and carries feedback only for regeneration", () => {
		const definition = getInteraction("new_task")

		expect(definition.input).toMatchObject({ enabled: true, acceptsText: true, enterAction: "reject" })
		expect(definition.actions).toEqual([
			{
				type: "approve",
				label: "Start New Task",
				appearance: "primary",
				payloadPolicy: "none",
			},
			{
				type: "reject",
				label: "Regenerate Context",
				appearance: "secondary",
				payloadPolicy: "draft",
			},
		])
	})

	it("preserves the current draft on Condense and carries it only for Regenerate", () => {
		const definition = getInteraction("condense")

		expect(definition.actions).toEqual([
			{
				type: "confirm_utility",
				label: "Condense Conversation",
				appearance: "primary",
				payloadPolicy: "none",
			},
			{
				type: "reject",
				label: "Regenerate Summary",
				appearance: "secondary",
				payloadPolicy: "draft",
			},
		])
	})
})
