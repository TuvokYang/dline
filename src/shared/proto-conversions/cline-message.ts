import {
    UiAsk as AppClineAsk,
    UiMessage as AppClineMessage,
    UiSay as AppClineSay,
    type CommandStatus,
} from "@shared/ExtensionMessage"
import {
    type ImageGenerationPresentationV1,
    parseImageGenerationPresentation,
    parseImageGenerationToolText,
} from "@shared/image-generation"
// The proto wire keeps its original Cline* message and enum names; only the application types were renamed.
import {
    ClineMessageType,
    ClineAsk as ProtoAsk,
    ClineMessage as ProtoClineMessage,
    type ImageGenerationPresentation as ProtoImageGenerationPresentation,
    ClineSay as ProtoSay,
} from "@shared/proto/dline/ui"

// Helper function to convert UiAsk string to enum
function convertClineAskToProtoEnum(ask: AppClineAsk | undefined): ProtoAsk | undefined {
    if (!ask) {
        return undefined
    }

    const mapping: Record<AppClineAsk, ProtoAsk> = {
        followup: ProtoAsk.FOLLOWUP,
        make_plan: ProtoAsk.MAKE_PLAN,
        act_mode_respond: ProtoAsk.ACT_MODE_RESPOND,
        command: ProtoAsk.COMMAND,
        command_output: ProtoAsk.COMMAND_OUTPUT,
        completion_result: ProtoAsk.COMPLETION_RESULT,
        tool: ProtoAsk.TOOL,
        api_req_failed: ProtoAsk.API_REQ_FAILED,
        resume_task: ProtoAsk.RESUME_TASK,
        resume_completed_task: ProtoAsk.RESUME_COMPLETED_TASK,
        mistake_limit_reached: ProtoAsk.MISTAKE_LIMIT_REACHED,
        browser_action_launch: ProtoAsk.BROWSER_ACTION_LAUNCH,
        use_mcp_server: ProtoAsk.USE_MCP_SERVER,
        new_task: ProtoAsk.NEW_TASK,
        condense: ProtoAsk.CONDENSE,
        summarize_task: ProtoAsk.SUMMARIZE_TASK,
        report_bug: ProtoAsk.REPORT_BUG,
        use_subagents: ProtoAsk.USE_SUBAGENTS,
        spawn_task: ProtoAsk.SPAWN_TASK,
        qna_respond: ProtoAsk.QNA_RESPOND,
        change_todo_list: ProtoAsk.CHANGE_TODO_LIST,
        status_acknowledgment: ProtoAsk.STATUS_ACKNOWLEDGMENT,
        generate_report: ProtoAsk.GENERATE_REPORT_ASK,
    }

    const result = mapping[ask]
    if (result === undefined) {
    }
    return result
}

// Helper function to convert ProtoAsk enum to string
function convertProtoEnumToClineAsk(ask: ProtoAsk): AppClineAsk | undefined {
    if (ask === ProtoAsk.UNRECOGNIZED) {
        return undefined
    }

    const mapping: Record<Exclude<ProtoAsk, ProtoAsk.UNRECOGNIZED>, AppClineAsk> = {
        [ProtoAsk.FOLLOWUP]: "followup",
        [ProtoAsk.MAKE_PLAN]: "make_plan",
        [ProtoAsk.ACT_MODE_RESPOND]: "act_mode_respond",
        [ProtoAsk.COMMAND]: "command",
        [ProtoAsk.COMMAND_OUTPUT]: "command_output",
        [ProtoAsk.COMPLETION_RESULT]: "completion_result",
        [ProtoAsk.TOOL]: "tool",
        [ProtoAsk.API_REQ_FAILED]: "api_req_failed",
        [ProtoAsk.RESUME_TASK]: "resume_task",
        [ProtoAsk.RESUME_COMPLETED_TASK]: "resume_completed_task",
        [ProtoAsk.MISTAKE_LIMIT_REACHED]: "mistake_limit_reached",
        [ProtoAsk.BROWSER_ACTION_LAUNCH]: "browser_action_launch",
        [ProtoAsk.USE_MCP_SERVER]: "use_mcp_server",
        [ProtoAsk.NEW_TASK]: "new_task",
        [ProtoAsk.CONDENSE]: "condense",
        [ProtoAsk.SUMMARIZE_TASK]: "summarize_task",
        [ProtoAsk.REPORT_BUG]: "report_bug",
        [ProtoAsk.USE_SUBAGENTS]: "use_subagents",
        [ProtoAsk.SPAWN_TASK]: "spawn_task",
        [ProtoAsk.QNA_RESPOND]: "qna_respond",
        [ProtoAsk.CHANGE_TODO_LIST]: "change_todo_list",
        [ProtoAsk.STATUS_ACKNOWLEDGMENT]: "status_acknowledgment",
        [ProtoAsk.GENERATE_REPORT_ASK]: "generate_report",
    }

    return mapping[ask]
}

