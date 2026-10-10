import { getPrompt } from "@core/prompts/i18n"

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
    const description = escapeXmlAttribute(getPrompt("inputQueue", "auxiliaryAlignmentV1", "en"))
    if (texts.length === 1) return `<user_message description="${description}">\n${texts[0]}\n</user_message>`
    const messages = texts.map((text) => `<user_message>\n${text}\n</user_message>`).join("\n\n")
    return `<user_messages description="${description}">\n${messages}\n</user_messages>`
}
