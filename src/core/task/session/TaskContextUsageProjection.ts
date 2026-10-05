import {
	type ContextWindowIndicatorLineage,
	type ContextWindowIndicatorSnapshot,
	getContextWindowIndicatorTotalTokens,
} from "@shared/context-window-indicator"
import { Logger } from "@shared/services/Logger"
import type { Mode } from "@shared/storage/types"
import { ContextWindowIndicator } from "../ContextWindowIndicator"
import {
	type ContextWindowIndicatorSegments,
	type ContextWindowRequestOpening,
	projectAuthoritativeContextWindowIndicatorSegments,
} from "../ContextWindowIndicatorProjection"
import type { TaskState } from "../kernel"
import type { ContextUsageObserverPort } from "./TaskProviderRequestReporter"

type FlowPhase = TaskState["flow"]["phase"]

/** Flow phases in which the run has no provider request left in flight. */
const RESTING_FLOW_PHASES: ReadonlySet<FlowPhase> = new Set<FlowPhase>([
	"idle",
	"waiting",
	"paused",
	"completed",
	"error",
	"terminated",
])

/**
 * Whether the run that issued the last request has come to rest.
 *
 * A completion offered to the user ends the run even though the flow itself
 * stays open for a reply. Any other dialog - a question, a plan, a report -
 * is part of the run: its answer continues the same conversation, so the
 * figure stays in flight until the run actually stops.
 */
export function isRunAtRest(state: Readonly<TaskState>): boolean {
	if (compactionInFlight(state)) return false
	if (RESTING_FLOW_PHASES.has(state.flow.phase)) return true
	const primary = state.dialog.primary
	return primary?.kind === "completion" && primary.status === "awaiting"
}

/** The compaction run the kernel has scheduled or started, which sends a request of its own. */
function compactionInFlight(state: Readonly<TaskState>): TaskState["flow"]["compaction"] | undefined {
	const compaction = state.flow.compaction
	return compaction?.status === "scheduled" || compaction?.status === "running" ? compaction : undefined
}

/** Where the projected snapshot is read by the controller and the Task Header. */
export interface ContextUsageTarget {
	contextWindowIndicator?: ContextWindowIndicatorSnapshot
}

/** The Mode and Profile the task currently runs under, and the window of the model serving it. */
export interface ContextUsageScope {
	readonly mode: Mode
	readonly profileId?: string
	readonly profileName?: string
	readonly contextWindow: number
}

export interface TaskContextUsageProjectionOptions {
	readonly taskId: string
	readonly target: ContextUsageTarget
	readonly scope: () => ContextUsageScope
	/** Pushes the new snapshot to the view; the header only redraws on a published state. */
	readonly publish: () => Promise<void>
}

/**
 * Projects the task's provider requests onto its context-window indicator.
 *
 * A request opens as sending and its reported occupancy shows as receiving:
 * the run that issued it may still continue, as after a dialog the user has
 * yet to answer. Only when the run stops does the figure settle as the resting
 * context. The provider's own count is the authority: it already includes
 * everything the request carried, so it replaces the earlier figure rather than
 * accumulating on top of it, which is what lets the header shrink after a
 * compaction.
 */
export class TaskContextUsageProjection implements ContextUsageObserverPort {
	private indicator: ContextWindowIndicator | undefined
	private sequence = 0
	private lineage: ContextWindowIndicatorLineage = { kind: "baseline" }
	private publication: Promise<void> = Promise.resolve()
	/** A streaming redraw is already queued; it will read the latest figure when it runs. */
	private streamingRedrawQueued = false
	/** Tokens the conversation gained after the last provider report, not yet carried by any request. */
	private pendingTail = 0

	constructor(private readonly options: TaskContextUsageProjectionOptions) {}

	async started(request: {
		readonly turnId: string
		readonly contextWindow: number
		readonly opening?: ContextWindowRequestOpening
	}): Promise<void> {
		if (this.compactionShown()) return
		this.begin(request)
		this.publish()
	}

