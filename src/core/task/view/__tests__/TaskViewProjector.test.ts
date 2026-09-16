import { describe, expect, it } from "vitest"
import type { ActiveInteraction } from "../../interaction/InteractionReducer"
import type { TaskRuntimeState } from "../../runtime/TaskRuntimeState"
import { TaskPhase } from "../../TaskPhase"
import { projectInteraction } from "../InteractionProjector"
import { projectTaskView } from "../TaskViewProjector"

/** Create runtime state with one optional active interaction. */
function runtime(phase: TaskPhase, interaction?: ActiveInteraction): TaskRuntimeState {
	return {
		taskId: "task-1",
		phase,
		revision: 8,
		anchor: {
			apiIndex: 4,
			uiMessageTs: interaction?.anchor?.messageTs,
			turnId: interaction?.turnId,
			interactionId: interaction?.interactionId,
		},
		interaction,
	}
}

/** Create one causally identified active interaction. */
function active(kind: ActiveInteraction["kind"], messageType: "ask" | "say" = "ask"): ActiveInteraction {
	return {
		taskId: "task-1",
		turnId: "turn-1",
		interactionId: "interaction-1",
		kind,
		status: "awaiting",
		createdRevision: 7,
		anchor: { messageTs: 100, messageType },
	}
}

/** Create a completion interaction entered through the completed-task resume ask. */
function activeCompletionResume(): ActiveInteraction {
	const interaction = active("completion")
	interaction.anchor = { messageTs: 100, messageType: "ask", taskAsk: "resume_completed_task" }
	return interaction
}

