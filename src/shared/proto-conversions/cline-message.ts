import {
	ClineAsk as AppClineAsk,
	ClineMessage as AppClineMessage,
	ClineSay as AppClineSay,
	type CommandStatus,
} from "@shared/ExtensionMessage"
import {
	type ImageGenerationPresentationV1,
	parseImageGenerationPresentation,
	parseImageGenerationToolText,
} from "@shared/image-generation"
import {
	ClineAsk,
	ClineMessageType,
	ClineSay,
	ClineMessage as ProtoClineMessage,
	type ImageGenerationPresentation as ProtoImageGenerationPresentation,
} from "@shared/proto/dline/ui"

// Helper function to convert ClineAsk string to enum
function convertClineAskToProtoEnum(ask: AppClineAsk | undefined): ClineAsk | undefined {
	if (!ask) {
		return undefined
	}

	const mapping: Record<AppClineAsk, ClineAsk> = {
		followup: ClineAsk.FOLLOWUP,
		make_plan: ClineAsk.MAKE_PLAN,
		act_mode_respond: ClineAsk.ACT_MODE_RESPOND,
		command: ClineAsk.COMMAND,
		command_output: ClineAsk.COMMAND_OUTPUT,
		completion_result: ClineAsk.COMPLETION_RESULT,
		tool: ClineAsk.TOOL,
		api_req_failed: ClineAsk.API_REQ_FAILED,
		resume_task: ClineAsk.RESUME_TASK,
		resume_completed_task: ClineAsk.RESUME_COMPLETED_TASK,
		mistake_limit_reached: ClineAsk.MISTAKE_LIMIT_REACHED,
		browser_action_launch: ClineAsk.BROWSER_ACTION_LAUNCH,
		use_mcp_server: ClineAsk.USE_MCP_SERVER,
		new_task: ClineAsk.NEW_TASK,
		condense: ClineAsk.CONDENSE,
		summarize_task: ClineAsk.SUMMARIZE_TASK,
		report_bug: ClineAsk.REPORT_BUG,
		use_subagents: ClineAsk.USE_SUBAGENTS,
		spawn_task: ClineAsk.SPAWN_TASK,
		qna_respond: ClineAsk.QNA_RESPOND,
		change_todo_list: ClineAsk.CHANGE_TODO_LIST,
		status_acknowledgment: ClineAsk.STATUS_ACKNOWLEDGMENT,
		generate_report: ClineAsk.GENERATE_REPORT_ASK,
	}

	const result = mapping[ask]
	if (result === undefined) {
	}
	return result
}

// Helper function to convert ClineAsk enum to string
function convertProtoEnumToClineAsk(ask: ClineAsk): AppClineAsk | undefined {
	if (ask === ClineAsk.UNRECOGNIZED) {
		return undefined
	}

	const mapping: Record<Exclude<ClineAsk, ClineAsk.UNRECOGNIZED>, AppClineAsk> = {
		[ClineAsk.FOLLOWUP]: "followup",
		[ClineAsk.MAKE_PLAN]: "make_plan",
		[ClineAsk.ACT_MODE_RESPOND]: "act_mode_respond",
		[ClineAsk.COMMAND]: "command",
		[ClineAsk.COMMAND_OUTPUT]: "command_output",
		[ClineAsk.COMPLETION_RESULT]: "completion_result",
		[ClineAsk.TOOL]: "tool",
		[ClineAsk.API_REQ_FAILED]: "api_req_failed",
		[ClineAsk.RESUME_TASK]: "resume_task",
		[ClineAsk.RESUME_COMPLETED_TASK]: "resume_completed_task",
		[ClineAsk.MISTAKE_LIMIT_REACHED]: "mistake_limit_reached",
		[ClineAsk.BROWSER_ACTION_LAUNCH]: "browser_action_launch",
		[ClineAsk.USE_MCP_SERVER]: "use_mcp_server",
		[ClineAsk.NEW_TASK]: "new_task",
		[ClineAsk.CONDENSE]: "condense",
		[ClineAsk.SUMMARIZE_TASK]: "summarize_task",
		[ClineAsk.REPORT_BUG]: "report_bug",
		[ClineAsk.USE_SUBAGENTS]: "use_subagents",
		[ClineAsk.SPAWN_TASK]: "spawn_task",
		[ClineAsk.QNA_RESPOND]: "qna_respond",
		[ClineAsk.CHANGE_TODO_LIST]: "change_todo_list",
		[ClineAsk.STATUS_ACKNOWLEDGMENT]: "status_acknowledgment",
		[ClineAsk.GENERATE_REPORT_ASK]: "generate_report",
	}

	return mapping[ask]
}

