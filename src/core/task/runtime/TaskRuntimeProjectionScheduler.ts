import type { TaskSnapshot } from "../TaskSnapshot"
import type { SnapshotDurability } from "./TaskEffect"

/** The transition that requested a projection, retained so a deferred failure stays attributable. */
export interface ProjectionOrigin {
	effectId: string
	/** Revision of the state that produced the effect, as the runtime would report it. */
	originRevision: number
}

/** One deferred projection failure, reported against the transition that scheduled it. */
export interface DeferredProjectionFailure {
	origin: ProjectionOrigin
	effectType: "POST_TASK_VIEW" | "PERSIST_SNAPSHOT"
	error: unknown
}

/** Infrastructure the projection scheduler drives on behalf of the runtime ports. */
export interface TaskRuntimeProjectionPorts {
	/** Build and post the full Webview state from already committed runtime state. */
	postView(): Promise<void>
	/** Hand the latest snapshot to the coalescing persistence layer without forcing a write. */
	scheduleSnapshot(snapshot: TaskSnapshot): void
	/** Force the latest scheduled snapshot to disk. */
	flushSnapshot(): Promise<void>
	/**
	 * Report a projection that failed after its effect had already returned.
	 *
	 * Deferred work has no caller left to reject, so the runtime is told
	 * explicitly, carrying the original effect identity rather than blaming
	 * whichever transition happens to run next.
	 */
	onDeferredFailure?(failure: DeferredProjectionFailure): void
}

export interface TaskRuntimeProjectionSchedulerOptions {
	ports: TaskRuntimeProjectionPorts
	/** Trailing window used to coalesce projections. */
	intervalMs?: number
	setTimeoutFn?: typeof setTimeout
	clearTimeoutFn?: typeof clearTimeout
}

const DEFAULT_INTERVAL_MS = 100

/**
 * Coalesces runtime view posts and snapshot writes to the latest committed state.
 *
 * Every accepted transition emits both a view effect and a snapshot effect, so a
 * turn with many blocks previously paid one full Webview state build and one
 * durable snapshot write per block, inside the serialized runtime queue. Both
 * projections are last-writer-wins: only the newest state is observable, so the
 * intermediate work is discardable as long as a barrier still forces the latest
 * state out before anything can depend on it having landed.
 *
 * Durability is decided by the reducer and carried on the effect, so the barrier
 * set is reviewable in one place instead of being implied by which call site
 * happened to await a flush.
 *
 * Deferring work moves it off the caller's stack but must not move it outside
 * the runtime's failure handling: the trailing flush is owned and awaited here,
 * and any failure is reported against the transition that scheduled it.
 */
export class TaskRuntimeProjectionScheduler {
	private readonly ports: TaskRuntimeProjectionPorts
	private readonly intervalMs: number
	private readonly setTimeoutFn: typeof setTimeout
	private readonly clearTimeoutFn: typeof clearTimeout

	private timer: ReturnType<typeof setTimeout> | undefined
	/** Origin of the newest coalesced transition; a deferred failure is reported against it. */
	private pendingOrigin: ProjectionOrigin | undefined
	private pendingView = false
	private pendingSnapshot = false
	private chain: Promise<void> = Promise.resolve()
	/** In-flight trailing settlement, so callers can await deferred work deterministically. */
	private settling: Promise<void> | undefined
	private disposed = false

	constructor(options: TaskRuntimeProjectionSchedulerOptions) {
		this.ports = options.ports
		this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
		this.setTimeoutFn = options.setTimeoutFn ?? setTimeout
		this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout
	}

	/**
	 * Route one committed snapshot according to the durability the reducer chose.
	 *
	 * A coalesced snapshot still reaches the persistence layer immediately so the
	 * latest state is retained; only the write is deferred to the trailing flush.
	 */
	async persistSnapshot(snapshot: TaskSnapshot, durability: SnapshotDurability, origin?: ProjectionOrigin): Promise<void> {
		this.ports.scheduleSnapshot(snapshot)
		if (durability !== "flushed") {
			this.pendingSnapshot = true
			this.arm(origin)
			return
		}
		// A barrier settles only the durable half plus whatever was already owed,
		// so an ordinary transition still pays one write and one view build, not two.
		this.pendingSnapshot = true
		await this.settleOwed()
	}

