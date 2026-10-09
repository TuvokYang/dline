import type { ContextWindowRequestPressure } from "./context-window-projection"

export interface TokenEstimateScope {
	readonly providerId?: string
	readonly modelId?: string
	readonly apiFormat?: number
}

const MAX_RECENT_SAMPLES = 9

/**
 * Resolve text tokens per UTF-8 byte from exact input usage reported by one Provider scope.
 *
 * Mixed-media samples are excluded because images and documents use independent token models;
 * including them would distort every later text estimate.
 */
export function resolveTokenPerByte(
	pressures: readonly ContextWindowRequestPressure[],
	scope: TokenEstimateScope,
): number | undefined {
	const samples = pressures
		.filter((pressure) => sameScope(pressure, scope))
		.filter((pressure) => pressure.estimatedMediaTokens === 0)
		.flatMap((pressure) => {
			const bytes = positive(pressure.estimatedTextBytes)
			const tokens = positive(pressure.actualInputTokens)
			return bytes > 0 && tokens > 0 ? [tokens / bytes] : []
		})
		.slice(-MAX_RECENT_SAMPLES)
		.sort((left, right) => left - right)

	if (samples.length === 0) return undefined
	const middle = Math.floor(samples.length / 2)
	return samples.length % 2 === 1 ? samples[middle] : (samples[middle - 1] + samples[middle]) / 2
}

function sameScope(pressure: ContextWindowRequestPressure, scope: TokenEstimateScope): boolean {
	return (
		pressure.providerId === scope.providerId && pressure.modelId === scope.modelId && pressure.apiFormat === scope.apiFormat
	)
}

function positive(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}
