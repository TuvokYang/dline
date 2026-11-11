export interface ScrollEventRecord {
    time: number
    source: string
    scrollTop: number
    delta: number
}
export interface RowObservation {
    ts: string
    top: number
}
export interface AnchorSample {
    time: number
    scrollTop: number
    anchorTop: number | null
    trackedTs: string | null
    rows?: RowObservation[]
    viewportHeight?: number
    paddingTop?: number
    contentTop?: number
    marginTop?: number
    flowPrefix?: number
    frameTime?: number
    programmaticSources?: string[]
    /** Present on continuous samples, not on settled samples. */
    programmaticPx?: number
}
export interface JitterDiagnostics {
    samples: AnchorSample[]
    events: ScrollEventRecord[]
    netTravel: number
    totalTravel: number
    excessTravel: number
    reversals: number
    peakToPeak: number
}
export interface PaintedFrame extends AnchorSample {
    visible: Record<string, number>
    programmaticTotal: number
    afterResize: boolean
}
export interface RenderingState {
    time: number
    visibility: string
    focused: boolean
}
export interface CoordinateRecord {
    time: number
    origin: number | null
    scrollHeight: number
    anchorItemIndex: number | null
}
export interface SizeChangeRecord {
    time: number
    itemIndex: number | null
    ts: string
    from: number
    to: number
    aboveAnchor: boolean
}
export interface SizeCorrectionRecord {
    time: number
    ts: string
    believed: number
    measured: number
    correction: number
    itemIndex: string | null
    priorMounts: number
    priorHeights: number[]
}

// Compare consecutive samples of the same mounted row; a handover is not displacement.
export function countBackwardFrames(samples: AnchorSample[], expectedAnchorDirection: number): number {
    const MIN_VISIBLE_PX = 6
    let backward = 0
    const onScreen = (sample: AnchorSample): number | null => sample.anchorTop
    for (let index = 1; index < samples.length; index++) {
        const previous = samples[index - 1]
        const current = samples[index]
        if (!previous || !current) continue
        if (previous.trackedTs === null || previous.trackedTs !== current.trackedTs) continue
        if (Math.sign(current.scrollTop - previous.scrollTop) !== -expectedAnchorDirection) continue
        const before = onScreen(previous)
        const after = onScreen(current)
        if (before === null || after === null) continue
        const step = after - before
        if (Math.abs(step) < MIN_VISIBLE_PX) continue
        if (Math.sign(step) !== expectedAnchorDirection) backward++
    }
    return backward
}
export function countTrackedRowSwitches(samples: AnchorSample[]): number {
    let switches = 0
    for (let index = 1; index < samples.length; index++) {
        const previous = samples[index - 1]
        const current = samples[index]
        if (!previous || !current) continue
        if (previous.trackedTs !== null && current.trackedTs !== null && previous.trackedTs !== current.trackedTs) switches++
    }
    return switches
}
export function unexplainedShift(previous: AnchorSample, current: AnchorSample): number | null {
    if (previous.trackedTs === null || previous.trackedTs !== current.trackedTs) return null
    if (previous.anchorTop === null || current.anchorTop === null) return null
    const jumpThreshold = current.viewportHeight ?? previous.viewportHeight ?? Number.POSITIVE_INFINITY
    if (Math.abs(current.scrollTop - previous.scrollTop) >= jumpThreshold) return null
    const onScreen = current.anchorTop - previous.anchorTop
    const scrolled = current.scrollTop - previous.scrollTop
    return onScreen + scrolled
}
export function classifyLegacyDiscards(samples: AnchorSample[]): { anchorChanged: number; repositioned: number } {
    let anchorChanged = 0
    let repositioned = 0
    for (let index = 1; index < samples.length; index++) {
        const previous = samples[index - 1]
        const current = samples[index]
        if (!previous || !current) continue
        if (previous.trackedTs === null || previous.trackedTs !== current.trackedTs) {
            anchorChanged++
            continue
        }
        if (previous.anchorTop === null || current.anchorTop === null) {
            anchorChanged++
            continue
        }
        const jumpThreshold = current.viewportHeight ?? previous.viewportHeight ?? Number.POSITIVE_INFINITY
        if (Math.abs(current.scrollTop - previous.scrollTop) >= jumpThreshold) repositioned++
    }
    return { anchorChanged, repositioned }
}
type FrameMovement =
    | { kind: "measured"; via: string; visualError: number; layoutDelta: number; nonUserScroll: number }
    | { kind: "coverageGap" }
    | { kind: "sameFrame" }
    | { kind: "navigation"; scrolled: number }
