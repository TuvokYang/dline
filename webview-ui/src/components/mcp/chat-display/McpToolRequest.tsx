import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import { Fragment, useState } from "react"
import { cn } from "@/lib/utils"

interface McpToolRequestProps {
    toolName: string
    description: string
    /** Raw JSON arguments of the call. Absent or `{}` renders no arguments block. */
    argumentsJson?: string
    /** With a response below, the details keep at most 30vh so the response always has room. */
    hasResponse: boolean
}

type ArgumentsView = { kind: "fields"; fields: [string, string][] } | { kind: "raw"; text: string }

const EDITOR_FONT = { fontFamily: "var(--vscode-editor-font-family, monospace)" }

/** Shared frame of the description and arguments boxes. */
const DETAILS_FRAME = "m-0 rounded-xs border border-(--vscode-editorGroup-border) p-2 text-[12px]"

/** String values are shown verbatim; JSON would escape their quotes as `\"`. */
function formatArgumentValue(value: unknown): string {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2)
}

function toArgumentsView(argumentsJson: string): ArgumentsView {
    try {
        const parsed: unknown = JSON.parse(argumentsJson)
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            return {
                kind: "fields",
                fields: Object.entries(parsed).map(([name, value]) => [name, formatArgumentValue(value)]),
            }
        }
        return { kind: "raw", text: JSON.stringify(parsed, null, 2) }
    } catch {
        return { kind: "raw", text: argumentsJson }
    }
}

function McpToolArguments({ argumentsJson }: { argumentsJson: string }) {
    const view = toArgumentsView(argumentsJson)
    if (view.kind === "raw") {
        return (
            <pre
                className={cn(DETAILS_FRAME, "whitespace-pre-wrap break-all")}
                data-testid="mcp-tool-arguments"
                style={EDITOR_FONT}>
                {view.text}
            </pre>
        )
    }
    return (
        <dl
            className={cn(DETAILS_FRAME, "grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1")}
            data-testid="mcp-tool-arguments"
            style={EDITOR_FONT}>
            {view.fields.map(([name, value]) => (
                <Fragment key={name}>
                    <dt className="text-(--vscode-textPreformat-foreground)">{name}</dt>
                    <dd className="m-0 min-w-0 whitespace-pre-wrap break-all">{value}</dd>
                </Fragment>
            ))}
        </dl>
    )
}

function DetailsHeading({ children }: { children: string }) {
    return <div className="mb-1 opacity-80 uppercase">{children}</div>
}

/**
 * The request half of an MCP tool card. The tool name is a fixed title that folds and
 * reopens the description and arguments, which scroll beneath it on their own.
 */
const McpToolRequest = ({ toolName, description, argumentsJson, hasResponse }: McpToolRequestProps) => {
    const [isExpanded, setIsExpanded] = useState(true)
    const hasArguments = !!argumentsJson && argumentsJson !== "{}"
    const hasDetails = !!description || hasArguments
    const showDetails = hasDetails && isExpanded

    return (
        <>
            <button
                aria-expanded={hasDetails ? isExpanded : undefined}
                className={cn(
                    "flex w-full shrink-0 items-center gap-1.5 border-0 bg-transparent px-2.5 pt-2 text-left font-medium text-inherit",
                    showDetails ? "pb-1" : "pb-2",
                    hasDetails ? "cursor-pointer select-none" : "cursor-default",
                )}
                data-testid="mcp-tool-title"
                disabled={!hasDetails}
                onClick={() => setIsExpanded((expanded) => !expanded)}
                type="button">
                {hasDetails &&
                    (isExpanded ? (
                        <ChevronDownIcon className="size-4 shrink-0" />
                    ) : (
                        <ChevronRightIcon className="size-4 shrink-0" />
                    ))}
                <span className="codicon codicon-symbol-method shrink-0" />
                <span className="min-w-0 truncate">{toolName}</span>
            </button>
            {showDetails && (
                <div
                    className={cn(
                        "themed-scrollbar min-h-0 overflow-y-auto overscroll-x-contain px-2.5 pb-2",
                        hasResponse && "max-h-[30vh] shrink-0",
                    )}
                    data-testid="mcp-request-body">
                    {description && (
                        <div>
                            <DetailsHeading>Description</DetailsHeading>
                            <div
                                className={cn(DETAILS_FRAME, "text-description whitespace-pre-wrap break-words")}
                                data-testid="mcp-tool-description">
                                {description}
                            </div>
                        </div>
                    )}
                    {hasArguments && argumentsJson && (
                        <div className={cn(description && "mt-2")}>
                            <DetailsHeading>Arguments</DetailsHeading>
                            <McpToolArguments argumentsJson={argumentsJson} />
                        </div>
                    )}
                </div>
            )}
        </>
    )
}

export default McpToolRequest