// Helper function to convert ClineSay string to enum
function convertClineSayToProtoEnum(say: AppClineSay | undefined): ClineSay | undefined {
	if (!say) {
		return undefined
	}

	const mapping: Record<AppClineSay, ClineSay> = {
		task: ClineSay.TASK,
		error: ClineSay.ERROR,
		api_req_started: ClineSay.API_REQ_STARTED,
		api_req_finished: ClineSay.API_REQ_FINISHED,
		text: ClineSay.TEXT,
		reasoning: ClineSay.REASONING,
		qna_respond: ClineSay.QNA_RESPOND_SAY,
		completion_result: ClineSay.COMPLETION_RESULT_SAY,
		user_feedback: ClineSay.USER_FEEDBACK,
		user_feedback_diff: ClineSay.USER_FEEDBACK_DIFF,
		api_req_retried: ClineSay.API_REQ_RETRIED,
		command: ClineSay.COMMAND_SAY,
		command_output: ClineSay.COMMAND_OUTPUT_SAY,
		tool: ClineSay.TOOL_SAY,
		shell_integration_warning: ClineSay.SHELL_INTEGRATION_WARNING,
		shell_integration_warning_with_suggestion: ClineSay.SHELL_INTEGRATION_WARNING,
		browser_action_launch: ClineSay.BROWSER_ACTION_LAUNCH_SAY,
		browser_action: ClineSay.BROWSER_ACTION,
		browser_action_result: ClineSay.BROWSER_ACTION_RESULT,
		mcp_server_request_started: ClineSay.MCP_SERVER_REQUEST_STARTED,
		mcp_server_response: ClineSay.MCP_SERVER_RESPONSE,
		mcp_notification: ClineSay.MCP_NOTIFICATION,
		use_mcp_server: ClineSay.USE_MCP_SERVER_SAY,
		diff_error: ClineSay.DIFF_ERROR,
		deleted_api_reqs: ClineSay.DELETED_API_REQS,
		clineignore_error: ClineSay.CLINEIGNORE_ERROR,
		command_permission_denied: ClineSay.COMMAND_PERMISSION_DENIED,
		checkpoint_created: ClineSay.CHECKPOINT_CREATED,
		load_mcp_documentation: ClineSay.LOAD_MCP_DOCUMENTATION,
		info: ClineSay.INFO,
		task_progress: ClineSay.TASK_PROGRESS,
		error_retry: ClineSay.ERROR_RETRY,
		hook_status: ClineSay.HOOK_STATUS,
		hook_output_stream: ClineSay.HOOK_OUTPUT_STREAM,
		conditional_rules_applied: ClineSay.CONDITIONAL_RULES_APPLIED,
		partial_tool_result: ClineSay.PARTIAL_TOOL_RESULT,
		subagent: ClineSay.SUBAGENT_STATUS,
		use_subagents: ClineSay.USE_SUBAGENTS_SAY,
		subagent_usage: ClineSay.SUBAGENT_USAGE,
		generate_explanation: ClineSay.GENERATE_EXPLANATION,
		state_snapshot: ClineSay.STATE_SNAPSHOT,
	}

	const result = mapping[say]

	return result
}

