import type { ReasoningConfig } from "@shared/proto/dline/provider/common"
import { resolveThinkingBudgetBounds } from "@shared/providers/thinking-budget"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { memo, useCallback, useEffect, useMemo, useState } from "react"
import styled from "styled-components"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

const THUMB_SIZE = 16

const Container = styled.div`
	display: flex;
	flex-direction: column;
	margin-top: 5px;
	margin-bottom: 10px;
`

const RangeInput = styled.input<{ $value: number; $min: number; $max: number }>`
	width: 100%;
	height: 8px;
	appearance: none;
	border-radius: 4px;
	outline: none;
	cursor: pointer;
	margin: 5px 0 0;
	padding: 0;
	background: ${(props) => {
		const span = props.$max - props.$min
		const percentage = span > 0 ? Math.max(0, Math.min(100, ((props.$value - props.$min) / span) * 100)) : 100
		return `linear-gradient(to right, 
			var(--vscode-progressBar-background) 0%,
			var(--vscode-progressBar-background) ${percentage}%,
			var(--vscode-scrollbarSlider-background) ${percentage}%,
			var(--vscode-scrollbarSlider-background) 100%)`
	}};

	&::-webkit-slider-thumb {
		appearance: none;
		width: ${THUMB_SIZE}px;
		height: ${THUMB_SIZE}px;
		border-radius: 50%;
		background: var(--vscode-foreground);
		cursor: pointer;
		border: 0px solid var(--vscode-progressBar-background);
		box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
	}

	&:focus {
		outline: none;
	}

	&:focus::-webkit-slider-thumb,
	&:hover::-webkit-slider-thumb {
		border-color: var(--vscode-progressBar-background);
		box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
	}

	&:active::-webkit-slider-thumb {
		outline: none;
		border-color: var(--vscode-progressBar-background);
	}
`

type ThinkingMode = "effort" | "budget"

/** Sentinel for "leave the provider field unset", which cannot be an empty Select value. */
const DISPLAY_UNSET = "none"

interface ThinkingDisplayOption {
	value: string
	label: string
}

interface ThinkingControlProps {
	// === Data ===
	reasoningConfig?: ReasoningConfig
	onReasoningConfigUpdate: (config: ReasoningConfig) => void

	// === Display mode ===
	mode: "effort-only" | "budget-only" | "both"

	// === Display configuration ===
	effortOptions?: readonly string[]
	effortLabel?: string
	effortDescription?: string
	budgetLabel?: string
	maxBudget?: number
	/** Declared positive-budget lower bound; absence stays unknown and does not select a preference. */
	minBudget?: number
	defaultEnabled?: boolean
	defaultEffort?: string
	disableSupported?: boolean
	showModeSelector?: boolean
	modeSelectorLabel?: string
	modeSelectorOptions?: Array<{ value: ThinkingMode; label: string }>

	// === Reasoning display, for providers that expose the choice ===
	displayOptions?: readonly ThinkingDisplayOption[]
	displayLabel?: string
	displayDescription?: string
}

/**
 * Unified thinking control component supporting effort-only, budget-only, and both modes.
 * Now data-driven: receives ReasoningConfig and returns updated config through callback.
 */
