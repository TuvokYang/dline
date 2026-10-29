/**
 * Pure functions for the partial-tool lifecycle state machine used by
 * `reRenderUpdatedPartialBlocks`.  Extracted from `Task` so the state
 * transitions are independently testable without dragging in the full
 * Task / ToolExecutor dependency graph.
 *
 * Lifecycle states:
 *   partial-shown    - handlePartialBlock ran, awaiting final
 *   complete-running - final executeTool in progress
 *   complete-done    - final executeTool completed
 */

export type PartialToolLifecycle = "partial-shown" | "complete-running" | "complete-done"

export type DeferredToolAction = "execute" | "defer" | "skip"

/**
 * Determine what action to take for a tool block that has transitioned
 * from partial to non-partial after the presentation index advanced past it.
 *
 * @param lifecycle Current lifecycle state from `partialToolLifecycleByTs`
 * @param isTurnEnding Whether this tool ends the assistant turn
 * @param streamComplete Whether the API stream has finished (`didCompleteReadingStream`)
 */
export function getDeferredToolAction(
    lifecycle: PartialToolLifecycle | undefined,
    isTurnEnding: boolean,
    streamComplete: boolean,
): DeferredToolAction {
    // Already executing or completed - nothing to do
    if (lifecycle === "complete-running" || lifecycle === "complete-done") {
        return "skip"
    }

    // Never seen or already handled
    if (lifecycle !== "partial-shown") {
        return "skip"
    }

    // Turn-ending tools must wait until the stream is fully consumed
    if (isTurnEnding && !streamComplete) {
        return "defer"
    }

    return "execute"
}

/**
 * Advance the lifecycle of a single deferred-tool entry.
 *
 * Performs state validation before mutating the map:
 *   start-execute     : partial-shown  -> complete-running
 *   execution-success : complete-running -> complete-done
 *   execution-failed  : complete-running -> partial-shown
 * All other combinations are no-ops (the map is unchanged).
 *
 * @param map The lifecycle map (mutated in place)
 * @param ts  Timestamp of the tool block
 * @param action Which lifecycle transition to record
 */
export function advanceLifecycle(
    map: Map<number, PartialToolLifecycle>,
    ts: number,
    action: "start-execute" | "execution-success" | "execution-failed",
): void {
    const current = map.get(ts)

    switch (action) {
        case "start-execute":
            if (current === "partial-shown") {
                map.set(ts, "complete-running")
            }
            break

        case "execution-success":
            if (current === "complete-running") {
                map.set(ts, "complete-done")
            }
            break

        case "execution-failed":
            if (current === "complete-running") {
                map.set(ts, "partial-shown")
            }
            break
    }
}
