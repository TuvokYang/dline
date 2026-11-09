interface SummaryPart {
    readonly itemId: string
    readonly index: number | undefined
}

function lineBreaks(text: string): number {
    return text.match(/\n/g)?.length ?? 0
}

/** Preserve Responses summary-part boundaries in the flattened readable text of one response. */
export class ResponsesSummaryText {
    private previous: SummaryPart | undefined
    private trailingBreaks = 0

    append(text: string, itemId: string, index: number | undefined): string {
        if (!text) return text

        const previous = this.previous
        // Compatible gateways may omit summary_index; do not invent token boundaries in that case.
        const newPart =
            previous !== undefined &&
            (previous.itemId !== itemId || (previous.index !== undefined && index !== undefined && previous.index !== index))
        const leadingBreaks = lineBreaks(text.match(/^(?:\r?\n)*/)?.[0] ?? "")
        const separator = newPart ? "\n".repeat(Math.max(0, 2 - this.trailingBreaks - leadingBreaks)) : ""
        this.previous = { itemId, index: index ?? (previous?.itemId === itemId ? previous.index : undefined) }
        // A delta can consist entirely of line breaks, so retain the suffix across token boundaries.
        const suffix = text.match(/(?:\r?\n)*$/)?.[0] ?? ""
        this.trailingBreaks = Math.min(
            2,
            lineBreaks(suffix) + (suffix.length === text.length ? this.trailingBreaks + separator.length : 0),
        )
        return separator + text
    }
}
