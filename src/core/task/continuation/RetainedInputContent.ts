import { getPrompt } from "@core/prompts/i18n"
import { type AdmittedInputPart, appendAdmittedPart } from "@shared/input-semantics/admitted-parts"

function escapeXmlAttribute(value: string): string {
    return value
        .replace(/&/g, "&" + "amp;")
        .replace(/"/g, "&" + "quot;")
        .replace(/</g, "&" + "lt;")
        .replace(/>/g, "&" + "gt;")
        .replace(/'/g, "&" + "apos;")
}

/** Model-only guidance; the user's chat row always keeps the original text. */
export function renderRetainedInput(text: string): string {
    return renderRetainedInputs([text])
}

/** A batch shares guidance but keeps every authored input as an ordered sibling. */
export function renderRetainedInputs(texts: readonly string[]): string {
    return renderRetainedInputParts(texts.map((text) => [{ kind: "text", text }]))
        .map((part) => (part.kind === "text" ? part.text : ""))
        .join("")
}

/**
 * The same rendering as {@link renderRetainedInputs}, keeping each input's
 * resources where its author placed them.
 *
 * One wrapping serves both forms, so a batch reads the same to the model
 * whether or not one of its inputs carries an image or a file.
 */
export function renderRetainedInputParts(inputs: readonly (readonly AdmittedInputPart[])[]): AdmittedInputPart[] {
    const description = escapeXmlAttribute(getPrompt("inputQueue", "auxiliaryAlignmentV1", "en"))
    const rendered: AdmittedInputPart[] = []
    const text = (value: string) => appendAdmittedPart(rendered, { kind: "text", text: value })
    if (inputs.length === 1) {
        text(`<user_message description="${description}">\n`)
        for (const part of inputs[0] ?? []) appendAdmittedPart(rendered, part)
        text("\n</user_message>")
        return rendered
    }
    text(`<user_messages description="${description}">\n`)
    inputs.forEach((parts, index) => {
        text(`${index === 0 ? "" : "\n\n"}<user_message>\n`)
        for (const part of parts) appendAdmittedPart(rendered, part)
        text("\n</user_message>")
    })
    text("\n</user_messages>")
    return rendered
}
