import type { LoadCapabilityDetail, LoadCapabilityPayload } from "@shared/load-capabilities"
import { AlertCircleIcon, CheckCircle2Icon, ChevronDownIcon, ChevronRightIcon, LoaderCircleIcon } from "lucide-react"
import { useMemo } from "react"
import { TOOL_RESPONSE_SCROLL_CLASS } from "./constants"

interface LoadCapabilityRowProps {
    payload: LoadCapabilityPayload
    isExpanded: boolean
    onToggleExpand: () => void
}

const KIND_LABELS: Record<LoadCapabilityPayload["kind"], string> = {
    mcp: "MCP",
    skill: "Skill",
    workflow: "Workflow",
}

/**
 * Render a structured load_xxx tool result row.
 *
 * @param props Component props containing payload and expansion state.
 * @returns React element for loading, completed, or failed capability load states.
 */
export default function LoadCapabilityRow({ payload, isExpanded, onToggleExpand }: LoadCapabilityRowProps) {
    const title = useMemo(() => buildTitle(payload), [payload])
    const details = payload.details ?? []
    const canExpand = payload.status === "completed" && (details.length > 0 || !!payload.body)

    return (
        <div>
            <div className="flex items-center gap-2.5 mb-3">
                <StatusIcon status={payload.status} />
                <span className="font-bold">{title}</span>
            </div>
            <div
                className={joinClasses(
                    "bg-code border border-editor-group-border overflow-hidden rounded-xs",
                    borderClass(payload.status),
                )}>
                <button
                    className={joinClasses(
                        "w-full text-left py-[9px] px-2.5 flex items-center gap-2",
                        canExpand ? "cursor-pointer" : "cursor-default",
                    )}
                    disabled={!canExpand}
                    onClick={canExpand ? onToggleExpand : undefined}
                    type="button">
                    <span className="ph-no-capture min-w-0 flex-1">
                        <span className="font-medium">{payload.name || "Unnamed capability"}</span>
                        {payload.source ? <span className="text-description ml-2">{payload.source}</span> : null}
                        {payload.summary ? (
                            <span className="block text-description mt-1 whitespace-pre-wrap">{payload.summary}</span>
                        ) : null}
                        {payload.error ? (
                            <span className="block text-error mt-1 whitespace-pre-wrap">{payload.error}</span>
                        ) : null}
                    </span>
                    {canExpand ? (
                        isExpanded ? (
                            <ChevronDownIcon className="size-4" />
                        ) : (
                            <ChevronRightIcon className="size-4" />
                        )
                    ) : null}
                </button>
                {canExpand && isExpanded ? <ExpandedContent body={payload.body} details={details} /> : null}
            </div>
        </div>
    )
}

/**
 * Render the status icon for a load capability payload.
 *
 * @param props Status prop.
 * @returns Icon element for the payload status.
 */
function StatusIcon({ status }: { status: LoadCapabilityPayload["status"] }) {
    if (status === "loading") {
        return <LoaderCircleIcon className="size-2 animate-spin" />
    }
    if (status === "failed") {
        return <AlertCircleIcon className="size-2 text-error" />
    }
    return <CheckCircle2Icon className="size-2 text-success" />
}

/**
 * Render expanded capability details and body.
 *
 * @param props Details and optional body content.
 * @returns Expanded detail section.
 */
function ExpandedContent({ details, body }: { details: LoadCapabilityDetail[]; body?: string }) {
    return (
        <div
            className={`border-t border-editor-group-border px-2.5 py-2 text-sm ${TOOL_RESPONSE_SCROLL_CLASS}`}
            data-testid="load-capability-details-scroll">
            {details.length > 0 ? (
                <dl className="space-y-1">
                    {details.map((detail) => (
                        <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-2" key={detail.label}>
                            <dt className="text-description">{detail.label}</dt>
                            <dd className="ph-no-capture whitespace-pre-wrap break-words">{formatDetail(detail.value)}</dd>
                        </div>
                    ))}
                </dl>
            ) : null}
            {body ? (
                <pre className="ph-no-capture mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">{body}</pre>
            ) : null}
        </div>
    )
}

/**
 * Build the row title from payload state.
 *
 * @param payload Load capability payload.
 * @returns Human-readable row title.
 */
function buildTitle(payload: LoadCapabilityPayload): string {
    const label = KIND_LABELS[payload.kind]
    if (payload.status === "loading") {
        return `Loading ${label}`
    }
    if (payload.status === "failed") {
        return `Failed to load ${label}`
    }
    return `Loaded ${label}`
}

/**
 * Select a border class for the status state.
 *
 * @param status Payload status.
 * @returns Tailwind class names for status decoration.
 */
function borderClass(status: LoadCapabilityPayload["status"]): string {
    if (status === "failed") {
        return "border-error/40"
    }
    if (status === "completed") {
        return "border-success/30"
    }
    return ""
}

/**
 * Format a detail value for rendering.
 *
 * @param value Detail value from the backend payload.
 * @returns Display text for the detail value.
 */
function formatDetail(value: LoadCapabilityDetail["value"]): string {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2)
}

/**
 * Join optional class names for simple conditional styling.
 *
 * @param classes Optional class names.
 * @returns Combined class names without empty values.
 */
function joinClasses(...classes: Array<string | undefined>): string {
    return classes.filter((className): className is string => Boolean(className)).join(" ")
}