const ThinkingControl = ({
	reasoningConfig,
	onReasoningConfigUpdate,
	mode,
	effortOptions = [],
	effortLabel = "Reasoning Effort",
	effortDescription = "Higher effort improves depth, but uses more tokens.",
	budgetLabel = "Thinking Budget",
	maxBudget,
	minBudget,
	defaultEnabled = false,
	defaultEffort,
	disableSupported = true,
	showModeSelector = true,
	modeSelectorLabel = "Thinking Mode",
	modeSelectorOptions = [
		{ value: "effort" as ThinkingMode, label: "Effort" },
		{ value: "budget" as ThinkingMode, label: "Budget" },
	],
	displayOptions,
	displayLabel = "Reasoning Display",
	displayDescription,
}: ThinkingControlProps) => {
	// Derive state from reasoningConfig
	const enableThinking = useMemo(() => {
		if (!disableSupported) {
			return true
		}
		if (reasoningConfig?.effort === "none") return false
		// Use explicit enableThinking field if present.
		if (reasoningConfig?.enableThinking !== undefined) {
			return reasoningConfig.enableThinking
		}
		// Fallback: infer preference state from effort/budget (backward compatibility).
		// Exclude empty string '' to prevent proto3 zero-value from being treated as enabled
		const hasEffort = !!(reasoningConfig?.effort && reasoningConfig.effort !== "none" && reasoningConfig.effort !== "")
		const hasBudget = !!(reasoningConfig?.thinkingBudget && reasoningConfig.thinkingBudget > 0)
		return hasEffort || hasBudget || defaultEnabled
	}, [
		defaultEnabled,
		disableSupported,
		reasoningConfig?.enableThinking,
		reasoningConfig?.effort,
		reasoningConfig?.thinkingBudget,
	])

	const activeType = useMemo<ThinkingMode>(() => {
		if (reasoningConfig?.thinkingBudget != null && reasoningConfig.thinkingBudget > 0) {
			return "budget"
		}
		return "effort"
	}, [reasoningConfig?.thinkingBudget])

	const effort = reasoningConfig?.effort
	const budget = reasoningConfig?.thinkingBudget ?? 0
	const selectableEfforts = useMemo(
		() => effortOptions.filter((value) => value.length > 0 && (disableSupported || value !== "none")),
		[disableSupported, effortOptions],
	)
	const selectedEffort =
		effort && selectableEfforts.includes(effort)
			? effort
			: defaultEffort && selectableEfforts.includes(defaultEffort)
				? defaultEffort
				: ""
	const bounds = resolveThinkingBudgetBounds({ minBudget, maxBudget })
	const minimum = bounds?.minimum ?? 1
	const maximum = bounds?.maximum
	const storedBudget =
		bounds && Number.isSafeInteger(budget) && budget >= minimum && (maximum === undefined || budget <= maximum)
			? budget
			: undefined
	// Every update below rebuilds the whole config, so the current display has to be
	// carried through explicitly or changing the effort would silently clear it.
	const display = reasoningConfig?.display

	// Local state for budget slider
	const [localBudget, setLocalBudget] = useState(budget || 0)

	const handleEnableChange = useCallback(
		(checked: boolean) => {
			if (!checked && !disableSupported) {
				return
			}
			if (checked) {
				// Enable with default values based on mode
				const defaultMode = mode === "budget-only" ? "budget" : "effort"
				onReasoningConfigUpdate({
					enableThinking: true,
					effort: defaultMode === "effort" && selectedEffort !== "none" ? selectedEffort || undefined : undefined,
					thinkingBudget: defaultMode === "budget" ? storedBudget : undefined,
					display,
				})
			} else {
				// Disable
				onReasoningConfigUpdate({
					enableThinking: false,
					effort: undefined,
					thinkingBudget: undefined,
					display,
				})
			}
		},
		[disableSupported, display, mode, onReasoningConfigUpdate, selectedEffort, storedBudget],
	)

	const handleEffortChange = useCallback(
		(value: string) => {
			if (!selectableEfforts.includes(value)) return
			onReasoningConfigUpdate({
				enableThinking: value !== "none",
				effort: value,
				thinkingBudget: undefined,
				display,
			})
		},
		[display, onReasoningConfigUpdate, selectableEfforts],
	)

	const handleBudgetSliderChange = useCallback(
		(event: React.ChangeEvent<HTMLInputElement>) => {
			const value = Number(event.target.value)
			if (!Number.isSafeInteger(value)) return
			const clampedValue = Math.max(minimum, maximum === undefined ? value : Math.min(value, maximum))
			setLocalBudget(clampedValue)
		},
		[minimum, maximum],
	)

	const handleBudgetSliderComplete = useCallback(() => {
		if (!Number.isSafeInteger(localBudget) || localBudget < minimum || (maximum !== undefined && localBudget > maximum))
			return
		onReasoningConfigUpdate({
			enableThinking: true,
			effort: undefined,
			thinkingBudget: localBudget,
			display,
		})
	}, [display, localBudget, maximum, minimum, onReasoningConfigUpdate])

	const handleModeChange = useCallback(
		(value: string) => {
			if (value !== "effort" && value !== "budget") return
			const newMode = value
			onReasoningConfigUpdate({
				enableThinking: true,
				effort: newMode === "effort" && selectedEffort !== "none" ? selectedEffort || undefined : undefined,
				thinkingBudget: newMode === "budget" ? storedBudget : undefined,
				display,
			})
		},
		[display, onReasoningConfigUpdate, selectedEffort, storedBudget],
	)

	const handleDisplayChange = useCallback(
		(value: string) => {
			onReasoningConfigUpdate({
				...reasoningConfig,
				display: value === DISPLAY_UNSET ? undefined : value,
			})
		},
		[reasoningConfig, onReasoningConfigUpdate],
	)

	// The Enable Thinking checkbox is the single visibility gate for all thinking detail controls.
	const showThinkingOptions = enableThinking
	const shouldShowEffort =
		showThinkingOptions &&
		selectableEfforts.length > 0 &&
		(mode === "effort-only" || (mode === "both" && activeType === "effort"))
	const shouldShowBudget =
		showThinkingOptions && bounds !== undefined && (mode === "budget-only" || (mode === "both" && activeType === "budget"))
	const shouldShowModeSelector = showThinkingOptions && mode === "both" && showModeSelector
	const shouldShowDisplaySelector = showThinkingOptions && (displayOptions?.length ?? 0) > 0

	// Sync local budget with config when external budget changes
	useEffect(() => {
		setLocalBudget(budget || 0)
	}, [budget])

	return (
		<div className="w-full" style={{ marginTop: 10, marginBottom: 10 }}>
			{/* Enable Thinking Checkbox */}
			<VSCodeCheckbox
				checked={enableThinking}
				disabled={!disableSupported}
				onChange={(event) => {
					const target = event.target as (EventTarget & { checked?: boolean }) | null
					handleEnableChange(target?.checked === true)
				}}>
				Enable Thinking
			</VSCodeCheckbox>

			{showThinkingOptions && (
				<>
					{/* Mode Selector (only in 'both' mode) */}
					{shouldShowModeSelector && (
						<div style={{ marginTop: 10, marginBottom: 5 }}>
							<Label className="text-xs font-medium">{modeSelectorLabel}</Label>
							<Select onValueChange={handleModeChange} value={activeType}>
								<SelectTrigger className="w-full mt-1">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{modeSelectorOptions.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					)}

					{/* Effort Selector */}
					{shouldShowEffort && (
						<div style={{ marginTop: 10, marginBottom: 5 }}>
							<Label className="text-xs font-medium">{effortLabel}</Label>
							<Select onValueChange={handleEffortChange} value={selectedEffort}>
								<SelectTrigger className="w-full mt-1">
									<SelectValue placeholder="Provider default" />
								</SelectTrigger>
								<SelectContent>
									{selectableEfforts.map((opt) => (
										<SelectItem key={opt} value={opt}>
											{opt.charAt(0).toUpperCase() + opt.slice(1)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							{effortDescription && (
								<p
									style={{
										fontSize: "12px",
										marginTop: 3,
										marginBottom: 0,
										color: "var(--vscode-descriptionForeground)",
									}}>
									{effortDescription}
								</p>
							)}
						</div>
					)}

					{/* Reasoning Display Selector */}
					{shouldShowDisplaySelector && displayOptions && (
						<div style={{ marginTop: 10, marginBottom: 5 }}>
							<Label className="text-xs font-medium">{displayLabel}</Label>
							<Select onValueChange={handleDisplayChange} value={display ?? DISPLAY_UNSET}>
								<SelectTrigger className="w-full mt-1">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{displayOptions.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							{displayDescription && (
								<p
									style={{
										fontSize: "12px",
										marginTop: 3,
										marginBottom: 0,
										color: "var(--vscode-descriptionForeground)",
									}}>
									{displayDescription}
								</p>
							)}
						</div>
					)}

					{/* Budget Slider */}
					{shouldShowBudget && (
						<div style={{ marginTop: 10, marginBottom: 5 }}>
							<Label className="text-xs font-medium">
								{budgetLabel} ({localBudget.toLocaleString()} tokens)
							</Label>
							<Container>
								{maximum !== undefined ? (
									<RangeInput
										$max={maximum}
										$min={minimum}
										$value={localBudget}
										aria-label={`${budgetLabel}: ${localBudget.toLocaleString()} tokens`}
										aria-valuemax={maximum}
										aria-valuemin={minimum}
										aria-valuenow={localBudget}
										id="thinking-budget-slider"
										max={maximum}
										min={minimum}
										onChange={handleBudgetSliderChange}
										onMouseUp={handleBudgetSliderComplete}
										onTouchEnd={handleBudgetSliderComplete}
										step={1}
										type="range"
										value={localBudget}
									/>
								) : (
									<input
										aria-label={budgetLabel}
										className="w-full"
										min={minimum}
										onBlur={handleBudgetSliderComplete}
										onChange={handleBudgetSliderChange}
										step={1}
										type="number"
										value={localBudget}
									/>
								)}
							</Container>
						</div>
					)}
				</>
			)}
		</div>
	)
}

export default memo(ThinkingControl)
