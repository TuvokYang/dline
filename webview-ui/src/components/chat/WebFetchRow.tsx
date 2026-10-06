import type { ClineSayTool } from "@shared/ExtensionMessage"
import { StringRequest } from "@shared/proto/dline/common"
import { ChevronDownIcon, ChevronRightIcon, Link2Icon, TriangleAlertIcon } from "lucide-react"
import { useState } from "react"
import { UiServiceClient } from "@/services/grpc-client"
import HostedCallDeferredNotice from "./HostedCallDeferredNotice"

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

const WebFetchRow = ({ messageType, url, webFetch }: WebFetchRowProps) => {
	const resolvedUrl = webFetch?.url || url || ""
	const label = sourceLabel(webFetch)
	const [detailsExpanded, setDetailsExpanded] = useState(false)

	return (
		<div className="max-h-[40vh] overflow-y-auto pr-1" data-testid="web-fetch-card">
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
				{webFetch?.content && (
					<>
						<button
							aria-expanded={detailsExpanded}
							aria-label={detailsExpanded ? "Collapse fetched web content" : "Expand fetched web content"}
							className="flex w-full cursor-pointer items-center gap-1 border-0 border-t border-editor-widget-border/50 bg-transparent pt-2 text-left text-xs text-description"
							data-testid="web-fetch-details-toggle"
							onClick={() => setDetailsExpanded((expanded) => !expanded)}
							type="button">
							{detailsExpanded ? (
								<ChevronDownIcon aria-hidden="true" className="size-3 shrink-0" />
							) : (
								<ChevronRightIcon aria-hidden="true" className="size-3 shrink-0" />
							)}
							<span>{detailsExpanded ? "Hide fetched content" : "Show fetched content"}</span>
						</button>
						{detailsExpanded && (
							<div className="border-t border-editor-widget-border/50 pt-2" data-testid="web-fetch-results">
								<div className="ph-no-capture break-words whitespace-pre-wrap text-xs">{webFetch.content}</div>
							</div>
						)}
					</>
				)}
			</div>
		</div>
	)
}

export default WebFetchRow
