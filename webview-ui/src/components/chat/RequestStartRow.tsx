import type { UiMessage, UiSayTool } from "@shared/ExtensionMessage"
import type { Mode } from "@shared/storage/types"
import type React from "react"
import { useMemo } from "react"
import { cleanPathPrefix } from "../common/CodeAccordian"
import { getIconByToolName } from "./chat-view"
import { isApiReqAbsorbable, isLowStakesTool } from "./chat-view/utils/messageUtils"
import ErrorRow from "./ErrorRow"
import { TypewriterText } from "./TypewriterText"

interface UsageInfo {
    tokensIn?: number
    tokensOut?: number
    cacheWrites?: number
    cacheReads?: number
    cacheHitRate?: number
    currency?: string
    inputPrice?: number
    outputPrice?: number
}

interface RequestStartRowProps {
    message: UiMessage
    apiRequestFailedMessage?: string
    apiReqStreamingFailedMessage?: string
    cost?: number
    clineMessages: UiMessage[]
    mode?: Mode
    classNames?: string
    usageInfo?: UsageInfo
}

// State type for api_req_started rendering
type ApiReqState = "pre" | "error" | "final"

// Helper to format search regex for display - show all terms separated by |
const formatSearchRegex = (regex: string, path: string, filePattern?: string): string => {
    const cleanedPath = cleanPathPrefix(path)
    const terms = regex
        .split("|")
        .map((t) => t.trim().replace(/\\b/g, "").replace(/\\s\?/g, " "))
        .filter(Boolean)
        .join(" | ")
    return filePattern && filePattern !== "*" ? `"${terms}" in ${cleanedPath}/ (${filePattern})` : `"${terms}" in ${cleanedPath}/`
}
// Format activity text based on tool type
const getActivityText = (tool: UiSayTool): string | null => {
    const cleanedPath = cleanPathPrefix(tool.path || "")
    switch (tool.tool) {
        case "readFile":
            return tool.path ? `Reading ${cleanedPath}...` : null
        case "listFilesTopLevel":
        case "listFilesRecursive":
            return tool.path ? `Exploring ${cleanedPath}/...` : null
        case "searchFiles":
            return tool.regex && tool.path ? `Searching ${formatSearchRegex(tool.regex, tool.path, tool.filePattern)}...` : null
        case "listCodeDefinitionNames":
            return tool.path ? `Analyzing ${cleanedPath}/...` : null
        default:
            return null
    }
}

// Collect tools in a given range, with optional stop condition
const collectToolsInRange = (
    messages: UiMessage[],
    startIdx: number,
    endIdx: number,
    stopCondition?: (msg: UiMessage) => boolean,
): { icon: React.ElementType; text: string }[] => {
    const activities: { icon: React.ElementType; text: string }[] = []

    for (let i = startIdx; i < endIdx; i++) {
        const msg = messages[i]

        if (stopCondition?.(msg)) {
            break
        }

        // Only collect tools that are currently executing (ask === "tool")
        // Skip completed tools (say === "tool") - they should be in the completed list
        if (msg.say === "tool" || msg.ask !== "tool") {
            continue
        }

        try {
            const tool = JSON.parse(msg.text || "{}") as UiSayTool
            const activityText = getActivityText(tool)
            if (activityText) {
                const toolIcon = getIconByToolName(tool.tool)
                activities.push({ icon: toolIcon, text: activityText })
            }
        } catch {
            // ignore parse errors
        }
    }
    return activities
}

// Find current api_req and determine if it has cost
const findCurrentApiReq = (messages: UiMessage[]): { index: number; hasCost: boolean } | null => {
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.say === "api_req_started" && msg.text) {
            try {
                const info = JSON.parse(msg.text)
                return { index: i, hasCost: info.cost != null }
            } catch {
                return null
            }
        }
    }
    return null
}

