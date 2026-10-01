import { memo } from "react"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

interface ReasoningEffortSelectorProps {
	label?: string
	description?: string
	allowedEfforts: readonly string[]
	defaultEffort?: string
	reasoningEffort?: string
	onReasoningEffortChange: (value: string) => void
}

/** Display only caller-declared levels; an omitted default leaves the provider field unset. */
const ReasoningEffortSelector = ({
	label = "Reasoning Effort",
	description = "Higher effort improves depth, but uses more tokens.",
	allowedEfforts,
	defaultEffort,
	reasoningEffort,
	onReasoningEffortChange,
}: ReasoningEffortSelectorProps) => {
	const efforts = allowedEfforts.filter((value) => value.length > 0)
	const selectedEffort =
		reasoningEffort && efforts.includes(reasoningEffort)
			? reasoningEffort
			: defaultEffort && efforts.includes(defaultEffort)
				? defaultEffort
				: ""
	const handleEffortChange = (value: string) => {
		if (efforts.includes(value)) onReasoningEffortChange(value)
	}
	if (efforts.length === 0) return null

	return (
		<div style={{ marginTop: 10, marginBottom: 5 }}>
			<Label className="text-xs font-medium">{label}</Label>
			<Select onValueChange={handleEffortChange} value={selectedEffort}>
				<SelectTrigger className="w-full mt-1">
					<SelectValue placeholder="Provider default" />
				</SelectTrigger>
				<SelectContent>
					{efforts.map((effort) => (
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