	/**
	 * Post the committed view, coalescing non-barrier transitions.
	 * A barrier awaits the post so the caller observes its failure.
	 */
	async postView(durability: SnapshotDurability, origin?: ProjectionOrigin): Promise<void> {
		this.pendingView = true
		if (durability !== "flushed") {
			this.arm(origin)
			return
		}
		await this.settleOwed()
	}

	/** Arm the single trailing timer that settles whatever is currently owed. */
	private arm(origin?: ProjectionOrigin): void {
		if (this.disposed) return
		if (origin) {
			this.pendingOrigin = origin
		}
		if (this.timer) return
		this.timer = this.setTimeoutFn(() => {
			this.timer = undefined
			const settlement = this.settleDeferred()
			this.settling = settlement
			void settlement.finally(() => {
				if (this.settling === settlement) this.settling = undefined
			})
		}, this.intervalMs)
	}

	/**
	 * Run the trailing projection and report failure against its own origin.
	 * The work is awaited here so it cannot become a detached rejection.
	 */
	private async settleDeferred(): Promise<void> {
		const origin = this.pendingOrigin
		const owedView = this.pendingView
		const owedSnapshot = this.pendingSnapshot
		try {
			await this.settleOwed()
		} catch (error) {
			this.reportDeferredFailure(origin, owedView, owedSnapshot, error)
		}
	}

	/** Tell the runtime about deferred work that failed, preserving its original identity. */
	private reportDeferredFailure(
		origin: ProjectionOrigin | undefined,
		owedView: boolean,
		owedSnapshot: boolean,
		error: unknown,
	): void {
		if (!origin || !this.ports.onDeferredFailure) return
		// The snapshot write is the durable half, so it names the failure when both
		// were owed; a view-only failure is reported as the view effect.
		const effectType = owedSnapshot || !owedView ? "PERSIST_SNAPSHOT" : "POST_TASK_VIEW"
		try {
			this.ports.onDeferredFailure({ origin, effectType, error })
		} catch {
			/* Reporting must not mask the original failure. */
		}
	}

	/**
	 * Settle everything currently owed: post the latest view and force the latest
	 * snapshot to disk. Failures reach the caller so a barrier can reject.
	 */
	async flushNow(): Promise<void> {
		this.pendingView = true
		this.pendingSnapshot = true
		await this.settleOwed()
	}

	/** Perform exactly the projections currently owed, then clear them. */
	private async settleOwed(): Promise<void> {
		if (this.timer) {
			this.clearTimeoutFn(this.timer)
			this.timer = undefined
		}
		const owedView = this.pendingView
		const owedSnapshot = this.pendingSnapshot
		this.pendingView = false
		this.pendingSnapshot = false
		this.pendingOrigin = undefined
		if (!owedView && !owedSnapshot) return

		const attempt = this.chain.then(async () => {
			if (owedView) await this.ports.postView()
			if (owedSnapshot) await this.ports.flushSnapshot()
		})
		// Keep the internal tail usable so one failure does not wedge every later
		// projection behind a rejected chain.
		this.chain = attempt.catch(() => undefined)
		try {
			await attempt
		} catch (error) {
			// Restore what was owed so a later barrier retries rather than silently
			// dropping a projection that never landed.
			this.pendingView = this.pendingView || owedView
			this.pendingSnapshot = this.pendingSnapshot || owedSnapshot
			throw error
		}
	}

	/** True while a coalesced projection is still owed. */
	get hasPendingProjection(): boolean {
		return this.pendingView || this.pendingSnapshot || this.timer !== undefined
	}

	/**
	 * Await any trailing projection that has already started.
	 *
	 * Deferred work is intentionally off the caller's stack, so this gives
	 * teardown and tests a definite settlement point instead of requiring them to
	 * guess how many turns the internal chain takes.
	 */
	async whenSettled(): Promise<void> {
		await this.settling
	}

	/** Drop any armed timer without projecting; used when a task is being torn down. */
	dispose(): void {
		this.disposed = true
		if (this.timer) {
			this.clearTimeoutFn(this.timer)
			this.timer = undefined
		}
		this.pendingView = false
		this.pendingSnapshot = false
		this.pendingOrigin = undefined
	}
}