describe("projectTaskView", () => {
	// A completed task reopened from history anchors on `resume_completed_task`,
	// but the `completion` kind statically declares `completion_result`. Projecting
	// the static value leaves the Webview unable to match its own anchor, which
	// silently blocks every submit path. The anchor is the only causal truth here.
	it("projects the anchor ask when completion is entered through a resume", () => {
		const view = projectTaskView(runtime(TaskPhase.AWAITING_APPROVAL, activeCompletionResume()))

		expect(view.activeInteraction).toMatchObject({
			kind: "completion",
			taskAsk: "resume_completed_task",
			askMessageTs: 100,
		})
	})

	it("keeps the completion presentation and actions across both entry asks", () => {
		const direct = projectTaskView(runtime(TaskPhase.AWAITING_APPROVAL, active("completion")))
		const resumed = projectTaskView(runtime(TaskPhase.AWAITING_APPROVAL, activeCompletionResume()))

		expect(direct.activeInteraction?.taskAsk).toBe("completion_result")
		expect(resumed.activeInteraction?.presentationKind).toBe(direct.activeInteraction?.presentationKind)
		expect(resumed.footer.actions.map((action) => action.type)).toEqual(direct.footer.actions.map((action) => action.type))
		expect(resumed.input.enterAction).toBe(direct.input.enterAction)
	})

	it("projects tool approval from the active interaction", () => {
		const view = projectTaskView(runtime(TaskPhase.AWAITING_APPROVAL, active("tool_approval")))

		expect(view.input).toMatchObject({ enabled: true, acceptsText: true })
		expect(view.input.enterAction).toBe("reject")
		expect(view.footer.actions.map((action) => action.type)).toEqual(["approve", "reject"])
		expect(view.footer.actions.every((action) => action.dispatchTarget === "interaction")).toBe(true)
		expect(view.activeInteraction).toMatchObject({ askMessageTs: 100, taskAsk: "tool" })
	})

	it("projects Hosted Web request approval with tool presentation and approval actions", () => {
		const view = projectTaskView(runtime(TaskPhase.AWAITING_APPROVAL, active("hosted_web_approval")))

		expect(view.activeInteraction).toMatchObject({
			kind: "hosted_web_approval",
			presentationKind: "tool_approval",
			taskAsk: "tool",
		})
		expect(view.footer.actions.map((action) => action.type)).toEqual(["approve", "reject"])
	})

	it("projects the current runtime revision as causal response identity", () => {
		const view = projectTaskView(runtime(TaskPhase.AWAITING_APPROVAL, active("tool_approval")))

		expect(view.activeInteraction?.stateRevision).toBe(8)
	})

	it.each([
		"followup",
		"make_plan",
		"qna_response",
		"generate_report",
	] as const)("keeps %s input enabled without footer actions", (kind) => {
		const view = projectTaskView(runtime(TaskPhase.EXECUTING, active(kind)))

		expect(view.input).toMatchObject({ enabled: true, enterAction: "reply" })
		expect(view.footer.actions).toEqual([])
	})

	it("removes approval actions once the approval response is resolving", () => {
		const interaction = active("tool_approval")
		interaction.status = "resolving"
		interaction.acceptedResponse = {
			taskId: "task-1",
			turnId: "turn-1",
			interactionId: "interaction-1",
			actionId: "approve",
			stateRevision: 8,
			draft: { text: "approved", images: [], files: [] },
		}
		const view = projectTaskView(runtime(TaskPhase.AWAITING_APPROVAL, interaction))

		expect(view.input.enabled).toBe(false)
		expect(view.footer.actions.map((action) => action.type)).toEqual([])
	})

	it("restores Cancel while an approved command is running", () => {
		const interaction = active("command_approval")
		interaction.status = "resolving"
		const view = projectTaskView(runtime(TaskPhase.EXECUTING, interaction))

		expect(view.input.enabled).toBe(false)
		expect(view.footer.actions).toEqual([
			{
				type: "cancel",
				label: "Cancel",
				appearance: "danger",
				enabled: true,
				payloadPolicy: "none",
				dispatchTarget: "task",
			},
		])
	})

	it("projects TODO-list selection requirements with Webview presentation compatibility", () => {
		const view = projectTaskView(runtime(TaskPhase.AWAITING_APPROVAL, active("change_todo_list")))

		expect(view.activeInteraction).toMatchObject({
			kind: "change_todo_list",
			taskAsk: "change_todo_list",
			presentationKind: "focus_chain_change",
		})
		expect(view.footer.actions[0]).toMatchObject({ type: "approve", payloadPolicy: "draft_and_selection" })
	})

	it("projects manual condense acceptance and feedback regeneration", () => {
		const view = projectTaskView(runtime(TaskPhase.AWAITING_APPROVAL, active("condense")))

		expect(view.input).toMatchObject({ enabled: true, enterAction: "reject" })
		expect(view.footer.actions).toEqual([
			{
				type: "confirm_utility",
				label: "Condense Conversation",
				appearance: "primary",
				enabled: true,
				payloadPolicy: "none",
				dispatchTarget: "interaction",
			},
			{
				type: "reject",
				label: "Regenerate Summary",
				appearance: "secondary",
				enabled: true,
				payloadPolicy: "draft",
				dispatchTarget: "interaction",
			},
		])
	})

	it("projects Resume for a paused synthesized anchored resume interaction", () => {
		const view = projectTaskView(runtime(TaskPhase.PAUSED, active("resume")))

		expect(view.activeInteraction).toMatchObject({ kind: "resume", interactionId: "interaction-1" })
		expect(view.input).toMatchObject({ enabled: true, enterAction: "resume" })
		expect(view.footer.actions.map((action) => action.type)).toEqual(["resume"])
	})

	it("does not invent task-level Resume when PAUSED has no interaction", () => {
		const view = projectTaskView(runtime(TaskPhase.PAUSED))

		expect(view.input.enabled).toBe(false)
		expect(view.footer.actions).toEqual([])
	})

	it("keeps reply input without Resume for a paused anchored followup", () => {
		const view = projectTaskView(runtime(TaskPhase.PAUSED, active("followup")))

		expect(view.activeInteraction).toMatchObject({ kind: "followup", interactionId: "interaction-1" })
		expect(view.input).toMatchObject({ enabled: true, enterAction: "reply" })
		expect(view.footer.actions).toEqual([])
	})

	it("keeps Approve and Reject for a paused anchored tool approval", () => {
		const view = projectTaskView(runtime(TaskPhase.PAUSED, active("tool_approval")))

		expect(view.activeInteraction).toMatchObject({ kind: "tool_approval", interactionId: "interaction-1" })
		expect(view.input).toMatchObject({ enabled: true, enterAction: "reject" })
		expect(view.footer.actions.map((action) => action.type)).toEqual(["approve", "reject"])
	})

	it.each([
		"tool_approval",
		"followup",
		"completion",
		"resume",
	] as const)("exposes no action buttons while an anchored %s interaction is resolving", (kind) => {
		const interaction = active(kind)
		interaction.status = "resolving"

		const view = projectTaskView(runtime(TaskPhase.PAUSED, interaction))

		expect(view.input.enabled).toBe(false)
		expect(view.footer.actions).toEqual([])
	})

	it("projects error recovery actions", () => {
		const view = projectTaskView(runtime(TaskPhase.PAUSED, active("error_retry")))

		expect(view.footer.actions.map((action) => action.type)).toEqual(["retry", "start_new_task"])
	})

	it("projects Force Truncate only for an awaiting error-retry interaction", () => {
		const view = projectTaskView(runtime(TaskPhase.PAUSED, active("error_retry")), {
			forceTruncateAvailable: true,
		})

		expect(view.forceTruncateAvailable).toBe(true)
	})

	it("does not project Force Truncate for a non-error interaction", () => {
		const view = projectTaskView(runtime(TaskPhase.EXECUTING, active("followup")), {
			forceTruncateAvailable: true,
		})

		expect(view.forceTruncateAvailable).toBeUndefined()
	})

	it("does not project Force Truncate while error recovery is resolving", () => {
		const interaction = active("error_retry")
		interaction.status = "resolving"
		const view = projectTaskView(runtime(TaskPhase.PAUSED, interaction), {
			forceTruncateAvailable: true,
		})

		expect(view.forceTruncateAvailable).toBeUndefined()
	})

	it("keeps Retry enabled while an automatic retry request is in flight", () => {
		const view = projectTaskView(runtime(TaskPhase.STREAMING), {
			autoRetryActive: true,
			autoRetryPending: false,
		})

		expect(view.footer.actions.map((action) => action.type)).toEqual(["retry", "cancel"])
		expect(view.footer.actions[0].enabled).toBe(true)
	})

	it("projects Retry and Cancel during an automatic retry countdown", () => {
		const view = projectTaskView(runtime(TaskPhase.STREAMING), {
			autoRetryActive: true,
			autoRetryPending: true,
		})

		expect(view.footer.actions.map((action) => action.type)).toEqual(["retry", "cancel"])
		expect(view.footer.actions[0].enabled).toBe(true)
	})

	it("projects the active context-compaction operation for Header anti-reentry", () => {
		const view = projectTaskView(runtime(TaskPhase.AWAITING_APPROVAL, active("followup")), {
			contextCompactionOperationId: "manual-compact:task-1:8",
		})

		expect(view.contextCompaction).toEqual({
			active: true,
			operationId: "manual-compact:task-1:8",
		})
	})

	it("projects feedback input and only Start New Task for a completed anchored completion", () => {
		const view = projectTaskView(runtime(TaskPhase.COMPLETED, active("completion")))

		expect(view.activeInteraction).toMatchObject({ kind: "completion", interactionId: "interaction-1" })
		expect(view.input).toMatchObject({ enabled: true, enterAction: "reply" })
		expect(view.footer.actions.map((action) => action.type)).toEqual(["start_new_task"])
	})

	it("projects Continue in Background before task Cancel for the ready foreground command", () => {
		const view = projectTaskView(runtime(TaskPhase.EXECUTING), {
			commandHandoffActivityId: "command-1",
		})

		expect(view.footer.actions).toEqual([
			{
				type: "continue_in_background",
				label: "Continue in Background",
				appearance: "secondary",
				enabled: true,
				payloadPolicy: "none",
				dispatchTarget: "task",
				activityId: "command-1",
			},
			{
				type: "cancel",
				label: "Cancel",
				appearance: "danger",
				enabled: true,
				payloadPolicy: "none",
				dispatchTarget: "task",
			},
		])
	})

	it("projects cancelling with a disabled cancel action", () => {
		const view = projectTaskView(runtime(TaskPhase.CANCELLING, active("tool_approval")))

		expect(view.input.enabled).toBe(false)
		expect(view.activeInteraction).toBeUndefined()
		expect(view.footer.actions).toEqual([
			{
				type: "cancel",
				label: "Cancel",
				appearance: "danger",
				enabled: false,
				payloadPolicy: "none",
				dispatchTarget: "task",
			},
		])
	})

	it("projects one explicitly admitted Profile recovery reply between turns", () => {
		const state = runtime(TaskPhase.BETWEEN_TURNS)
		state.ordinaryInput = { kind: "profile_recovery" }

		const view = projectTaskView(state)

		expect(view.activeInteraction).toBeUndefined()
		expect(view.input).toEqual({
			enabled: true,
			acceptsText: true,
			acceptsImages: true,
			acceptsFiles: true,
			enterAction: "reply",
		})
		expect(view.footer.actions.map((action) => action.type)).toEqual(["cancel"])
	})

	// BETWEEN_TURNS is the gap between a finished turn and the next provider
	// request: the task loop is still running and nobody is waiting for a
	// reply. Projecting it as ready-for-input let the composer bypass the queue
	// and push text in as an answer to a question that was never asked, while
	// the missing Cancel left a working task with no way to stop it. A slow
	// checkpoint write widens this gap enough for the user to hit it.
	it("projects a working task without input and with Cancel between turns", () => {
		const view = projectTaskView(runtime(TaskPhase.BETWEEN_TURNS))

		expect(view.activeInteraction).toBeUndefined()
		expect(view.input).toEqual({
			enabled: false,
			acceptsText: false,
			acceptsImages: false,
			acceptsFiles: false,
		})
		expect(view.footer.actions).toEqual([
			{
				type: "cancel",
				label: "Cancel",
				appearance: "danger",
				enabled: true,
				payloadPolicy: "none",
				dispatchTarget: "task",
			},
		])
	})

	it("projects cancel from working runtime phase without message inference", () => {
		const view = projectTaskView(runtime(TaskPhase.STREAMING))

		expect(view.activeInteraction).toBeUndefined()
		expect(view.input.enabled).toBe(false)
		expect(view.footer.actions).toEqual([
			{
				type: "cancel",
				label: "Cancel",
				appearance: "danger",
				enabled: true,
				payloadPolicy: "none",
				dispatchTarget: "task",
			},
		])
	})
})