// Helper function to convert ProtoSay string to enum
function convertClineSayToProtoEnum(say: AppClineSay | undefined): ProtoSay | undefined {
    if (!say) {
        return undefined
    }

    const mapping: Record<AppClineSay, ProtoSay> = {
        task: ProtoSay.TASK,
        error: ProtoSay.ERROR,
        api_req_started: ProtoSay.API_REQ_STARTED,
        api_req_finished: ProtoSay.API_REQ_FINISHED,
        text: ProtoSay.TEXT,
        reasoning: ProtoSay.REASONING,
        qna_respond: ProtoSay.QNA_RESPOND_SAY,
        completion_result: ProtoSay.COMPLETION_RESULT_SAY,
        user_feedback: ProtoSay.USER_FEEDBACK,
        user_feedback_diff: ProtoSay.USER_FEEDBACK_DIFF,
        api_req_retried: ProtoSay.API_REQ_RETRIED,
        command: ProtoSay.COMMAND_SAY,
        command_output: ProtoSay.COMMAND_OUTPUT_SAY,
        tool: ProtoSay.TOOL_SAY,
        shell_integration_warning: ProtoSay.SHELL_INTEGRATION_WARNING,
        shell_integration_warning_with_suggestion: ProtoSay.SHELL_INTEGRATION_WARNING,
        browser_action_launch: ProtoSay.BROWSER_ACTION_LAUNCH_SAY,
        browser_action: ProtoSay.BROWSER_ACTION,
        browser_action_result: ProtoSay.BROWSER_ACTION_RESULT,
        mcp_server_request_started: ProtoSay.MCP_SERVER_REQUEST_STARTED,
        mcp_server_response: ProtoSay.MCP_SERVER_RESPONSE,
        mcp_notification: ProtoSay.MCP_NOTIFICATION,
        use_mcp_server: ProtoSay.USE_MCP_SERVER_SAY,
        diff_error: ProtoSay.DIFF_ERROR,
        deleted_api_reqs: ProtoSay.DELETED_API_REQS,
        clineignore_error: ProtoSay.CLINEIGNORE_ERROR,
        command_permission_denied: ProtoSay.COMMAND_PERMISSION_DENIED,
        checkpoint_created: ProtoSay.CHECKPOINT_CREATED,
        load_mcp_documentation: ProtoSay.LOAD_MCP_DOCUMENTATION,
        info: ProtoSay.INFO,
        task_progress: ProtoSay.TASK_PROGRESS,
        error_retry: ProtoSay.ERROR_RETRY,
        hook_status: ProtoSay.HOOK_STATUS,
        hook_output_stream: ProtoSay.HOOK_OUTPUT_STREAM,
        conditional_rules_applied: ProtoSay.CONDITIONAL_RULES_APPLIED,
        partial_tool_result: ProtoSay.PARTIAL_TOOL_RESULT,
        subagent: ProtoSay.SUBAGENT_STATUS,
        use_subagents: ProtoSay.USE_SUBAGENTS_SAY,
        subagent_usage: ProtoSay.SUBAGENT_USAGE,
        generate_explanation: ProtoSay.GENERATE_EXPLANATION,
        state_snapshot: ProtoSay.STATE_SNAPSHOT,
    }

    const result = mapping[say]

    return result
}