	async record(usage: {
		readonly turnId: string
		readonly contextTokens: number
		readonly outputTokens: number
		readonly contextWindow: number
	}): Promise<void> {
		// A compaction condenses the conversation this figure describes; its own
		// sending state must not be replaced by a report from before it.
		if (this.compactionShown()) return
		// A report whose request is no longer in flight here still states the occupancy.
		if (!this.inFlight(usage.turnId)) this.begin(usage)
		const indicator = this.indicatorFor(usage.contextWindow)
		// The response is what the round received; the rest of the figure is what
		// it sent. Only the received part stays apart until the round settles, so
		// the next request finds this round's input already durable.
		this.show(
			indicator.receive({
				lineage: this.lineage,
				receivingTokens: usage.outputTokens,
				authoritativeContextTokens: usage.contextTokens,
			}),
		)
		this.publish()
	}

	/**
	 * Shows the response as received while it streams.
	 *
	 * The provider's figure, once it reports one, already counts the input, so
	 * the header shows the request's real occupancy before the final usage
	 * arrives; until then the received part is an estimate of what the response
	 * has generated. `record` settles both with the provider's final count.
	 */
	receiving(estimate: {
		readonly turnId: string
		readonly receivingTokens: number
		readonly authoritativeContextTokens: number
		readonly contextWindow: number
	}): void {
		const indicator = this.indicator
		if (!this.inFlight(estimate.turnId) || !indicator) return
		const before = indicator.getSnapshot().revision
		const received = indicator.receive({
			lineage: this.lineage,
			receivingTokens: estimate.receivingTokens,
			authoritativeContextTokens: estimate.authoritativeContextTokens,
		})
		if (received.revision === before) return
		// A stream grows on every delta, so its redraws coalesce. The figure is
		// shown only when its redraw runs: a redraw reads the figure at that
		// moment, and showing it now would let the first deltas overwrite the
		// request's sending state before the view ever drew it.
		if (this.streamingRedrawQueued) return
		this.streamingRedrawQueued = true
		this.publication = this.publication
			.then(() => {
				this.streamingRedrawQueued = false
				if (this.inFlight(estimate.turnId)) this.show(indicator.getSnapshot())
				return this.options.publish()
			})
			.catch((error) => {
				Logger.warn(
					`[ContextUsage] failed to publish context usage: ${error instanceof Error ? error.message : String(error)}`,
				)
			})
	}

	/**
	 * Records what the round added after the last provider report.
	 *
	 * A compaction scheduled before the next ordinary request condenses this
	 * tail as well, so its own request is shown carrying it. Nothing is drawn
	 * here: an ordinary request reports the tail itself once it is sent.
	 */
	staged(input: { readonly pendingContextTokens: number }): void {
		const tokens = input.pendingContextTokens
		this.pendingTail = Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0
	}

	/** A request that reported nothing, or never entered the conversation, leaves the previous figure standing. */
	async unmeasured(request: { readonly turnId: string }): Promise<void> {
		if (!this.inFlight(request.turnId)) return
		if (this.settle()) this.publish()
	}

	/**
	 * Settles the figure once the run has come to rest, and shows a compaction the run scheduled.
	 *
	 * A compaction that has ended hands the figure back as well: its own request
	 * is over, and the next ordinary request - the one that carries the condensed
	 * context - must be free to replace it even while the run continues.
	 */
	committed(state: Readonly<TaskState>): void {
		const changed = this.beginCompaction(state) || ((isRunAtRest(state) || this.compactionEnded(state)) && this.settle())
		if (changed) this.publish()
	}

	/**
	 * Adopts the Mode, Profile, and window the task switched to.
	 *
	 * The occupancy is unchanged by a switch - the same conversation is simply
	 * measured against another window - so only the scope moves. A task that has
	 * not sent anything yet has no figure to rescope; its first request opens one
	 * under the new scope.
	 */
	rebound(): void {
		if (!this.indicator) return
		const before = this.indicator.getSnapshot().revision
		const adopted = this.indicator.adoptScope(this.options.scope())
		if (adopted.revision === before) return
		this.show(adopted)
		this.publish()
	}

