import { displayTextOf } from "@shared/input-semantics/presentation"
import type { UserInputEnvelope } from "../stores/payload/TaskPayloadEnvelopes"

/**
 * The text a user's own chat row shows for one submitted input.
 *
 * A structured input is shown from its document, so each resource appears by
 * name where the user placed it, even when the input holds nothing else; the
 * raw text of such an input is only the composer's mirror. A legacy input has
 * no document and is shown as typed.
 */
export function userInputRowText(payload: Pick<UserInputEnvelope, "text" | "semanticInput">): string {
    return payload.semanticInput ? displayTextOf(payload.semanticInput) : (payload.text ?? "")
}
