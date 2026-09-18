import { lanesAreCompatible, type ToolLane } from "./tool-lanes"

/**
 * One block as the admission decision sees it.
 *
 * This is a projection of the reducer's block lifecycle, not a second copy of
 * it. Admission needs identity, position, lanes and readiness; it deliberately
 * cannot see handlers, services or anything it could mutate.
 */
export interface AdmissionBlock {
	/** Dline trace identity; the stable key for the block. */
	dlineTid: string
	/** Position in the assistant's tool-call order. */
	index: number
	/** Lanes this block must hold exclusively while it runs. */
	lanes: readonly ToolLane[]
	/** True when the block ends the turn and must run alone, after a drain. */
	isTurnEnding: boolean
}

/** Admission inputs for one scheduling decision. */
export interface AdmissionInput {
	/** Blocks approved and waiting for a slot, in assistant order. */
	pending: readonly AdmissionBlock[]
	/** Blocks currently executing. */
	running: readonly AdmissionBlock[]
	/** Maximum concurrent executions permitted now. */
	limit: number
	/**
	 * True when blocks earlier in the turn have not reached a terminal phase.
	 *
	 * A turn-ending block must wait for the pool to drain, so it needs to know
	 * whether anything at all is still outstanding, including blocks that are
	 * neither running nor pending because they are still streaming.
	 */
	hasUnfinishedEarlierWork?: boolean
}

/** Why a pending block was not admitted. */
export type AdmissionRefusal =
	/** The configured limit is already reached. */
	| "limit_reached"
	/** Another execution holds one of this block's lanes. */
	| "lane_held"
	/** A turn-ending block is waiting for the pool to drain. */
	| "awaiting_drain"

/** Outcome of one admission decision. */
export interface AdmissionResult {
	/** Blocks that may start now, in assistant order. */
	admit: AdmissionBlock[]
	/** Blocks that must keep waiting, each with the reason. */
	refuse: Array<{ block: AdmissionBlock; reason: AdmissionRefusal }>
}

/**
 * Decide which pending blocks may start.
 *
 * The function is pure and total: it reads only the state handed to it and
 * returns the same decision for the same input, which is what allows the
 * scheduling authority to live in reducer-visible state rather than in a
 * scheduler's private fields.
 *
 * Blocks are considered in assistant order, so a block that has waited longer
 * is offered a slot before a later one. Refusing a block never skips past it to
 * a cheaper candidate: the lane check would otherwise let a steady stream of
 * unrestricted work starve an older block waiting on a busy lane.
 *
 * @param input Pending and running blocks, the current limit, and drain state.
 * @returns The blocks to admit and the blocks to keep waiting.
 */
export function decideAdmission(input: AdmissionInput): AdmissionResult {
	const admit: AdmissionBlock[] = []
	const refuse: AdmissionResult["refuse"] = []

	// A non-finite limit is zero capacity, not unbounded. `Math.floor(NaN)` is
	// NaN and every `occupied >= limit` comparison against it is false, which
	// would turn a misconfigured limit into unlimited concurrency.
	const limit = Number.isFinite(input.limit) ? Math.max(0, Math.floor(input.limit)) : 0
	const heldLanes: ToolLane[][] = input.running.map((block) => [...block.lanes])
	let occupied = input.running.length

	const ordered = [...input.pending].sort((a, b) => a.index - b.index)
	// A lane blocked for one candidate stays blocked for every later candidate,
	// so waiting is head-of-line by lane rather than by the whole queue. This
	// keeps ordering fair without making one busy lane stall unrelated work.
	const blockedLanes = new Set<ToolLane>()

	// Set once a turn-ending block is reached, whether it was admitted or is
	// still waiting to drain. Everything after it waits, including work that is
	// otherwise eligible: "runs alone" has to mean alone in both directions,
	// not merely that nothing was running when it started. A block that is
	// merely waiting must hold the line too, or later work would overtake the
	// very block the barrier exists to isolate.
	let turnEndingReached = false

	// A turn-ending block already running is the same barrier seen from the
	// other side. Admission is called again on every submit and completion, so
	// without this a block submitted after the ending one started would find
	// free capacity and disjoint lanes, and run beside it.
	const turnEndingRunning = input.running.some((block) => block.isTurnEnding === true)

	for (const block of ordered) {
		if (turnEndingRunning) {
			refuse.push({ block, reason: "awaiting_drain" })
			continue
		}

		if (block.isTurnEnding) {
			// A turn-ending tool hands control back to the user, so nothing may
			// still be running or outstanding when it starts — and nothing
			// pending may start beside it either, whether that pending work was
			// admitted in this pass or merely refused for capacity.
			const outstanding = occupied > 0 || admit.length > 0 || refuse.length > 0 || input.hasUnfinishedEarlierWork === true
			turnEndingReached = true
			if (outstanding) {
				refuse.push({ block, reason: "awaiting_drain" })
				continue
			}
			admit.push(block)
			occupied += 1
			continue
		}

		if (turnEndingReached) {
			refuse.push({ block, reason: "awaiting_drain" })
			continue
		}

		if (occupied >= limit) {
			refuse.push({ block, reason: "limit_reached" })
			continue
		}

		// Whether the conflict is with running work or with an earlier pending
		// block, every lane this block needs becomes head-of-line for it. Adding
		// only the directly contended lane would let a later block overtake it
		// on one of the lanes it is still waiting for.
		const blockedByEarlierCandidate = block.lanes.some((lane) => blockedLanes.has(lane))
		const conflictsWithHeld = heldLanes.some((lanes) => !lanesAreCompatible(lanes, block.lanes))

		if (blockedByEarlierCandidate || conflictsWithHeld) {
			for (const lane of block.lanes) {
				blockedLanes.add(lane)
			}
			refuse.push({ block, reason: "lane_held" })
			continue
		}

		admit.push(block)
		heldLanes.push([...block.lanes])
		occupied += 1
	}

	return { admit, refuse }
}

/**
 * Whether a turn-ending block may start.
 *
 * Exposed separately because the turn barrier is also consulted outside a full
 * admission pass, and restating the rule at that call site is how two copies
 * of a contract begin to drift.
 *
 * @param input Running blocks and outstanding-work state.
 * @returns True when the pool has drained.
 */
export function poolHasDrained(input: Pick<AdmissionInput, "running" | "hasUnfinishedEarlierWork">): boolean {
	return input.running.length === 0 && !input.hasUnfinishedEarlierWork
}