// Helper function to convert ClineSay enum to string
function convertProtoEnumToClineSay(say: ClineSay): AppClineSay | undefined {
	if (say === ClineSay.UNRECOGNIZED) {
		return undefined
	}

	const mapping: Record<Exclude<ClineSay, ClineSay.UNRECOGNIZED>, AppClineSay> = {
		[ClineSay.TASK]: "task",
		[ClineSay.ERROR]: "error",
		[ClineSay.API_REQ_STARTED]: "api_req_started",
		[ClineSay.API_REQ_FINISHED]: "api_req_finished",
		[ClineSay.TEXT]: "text",
		[ClineSay.REASONING]: "reasoning",
		[ClineSay.COMPLETION_RESULT_SAY]: "completion_result",
		[ClineSay.USER_FEEDBACK]: "user_feedback",
		[ClineSay.USER_FEEDBACK_DIFF]: "user_feedback_diff",
		[ClineSay.API_REQ_RETRIED]: "api_req_retried",
		[ClineSay.COMMAND_SAY]: "command",
		[ClineSay.COMMAND_OUTPUT_SAY]: "command_output",
		[ClineSay.TOOL_SAY]: "tool",
		[ClineSay.SHELL_INTEGRATION_WARNING]: "shell_integration_warning",
		[ClineSay.BROWSER_ACTION_LAUNCH_SAY]: "browser_action_launch",
		[ClineSay.BROWSER_ACTION]: "browser_action",
		[ClineSay.BROWSER_ACTION_RESULT]: "browser_action_result",
		[ClineSay.MCP_SERVER_REQUEST_STARTED]: "mcp_server_request_started",
		[ClineSay.MCP_SERVER_RESPONSE]: "mcp_server_response",
		[ClineSay.MCP_NOTIFICATION]: "mcp_notification",
		[ClineSay.USE_MCP_SERVER_SAY]: "use_mcp_server",
		[ClineSay.DIFF_ERROR]: "diff_error",
		[ClineSay.DELETED_API_REQS]: "deleted_api_reqs",
		[ClineSay.CLINEIGNORE_ERROR]: "clineignore_error",
		[ClineSay.COMMAND_PERMISSION_DENIED]: "command_permission_denied",
		[ClineSay.CHECKPOINT_CREATED]: "checkpoint_created",
		[ClineSay.LOAD_MCP_DOCUMENTATION]: "load_mcp_documentation",
		[ClineSay.INFO]: "info",
		[ClineSay.TASK_PROGRESS]: "task_progress",
		[ClineSay.ERROR_RETRY]: "error_retry",
		[ClineSay.GENERATE_EXPLANATION]: "generate_explanation",
		[ClineSay.HOOK_STATUS]: "hook_status",
		[ClineSay.HOOK_OUTPUT_STREAM]: "hook_output_stream",
		[ClineSay.CONDITIONAL_RULES_APPLIED]: "conditional_rules_applied",
		[ClineSay.PARTIAL_TOOL_RESULT]: "partial_tool_result",
		[ClineSay.SUBAGENT_STATUS]: "subagent",
		[ClineSay.USE_SUBAGENTS_SAY]: "use_subagents",
		[ClineSay.SUBAGENT_USAGE]: "subagent_usage",
		[ClineSay.QNA_RESPOND_SAY]: "qna_respond",
		[ClineSay.STATE_SNAPSHOT]: "state_snapshot",
	}

	return mapping[say]
}

function convertImageGenerationToProto(
	presentation: ImageGenerationPresentationV1 | undefined,
): ProtoImageGenerationPresentation | undefined {
	if (!presentation) return undefined
	return {
		schemaVersion: presentation.schemaVersion,
		status: presentation.status,
		requestId: presentation.requestId,
		prompt: presentation.prompt,
		profileId: presentation.profileId,
		providerId: presentation.providerId,
		modelId: presentation.modelId,
		count: presentation.count,
		artifacts: presentation.artifacts ?? [],
		preview: presentation.preview,
		previews: presentation.previews ?? [],
		usage: presentation.usage,
		error: presentation.error,
	}
}

/**
 * Convert application ClineMessage to proto ClineMessage
 */
