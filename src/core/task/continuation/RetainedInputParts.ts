import { type AdmittedInputPart, hasResourceParts } from "@shared/input-semantics/admitted-parts"
import type { UserInputEnvelope } from "../stores/payload/TaskPayloadEnvelopes"
import { renderRetainedInputParts } from "./RetainedInputContent"

/**
 * The parts of a retained batch, with each entry's resources where its user placed them.
 *
 * Undefined when no entry carries a resource, because the batch's text then
 * represents it fully. An entry without parts contributes the text the model
 * reads for it, so a mixed batch keeps every entry in order.
 */
export function retainedInputPartsOf(payloads: readonly UserInputEnvelope[]): readonly AdmittedInputPart[] | undefined {
    if (!payloads.some((payload) => payload.admittedParts && hasResourceParts(payload.admittedParts))) return undefined
    return renderRetainedInputParts(
        payloads.map(
            (payload): readonly AdmittedInputPart[] =>
                payload.admittedParts ?? [{ kind: "text", text: payload.admittedText ?? payload.text ?? "" }],
        ),
    )
}
