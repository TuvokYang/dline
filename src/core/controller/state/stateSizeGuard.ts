import type { ExtensionState } from "@/shared/ExtensionMessage"

/**
 * Last line of defence against a state payload large enough to stall the host.
 *
 * Bounding the known offender removes the cause that was found; it does not
 * prevent the next unbounded field from appearing. Serializing a payload of
 * this size occupies the extension host main thread, and field logs show it
 * repeating several times a second across concurrent tasks — so a payload that
 * still arrives oversized is degraded rather than sent whole.
 *
 * Degrading is preferred to dropping: a webview that receives nothing renders
 * the blank panel this workstream exists to remove.
 */

/**
 * Size above which a payload is degraded before delivery.
 *
 * Well clear of a normal push and of a task history at its own 100-item cap,
 * so this only engages for a field that has escaped its bounds.
 */
export const STATE_SIZE_DEGRADE_THRESHOLD_BYTES = 8 * 1024 * 1024

/**
 * Fields dropped when degrading, in the order they are given up.
 *
 * Each is bulk display data the webview can do without for one render, and
 * each has its own path to the full content: focus chain history is opened
 * from the panel, and task history is re-read by the history view. Nothing
 * here carries interaction state or identity, so degrading cannot strand a
 * task or lose a user's answer.
 */
const DEGRADABLE_FIELDS = ["focusChainHistory", "taskHistory"] as const

export interface StateDegradation {
    state: ExtensionState
    /** Fields that were dropped, empty when the payload was left intact. */
    droppedFields: string[]
}

/**
 * Returns a payload safe to serialize for delivery.
 *
 * Drops fields one at a time and stops as soon as the payload fits, so a
 * payload only slightly over the limit keeps as much as possible. The state is
 * copied rather than mutated: the caller's object is also the one kept for
 * later pushes, and degrading it in place would make the loss permanent.
 */
export function degradeOversizedState(
    state: ExtensionState,
    serializedBytes: number,
    thresholdBytes: number = STATE_SIZE_DEGRADE_THRESHOLD_BYTES,
): StateDegradation {
    if (serializedBytes < thresholdBytes) {
        return { state, droppedFields: [] }
    }

    const degraded: ExtensionState = { ...state, stateDegraded: true }
    const droppedFields: string[] = []

    for (const field of DEGRADABLE_FIELDS) {
        if (degraded[field] === undefined) {
            continue
        }
        // Emptied rather than deleted: an absent key and an empty one read the
        // same to the webview, and `stateDegraded` is what tells them apart.
        degraded[field] = (Array.isArray(state[field]) ? [] : null) as never
        droppedFields.push(field)

        if (measureBytes(degraded) < thresholdBytes) {
            break
        }
    }

    return { state: degraded, droppedFields }
}

/**
 * Serialized size of a candidate payload, or the worst case when it cannot be
 * measured. Reporting a failure as oversized keeps the loop dropping fields
 * instead of concluding that an unmeasurable payload is safe to send.
 */
function measureBytes(state: ExtensionState): number {
    try {
        return Buffer.byteLength(JSON.stringify(state), "utf8")
    } catch {
        return Number.POSITIVE_INFINITY
    }
}
