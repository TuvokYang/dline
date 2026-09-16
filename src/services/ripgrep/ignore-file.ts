import fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { Logger } from "@/shared/services/Logger"

/**
 * Hands the workspace scan rules to ripgrep as an `--ignore-file`.
 *
 * ripgrep cannot read the compiled rules held by `IgnoreController`, so they
 * are materialised into a temporary file for the duration of one process.
 * Passing them as an ignore file prunes during the walk instead of filtering
 * results afterwards, which is what keeps an ignored directory from being
 * traversed at all.
 */

/** The ignore facts a ripgrep invocation needs, satisfied by IgnoreController. */
export interface RipgrepScanRules {
	/** Raw scan rules in `.gitignore` syntax, or undefined when none apply. */
	getIgnoreContent(permission: "scan"): string | undefined
	/**
	 * Scan rules stated by the workspace, without repository or built-in pruning.
	 *
	 * Optional so a caller that only knows the combined rules still satisfies the
	 * interface; a deliberate descent needs this narrower set.
	 */
	getAgentScanContent?(): string | undefined
}

/**
 * Which rules a ripgrep invocation should enforce.
 *
 * `all` is the default walk. `agent-only` drops the cost-driven pruning for a
 * caller that named an ignored path on purpose, while keeping every restriction
 * the workspace stated in `.agentignore`.
 */
export type RipgrepRuleScope = "all" | "agent-only"

/** A materialised ignore file plus the arguments that activate it. */
export interface RipgrepIgnoreFile {
	/** Arguments to spread into the ripgrep invocation; empty when no rules apply. */
	readonly args: readonly string[]
	/** Remove the temporary file. Safe to call when nothing was written. */
	dispose(): Promise<void>
}

const NO_IGNORE_FILE: RipgrepIgnoreFile = {
	args: [],
	dispose: async () => {},
}

/**
 * Materialise the scan rules for one ripgrep process.
 *
 * Returns empty arguments when the workspace has no rules or the file cannot be
 * written: ripgrep still honours `.gitignore` on its own, so a failure here
 * degrades the pruning rather than the search. Callers must `dispose()` once
 * the process has exited.
 */
export async function createRipgrepIgnoreFile(
	rules: RipgrepScanRules | undefined,
	scope: RipgrepRuleScope = "all",
): Promise<RipgrepIgnoreFile> {
	// Searching walks the tree, so it follows the scan rules rather than the read
	// rules: whether a path may be traversed is a different question from whether
	// its contents may be opened.
	//
	// An agent-only scope keeps the workspace's own restrictions and drops the
	// pruning, so naming an ignored path can widen what is walked but never what
	// is permitted.
	const content = scope === "agent-only" ? rules?.getAgentScanContent?.() : rules?.getIgnoreContent("scan")
	if (!content) {
		return NO_IGNORE_FILE
	}

	const fileName = `.agentignore-rg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
	const filePath = path.join(os.tmpdir(), fileName)

	try {
		await fs.writeFile(filePath, content, "utf8")
	} catch (error) {
		Logger.error("Failed to write the agent ignore file for rg:", error)
		return NO_IGNORE_FILE
	}

	return {
		args: ["--ignore-file", filePath],
		dispose: async () => {
			try {
				await fs.unlink(filePath)
			} catch {
				// A leftover file in the OS temp directory is not worth surfacing.
			}
		},
	}
}
