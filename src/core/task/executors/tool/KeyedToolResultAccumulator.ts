import type { ClineToolResponseContent as ToolResponse } from "@shared/messages/content"

/**
 * Approval feedback belonging to one specific tool execution.
 *
 * Feedback is keyed because the existing drain removes every pending block from
 * one shared list. Serially that is harmless — there is only ever one tool in
 * flight. Concurrently the first tool to finish absorbs another tool's
 * feedback, and the result is still well-formed, so nothing detects it.
 */
export interface KeyedFeedback {
	dlineTid: string
	content: ToolResponse
}

/** One tool's outcome, recorded against its own identity. */
export interface KeyedToolOutcome {
	dlineTid: string
	/** Position in the assistant's tool-call order. */
	index: number
	content: ToolResponse
	isError?: boolean
}

/** A tool result assembled with the feedback that belongs to it. */
export interface AssembledToolResult {
	dlineTid: string
	index: number
	content: ToolResponse
	isError?: boolean
	/** Feedback recorded against this execution, in arrival order. */
	feedback: ToolResponse[]
}

/**
 * Collects concurrent tool outcomes and approval feedback by `dline_tid`.
 *
 * Two responsibilities that serial execution allowed to be implicit become
 * explicit here: which feedback belongs to which tool, and what order the
 * results are presented in. Completion order is not the presentation order —
 * the provider pairs by tool-call ID, but a reader of the conversation should
 * still see the turn in the order the assistant wrote it.
 */
export class KeyedToolResultAccumulator {
	private readonly outcomes = new Map<string, KeyedToolOutcome>()
	private readonly feedback = new Map<string, ToolResponse[]>()

	/**
	 * Record approval feedback for one execution.
	 *
	 * @param entry Feedback and the identity it belongs to.
	 */
	addFeedback(entry: KeyedFeedback): void {
		const existing = this.feedback.get(entry.dlineTid)
		if (existing) {
			existing.push(entry.content)
			return
		}
		this.feedback.set(entry.dlineTid, [entry.content])
	}

	/**
	 * Record one tool's outcome.
	 *
	 * A repeated identity replaces the earlier outcome: a re-executed block
	 * (partial then final, or an error then its retry) must present its latest
	 * result, which is the same rule the serial path already applies.
	 *
	 * @param outcome Result content and the identity that produced it.
	 */
	addOutcome(outcome: KeyedToolOutcome): void {
		this.outcomes.set(outcome.dlineTid, outcome)
	}

	/** Whether an outcome has been recorded for an identity. */
	has(dlineTid: string): boolean {
		return this.outcomes.has(dlineTid)
	}

	/** Number of recorded outcomes. */
	get size(): number {
		return this.outcomes.size
	}

	/**
	 * Feedback recorded for one identity.
	 *
	 * @param dlineTid Execution identity.
	 * @returns Feedback in arrival order; empty when none was recorded.
	 */
	feedbackFor(dlineTid: string): ToolResponse[] {
		return [...(this.feedback.get(dlineTid) ?? [])]
	}

	/**
	 * Assemble every recorded outcome in assistant tool-call order.
	 *
	 * @returns Results ordered by the position the assistant emitted, each
	 *   carrying only the feedback recorded against it.
	 */
	assemble(): AssembledToolResult[] {
		return Array.from(this.outcomes.values())
			.sort((a, b) => a.index - b.index)
			.map((outcome) => ({
				dlineTid: outcome.dlineTid,
				index: outcome.index,
				content: outcome.content,
				...(outcome.isError === undefined ? {} : { isError: outcome.isError }),
				feedback: this.feedbackFor(outcome.dlineTid),
			}))
	}

	/**
	 * Feedback whose execution never recorded an outcome.
	 *
	 * A cancelled or rejected block can leave feedback behind. Dropping it
	 * silently would lose what the user typed, so the caller is given it back
	 * explicitly and decides where it belongs.
	 *
	 * @returns Orphaned feedback keyed by the identity it was recorded against.
	 */
	orphanedFeedback(): KeyedFeedback[] {
		const orphaned: KeyedFeedback[] = []
		for (const [dlineTid, entries] of this.feedback) {
			if (this.outcomes.has(dlineTid)) continue
			for (const content of entries) {
				orphaned.push({ dlineTid, content })
			}
		}
		return orphaned
	}

	/** Discard every recorded outcome and feedback. */
	clear(): void {
		this.outcomes.clear()
		this.feedback.clear()
	}
}
