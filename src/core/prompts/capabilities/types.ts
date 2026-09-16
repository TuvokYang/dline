export type CapabilitySource = "mcp" | "skills" | "workflows" | "subagents"

/**
 * Represents the prompt-safe identity of one capability.
 */
export interface CapabilityEntry {
	readonly name: string
	readonly description: string
	/** Optional privacy-safe fingerprint for capability content that is loaded on demand. */
	readonly contentHash?: string
	/** Optional privacy-safe fingerprint for the provider-visible native tool identity. */
	readonly nativeToolHash?: string
	/**
	 * Tools this capability is actually permitted to use, when that set is
	 * enforced rather than advisory.
	 *
	 * Advertising it lets the caller choose a capability by what it can do
	 * instead of dispatching blind. Populated for subagents, whose allowlist is
	 * enforced at build time; omitted where no such restriction exists.
	 */
	readonly tools?: readonly string[]
}

/**
 * Stores all prompt-safe capability groups for a task prompt snapshot.
 */
export interface CapabilitiesSnapshot {
	readonly mcp: readonly CapabilityEntry[]
	readonly skills: readonly CapabilityEntry[]
	readonly workflows: readonly CapabilityEntry[]
	readonly subagents: readonly CapabilityEntry[]
}
