export interface ApiRequestTimingMarkers {
	requestStartedAtMs: number
	providerRequestStartedAtMs: number
	firstChunkAtMs: number
	streamCompletedAtMs: number
}

export interface ApiRequestTiming {
	localPrepareMs: number
	upstreamTtfbMs: number
	streamMs: number
	totalMs: number
}

function phaseDuration(startedAtMs: number, completedAtMs: number): number {
	return Math.max(0, Math.round(completedAtMs - startedAtMs))
}

/** Calculate non-overlapping request phases from monotonic clock markers. */
export function calculateApiRequestTiming(markers: ApiRequestTimingMarkers): ApiRequestTiming {
	return {
		localPrepareMs: phaseDuration(markers.requestStartedAtMs, markers.providerRequestStartedAtMs),
		upstreamTtfbMs: phaseDuration(markers.providerRequestStartedAtMs, markers.firstChunkAtMs),
		streamMs: phaseDuration(markers.firstChunkAtMs, markers.streamCompletedAtMs),
		totalMs: phaseDuration(markers.requestStartedAtMs, markers.streamCompletedAtMs),
	}
}

/**
 * The diagnostic line a completed request logs.
 *
 * Its shape is a contract: the multi-task pressure E2E parses it to tell local
 * preparation from upstream latency under concurrent tasks.
 */
export function formatApiRequestTiming(input: {
	readonly taskId: string
	readonly request: number
	readonly timing: ApiRequestTiming
	readonly activeTasks: number
}): string {
	const { timing } = input
	return `[Task ${input.taskId}] API timing: request=${input.request}, localPrepareMs=${timing.localPrepareMs}, upstreamTtfbMs=${timing.upstreamTtfbMs}, streamMs=${timing.streamMs}, totalMs=${timing.totalMs}, activeTasks=${input.activeTasks}`
}
