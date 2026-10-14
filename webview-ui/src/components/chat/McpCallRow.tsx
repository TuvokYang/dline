import type { UiAskUseMcpServer } from "@shared/ExtensionMessage"
import type { McpServer } from "@shared/mcp"
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import type { ReactNode } from "react"
import McpResponseDisplay from "@/components/mcp/chat-display/McpResponseDisplay"
import McpToolRequest from "@/components/mcp/chat-display/McpToolRequest"
import McpResourceRow from "@/components/mcp/configuration/tabs/installed/server-row/McpResourceRow"
import { cn } from "@/lib/utils"
import { findMatchingResourceOrTemplate } from "@/utils/mcp"
import { CHAT_ROW_HEADER_CLASSNAMES } from "./constants"

export interface McpCallRowProps {
    /** Header icon and title, built by the chat row like every other row header. */
    icon: ReactNode
    title: ReactNode
    request: UiAskUseMcpServer
    /** The connected server that owns the tool or resource, when it is known. */
    server?: McpServer
    /** Every response item of this call, in order. */
    responseTexts: string[]
    /** The response has landed and the call neither streams nor runs any more. */
    isFinal: boolean
    isExpanded: boolean
    onToggleExpand: () => void
}

function McpCallHeader({
    icon,
    title,
    toolName,
    isFinal,
    isExpanded,
    onToggleExpand,
}: Pick<McpCallRowProps, "icon" | "title" | "isFinal" | "isExpanded" | "onToggleExpand"> & { toolName?: string }) {
    if (!isFinal) {
        return (
            <div className={CHAT_ROW_HEADER_CLASSNAMES}>
                {icon}
                {title}
            </div>
        )
    }
    return (
        <button
            aria-expanded={isExpanded}
            aria-label={isExpanded ? "Collapse MCP call" : "Expand MCP call"}
            className={cn(
                CHAT_ROW_HEADER_CLASSNAMES,
                "w-full cursor-pointer select-none border-0 bg-transparent p-0 text-left text-inherit",
                !isExpanded && "mb-0",
            )}
            data-testid="mcp-call-toggle"
            onClick={onToggleExpand}
            type="button">
            {icon}
            <span className="min-w-0 flex-1">{title}</span>
            {!isExpanded && toolName ? <code className="min-w-0 truncate font-normal text-description">{toolName}</code> : null}
            {isExpanded ? <ChevronDownIcon className="size-4 shrink-0" /> : <ChevronRightIcon className="size-4 shrink-0" />}
        </button>
    )
}

function McpResourceRequest({
    request,
    server,
    hasResponse,
}: {
    request: UiAskUseMcpServer
    server?: McpServer
    hasResponse: boolean
}) {
    const uri = request.uri || ""
    const resource = findMatchingResourceOrTemplate(uri, server?.resources, server?.resourceTemplates) || {
        name: "",
        mimeType: "",
        description: "",
    }
    return (
        <div
            className={cn(
                "themed-scrollbar min-h-0 overflow-y-auto overscroll-x-contain px-2.5 py-2",
                hasResponse && "max-h-[30vh] shrink-0",
            )}
            data-testid="mcp-request-body">
            <McpResourceRow item={{ ...resource, uri }} />
        </div>
    )
}

/**
 * One MCP call as a single card. While the call is pending or running the card stays
 * open; once its response has landed the call is final and folds to its header,
 * request and response together, and the header reopens it.
 *
 * The card is capped at 60vh. With a response the request keeps at most 30vh so the
 * response always has room, and each part scrolls inside its own area.
 */
const McpCallRow = ({ icon, title, request, server, responseTexts, isFinal, isExpanded, onToggleExpand }: McpCallRowProps) => {
    const hasResponse = responseTexts.length > 0
    const showCard = !isFinal || isExpanded
    const toolDescription =
        request.type === "use_mcp_tool" ? server?.tools?.find((tool) => tool.name === request.toolName)?.description || "" : ""

    return (
        <div>
            <McpCallHeader
                icon={icon}
                isExpanded={isExpanded}
                isFinal={isFinal}
                onToggleExpand={onToggleExpand}
                title={title}
                toolName={request.toolName}
            />
            {showCard && (
                <div
                    className="bg-code rounded-xs mt-2 flex max-h-[60vh] flex-col overflow-hidden"
                    data-testid="mcp-request-card">
                    {request.type === "use_mcp_tool" && (
                        <McpToolRequest
                            argumentsJson={request.arguments}
                            description={toolDescription}
                            hasResponse={hasResponse}
                            toolName={request.toolName || ""}
                        />
                    )}
                    {request.type === "access_mcp_resource" && (
                        <McpResourceRequest hasResponse={hasResponse} request={request} server={server} />
                    )}
                    {hasResponse && (
                        <div className="flex min-h-0 flex-col" data-testid="mcp-response-group">
                            <McpResponseDisplay embedded responseText={responseTexts.join("\n\n")} />
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}

export default McpCallRow