// Find the most recent completed api_req before the given index
const _findPrevCompletedApiReq = (messages: UiMessage[], beforeIdx: number): number => {
    for (let i = beforeIdx - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg.say === "api_req_started" && msg.text) {
            try {
                const info = JSON.parse(msg.text)
                if (info.cost != null) {
                    return i
                }
            } catch {
                // ignore parse errors
            }
        }
    }
    return -1
}

/**
 * Displays the current state of an active tool operation and request failures.
 *
 * Reasoning is never drawn here: every reasoning message has its own row, and a
 * request row that also drew it rendered the same Thinking block twice.
 */
export const RequestStartRow: React.FC<RequestStartRowProps> = ({
    apiRequestFailedMessage,
    apiReqStreamingFailedMessage,
    cost,
    clineMessages,
    mode,
    message,
    usageInfo,
}) => {
    // Derive explicit state
    const hasError = !!(apiRequestFailedMessage || apiReqStreamingFailedMessage)
    const hasCost = cost != null
    const _hasCompletionResult = clineMessages.some(
        (msg) => msg.ask === "completion_result" || msg.say === "completion_result" || msg.ask === "make_plan",
    )

    const apiReqState: ApiReqState = hasError ? "error" : hasCost ? "final" : "pre"

    // Check if this api_req will be absorbed into a tool group (reasoning will disappear)
    const _willBeAbsorbed = useMemo(() => {
        return isApiReqAbsorbable(message.ts, clineMessages)
    }, [message.ts, clineMessages])

    // Find all exploratory tool activities that are currently in flight.
    // Tools come AFTER the api_req_started message, so we look from currentApiReq forward.
    const currentActivities = useMemo(() => {
        const currentApiReq = findCurrentApiReq(clineMessages)
        if (!currentApiReq) {
            return []
        }

        if (!currentApiReq.hasCost) {
            // CASE A: Current api_req is INCOMPLETE
            // Look for ask === "tool" messages AFTER the current api_req_started
            return collectToolsInRange(clineMessages, currentApiReq.index + 1, clineMessages.length)
        }
        // CASE B: Current api_req is COMPLETE - no activities to show
        return []
    }, [clineMessages])

    // Check if there are any completed tools in the tool group
    const hasCompletedTools = useMemo(() => {
        // Look for any completed low-stakes tool messages that would be in a tool group
        return clineMessages.some((msg, idx) => {
            if (msg.say === "tool" && isLowStakesTool(msg)) {
                // Check if this tool is from a completed API request
                // (looking backwards for an api_req with cost)
                for (let i = idx - 1; i >= 0; i--) {
                    const prevMsg = clineMessages[i]
                    if (prevMsg.say === "api_req_started" && prevMsg.text) {
                        try {
                            const info = JSON.parse(prevMsg.text)
                            return info.cost != null
                        } catch {
                            return false
                        }
                    }
                }
            }
            return false
        })
    }, [clineMessages])

    // Only show currentActivities if there are NO completed tools
    // (otherwise they'll be shown in the unified ToolGroupRenderer list)
    const shouldShowActivities = currentActivities.length > 0 && !hasCompletedTools

    // Initial loading ("Thinking..." before any content) is injected as a synthetic in-list
    // reasoning row in MessagesArea to avoid footer handoff flicker.

    return (
        <div>
            {apiReqState === "pre" && shouldShowActivities && (
                <div className="flex items-center text-description w-full text-sm">
                    <div className="ml-1 flex-1 w-full h-full">
                        <div className="flex flex-col gap-0.5 w-full min-h-1">
                            {currentActivities.map((activity, _) => (
                                <div className="flex items-center gap-2 h-auto w-full overflow-hidden" key={activity.text}>
                                    <activity.icon className="size-2 text-foreground shrink-0" />
                                    <TypewriterText speed={15} text={activity.text} />
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}
            {apiReqState === "error" && (
                <ErrorRow
                    apiReqStreamingFailedMessage={apiReqStreamingFailedMessage}
                    apiRequestFailedMessage={apiRequestFailedMessage}
                    errorType="error"
                    message={message}
                />
            )}
        </div>
    )
}