	/**
	 * Settles the figure on the conversation a landed summary left behind.
	 *
	 * The summary has replaced the history, so the context is already smaller;
	 * waiting for the next request to report it would show the full figure to
	 * every reader in between - the header, a Mode or Profile switch deciding
	 * whether the target window fits, a subagent sizing its budget. Only a
	 * landing calls this, so a run that failed or stopped without condensing
	 * anything keeps the figure it had.
	 */
	compacted(input: { readonly contextTokens: number; readonly contextWindow: number }): void {
		// The summary replaced whatever tail the round had added.
		this.pendingTail = 0
		const scope = this.options.scope()
		const measured = {
			durableContextTokens: input.contextTokens,
			pendingSendTokens: 0,
			environmentTokens: 0,
			contextWindow: input.contextWindow,
			profileId: scope.profileId,
			profileName: scope.profileName,
			mode: scope.mode,
		}
		if (!this.indicator) {
			this.indicator = new ContextWindowIndicator({ taskId: this.options.taskId, ...measured })
			this.show(this.indicator.getSnapshot())
			this.publish()
			return
		}
		const condensed =
			this.lineage.kind === "compaction_pass"
				? this.indicator.commit({ lineage: this.lineage, ...measured, allowDecrease: true })
				: this.indicator.rebaseDurable(measured)
		// The rebased figure carries the baseline lineage; settling under it ends the commit.
		if (condensed.lineage.kind === "baseline") this.lineage = condensed.lineage
		this.show(condensed)
		this.settle()
		this.publish()
	}

	/**
	 * Redraws the header in the order the figures changed.
	 *
	 * Best effort and never awaited by the caller: a provider request and a
	 * state commit must not wait on, or fail because of, the view they inform.
	 */
	private publish(): void {
		this.publication = this.publication
			.then(() => this.options.publish())
			.catch((error) => {
				Logger.warn(
					`[ContextUsage] failed to publish context usage: ${error instanceof Error ? error.message : String(error)}`,
				)
			})
	}

	private compactionShown(): boolean {
		const phase = this.indicator?.getSnapshot().phase
		return this.lineage.kind === "compaction_pass" && (phase === "sending" || phase === "receiving")
	}

	/** The compaction this figure shows is no longer scheduled or running. */
	private compactionEnded(state: Readonly<TaskState>): boolean {
		return this.compactionShown() && !compactionInFlight(state)
	}

	/**
	 * Shows a compaction's own request as sending.
	 *
	 * Compaction runs in its own execution domain and never passes through the
	 * provider reporter, so the committed run is the only sign it is in flight.
	 * Its figure is the conversation it condenses: the last reported occupancy
	 * plus the tail the round added since, which the summary request carries
	 * although no provider has measured it yet. The tail is taken once; a retried
	 * attempt starts from a figure that already includes it.
	 */
	private beginCompaction(state: Readonly<TaskState>): boolean {
		const compaction = compactionInFlight(state)
		if (!compaction || !this.indicator) return false
		if (this.lineage.kind === "compaction_pass" && this.lineage.attemptId === compaction.attempt) return false
		const indicator = this.indicator
		const current = indicator.getSnapshot()
		const scope = this.options.scope()
		const tail = this.pendingTail
		this.pendingTail = 0
		const segments = projectAuthoritativeContextWindowIndicatorSegments({
			projectedTotalTokens: getContextWindowIndicatorTotalTokens(current) + tail,
			durableContextTokens: current.durableContextTokens,
			estimatedEnvironmentTokens: current.environmentTokens,
		})
		this.lineage = {
			kind: "compaction_pass",
			operationId: compaction.compactionId,
			passIndex: 0,
			attemptIndex: 0,
			attemptId: compaction.attempt,
		}
		this.show(
			indicator.beginSend({
				lineage: this.lineage,
				durableContextTokens: segments.durableContextTokens,
				pendingSendTokens: segments.pendingSendTokens,
				environmentTokens: segments.environmentTokens,
				contextWindow: current.contextWindow,
				profileId: scope.profileId,
				profileName: scope.profileName,
				mode: scope.mode,
			}),
		)
		return true
	}

