import type { ClineSayTool } from "@shared/ExtensionMessage"
import { StringRequest } from "@shared/proto/dline/common"
import { ChevronDownIcon, ChevronRightIcon, Link2Icon, TriangleAlertIcon } from "lucide-react"
import { useState } from "react"
import { UiServiceClient } from "@/services/grpc-client"
import HostedCallDeferredNotice from "./HostedCallDeferredNotice"
import ToolCardHeader from "./ToolCardHeader"

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

interface FetchedContentProps {
	content: string
	expanded: boolean
	onToggle: () => void
}

/**
 * The fetched page, collapsed by default so a long page never floods the chat.
 *
 * While collapsed the text is not rendered at all; expanded, it scrolls inside a bounded area. The toggle
 * bar sits above that area, next to the card title that toggles the same state, so collapsing never
 * requires scrolling to the end of the page.
 */
const FetchedContent = ({ content, expanded, onToggle }: FetchedContentProps) => (
	<div className="border-t border-editor-widget-border/50 pt-1.5">
		<button
			aria-expanded={expanded}
			aria-label={expanded ? "Collapse fetched web content" : "Expand fetched web content"}
			className="flex w-full shrink-0 cursor-pointer items-center gap-1 border-0 bg-transparent text-left text-xs text-description"
			data-testid="web-fetch-details-toggle"
			onClick={onToggle}
			type="button">
			{expanded ? (
				<ChevronDownIcon aria-hidden="true" className="size-3 shrink-0" />
			) : (
				<ChevronRightIcon aria-hidden="true" className="size-3 shrink-0" />
			)}
			<span>{expanded ? "Collapse fetched content" : "Show fetched content"}</span>
		</button>
		{expanded && (
			<div
				className="mt-1 max-h-[40vh] overflow-y-auto overscroll-contain border-t border-editor-widget-border/50 pt-1.5 pr-1"
				data-testid="web-fetch-results">
				<div className="ph-no-capture break-words whitespace-pre-wrap text-xs">{content}</div>
			</div>
		)}
	</div>
)

const WebFetchRow = ({ messageType, url, webFetch }: WebFetchRowProps) => {
	const resolvedUrl = webFetch?.url || url || ""
	const label = sourceLabel(webFetch)
	const content = webFetch?.content
	const [contentExpanded, setContentExpanded] = useState(false)
	const toggleContent = () => setContentExpanded((expanded) => !expanded)

	return (
		<div className="pr-1" data-testid="web-fetch-card">
			<ToolCardHeader
				expansion={content ? { expanded: contentExpanded, onToggle: toggleContent } : undefined}
				icon={<Link2Icon className="size-2" />}
				testId="web-fetch-header"
				title={
					messageType === "ask" ? "Dline wants to fetch content from this URL:" : "Dline fetched content from this URL:"
				}
			/>
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
				{content && <FetchedContent content={content} expanded={contentExpanded} onToggle={toggleContent} />}
			</div>
		</div>
	)
}

export default WebFetchRow
