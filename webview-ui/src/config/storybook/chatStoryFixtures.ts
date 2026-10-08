import type {
	TaskInputViewState,
	TaskViewAction,
	TaskViewActionType,
	TaskViewState,
	UiAsk,
	UiMessage,
} from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import type { ExtensionStateContextType } from "@/context/ExtensionStateContext"

const DEFAULT_TASK_ID = "storybook-task"
const DEFAULT_TASK_TITLE = "Storybook chat task"
const DEFAULT_TASK_TIMESTAMP = 1_725_000_000_000
const DEFAULT_STATE_REVISION = 1

export type ChatStoryStateOverrides = Partial<ExtensionStateContextType> & {
	activeTask?: boolean
	taskTitle?: string
}

interface StoryInteractionDefinition {
	kind: string
	presentationKind: string
	input: TaskInputViewState
	actions: TaskViewAction[]
}

const DRAFT_INPUT: TaskInputViewState = {
	enabled: true,
	acceptsText: true,
	acceptsImages: true,
	acceptsFiles: true,
}

const APPROVAL_INPUT: TaskInputViewState = { ...DRAFT_INPUT, enterAction: "reject" }
const REPLY_INPUT: TaskInputViewState = { ...DRAFT_INPUT, enterAction: "reply" }
const RETRY_INPUT: TaskInputViewState = { ...DRAFT_INPUT, enterAction: "retry" }
const RESUME_INPUT: TaskInputViewState = { ...DRAFT_INPUT, enterAction: "resume" }

function action(
	type: TaskViewActionType,
	label: string,
	payloadPolicy: TaskViewAction["payloadPolicy"] = "none",
	appearance: TaskViewAction["appearance"] = "primary",
): TaskViewAction {
	return {
		type,
		label,
		appearance,
		enabled: true,
		payloadPolicy,
		dispatchTarget: "interaction",
	}
}

const APPROVAL_ACTIONS = [action("approve", "Approve", "draft"), action("reject", "Reject", "draft", "danger")]

const STORY_INTERACTIONS: Partial<Record<UiAsk, StoryInteractionDefinition>> = {
	tool: {
		kind: "tool_approval",
		presentationKind: "tool_approval",
		input: APPROVAL_INPUT,
		actions: APPROVAL_ACTIONS,
	},
	command: {
		kind: "command_approval",
		presentationKind: "command_approval",
		input: APPROVAL_INPUT,
		actions: APPROVAL_ACTIONS,
	},
	browser_action_launch: {
		kind: "browser_approval",
		presentationKind: "browser_approval",
		input: APPROVAL_INPUT,
		actions: APPROVAL_ACTIONS,
	},
	use_mcp_server: {
		kind: "mcp_approval",
		presentationKind: "mcp_approval",
		input: APPROVAL_INPUT,
		actions: APPROVAL_ACTIONS,
	},
	new_task: {
		kind: "new_task",
		presentationKind: "new_task",
		input: APPROVAL_INPUT,
		actions: [action("approve", "Start New Task"), action("reject", "Regenerate Context", "draft", "secondary")],
	},
	report_bug: {
		kind: "report_bug",
		presentationKind: "report_bug",
		input: DRAFT_INPUT,
		actions: [action("confirm_utility", "Report Bug", "draft")],
	},
	condense: {
		kind: "condense",
		presentationKind: "condense",
		input: APPROVAL_INPUT,
		actions: [
			action("confirm_utility", "Condense Conversation"),
			action("reject", "Regenerate Summary", "draft", "secondary"),
		],
	},
	followup: {
		kind: "followup",
		presentationKind: "followup",
		input: REPLY_INPUT,
		actions: [],
	},
	make_plan: {
		kind: "make_plan",
		presentationKind: "make_plan",
		input: REPLY_INPUT,
		actions: [],
	},
	api_req_failed: {
		kind: "error_retry",
		presentationKind: "error_retry",
		input: RETRY_INPUT,
		actions: [action("retry", "Retry", "draft"), action("start_new_task", "Start New Task", "draft")],
	},
	mistake_limit_reached: {
		kind: "mistake_limit",
		presentationKind: "mistake_limit",
		input: DRAFT_INPUT,
		actions: [action("process_anyway", "Process Anyway", "draft"), action("start_new_task", "Start New Task", "draft")],
	},
	completion_result: {
		kind: "completion",
		presentationKind: "completion",
		input: REPLY_INPUT,
		actions: [action("start_new_task", "Start New Task", "draft")],
	},
	resume_task: {
		kind: "resume",
		presentationKind: "resume",
		input: RESUME_INPUT,
		actions: [action("resume", "Resume", "draft")],
	},
	resume_completed_task: {
		kind: "resume",
		presentationKind: "resume",
		input: RESUME_INPUT,
		actions: [action("start_new_task", "Start New Task", "draft")],
	},
}

