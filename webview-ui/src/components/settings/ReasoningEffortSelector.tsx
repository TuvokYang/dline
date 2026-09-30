import { GENERIC_REASONING_EFFORT_OPTIONS } from "@shared/storage/types"
import { memo } from "react"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

interface ReasoningEffortSelectorProps {
	label?: string
	description?: string
	allowedEfforts?: readonly string[]
	defaultEffort?: string
	/**
	 * Direct reasoning effort value (preferred).
	 * When provided, onReasoningEffortChange must also be provided.
	 * Falls back to apiConfiguration mode-specific fields when not set.
	 */
	reasoningEffort?: string
	/** Callback when reasoning effort changes (when using direct value). */
	onReasoningEffortChange?: (value: string) => void
}

/**
 * Selector for reasoning effort level.
 * Uses reasoningEffort prop when provided, otherwise falls back
 * to legacy apiConfiguration mode-specific fields.
 */
const ReasoningEffortSelector = ({
	label = "Reasoning Effort",
	description = "Higher effort improves depth, but uses more tokens.",
	allowedEfforts = GENERIC_REASONING_EFFORT_OPTIONS,
	defaultEffort = "medium",
	reasoningEffort,
	onReasoningEffortChange,
}: ReasoningEffortSelectorProps) => {
	const rawEffort = reasoningEffort

	const selectedEffort =
		rawEffort && allowedEfforts.includes(rawEffort) ? rawEffort : allowedEfforts.includes(defaultEffort) ? defaultEffort : ""

	// Handle effort value change
	const handleEffortChange = (value: string) => {
		if (allowedEfforts.includes(value)) onReasoningEffortChange?.(value)
	}

	return (
		<div style={{ marginTop: 10, marginBottom: 5 }}>
			<Label className="text-xs font-medium">{label}</Label>
			<Select onValueChange={handleEffortChange} value={selectedEffort}>
				<SelectTrigger className="w-full mt-1">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{allowedEfforts.map((effort) => (
						<SelectItem key={effort} value={effort}>
							{effort.charAt(0).toUpperCase() + effort.slice(1)}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<p
				style={{
					fontSize: "12px",
					marginTop: 3,
					marginBottom: 0,
					color: "var(--vscode-descriptionForeground)",
				}}>
				{description}
			</p>
		</div>
	)
}

export default memo(ReasoningEffortSelector)