function sharedRow(previous: AnchorSample, current: AnchorSample): { ts: string; before: number; after: number } | null {
    const previousRows = previous.rows
    const currentRows = current.rows
    if (!previousRows || !currentRows) return null
    const currentByTs = new Map(currentRows.map((row) => [row.ts, row.top]))
    const middle = (previous.viewportHeight ?? 0) / 2
    let best: { ts: string; before: number; after: number } | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const row of previousRows) {
        const after = currentByTs.get(row.ts)
        if (after === undefined) continue
        const distance = Math.abs(row.top - middle)
        if (distance < bestDistance) {
            bestDistance = distance
            best = { ts: row.ts, before: row.top, after }
        }
    }
    return best
}
function frameMovement(previous: AnchorSample, current: AnchorSample): FrameMovement {
    if (previous.frameTime !== undefined && current.frameTime !== undefined && previous.frameTime === current.frameTime)
        return { kind: "sameFrame" }
    const shared = sharedRow(previous, current)
    const measurement = shared
        ? { via: shared.ts, onScreen: shared.after - shared.before }
        : previous.trackedTs !== null &&
            previous.trackedTs === current.trackedTs &&
            previous.anchorTop !== null &&
            current.anchorTop !== null
          ? { via: previous.trackedTs, onScreen: current.anchorTop - previous.anchorTop }
          : null
    if (!measurement) return { kind: "coverageGap" }
    const scrolled = current.scrollTop - previous.scrollTop
    const nonUserScroll = current.programmaticPx!
    const userScroll = scrolled - nonUserScroll
    const viewportHeight = current.viewportHeight ?? previous.viewportHeight
    if (viewportHeight !== undefined && Math.abs(scrolled) >= viewportHeight) return { kind: "navigation", scrolled }
    return {
        kind: "measured",
        via: measurement.via,
        visualError: measurement.onScreen + userScroll,
        layoutDelta: measurement.onScreen + scrolled,
        nonUserScroll,
    }
}
export function largestVisualError(samples: AnchorSample[]): {
    pixels: number
    atTime: number | null
    layoutDelta: number
    nonUserScroll: number
    coverageGaps: number
    sameFrame: number
    navigations: number
    sources: string[]
} {
    let largest = 0
    let atTime: number | null = null
    let layoutDelta = 0
    let nonUserScroll = 0
    let coverageGaps = 0
    let sameFrame = 0
    let navigations = 0
    let sources: string[] = []
    for (let index = 1; index < samples.length; index++) {
        const previous = samples[index - 1]
        const current = samples[index]
        if (!previous || !current) continue
        const movement = frameMovement(previous, current)
        if (movement.kind === "sameFrame") {
            sameFrame++
            continue
        }
        if (movement.kind === "navigation") {
            navigations++
            continue
        }
        if (movement.kind === "coverageGap") {
            coverageGaps++
            continue
        }
        if (Math.abs(movement.visualError) > Math.abs(largest)) {
            largest = movement.visualError
            atTime = current.time
            layoutDelta = movement.layoutDelta
            nonUserScroll = movement.nonUserScroll
            sources = current.programmaticSources ?? []
        }
    }
    return { pixels: largest, atTime, layoutDelta, nonUserScroll, coverageGaps, sameFrame, navigations, sources }
}
export function worstVisualErrorFrames(
    samples: AnchorSample[],
    limit: number,
): Array<{
    at: number
    visualError: number
    layoutDelta: number
    nonUserScroll: number
    residualScroll: number
    via: string
    sources: string[]
}> {
    const scored: Array<{
        at: number
        visualError: number
        layoutDelta: number
        nonUserScroll: number
        residualScroll: number
        via: string
        sources: string[]
    }> = []
    for (let index = 1; index < samples.length; index++) {
        const previous = samples[index - 1]
        const current = samples[index]
        if (!previous || !current) continue
        const movement = frameMovement(previous, current)
        if (movement.kind !== "measured") continue
        scored.push({
            at: Math.round(current.time),
            visualError: Math.round(movement.visualError),
            layoutDelta: Math.round(movement.layoutDelta),
            nonUserScroll: Math.round(movement.nonUserScroll),
            residualScroll: Math.round(current.scrollTop - previous.scrollTop - movement.nonUserScroll),
            via: movement.via,
            sources: current.programmaticSources ?? [],
        })
    }
    scored.sort((left, right) => Math.abs(right.visualError) - Math.abs(left.visualError))
    return scored.slice(0, limit)
}
export function describeRowMotion(
    previous: AnchorSample,
    current: AnchorSample,
): { shared: number; minShift: number; maxShift: number; spread: number; uniform: boolean } | null {
    const previousRows = previous.rows
    const currentRows = current.rows
    if (!previousRows || !currentRows) return null
    const currentByTs = new Map(currentRows.map((row) => [row.ts, row.top]))
    const shifts: number[] = []
    for (const row of previousRows) {
        const after = currentByTs.get(row.ts)
        if (after === undefined) continue
        shifts.push(after - row.top)
    }
    if (shifts.length === 0) return null
    const minShift = Math.min(...shifts)
    const maxShift = Math.max(...shifts)
    const spread = maxShift - minShift
    return {
        shared: shifts.length,
        minShift: Math.round(minShift),
        maxShift: Math.round(maxShift),
        spread: Math.round(spread),
        uniform: spread < 2,
    }
}
export function largestContentDisplacement(samples: AnchorSample[]): { pixels: number; atTime: number | null } {
    let largest = 0
    let atTime: number | null = null
    for (let index = 1; index < samples.length; index++) {
        const previous = samples[index - 1]
        const current = samples[index]
        if (!previous || !current) continue
        const shift = unexplainedShift(previous, current)
        if (shift === null) continue
        const displacement = Math.abs(shift)
        if (displacement > largest) {
            largest = displacement
            atTime = current.time
        }
    }
    return { pixels: largest, atTime }
}
export function largestAnchorJump(samples: AnchorSample[]): number {
    const resolved = samples.filter((sample): sample is AnchorSample & { anchorTop: number } => sample.anchorTop !== null)
    let largest = 0
    for (let index = 1; index < resolved.length; index++) {
        const previous = resolved[index - 1]
        const current = resolved[index]
        if (!previous || !current) continue
        largest = Math.max(largest, Math.abs(current.anchorTop - previous.anchorTop))
    }
    return largest
}
export function countContestedRestores(events: ScrollEventRecord[]): number {
    const MIN_OFFSET_PX = 8
    const OPPOSITION_TOLERANCE = 0.3
    const WINDOW_MS = 400
    const moves = events.filter((event) => event.source === "scroll" && Math.abs(event.delta) >= MIN_OFFSET_PX)
    let contested = 0
    for (let index = 1; index < moves.length; index++) {
        const previous = moves[index - 1]
        const current = moves[index]
        if (!previous || !current) continue
        if (current.time - previous.time > WINDOW_MS) continue
        if (Math.sign(current.delta) === Math.sign(previous.delta)) continue
        const ratio = Math.abs(current.delta) / Math.abs(previous.delta)
        if (Math.abs(ratio - 1) <= OPPOSITION_TOLERANCE) contested++
    }
    return contested
}
export function describeRendering(label: string, state: RenderingState): string {
    return `${label}@${Math.round(state.time)}ms visibility=${state.visibility} focused=${state.focused}`
}
export function describeCadence(times: number[]): string {
    const first = times[0]
    const last = times.at(-1)
    if (first === undefined || last === undefined || times.length < 2) return `samples=${times.length}`
    const intervals = times
        .slice(1)
        .map((time, index) => time - (times[index] ?? time))
        .sort((a, b) => a - b)
    const median = intervals[Math.floor(intervals.length / 2)] ?? 0
    const longest = intervals.at(-1) ?? 0
    return `samples=${times.length} span=${Math.round(first)}..${Math.round(last)}ms medianInterval=${median.toFixed(1)}ms longestInterval=${Math.round(longest)}ms`
}
export function describeSettleSamples(samples: AnchorSample[]): string {
    const scrollTops = samples.map((sample) => sample.scrollTop)
    const firstUnresolved = samples.findIndex((sample) => sample.anchorTop === null)
    return `${describeCadence(samples.map((sample) => sample.time))} scrollTop=${Math.round(scrollTops[0] ?? 0)}->${Math.round(scrollTops.at(-1) ?? 0)} (min=${Math.round(Math.min(...scrollTops))}, max=${Math.round(Math.max(...scrollTops))}) firstUnresolved=${firstUnresolved}`
}
export interface PaintedShift {
    frame: number
    time: number
    shift: number
    readerScroll: number
    sharedRows: number
}
export function paintedShifts(frames: PaintedFrame[]): PaintedShift[] {
    const shifts: PaintedShift[] = []
    for (let index = 1; index < frames.length; index++) {
        const previous = frames[index - 1]
        const current = frames[index]
        if (!previous || !current) continue
        const readerScroll = current.scrollTop - previous.scrollTop - (current.programmaticTotal - previous.programmaticTotal)
        let smallest: number | null = null
        let sharedRows = 0
        for (const [ts, top] of Object.entries(current.visible)) {
            const before = previous.visible[ts]
            if (before === undefined) continue
            sharedRows++
            const remainder = top - before + readerScroll
            if (smallest === null || Math.abs(remainder) < Math.abs(smallest)) smallest = remainder
        }
        if (smallest === null) continue
        shifts.push({ frame: index, time: current.time, shift: smallest, readerScroll, sharedRows })
    }
    return shifts
}
/** Measure every frame pair; a missing shared identity is a coverage gap, not zero motion. */
export function measurePaintedDisplacements(frames: PaintedFrame[]): { shifts: PaintedShift[]; coverageGaps: number } {
    const shifts: PaintedShift[] = []
    let coverageGaps = 0
    for (let index = 1; index < frames.length; index++) {
        const previous = frames[index - 1]!
        const current = frames[index]!
        const readerScroll = current.scrollTop - previous.scrollTop - (current.programmaticTotal - previous.programmaticTotal)
        let largest: number | null = null
        let sharedRows = 0
        for (const [ts, top] of Object.entries(current.visible)) {
            const before = previous.visible[ts]
            if (before === undefined) continue
            sharedRows++
            const displacement = top - before + readerScroll
            if (largest === null || Math.abs(displacement) > Math.abs(largest)) largest = displacement
        }
        if (largest === null) coverageGaps++
        else shifts.push({ frame: index, time: current.time, shift: largest, readerScroll, sharedRows })
    }
    return { shifts, coverageGaps }
}
const PAINT_FLASH_MIN_PX = 60
const PAINT_FLASH_WINDOW_MS = 100
export interface PaintedFlash {
    at: number
    out: number
    back: number
    frames: number
    outFrame: number
    backFrame: number
}
export function paintedFlashes(shifts: PaintedShift[]): PaintedFlash[] {
    const flashes: PaintedFlash[] = []
    let index = 0
    while (index < shifts.length) {
        const out = shifts[index]
        let matched = index
        if (out && Math.abs(out.shift) >= PAINT_FLASH_MIN_PX) {
            for (let next = index + 1; next < shifts.length; next++) {
                const back = shifts[next]
                if (!back || back.time - out.time > PAINT_FLASH_WINDOW_MS) break
                if (Math.abs(back.shift) >= PAINT_FLASH_MIN_PX && Math.sign(back.shift) !== Math.sign(out.shift)) {
                    flashes.push({
                        at: Math.round(out.time),
                        out: Math.round(out.shift),
                        back: Math.round(back.shift),
                        frames: next - index,
                        outFrame: out.frame,
                        backFrame: back.frame,
                    })
                    matched = next
                    break
                }
            }
        }
        index = matched + 1
    }
    return flashes
}
export function describeFlash(frames: PaintedFrame[], flash: PaintedFlash) {
    return frames.slice(Math.max(0, flash.outFrame - 2), flash.backFrame + 2).map((frame) => ({
        t: Math.round(frame.time),
        scrollTop: Math.round(frame.scrollTop),
        programmatic: Math.round(frame.programmaticTotal),
        afterResize: frame.afterResize,
        rows: Object.entries(frame.visible)
            .slice(0, 3)
            .map(([ts, top]) => `${ts.slice(-4)}@${Math.round(top)}`),
        rowCount: Object.keys(frame.visible).length,
    }))
}
