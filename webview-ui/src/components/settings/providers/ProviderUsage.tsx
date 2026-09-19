import { ChevronDownIcon, ChevronRightIcon, LoaderIcon, RefreshCwIcon } from "lucide-react"
import { useState } from "react"
import { cn } from "@/lib/utils"
import {
	formatProviderUsageCurrency,
	ProviderUsageDetails,
	providerUsageRemainingLabel,
	selectEffectiveUsageQuota,
} from "./ProviderUsageDetails"
import { useProviderUsage } from "./useProviderUsage"

/** Reusable Profile-scoped settings surface for providers that expose usage capabilities. */
export function ProviderUsage({ profileId, enabled }: { profileId: string; enabled: boolean }) {
	const state = useProviderUsage(profileId, enabled)
	const [expanded, setExpanded] = useState(false)
	const usage = state.usage
	const effectiveQuota = selectEffectiveUsageQuota(usage?.quotas ?? [])
	const canExpand = usage?.isAvailable === true
	const summary = state.loading
		? "Loading usage…"
		: state.error
			? "Usage unavailable"
			: effectiveQuota
				? providerUsageRemainingLabel(effectiveQuota)
				: !usage?.planType && usage?.remainingBalance !== undefined
					? formatProviderUsageCurrency(usage.currency, usage.remainingBalance)
					: "No usage data"

	return (
		<div
			aria-label="Provider usage"
			className="mt-2 flex min-w-0 flex-col gap-2 border-t border-editor-widget-border/50 pt-2"
			role="group">
			<div className="flex min-w-0 items-center gap-1">
				<button
					aria-expanded={expanded}
					aria-label={`Usage ${summary}`}
					className="flex min-h-7 min-w-0 flex-1 items-center gap-1 rounded-xs border-0 bg-transparent px-1 text-left text-xs text-foreground hover:bg-toolbar-hover disabled:cursor-default disabled:opacity-60"
					disabled={!canExpand}
					onClick={() => setExpanded((value) => !value)}
					type="button">
					{canExpand ? (
						expanded ? (
							<ChevronDownIcon className="size-3.5 shrink-0" />
						) : (
							<ChevronRightIcon className="size-3.5 shrink-0" />
						)
					) : null}
					{state.loading ? <LoaderIcon className="size-3.5 shrink-0 animate-spin" /> : null}
					<span className="shrink-0 font-medium">Usage</span>
					<span className="truncate text-description">{summary}</span>
				</button>
				<button
					aria-label="Refresh Provider usage"
					className="flex size-6 shrink-0 items-center justify-center rounded-xs border-0 bg-transparent text-description hover:bg-toolbar-hover hover:text-foreground disabled:opacity-50"
					disabled={!enabled || state.loading || state.refreshing}
					onClick={() => void state.refresh()}
					type="button">
					<RefreshCwIcon className={cn("size-3.5", state.refreshing && "animate-spin")} />
				</button>
			</div>
			{expanded && usage ? (
				<div className="rounded-xs bg-toolbar-hover/20 p-2">
					<ProviderUsageDetails
						consumeResetCredit={state.consumeResetCredit}
						resetError={state.resetError}
						resetting={state.resetting}
						usage={usage}
					/>
				</div>
			) : null}
			{state.error ? (
				<div className="text-xs text-error" role="alert">
					{state.error}
				</div>
			) : null}
		</div>
	)
}