export function convertClineMessageToProto(message: AppClineMessage): ProtoClineMessage {
	// For sending messages, we need to provide values for required proto fields
	const askEnum = message.ask ? convertClineAskToProtoEnum(message.ask) : undefined
	const sayEnum = message.say ? convertClineSayToProtoEnum(message.say) : undefined
	const imageGeneration = message.imageGeneration ?? parseImageGenerationToolText(message.text)

	// Determine appropriate enum values based on message type
	let finalAskEnum: ClineAsk = ClineAsk.FOLLOWUP // Proto default
	let finalSayEnum: ClineSay = ClineSay.TEXT // Proto default

	if (message.type === "ask") {
		finalAskEnum = askEnum ?? ClineAsk.FOLLOWUP // Use FOLLOWUP as default for ask messages
	} else if (message.type === "say") {
		finalSayEnum = sayEnum ?? ClineSay.TEXT // Use TEXT as default for say messages
	}

	const protoMessage: ProtoClineMessage = {
		ts: message.ts,
		type: message.type === "ask" ? ClineMessageType.ASK : ClineMessageType.SAY,
		ask: finalAskEnum,
		say: finalSayEnum,
		text: message.text ?? "",
		reasoning: message.reasoning ?? "",
		images: message.images ?? [],
		files: message.files ?? [],
		partial: message.partial ?? false,
		lastCheckpointHash: message.lastCheckpointHash ?? [],
		checkpointWorkspaceRoots: message.checkpointWorkspaceRoots ?? [],
		isCheckpointCheckedOut: message.isCheckpointCheckedOut ?? false,
		completionHasChanges: message.completionHasChanges ?? false,
		isOperationOutsideWorkspace: message.isOperationOutsideWorkspace ?? false,
		conversationHistoryIndex: message.conversationHistoryIndex ?? 0,
		conversationHistoryDeletedRange: message.conversationHistoryDeletedRange
			? {
					startIndex: message.conversationHistoryDeletedRange[0],
					endIndex: message.conversationHistoryDeletedRange[1],
				}
			: undefined,
		// Additional optional fields for specific ask/say types
		sayTool: undefined,
		sayBrowserAction: undefined,
		browserActionResult: undefined,
		askUseMcpServer: undefined,
		makePlanResponse: undefined,
		askQuestion: undefined,
		askNewTask: undefined,
		askSpawnTask: undefined,
		apiReqInfo: undefined,
		modelInfo: message.modelInfo ?? undefined,
		commandStatus: message.commandStatus ?? "",
		exitCode: message.exitCode ?? 0,
		logPath: message.logPath ?? "",
		commandTs: message.commandTs ?? 0,
		activityId: message.activityId ?? "",
		interactionId: message.interactionId ?? "",
		commandExecutionMode: message.commandExecutionMode ?? "",
		commandCanMoveToBackground: message.commandCanMoveToBackground ?? false,
		compactionConversationRange: message.compactionConversationRange
			? {
					logicalTurnStartIndex: message.compactionConversationRange.logicalTurnRange[0],
					logicalTurnEndIndex: message.compactionConversationRange.logicalTurnRange[1],
					apiConversationStartIndex: message.compactionConversationRange.apiConversationRange[0],
					apiConversationEndIndex: message.compactionConversationRange.apiConversationRange[1],
					preCompactionApiEndIndex: message.compactionConversationRange.preCompactionApiEndIndex,
				}
			: undefined,
		userInputKind: message.userInputKind ?? "",
		queuedInputMode: message.queuedInputMode ?? "",
		imageGeneration: convertImageGenerationToProto(imageGeneration),
	}

	return protoMessage
}

/**
 * Convert proto ClineMessage to application ClineMessage
 */