// Helper function to convert ProtoSay enum to string
function convertProtoEnumToClineSay(say: ProtoSay): AppClineSay | undefined {
    if (say === ProtoSay.UNRECOGNIZED) {
        return undefined
    }

    const mapping: Record<Exclude<ProtoSay, ProtoSay.UNRECOGNIZED>, AppClineSay> = {
        [ProtoSay.TASK]: "task",
        [ProtoSay.ERROR]: "error",
        [ProtoSay.API_REQ_STARTED]: "api_req_started",
        [ProtoSay.API_REQ_FINISHED]: "api_req_finished",
        [ProtoSay.TEXT]: "text",
        [ProtoSay.REASONING]: "reasoning",
        [ProtoSay.COMPLETION_RESULT_SAY]: "completion_result",
        [ProtoSay.USER_FEEDBACK]: "user_feedback",
        [ProtoSay.USER_FEEDBACK_DIFF]: "user_feedback_diff",
        [ProtoSay.API_REQ_RETRIED]: "api_req_retried",
        [ProtoSay.COMMAND_SAY]: "command",
        [ProtoSay.COMMAND_OUTPUT_SAY]: "command_output",
        [ProtoSay.TOOL_SAY]: "tool",
        [ProtoSay.SHELL_INTEGRATION_WARNING]: "shell_integration_warning",
        [ProtoSay.BROWSER_ACTION_LAUNCH_SAY]: "browser_action_launch",
        [ProtoSay.BROWSER_ACTION]: "browser_action",
        [ProtoSay.BROWSER_ACTION_RESULT]: "browser_action_result",
        [ProtoSay.MCP_SERVER_REQUEST_STARTED]: "mcp_server_request_started",
        [ProtoSay.MCP_SERVER_RESPONSE]: "mcp_server_response",
        [ProtoSay.MCP_NOTIFICATION]: "mcp_notification",
        [ProtoSay.USE_MCP_SERVER_SAY]: "use_mcp_server",
        [ProtoSay.DIFF_ERROR]: "diff_error",
        [ProtoSay.DELETED_API_REQS]: "deleted_api_reqs",
        [ProtoSay.CLINEIGNORE_ERROR]: "clineignore_error",
        [ProtoSay.COMMAND_PERMISSION_DENIED]: "command_permission_denied",
        [ProtoSay.CHECKPOINT_CREATED]: "checkpoint_created",
        [ProtoSay.LOAD_MCP_DOCUMENTATION]: "load_mcp_documentation",
        [ProtoSay.INFO]: "info",
        [ProtoSay.TASK_PROGRESS]: "task_progress",
        [ProtoSay.ERROR_RETRY]: "error_retry",
        [ProtoSay.GENERATE_EXPLANATION]: "generate_explanation",
        [ProtoSay.HOOK_STATUS]: "hook_status",
        [ProtoSay.HOOK_OUTPUT_STREAM]: "hook_output_stream",
        [ProtoSay.CONDITIONAL_RULES_APPLIED]: "conditional_rules_applied",
        [ProtoSay.PARTIAL_TOOL_RESULT]: "partial_tool_result",
        [ProtoSay.SUBAGENT_STATUS]: "subagent",
        [ProtoSay.USE_SUBAGENTS_SAY]: "use_subagents",
        [ProtoSay.SUBAGENT_USAGE]: "subagent_usage",
        [ProtoSay.QNA_RESPOND_SAY]: "qna_respond",
        [ProtoSay.STATE_SNAPSHOT]: "state_snapshot",
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
 * Convert application UiMessage to proto UiMessage
 */
export function convertClineMessageToProto(message: AppClineMessage): ProtoClineMessage {
    // For sending messages, we need to provide values for required proto fields
    const askEnum = message.ask ? convertClineAskToProtoEnum(message.ask) : undefined
    const sayEnum = message.say ? convertClineSayToProtoEnum(message.say) : undefined
    const imageGeneration = message.imageGeneration ?? parseImageGenerationToolText(message.text)

    // Determine appropriate enum values based on message type
    let finalAskEnum: ProtoAsk = ProtoAsk.FOLLOWUP // Proto default
    let finalSayEnum: ProtoSay = ProtoSay.TEXT // Proto default

    if (message.type === "ask") {
        finalAskEnum = askEnum ?? ProtoAsk.FOLLOWUP // Use FOLLOWUP as default for ask messages
    } else if (message.type === "say") {
        finalSayEnum = sayEnum ?? ProtoSay.TEXT // Use TEXT as default for say messages
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
 * Convert proto UiMessage to application UiMessage
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