function isTaskTitle(message: UiMessage): boolean {
	return message.type === "say" && message.say === "task"
}

function findInteractionAnchor(messages: readonly UiMessage[]): {
	index: number
	message: UiMessage & { type: "ask"; ask: UiAsk }
	definition: StoryInteractionDefinition
} | null {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]
		if (message.type !== "ask" || !message.ask) {
			continue
		}
		const ask = message.ask
		const definition = STORY_INTERACTIONS[ask]
		if (definition) {
			return { index, message: { ...message, type: "ask", ask }, definition }
		}
	}
	return null
}

function normalizeInteraction(
	messages: UiMessage[],
	taskId: string,
): {
	messages: UiMessage[]
	view: TaskViewState
} {
	const anchor = findInteractionAnchor(messages)
	if (!anchor) {
		return {
			messages,
			view: {
				taskId,
				phase: "between_turns",
				stateRevision: DEFAULT_STATE_REVISION,
				input: { ...DRAFT_INPUT },
				footer: { actions: [] },
			},
		}
	}

	const interactionId = anchor.message.interactionId ?? `storybook-${anchor.message.ask}-${anchor.message.ts}`
	const normalizedAnchor: UiMessage & { type: "ask"; ask: UiAsk } = { ...anchor.message, interactionId }
	const normalizedMessages = [...messages]
	normalizedMessages[anchor.index] = normalizedAnchor

	return {
		messages: normalizedMessages,
		view: {
			taskId,
			phase: "awaiting_approval",
			stateRevision: DEFAULT_STATE_REVISION,
			activeInteraction: {
				taskId,
				turnId: "storybook-turn",
				interactionId,
				kind: anchor.definition.kind,
				status: "awaiting",
				stateRevision: DEFAULT_STATE_REVISION,
				taskAsk: normalizedAnchor.ask,
				presentationKind: anchor.definition.presentationKind,
				askMessageTs: normalizedAnchor.ts,
			},
			input: { ...anchor.definition.input },
			footer: { actions: anchor.definition.actions.map((item) => ({ ...item })) },
		},
	}
}

function createTaskTitle(text: string, timestamp: number): UiMessage {
	return {
		ts: timestamp,
		type: "say",
		say: "task",
		text,
	}
}

function createHistoryItem(taskId: string, taskTitle: UiMessage): HistoryItem {
	return {
		id: taskId,
		ulid: "01HZZZ1A1B2C3D4E5F6G7H8J9K",
		ts: taskTitle.ts,
		task: taskTitle.text ?? DEFAULT_TASK_TITLE,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
	}
}

/** Build a coherent Storybook projection for the current ChatView state contract. */
export function createChatStoryState(
	baseState: ExtensionStateContextType,
	overrides: ChatStoryStateOverrides = {},
): ExtensionStateContextType {
	const {
		activeTask: explicitActiveTask,
		taskTitle,
		clineMessages: overriddenMessages,
		currentTaskItem: overriddenTaskItem,
		taskTitleMessage: overriddenTaskTitle,
		taskViewState: overriddenTaskView,
		...stateOverrides
	} = overrides
	const sourceMessages = overriddenMessages ?? baseState.clineMessages
	const bodyMessages = sourceMessages.filter((message) => !isTaskTitle(message))
	const embeddedTaskTitle = sourceMessages.find(isTaskTitle)
	const activeTask = explicitActiveTask ?? true

	if (!activeTask) {
		return {
			...baseState,
			...stateOverrides,
			clineMessages: bodyMessages,
			currentTaskItem: undefined,
			taskTitleMessage: undefined,
			taskViewState: undefined,
			totalMessageCount: bodyMessages.length,
			firstItemIndex: 0,
			didHydrateState: true,
			hydration: { status: "ready" },
		}
	}

	const taskId = overriddenTaskView?.taskId ?? overriddenTaskItem?.id ?? DEFAULT_TASK_ID
	const titleTimestamp = overriddenTaskTitle?.ts ?? embeddedTaskTitle?.ts ?? overriddenTaskItem?.ts ?? DEFAULT_TASK_TIMESTAMP
	const resolvedTaskTitle =
		overriddenTaskTitle ??
		embeddedTaskTitle ??
		createTaskTitle(taskTitle ?? overriddenTaskItem?.task ?? DEFAULT_TASK_TITLE, titleTimestamp)
	const normalized = overriddenTaskView
		? { messages: bodyMessages, view: overriddenTaskView }
		: normalizeInteraction(bodyMessages, taskId)

	return {
		...baseState,
		...stateOverrides,
		clineMessages: normalized.messages,
		currentTaskItem: overriddenTaskItem ?? createHistoryItem(taskId, resolvedTaskTitle),
		taskTitleMessage: resolvedTaskTitle,
		taskViewState: normalized.view,
		totalMessageCount: normalized.messages.length,
		firstItemIndex: 0,
		didHydrateState: true,
		hydration: { status: "ready" },
	}
}
