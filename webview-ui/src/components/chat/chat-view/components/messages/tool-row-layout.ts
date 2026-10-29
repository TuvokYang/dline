/** Text widths are supplied by the renderer in CSS pixels, using its actual font. */
export type MeasureText = (text: string) => number

export interface ToolRowParts {
    prefix?: string
    prefixSeparator?: string
    path: string
    suffix?: string
    suffixSeparator?: string
}

export interface ToolItemText {
    /** Uncompressed row summary, including the existing search-term count cap. */
    displayText: string
    /** Complete hover/accessibility text; never replaced with the fitted path. */
    tooltipText: string
    /** Structured path entries; plain summaries use displayText instead. */
    row?: ToolRowParts
}

export interface ToolRowLayout {
    mode: "full" | "compact" | "metadata-only"
    showIcon: boolean
    prefix: string
    prefixSeparator: string
    path: string
    suffixSeparator: string
    suffix: string
}

export const TOOL_ROW_ICON_WIDTH = 12
export const TOOL_ROW_GAP = 3
const ELLIPSIS = "…"

/** Fit a prefix without splitting UTF-16 surrogate pairs. */
export function fitText(text: string, width: number, measure: MeasureText): string {
    return measure(text) <= width ? text : fitPrefix(text, width, measure, ELLIPSIS)
}

function fitPrefix(text: string, width: number, measure: MeasureText, ending: string): string {
    if (measure(ending) > width) return ""
    const characters = Array.from(text)
    let low = 0
    let high = characters.length
    while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        if (measure(characters.slice(0, mid).join("") + ending) <= width) low = mid
        else high = mid - 1
    }
    return characters.slice(0, low).join("") + ending
}

function leafParts(path: string) {
    const matches = [...path.matchAll(/[^\\/]+/g)]
    const last = matches.at(-1)
    const name = last?.[0] ?? path
    const trailing = last ? path.slice(last.index + name.length) : ""
    const dot = name.lastIndexOf(".")
    const extension = dot > 0 ? name.slice(dot) : ""
    return { matches, name, trailing, extension, stem: extension ? name.slice(0, dot) : name }
}

/** Keep as many trailing directory segments as fit; abbreviate the leaf only as a last resort. */
export function compactPath(path: string, width: number, measure: MeasureText): string {
    if (measure(path) <= width) return path
    const { matches, name, trailing, extension, stem } = leafParts(path)
    for (let index = 1; index < matches.length; index++) {
        const start = matches[index].index
        const candidate = `${ELLIPSIS}${path[start - 1]}${path.slice(start)}`
        if (measure(candidate) <= width) return candidate
    }
    const leaf = name + trailing
    if (measure(leaf) <= width) return leaf
    // Preserve the extension when at least one stem character can still be shown.
    const ending = ELLIPSIS + extension + trailing
    if (measure((Array.from(stem)[0] ?? "") + ending) <= width) {
        return fitPrefix(stem, width, measure, ending)
    }
    return fitText(leaf, width, measure)
}

function minimumPathWidth(path: string, measure: MeasureText): number {
    const { name, stem, extension, trailing } = leafParts(path)
    const minimalLeaf = Array.from(stem).slice(0, 3).join("") + ELLIPSIS + extension + trailing
    return Math.min(measure(name + trailing), measure(minimalLeaf))
}

/**
 * Reserve metadata first, then the icon and a meaningful leaf. Prefixes may use
 * up to a third of the remaining space, but never displace the complete leaf.
 * If even a useful leaf cannot fit, remove all leading content atomically.
 * Widths below the metadata's own width are a physical lower bound: keep its text intact.
 */
export function layoutToolRow(parts: ToolRowParts, width: number, measure: MeasureText): ToolRowLayout {
    const suffix = parts.suffix ?? ""
    const prefix = parts.prefix ?? ""
    const prefixSeparator = prefix ? (parts.prefixSeparator ?? " ") : ""
    const suffixSeparator = suffix ? (parts.suffixSeparator ?? " ") : ""
    const full: ToolRowLayout = {
        mode: "full",
        showIcon: true,
        prefix,
        prefixSeparator,
        path: parts.path,
        suffixSeparator,
        suffix,
    }
    const iconSpace = TOOL_ROW_ICON_WIDTH + TOOL_ROW_GAP
    const metadataSpace = suffix ? measure(suffix) + measure(suffixSeparator) : 0
    const fullWidth = iconSpace + measure(prefix) + measure(prefixSeparator) + measure(parts.path) + metadataSpace
    if (fullWidth <= width) return full

    let available = Math.max(0, width - iconSpace - metadataSpace)
    const minimum = minimumPathWidth(parts.path, measure)
    if (suffix && available < minimum) {
        return { mode: "metadata-only", showIcon: false, prefix: "", prefixSeparator: "", path: "", suffixSeparator: "", suffix }
    }
    const showIcon = available >= minimum
    if (!showIcon) available = Math.max(0, width - metadataSpace)

    const { name, trailing } = leafParts(parts.path)
    const prefixBudget = Math.min(available / 3, available - measure(name + trailing) - measure(prefixSeparator))
    const fittedPrefix =
        prefixBudget >= measure(Array.from(prefix).slice(0, 3).join("") + ELLIPSIS) ? fitText(prefix, prefixBudget, measure) : ""
    const fittedSeparator = fittedPrefix ? prefixSeparator : ""
    const pathBudget = available - measure(fittedPrefix) - measure(fittedSeparator)
    return {
        mode: "compact",
        showIcon,
        prefix: fittedPrefix,
        prefixSeparator: fittedSeparator,
        path: compactPath(parts.path, Math.max(0, pathBudget), measure),
        suffixSeparator,
        suffix,
    }
}