	private inFlight(turnId: string): boolean {
		const phase = this.indicator?.getSnapshot().phase
		return (
			this.lineage.kind === "ordinary" &&
			this.lineage.requestId === turnId &&
			(phase === "sending" || phase === "receiving")
		)
	}

	/** Opens a request under the window of the handler that sent it and the scope the task runs under. */
	private begin(request: {
		readonly turnId: string
		readonly contextWindow: number
		readonly opening?: ContextWindowRequestOpening
	}): void {
		// An ordinary request carries the tail and reports it as part of its own occupancy.
		this.pendingTail = 0
		const indicator = this.indicatorFor(request.contextWindow)
		const scope = this.options.scope()
		const segments = openingSegments(indicator.getSnapshot(), request.opening)
		this.lineage = {
			kind: "ordinary",
			requestId: request.turnId,
			requestSequence: ++this.sequence,
			attemptId: request.turnId,
		}
		this.show(
			indicator.beginSend({
				lineage: this.lineage,
				durableContextTokens: segments.durableContextTokens,
				pendingSendTokens: segments.pendingSendTokens,
				environmentTokens: segments.environmentTokens,
				contextWindow: request.contextWindow,
				profileId: scope.profileId,
				profileName: scope.profileName,
				mode: scope.mode,
			}),
		)
	}

	/** Returns whether the indicator changed, which is when the view needs a redraw. */
	private settle(): boolean {
		if (!this.indicator) return false
		const before = this.indicator.getSnapshot().revision
		const settled = this.indicator.settle({ lineage: this.lineage })
		if (settled.revision === before) return false
		this.show(settled)
		return true
	}

	private show(snapshot: ContextWindowIndicatorSnapshot): void {
		this.options.target.contextWindowIndicator = snapshot
	}

	private indicatorFor(contextWindow: number): ContextWindowIndicator {
		if (this.indicator) return this.indicator
		const scope = this.options.scope()
		this.indicator = new ContextWindowIndicator({
			taskId: this.options.taskId,
			durableContextTokens: 0,
			environmentTokens: 0,
			contextWindow,
			profileId: scope.profileId,
			profileName: scope.profileName,
			mode: scope.mode,
		})
		return this.indicator
	}
}

/**
 * The figure an ordinary request shows while it is being sent.
 *
 * Before any provider has reported, the local estimate of the admitted request
 * is the only figure, split into what was sent before and what this round adds.
 * Once a report exists it sets the scale: the request shows the occupancy it is
 * projected to reach, with the resting context kept and only the environment
 * taken from the estimate, because the two counts must never be subtracted
 * from each other. A request admitted without a measurement keeps the resting
 * figure and adds nothing until the provider reports.
 */
function openingSegments(
	current: ContextWindowIndicatorSnapshot,
	opening: ContextWindowRequestOpening | undefined,
): Pick<ContextWindowIndicatorSegments, "durableContextTokens" | "pendingSendTokens" | "environmentTokens"> {
	if (!opening) return { durableContextTokens: current.durableContextTokens, pendingSendTokens: 0, environmentTokens: 0 }
	if (opening.unmeasured && current.revision === 0) return opening.segments
	return projectAuthoritativeContextWindowIndicatorSegments({
		projectedTotalTokens: opening.projectedUsageTokens,
		durableContextTokens: current.durableContextTokens,
		estimatedEnvironmentTokens: opening.segments.environmentTokens,
	})
}