describe("projectInteraction", () => {
	it("never projects actions for a say anchor", () => {
		const result = projectInteraction(active("tool_approval", "say"), 8)

		expect(result.view).toBeUndefined()
		expect(result.diagnostic?.code).toBe("interaction_anchor_is_say")
	})

	it("carries an invalid anchor diagnostic into the complete task view", () => {
		const view = projectTaskView(runtime(TaskPhase.PAUSED, active("tool_approval", "say")))

		expect(view.activeInteraction).toBeUndefined()
		expect(view.footer.actions).toEqual([])
		expect(view.diagnostic).toEqual({ code: "interaction_anchor_is_say", interactionId: "interaction-1" })
	})

	it("surfaces a failed opening recovery interaction without projecting controls", () => {
		const interaction = active("resume")
		interaction.status = "opening"
		delete interaction.anchor
		const state = runtime(TaskPhase.PAUSED, interaction)
		state.error = {
			effectId: "effect-ask",
			effectType: "APPEND_ASK",
			originRevision: 7,
			message: "ask persistence failed",
		}

		const view = projectTaskView(state)

		expect(view.activeInteraction).toBeUndefined()
		expect(view.footer.actions).toEqual([])
		expect(view.diagnostic).toEqual({ code: "interaction_anchor_missing", interactionId: "interaction-1" })
	})
})
