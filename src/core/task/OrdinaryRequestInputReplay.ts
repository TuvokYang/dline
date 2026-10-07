import type { CompactionProviderInput } from "@core/task/compaction/CompactionProviderInput"
import cloneDeep from "clone-deep"

interface OrdinaryRequestInputState {
	apiIndex: number
	providerInput: CompactionProviderInput
	canonicalRebuildAttempted: boolean
}

export type OrdinaryCanonicalRebuildDecision = "rebuild" | "exhausted" | "unavailable"

/** Retains one immutable ordinary Provider input across first-chunk retry attempts. */
export class OrdinaryRequestInputReplay {
	private state?: OrdinaryRequestInputState

	/** Freeze the latest admitted logical request, replacing any older unacknowledged request. */
	freeze(apiIndex: number, providerInput: CompactionProviderInput): void {
		this.state = { apiIndex, providerInput: cloneDeep(providerInput), canonicalRebuildAttempted: false }
	}

	/** Return a detached copy of the frozen request for an initial send or retry. */
	get(apiIndex: number): CompactionProviderInput | undefined {
		if (this.state?.apiIndex !== apiIndex) return undefined
		return cloneDeep(this.state.providerInput)
	}

	/** Reserve the single canonical rebuild allowed for one frozen logical request. */
	prepareCanonicalRebuild(apiIndex: number): OrdinaryCanonicalRebuildDecision {
		if (this.state?.apiIndex !== apiIndex) return "unavailable"
		if (this.state.canonicalRebuildAttempted) return "exhausted"
		this.state.canonicalRebuildAttempted = true
		return "rebuild"
	}

	/** Replace only the Provider input after canonical projection and pairing repair. */
	replaceAfterCanonicalRebuild(apiIndex: number, providerInput: CompactionProviderInput): void {
		if (this.state?.apiIndex !== apiIndex || !this.state.canonicalRebuildAttempted) {
			throw new Error(`Canonical rebuild is not prepared for apiIndex=${apiIndex}`)
		}
		this.state.providerInput = cloneDeep(providerInput)
	}

	/** Release the request after its first real Provider chunk is accepted. */
	acknowledge(apiIndex: number): void {
		if (this.state?.apiIndex === apiIndex) this.state = undefined
	}

	/** Invalidate the frozen request before canonical state or projection changes. */
	clear(): void {
		this.state = undefined
	}
}
