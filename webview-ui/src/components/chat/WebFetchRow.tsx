import type { ClineSayTool } from "@shared/ExtensionMessage"
import { StringRequest } from "@shared/proto/dline/common"
import { ChevronDownIcon, ChevronRightIcon, Link2Icon, TriangleAlertIcon } from "lucide-react"
import { type RefObject, useLayoutEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { UiServiceClient } from "@/services/grpc-client"
import HostedCallDeferredNotice from "./HostedCallDeferredNotice"

/** Collapsed preview height of the fetched content, matching the collapsed command output. */
const COLLAPSED_CONTENT_HEIGHT = "max-h-[120px]"
/** Expanded height, matching the other long chat cards so one page cannot take over the view. */
const EXPANDED_CONTENT_HEIGHT = "max-h-[60vh]"

interface WebFetchRowProps {
	messageType: "ask" | "say"
	url?: string
	webFetch?: ClineSayTool["webFetch"]
}

function sourceLabel(webFetch: ClineSayTool["webFetch"]): string | undefined {
	const source = webFetch?.source
	if (!source) return undefined
	const suffix = source.execution === "hosted" ? "Hosted" : "Dline"
	return `${source.label} (${suffix})`
}

/**
 * Whether the content is taller than the collapsed preview.
 *
 * Measured only while collapsed: once expanded the element grows, and the toggle must stay available to collapse it.
 */
function useOverflowsCollapsedHeight(ref: RefObject<HTMLElement | null>, content: string | undefined, expanded: boolean) {
	const [overflows, setOverflows] = useState(false)
	// biome-ignore lint/correctness/useExhaustiveDependencies: the text change itself must re-measure, because the ResizeObserver that would notice it is not available in every host.
	useLayoutEffect(() => {
		const element = ref.current
		if (!element || expanded) return
		const measure = () => setOverflows(element.scrollHeight > element.clientHeight)
		measure()
		if (typeof ResizeObserver === "undefined") return
		const observer = new ResizeObserver(measure)
		observer.observe(element)
		return () => observer.disconnect()
	}, [content, expanded])
	return overflows
}

const FetchedContent = ({ content }: { content: string }) => {
	const [expanded, setExpanded] = useState(false)
	const scrollRef = useRef<HTMLDivElement>(null)
	const overflows = useOverflowsCollapsedHeight(scrollRef, content, expanded)

	return (
		<div className="border-t border-editor-widget-border/50 pt-2">
			<div
				className={cn(
					"overflow-y-auto overscroll-contain pr-1",
					expanded ? EXPANDED_CONTENT_HEIGHT : COLLAPSED_CONTENT_HEIGHT,
				)}
				data-testid="web-fetch-results"
				ref={scrollRef}>
				<div className="ph-no-capture break-words whitespace-pre-wrap text-xs">{content}</div>
			</div>
			{(overflows || expanded) && (
				<button
					aria-expanded={expanded}
					aria-label={expanded ? "Collapse fetched web content" : "Expand fetched web content"}
					className="mt-1 flex w-full shrink-0 cursor-pointer items-center gap-1 border-0 border-t border-editor-widget-border/50 bg-transparent pt-1.5 text-left text-xs text-description"
					data-testid="web-fetch-details-toggle"
					onClick={() => setExpanded((value) => !value)}
					type="button">
					{expanded ? (
						<ChevronDownIcon aria-hidden="true" className="size-3 shrink-0" />
					) : (
						<ChevronRightIcon aria-hidden="true" className="size-3 shrink-0" />
					)}
					<span>{expanded ? "Collapse fetched content" : "Show all fetched content"}</span>
				</button>
			)}
		</div>
	)
}

const WebFetchRow = ({ messageType, url, webFetch }: WebFetchRowProps) => {
	const resolvedUrl = webFetch?.url || url || ""
	const label = sourceLabel(webFetch)

	return (
		<div className="pr-1" data-testid="web-fetch-card">
			<div className="mb-3 flex items-center gap-2.5">
				<Link2Icon className="size-2" />
				<span className="font-bold">
					{messageType === "ask"
						? "Dline wants to fetch content from this URL:"
						: "Dline fetched content from this URL:"}
				</span>
			</div>
			<div className="space-y-2 overflow-hidden rounded-xs border border-editor-group-border bg-code px-2.5 py-[9px] select-text">
				{label && <div className="text-xs font-semibold text-description">{label}</div>}
				<button
					className="w-full cursor-pointer text-left text-link underline"
					onClick={() => {
						if (!resolvedUrl) return
						UiServiceClient.openUrl(StringRequest.create({ value: resolvedUrl })).catch((error) => {
							console.error("Failed to open URL:", error)
						})
					}}
					type="button">
					<span className="ph-no-capture block break-all text-left [direction:ltr]">{resolvedUrl}</span>
				</button>
				{webFetch?.prompt && <div className="ph-no-capture break-words text-xs text-description">{webFetch.prompt}</div>}
				{webFetch?.status === "deferred" && <HostedCallDeferredNotice action="fetch" testId="web-fetch-deferred" />}
				{webFetch?.error && (
					<div className="flex items-start gap-2 rounded border border-error/40 bg-error/10 p-2 text-error">
						<TriangleAlertIcon className="mt-0.5 size-3 shrink-0" />
						<span className="ph-no-capture break-words text-xs">{webFetch.error}</span>
					</div>
				)}
				{webFetch?.content && <FetchedContent content={webFetch.content} />}
			</div>
		</div>
	)
}

export default WebFetchRow