export function convertProtoToClineMessage(protoMessage: ProtoClineMessage): AppClineMessage {
	const message: AppClineMessage = {
		ts: protoMessage.ts,
		type: protoMessage.type === ClineMessageType.ASK ? "ask" : "say",
	}

	// Convert ask enum to string
	if (protoMessage.type === ClineMessageType.ASK) {
		const ask = convertProtoEnumToClineAsk(protoMessage.ask)
		if (ask !== undefined) {
			message.ask = ask
		}
	}

	// Convert say enum to string
	if (protoMessage.type === ClineMessageType.SAY) {
		const say = convertProtoEnumToClineSay(protoMessage.say)
		if (say !== undefined) {
			message.say = say
		}
	}

	// Convert other fields - preserve empty strings as they may be intentional
	if (protoMessage.text !== "") {
		message.text = protoMessage.text
	}
	if (protoMessage.reasoning !== "") {
		message.reasoning = protoMessage.reasoning
	}
	if (protoMessage.images.length > 0) {
		message.images = protoMessage.images
	}
	if (protoMessage.files.length > 0) {
		message.files = protoMessage.files
	}
	if (protoMessage.partial) {
		message.partial = protoMessage.partial
	}
	if (protoMessage.lastCheckpointHash.length > 0) {
		message.lastCheckpointHash = protoMessage.lastCheckpointHash
	}
	if (protoMessage.checkpointWorkspaceRoots.length > 0) {
		message.checkpointWorkspaceRoots = protoMessage.checkpointWorkspaceRoots
	}
	if (protoMessage.isCheckpointCheckedOut) {
		message.isCheckpointCheckedOut = protoMessage.isCheckpointCheckedOut
	}
	if (protoMessage.completionHasChanges) {
		message.completionHasChanges = protoMessage.completionHasChanges
	}
	if (protoMessage.isOperationOutsideWorkspace) {
		message.isOperationOutsideWorkspace = protoMessage.isOperationOutsideWorkspace
	}
	if (protoMessage.conversationHistoryIndex !== 0) {
		message.conversationHistoryIndex = protoMessage.conversationHistoryIndex
	}

	// Convert conversationHistoryDeletedRange from object to tuple
	if (protoMessage.conversationHistoryDeletedRange) {
		message.conversationHistoryDeletedRange = [
			protoMessage.conversationHistoryDeletedRange.startIndex,
			protoMessage.conversationHistoryDeletedRange.endIndex,
		]
	}
	if (protoMessage.compactionConversationRange) {
		message.compactionConversationRange = {
			logicalTurnRange: [
				protoMessage.compactionConversationRange.logicalTurnStartIndex,
				protoMessage.compactionConversationRange.logicalTurnEndIndex,
			],
			apiConversationRange: [
				protoMessage.compactionConversationRange.apiConversationStartIndex,
				protoMessage.compactionConversationRange.apiConversationEndIndex,
			],
			preCompactionApiEndIndex: protoMessage.compactionConversationRange.preCompactionApiEndIndex,
		}
	}

	// Convert command state fields (commandStatus/exitCode/logPath)
	if (protoMessage.commandStatus !== "") {
		message.commandStatus = protoMessage.commandStatus as CommandStatus
		// exitCode is meaningful when commandStatus is set (includes 0 for success)
		message.exitCode = protoMessage.exitCode
	}
	if (protoMessage.logPath !== "") {
		message.logPath = protoMessage.logPath
	}
	if (protoMessage.commandTs !== 0) {
		message.commandTs = protoMessage.commandTs
	}
	if (protoMessage.activityId !== "") {
		message.activityId = protoMessage.activityId
	}
	if (protoMessage.interactionId !== "") {
		message.interactionId = protoMessage.interactionId
	}
	if (protoMessage.commandExecutionMode !== "") {
		message.commandExecutionMode = protoMessage.commandExecutionMode as AppClineMessage["commandExecutionMode"]
	}
	if (protoMessage.commandCanMoveToBackground) {
		message.commandCanMoveToBackground = true
	}
	if (protoMessage.userInputKind !== "") {
		message.userInputKind = protoMessage.userInputKind as AppClineMessage["userInputKind"]
	}
	if (protoMessage.queuedInputMode !== "") {
		message.queuedInputMode = protoMessage.queuedInputMode as AppClineMessage["queuedInputMode"]
	}
	if (protoMessage.imageGeneration) {
		const imageGeneration = parseImageGenerationPresentation(protoMessage.imageGeneration)
		if (imageGeneration) message.imageGeneration = imageGeneration
	}

	return message
}
