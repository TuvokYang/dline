/**
 * Decide what one committed external state change requires of a Controller.
 *
 * The callback this answers used to run the same three steps for every event,
 * so an idle window whose task history was rewritten paid for a full component
 * reconfiguration and a full state publication. The decisions are separated
 * from the work here because they are the part that differs per source, and
 * because "this event needs nothing" is the case that regressed.
 */

/** The event shapes the Controller reacts to; mirrors `StateSyncEvent["source"]`. */
export type ExternalStateChangeSource = "settings" | "task_history" | "account_usage" | "global_state"

export interface ExternalStateChangePlan {
    /**
     * Whether to reconfigure every registered runtime component.
     *
     * Only a settings commit can change the snapshot those components consume.
     * Task history lives in the state cache and is read during the state build,
     * so reconfiguring on a history write is pure repetition.
     */
    readonly reconfigureComponents: boolean
    /** Whether to rebuild and publish the full extension state. */
    readonly publishState: boolean
}

const DO_NOTHING: ExternalStateChangePlan = { reconfigureComponents: false, publishState: false }
const PUBLISH_ONLY: ExternalStateChangePlan = { reconfigureComponents: false, publishState: true }
const RECONFIGURE_AND_PUBLISH: ExternalStateChangePlan = { reconfigureComponents: true, publishState: true }

/**
 * Plan the reaction to one committed change.
 *
 * @param source Which authority changed.
 * @param changedKeys Keys the commit actually changed; empty for non-settings sources.
 */
export function planExternalStateChange(
    source: ExternalStateChangeSource,
    changedKeys: readonly string[],
): ExternalStateChangePlan {
    if (source === "settings") {
        // The settings repository already declines to publish a commit with no
        // changed keys, so one arriving here is a replay of a fact the caller
        // has seen. Reconfiguring and republishing for it would make an empty
        // commit cost the same as a real one.
        return changedKeys.length === 0 ? DO_NOTHING : RECONFIGURE_AND_PUBLISH
    }
    // Task history and account usage change what the Webview renders, so the
    // state still has to be rebuilt and published; neither is part of the
    // configuration snapshot, so no component needs reconfiguring.
    return PUBLISH_ONLY
}
