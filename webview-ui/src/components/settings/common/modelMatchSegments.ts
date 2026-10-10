import type { FuseResultMatch } from "fuse.js"

/** One run of an option label, flagged when it is part of a search match. */
export interface MatchSegment {
    text: string
    matched: boolean
    /** Stable per label: the run's start offset in the original text. */
    start: number
}

type MatchRange = readonly [number, number]

/**
 * Merges the overlapping and adjacent ranges Fuse reports for a single key.
 *
 * Fuse emits one range per matched run, and consecutive characters can arrive
 * as separate ranges. Rendering them unmerged would split a continuous match
 * into several elements.
 */
function mergeRanges(ranges: readonly MatchRange[]): MatchRange[] {
    if (ranges.length === 0) {
        return []
    }

    const sorted = [...ranges].sort((a, b) => a[0] - b[0])
    const merged: [number, number][] = [[sorted[0][0], sorted[0][1]]]

    for (let index = 1; index < sorted.length; index++) {
        const last = merged[merged.length - 1]
        const current = sorted[index]
        if (current[0] <= last[1] + 1) {
            last[1] = Math.max(last[1], current[1])
        } else {
            merged.push([current[0], current[1]])
        }
    }

    return merged
}

/**
 * Splits a label into matched and unmatched runs.
 *
 * The picker renders these as React elements instead of injecting markup, so
 * a model id containing HTML-significant characters stays literal text.
 */
export function toMatchSegments(text: string, matches: readonly FuseResultMatch[] | undefined): MatchSegment[] {
    const ranges = mergeRanges((matches ?? []).flatMap((match) => (match.indices ?? []) as unknown as MatchRange[]))
    if (ranges.length === 0) {
        return [{ text, matched: false, start: 0 }]
    }

    const segments: MatchSegment[] = []
    let cursor = 0

    for (const [start, end] of ranges) {
        if (start > cursor) {
            segments.push({ text: text.slice(cursor, start), matched: false, start: cursor })
        }
        segments.push({ text: text.slice(start, end + 1), matched: true, start })
        cursor = end + 1
    }

    if (cursor < text.length) {
        segments.push({ text: text.slice(cursor), matched: false, start: cursor })
    }

    return segments
}
