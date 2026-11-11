import { writeFile } from "node:fs/promises"
import type { Frame, TestInfo } from "@playwright/test"
import { SETTLE_SAMPLE_COUNT, SETTLE_SAMPLE_INTERVAL_MS } from "./fixture"
import type {
    AnchorSample,
    CoordinateRecord,
    JitterDiagnostics,
    PaintedFrame,
    RenderingState,
    RowObservation,
    ScrollEventRecord,
    SizeChangeRecord,
    SizeCorrectionRecord,
} from "./measurements"

interface RowShiftRecord {
    time: number
    dy: number
    index: string | null
    rows?: number
    firstIndex?: string | null
    lastIndex?: string | null
    scrollTop?: number
    padding?: number
    source?: {
        ts: string | null
        tag: string | null
        className: string | null
        previousTop: number
        previousBottom: number
        currentTop: number
        currentBottom: number
        viewportTop: number
        viewportBottom: number
    }
}
interface CorrectionPhaseRecord {
    time: number
    scrollTop: number
    frame: number
}

// Page callbacks stay self-contained: imported names below are erased types only.
export async function installScrollObserver(sidebar: Frame): Promise<void> {
    await sidebar.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]')
        if (!scroller) throw new Error("virtuoso scroller must exist before observing scroll origins")
        const records: ScrollEventRecord[] = []
        const state = { lastScrollTop: scroller.scrollTop }
        const frameState = { current: -1 }
        const nativeRaf = window.requestAnimationFrame.bind(window)
        window.requestAnimationFrame = ((callback: FrameRequestCallback) =>
            nativeRaf((frameTime) => {
                frameState.current = frameTime
                try {
                    callback(frameTime)
                } finally {
                    frameState.current = -1
                }
            })) as typeof window.requestAnimationFrame
        Object.defineProperty(window, "__dlineCurrentFrame", { value: () => frameState.current, configurable: true })
        const record = (source: string) => {
            const scrollTop = scroller.scrollTop
            records.push({ time: performance.now(), source, scrollTop, delta: scrollTop - state.lastScrollTop })
            state.lastScrollTop = scrollTop
        }
        const appMarks: number[] = []
        Object.defineProperty(window, "__dlineAppScrollMarks", { value: appMarks, configurable: true })
        const markApplicationScroll = () => appMarks.push(performance.now())
        Object.defineProperty(window, "__dlineMarkAppScroll", { value: markApplicationScroll, configurable: true })
        const publisherNow = () => {
            const lastMark = appMarks.length > 0 ? appMarks[appMarks.length - 1]! : Number.NEGATIVE_INFINITY
            return performance.now() - lastMark <= 32 ? "app" : "library"
        }
        const nativeScrollBy = scroller.scrollBy.bind(scroller)
        const nativeScrollTo = scroller.scrollTo.bind(scroller)
        scroller.scrollBy = ((...args: unknown[]) => {
            const first = args[0]
            const requested =
                typeof first === "object" && first !== null && "top" in first
                    ? (first as { top?: number }).top
                    : typeof first === "number"
                      ? (args[1] as number | undefined)
                      : undefined
            const before = scroller.scrollTop
            const now = performance.now()
            const publisher = publisherNow()
            const result = (nativeScrollBy as (...inner: unknown[]) => unknown)(...args)
            const after = scroller.scrollTop
            records.push({
                time: now,
                source: `scrollBy(top=${requested === undefined ? "?" : Math.round(requested)}) actual=${Math.round(after - before)} by=${publisher} frame=${frameState.current}`,
                scrollTop: after,
                delta: after - before,
            })
            state.lastScrollTop = after
            return result
        }) as typeof scroller.scrollBy
        scroller.scrollTo = ((...args: unknown[]) => {
            const before = scroller.scrollTop
            const now = performance.now()
            const publisher = publisherNow()
            const result = (nativeScrollTo as (...inner: unknown[]) => unknown)(...args)
            const after = scroller.scrollTop
            records.push({
                time: now,
                source: `scrollTo actual=${Math.round(after - before)} by=${publisher} frame=${frameState.current}`,
                scrollTop: after,
                delta: after - before,
            })
            state.lastScrollTop = after
            return result
        }) as typeof scroller.scrollTo
        const descriptor =
            Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop") ??
            Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop")
        if (descriptor?.set && descriptor.get) {
            const nativeSet = descriptor.set.bind(scroller)
            const nativeGet = descriptor.get.bind(scroller)
            Object.defineProperty(scroller, "scrollTop", {
                configurable: true,
                get: () => nativeGet(),
                set: (value: number) => {
                    const before = nativeGet()
                    nativeSet(value)
                    if (Math.abs(nativeGet() - before) >= 1) {
                        const stack = (new Error().stack ?? "").split("\n").slice(2, 6).join(" | ")
                        records.push({
                            time: performance.now(),
                            source: `assign by=${publisherNow()}:${stack.slice(0, 260)}`,
                            scrollTop: nativeGet(),
                            delta: nativeGet() - before,
                        })
                        state.lastScrollTop = nativeGet()
                    }
                },
            })
        }
        scroller.addEventListener("scroll", () => record("scroll"), { passive: true })
        Object.defineProperty(window, "__dlineScrollEvents", { value: records, configurable: true })
        const rowShifts: RowShiftRecord[] = []
        Object.defineProperty(window, "__dlineRowShifts", { value: rowShifts, configurable: true })
        const countAt = (): { rows: number; firstIndex: string | null; lastIndex: string | null; padding: number } => {
            const items = scroller.querySelectorAll<HTMLElement>("[data-item-index]")
            const list = scroller.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]')
            return {
                rows: items.length,
                firstIndex: items[0]?.getAttribute("data-item-index") ?? null,
                lastIndex: items[items.length - 1]?.getAttribute("data-item-index") ?? null,
                padding: list ? Math.round(Number.parseFloat(getComputedStyle(list).paddingTop) || 0) : 0,
            }
        }
        interface LayoutShiftSource {
            node?: Node | null
            currentRect: DOMRectReadOnly
            previousRect: DOMRectReadOnly
        }
        interface LayoutShiftEntry extends PerformanceEntry {
            sources?: LayoutShiftSource[]
        }
        try {
            new PerformanceObserver((list) => {
                for (const entry of list.getEntries() as LayoutShiftEntry[]) {
                    for (const source of entry.sources ?? []) {
                        const node = source.node
                        const element = node instanceof Element ? node : (node?.parentElement ?? null)
                        const row = element?.closest?.("[data-item-index]") ?? null
                        if (!row) continue
                        const dy = source.currentRect.y - source.previousRect.y
                        const window = Math.abs(dy) >= 120 ? countAt() : undefined
                        rowShifts.push({
                            time: entry.startTime,
                            dy,
                            index: row.getAttribute("data-item-index"),
                            rows: window?.rows,
                            firstIndex: window?.firstIndex,
                            lastIndex: window?.lastIndex,
                            scrollTop: window ? scroller.scrollTop : undefined,
                            padding: window?.padding,
                            source:
                                Math.abs(dy) >= 120
                                    ? {
                                          ts: element?.closest<HTMLElement>("[data-message-ts]")?.dataset.messageTs ?? null,
                                          tag: element?.tagName ?? null,
                                          className: element?.getAttribute("class") ?? null,
                                          previousTop: source.previousRect.top,
                                          previousBottom: source.previousRect.bottom,
                                          currentTop: source.currentRect.top,
                                          currentBottom: source.currentRect.bottom,
                                          viewportTop: scroller.getBoundingClientRect().top,
                                          viewportBottom: scroller.getBoundingClientRect().bottom,
                                      }
                                    : undefined,
                        })
                    }
                }
            }).observe({ buffered: true, type: "layout-shift" })
        } catch {
            // Calibration must expose a missing probe rather than report no movement.
        }
        const correctionPhases: CorrectionPhaseRecord[] = []
        Object.defineProperty(window, "__dlineCorrectionPhases", { value: correctionPhases, configurable: true })
        const list = scroller.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]')
        if (list && typeof ResizeObserver !== "undefined")
            new ResizeObserver(() => {
                correctionPhases.push({ time: performance.now(), scrollTop: scroller.scrollTop, frame: frameState.current })
            }).observe(list)
    })
}
export async function readPaintProbes(
    sidebar: Frame,
): Promise<{ rowShifts: RowShiftRecord[]; correctionPhases: CorrectionPhaseRecord[] }> {
    return sidebar.evaluate(() => {
        const scope = window as unknown as {
            __dlineRowShifts?: RowShiftRecord[]
            __dlineCorrectionPhases?: CorrectionPhaseRecord[]
        }
        return { rowShifts: scope.__dlineRowShifts ?? [], correctionPhases: scope.__dlineCorrectionPhases ?? [] }
    })
}
export async function sampleSettling(sidebar: Frame, anchorTs: number): Promise<JitterDiagnostics> {
    return sidebar.evaluate(
        async ({ ts, sampleCount, intervalMs }) => {
            const scroller = document.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]')
            if (!scroller) throw new Error("virtuoso scroller must exist while sampling")
            interface AnchorSample {
                time: number
                scrollTop: number
                anchorTop: number | null
            }
            const samples: AnchorSample[] = []
            const readAnchorTop = (): number | null => {
                const element = scroller.querySelector<HTMLElement>(`[data-message-ts="${ts}"]`)
                if (!element) return null
                return element.getBoundingClientRect().top - scroller.getBoundingClientRect().top
            }
            for (let index = 0; index < sampleCount; index++) {
                samples.push({ time: performance.now(), scrollTop: scroller.scrollTop, anchorTop: readAnchorTop() })
                await new Promise((resolve) => setTimeout(resolve, intervalMs))
            }
            const resolved = samples.filter((sample): sample is AnchorSample & { anchorTop: number } => sample.anchorTop !== null)
            const first = resolved.at(0)?.anchorTop ?? 0
            const last = resolved.at(-1)?.anchorTop ?? 0
            let totalTravel = 0
            let reversals = 0
            let previousDirection = 0
            for (let index = 1; index < resolved.length; index++) {
                const previous = resolved[index - 1]
                const current = resolved[index]
                if (!previous || !current) continue
                const step = current.anchorTop - previous.anchorTop
                if (Math.abs(step) < 0.5) continue
                totalTravel += Math.abs(step)
                const direction = step > 0 ? 1 : -1
                if (previousDirection !== 0 && direction !== previousDirection) reversals++
                previousDirection = direction
            }
            const tops = resolved.map((sample) => sample.anchorTop)
            const peakToPeak = tops.length > 0 ? Math.max(...tops) - Math.min(...tops) : 0
            const netTravel = Math.abs(last - first)
            return {
                samples,
                events: (window as unknown as { __dlineScrollEvents?: unknown[] }).__dlineScrollEvents ?? [],
                netTravel,
                totalTravel,
                excessTravel: Math.max(0, totalTravel - netTravel),
                reversals,
                peakToPeak,
            } as unknown as JitterDiagnostics
        },
        { ts: anchorTs, sampleCount: SETTLE_SAMPLE_COUNT, intervalMs: SETTLE_SAMPLE_INTERVAL_MS },
    )
}

export async function startContinuousSampling(sidebar: Frame, durationMs: number): Promise<void> {
    await sidebar.evaluate(
        ({ duration }) => {
            const scroller = document.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]')
            if (!scroller) throw new Error("virtuoso scroller must exist before sampling during input")
            const samples: AnchorSample[] = []
            const deadline = performance.now() + duration
            const programmatic = (window as { __dlineScrollEvents?: Array<{ delta: number }> }).__dlineScrollEvents
            let consumedWrites = programmatic ? programmatic.length : 0
            const drainProgrammatic = (): { sum: number; sources: string[] } => {
                if (!programmatic) return { sum: 0, sources: [] }
                let sum = 0
                const sources: string[] = []
                for (let index = consumedWrites; index < programmatic.length; index++) {
                    const write = programmatic[index]
                    if (!write) continue
                    const source = (write as { source?: string }).source ?? ""
                    if (source === "scroll") {
                        sources.push(source)
                        continue
                    }
                    sum += write.delta ?? 0
                    if (source) sources.push(source)
                }
                consumedWrites = programmatic.length
                return { sum, sources }
            }
            const viewportRelative = (element: HTMLElement): number =>
                element.getBoundingClientRect().top - scroller.getBoundingClientRect().top
            const pickAnchor = (): HTMLElement | null => {
                const bounds = scroller.getBoundingClientRect()
                const rows = [...scroller.querySelectorAll<HTMLElement>("[data-message-ts]")]
                const middle = scroller.clientHeight / 2
                let best: HTMLElement | null = null
                let bestDistance = Number.POSITIVE_INFINITY
                for (const row of rows) {
                    const rect = row.getBoundingClientRect()
                    const top = rect.top - bounds.top
                    if (rect.bottom - bounds.top <= 0 || top >= scroller.clientHeight) continue
                    const distance = Math.abs(top - middle)
                    if (distance < bestDistance) {
                        bestDistance = distance
                        best = row
                    }
                }
                return best
            }
            let anchorTs: string | null = null
            const readAnchorTop = (): number | null => {
                const held = anchorTs ? scroller.querySelector<HTMLElement>(`[data-message-ts="${anchorTs}"]`) : null
                if (held) return viewportRelative(held)
                const successor = pickAnchor()
                if (!successor) {
                    anchorTs = null
                    return null
                }
                anchorTs = successor.dataset.messageTs ?? null
                return viewportRelative(successor)
            }
            const listElement = (): HTMLElement | null =>
                scroller.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]')
            const readVisibleRows = (): RowObservation[] => {
                const bounds = scroller.getBoundingClientRect()
                const observations: RowObservation[] = []
                for (const row of scroller.querySelectorAll<HTMLElement>("[data-message-ts]")) {
                    const ts = row.dataset.messageTs
                    if (!ts) continue
                    observations.push({ ts, top: row.getBoundingClientRect().top - bounds.top })
                }
                return observations
            }
            const knownSizeAtArrival: Array<{
                time: number
                ts: string
                height: number
                knownSize: string | null
                index: string | null
                itemIndex: string | null
            }> = []
            const heights = new Map<string, number>()
            const resizes: Array<{ time: number; ts: string; from: number; to: number }> = []
            const arrivals: Array<{ time: number; ts: string; height: number; kind: string }> = []
            const present = new Set<string>()
            const mountHistory = new Map<string, number[]>()
            const sizeCorrections: SizeCorrectionRecord[] = []
            const recordResizes = () => {
                const seen = new Set<string>()
                for (const row of scroller.querySelectorAll<HTMLElement>("[data-message-ts]")) {
                    const ts = row.dataset.messageTs
                    if (!ts) continue
                    const height = Math.round(row.getBoundingClientRect().height)
                    seen.add(ts)
                    if (!present.has(ts)) {
                        const history = mountHistory.get(ts)
                        if (history) history.push(height)
                        else mountHistory.set(ts, [height])
                        const arrivalWrapper = row.closest<HTMLElement>("[data-known-size]") ?? row.parentElement
                        const believed = Number(arrivalWrapper?.getAttribute("data-known-size"))
                        if (Number.isFinite(believed) && Math.abs(believed - height) >= 20) {
                            sizeCorrections.push({
                                time: performance.now(),
                                ts,
                                believed,
                                measured: height,
                                correction: height - believed,
                                itemIndex: arrivalWrapper?.getAttribute("data-item-index") ?? null,
                                priorMounts: (mountHistory.get(ts)?.length ?? 1) - 1,
                                priorHeights: (mountHistory.get(ts) ?? []).slice(0, -1),
                            })
                        }
                        if (height >= 200) {
                            const wrapper = row.closest<HTMLElement>("[data-known-size]") ?? row.parentElement
                            knownSizeAtArrival.push({
                                time: performance.now(),
                                ts,
                                height,
                                knownSize: wrapper?.getAttribute("data-known-size") ?? null,
                                index: wrapper?.getAttribute("data-index") ?? null,
                                itemIndex: wrapper?.getAttribute("data-item-index") ?? null,
                            })
                        }
                    }
                    const known = heights.get(ts)
                    if (known === undefined) {
                        arrivals.push({
                            time: performance.now(),
                            ts,
                            height,
                            kind:
                                height >= 200
                                    ? `${row.querySelector("[data-testid]")?.getAttribute("data-testid") ?? "?"}:${(row.innerText || "").trim().slice(0, 60)}`
                                    : "",
                        })
                    } else if (known !== height && Math.abs(height - known) >= 20)
                        resizes.push({ time: performance.now(), ts, from: known, to: height })
                    heights.set(ts, height)
                }
                present.clear()
                for (const ts of seen) present.add(ts)
            }
            const coordinateHistory: CoordinateRecord[] = []
            const sizeChanges: SizeChangeRecord[] = []
            const framePrevious = new Map<string, number>()
            const wrapperOf = (row: HTMLElement): HTMLElement | null => row.closest<HTMLElement>("[data-item-index]")
            const numeric = (value: string | null | undefined): number | null => {
                if (value === null || value === undefined) return null
                const parsed = Number(value)
                return Number.isFinite(parsed) ? parsed : null
            }
            const recordCoordinate = () => {
                const rows = [...scroller.querySelectorAll<HTMLElement>("[data-message-ts]")]
                const anchorElement = anchorTs ? scroller.querySelector<HTMLElement>(`[data-message-ts="${anchorTs}"]`) : null
                const anchorTop = anchorElement ? anchorElement.getBoundingClientRect().top : null
                const time = performance.now()
                let origin: number | null = null
                let anchorItemIndex: number | null = null
                const seen = new Set<string>()
                for (const row of rows) {
                    const ts = row.dataset.messageTs
                    if (!ts) continue
                    seen.add(ts)
                    const wrapper = wrapperOf(row)
                    const itemIndex = numeric(wrapper?.getAttribute("data-item-index"))
                    const slot = numeric(wrapper?.getAttribute("data-index"))
                    if (origin === null && itemIndex !== null && slot !== null) origin = itemIndex - slot
                    if (ts === anchorTs) anchorItemIndex = itemIndex
                    const rect = row.getBoundingClientRect()
                    const height = Math.round(rect.height)
                    const before = framePrevious.get(ts)
                    framePrevious.set(ts, height)
                    if (before === undefined || Math.abs(height - before) < 8) continue
                    sizeChanges.push({
                        time,
                        itemIndex,
                        ts,
                        from: before,
                        to: height,
                        aboveAnchor: anchorTop !== null && rect.top < anchorTop,
                    })
                }
                for (const ts of [...framePrevious.keys()]) if (!seen.has(ts)) framePrevious.delete(ts)
                const previous = coordinateHistory[coordinateHistory.length - 1]
                const scrollHeight = scroller.scrollHeight
                if (
                    !previous ||
                    previous.origin !== origin ||
                    previous.scrollHeight !== scrollHeight ||
                    previous.anchorItemIndex !== anchorItemIndex
                )
                    coordinateHistory.push({ time, origin, scrollHeight, anchorItemIndex })
            }
            const tick = (frameTime: number) => {
                const anchorTop = readAnchorTop()
                const drained = drainProgrammatic()
                samples.push({
                    time: performance.now(),
                    scrollTop: scroller.scrollTop,
                    anchorTop,
                    trackedTs: anchorTs,
                    programmaticPx: drained.sum,
                    programmaticSources: drained.sources,
                    rows: readVisibleRows(),
                    viewportHeight: scroller.clientHeight,
                    frameTime,
                    paddingTop: (() => {
                        const list = listElement()
                        if (!list) return undefined
                        const padding = Number.parseFloat(getComputedStyle(list).paddingTop)
                        return Number.isFinite(padding) ? padding : undefined
                    })(),
                    contentTop: (() => {
                        const list = listElement()
                        if (!list) return undefined
                        return list.getBoundingClientRect().top - scroller.getBoundingClientRect().top
                    })(),
                    marginTop: (() => {
                        const list = listElement()
                        if (!list) return undefined
                        const margin = Number.parseFloat(getComputedStyle(list).marginTop)
                        return Number.isFinite(margin) ? margin : undefined
                    })(),
                    flowPrefix: (() => {
                        const list = listElement()
                        if (!list || !anchorTs) return undefined
                        const row = scroller.querySelector<HTMLElement>(`[data-message-ts="${anchorTs}"]`)
                        const wrapper = row?.closest<HTMLElement>("[data-item-index]")
                        if (!wrapper) return undefined
                        const padding = Number.parseFloat(getComputedStyle(list).paddingTop)
                        if (!Number.isFinite(padding)) return undefined
                        return wrapper.getBoundingClientRect().top - list.getBoundingClientRect().top - padding
                    })(),
                })
                recordResizes()
                recordCoordinate()
                if (performance.now() < deadline) requestAnimationFrame(tick)
            }
            requestAnimationFrame(tick)
            Object.defineProperty(window, "__dlineLiveSamples", { value: samples, configurable: true })
            Object.defineProperty(window, "__dlineRowResizes", { value: resizes, configurable: true })
            Object.defineProperty(window, "__dlineRowArrivals", { value: arrivals, configurable: true })
            Object.defineProperty(window, "__dlineRowMountHistory", { value: mountHistory, configurable: true })
            Object.defineProperty(window, "__dlineKnownSizeAtArrival", { value: knownSizeAtArrival, configurable: true })
            Object.defineProperty(window, "__dlineCoordinateHistory", { value: coordinateHistory, configurable: true })
            Object.defineProperty(window, "__dlineSizeChanges", { value: sizeChanges, configurable: true })
            Object.defineProperty(window, "__dlineSizeCorrections", { value: sizeCorrections, configurable: true })
        },
        { duration: durationMs },
    )
}
export async function readContinuousSamples(sidebar: Frame): Promise<AnchorSample[]> {
    return sidebar.evaluate(() => (window as unknown as { __dlineLiveSamples?: AnchorSample[] }).__dlineLiveSamples ?? [])
}

// Replace each provisional rAF read after the same cycle's resize broadcasts.
export async function startPaintSampling(sidebar: Frame, durationMs: number): Promise<void> {
    await sidebar.evaluate(
        ({ duration }) => {
            const scroller = document.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]')
            const list = scroller?.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]')
            if (!scroller || !list) throw new Error("the virtuoso list must exist before sampling painted frames")
            const writes = (window as unknown as { __dlineScrollEvents?: Array<{ delta: number; source: string }> })
                .__dlineScrollEvents
            if (!writes) throw new Error("the scroll observer must be installed before sampling painted frames")
            let counted = writes.length
            let programmaticTotal = 0
            const readProgrammaticTotal = (): number => {
                for (; counted < writes.length; counted++) {
                    const write = writes[counted]
                    if (write && write.source !== "scroll") programmaticTotal += write.delta
                }
                return programmaticTotal
            }
            let anchorTs: string | null = null
            const frames: PaintedFrame[] = []
            const capture = (afterResize: boolean) => {
                const bounds = scroller.getBoundingClientRect()
                const middle = scroller.clientHeight / 2
                const visible: Record<string, number> = {}
                let middleTs: string | null = null
                let middleDistance = Number.POSITIVE_INFINITY
                for (const row of scroller.querySelectorAll<HTMLElement>("[data-message-ts]")) {
                    const ts = row.dataset.messageTs
                    if (!ts) continue
                    const rect = row.getBoundingClientRect()
                    if (rect.bottom <= bounds.top || rect.top >= bounds.bottom) continue
                    const top = rect.top - bounds.top
                    visible[ts] = top
                    const distance = Math.abs(top - middle)
                    if (distance < middleDistance) {
                        middleDistance = distance
                        middleTs = ts
                    }
                }
                if (anchorTs === null || visible[anchorTs] === undefined) anchorTs = middleTs
                return {
                    time: performance.now(),
                    scrollTop: scroller.scrollTop,
                    anchorTop: anchorTs === null ? null : (visible[anchorTs] ?? null),
                    trackedTs: anchorTs,
                    visible,
                    programmaticTotal: readProgrammaticTotal(),
                    afterResize,
                }
            }
            const deadline = performance.now() + duration
            let observer: ResizeObserver | null = null
            const probeChain: HTMLElement[] = []
            const probeRoot = document.createElement("div")
            probeRoot.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;pointer-events:none"
            let parent: HTMLElement = probeRoot
            for (let depth = 0; depth < 96; depth++) {
                const child = document.createElement("div")
                parent.appendChild(child)
                probeChain.push(child)
                parent = child
            }
            document.body.appendChild(probeRoot)
            const firstProbe = 40
            const signatureOf = (frame: ReturnType<typeof capture>) =>
                `${frame.scrollTop}|${scroller.scrollHeight}|${JSON.stringify(frame.visible)}`
            let late: ResizeObserver | null = null
            const rereadUntilSettled = (step: number, previous: string) => {
                late?.disconnect()
                late = null
                const probe = probeChain[step]
                if (!probe) return
                late = new ResizeObserver(() => {
                    late?.disconnect()
                    late = null
                    if (frames.length === 0) return
                    const reread = capture(true)
                    frames[frames.length - 1] = reread
                    const signature = signatureOf(reread)
                    if (signature !== previous) rereadUntilSettled(step + 1, signature)
                })
                late.observe(probe)
            }
            const observeThisFrame = () => {
                observer?.disconnect()
                const current = scroller.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]')
                observer = current
                    ? new ResizeObserver(() => {
                          if (frames.length === 0) return
                          const first = capture(true)
                          frames[frames.length - 1] = first
                          rereadUntilSettled(firstProbe, signatureOf(first))
                      })
                    : null
                if (current) observer?.observe(current)
            }
            const tick = () => {
                frames.push(capture(false))
                if (performance.now() < deadline) {
                    observeThisFrame()
                    requestAnimationFrame(tick)
                } else {
                    observer?.disconnect()
                    late?.disconnect()
                    probeRoot.remove()
                }
            }
            requestAnimationFrame(tick)
            Object.defineProperty(window, "__dlinePaintedFrames", { value: frames, configurable: true })
        },
        { duration: durationMs },
    )
}
export async function readPaintedFrames(sidebar: Frame): Promise<PaintedFrame[]> {
    return sidebar.evaluate(() => (window as unknown as { __dlinePaintedFrames?: PaintedFrame[] }).__dlinePaintedFrames ?? [])
}
/** Retain both measurement phases and their scroll writes outside a report-only attachment. */
export async function persistSamplingEvidence(sidebar: Frame, testInfo: TestInfo, name: string): Promise<void> {
    const samples = await readContinuousSamples(sidebar)
    const painted = await readPaintedFrames(sidebar)
    const causes = await readDisplacementCauses(sidebar)
    const events = await sidebar.evaluate(
        () => (window as unknown as { __dlineScrollEvents?: ScrollEventRecord[] }).__dlineScrollEvents ?? [],
    )
    const path = testInfo.outputPath(name)
    await writeFile(path, `${JSON.stringify({ samples, painted, causes, events }, null, 2)}\n`, "utf8")
    await testInfo.attach(name, { path, contentType: "application/json" })
}
export async function readRenderingState(sidebar: Frame): Promise<RenderingState> {
    return sidebar.evaluate(() => ({
        time: performance.now(),
        visibility: document.visibilityState,
        focused: document.hasFocus(),
    }))
}
export async function readDisplacementCauses(
    sidebar: Frame,
): Promise<{ coordinates: CoordinateRecord[]; sizeChanges: SizeChangeRecord[]; sizeCorrections: SizeCorrectionRecord[] }> {
    return sidebar.evaluate(() => {
        const scope = window as unknown as {
            __dlineCoordinateHistory?: CoordinateRecord[]
            __dlineSizeChanges?: SizeChangeRecord[]
            __dlineSizeCorrections?: SizeCorrectionRecord[]
        }
        return {
            coordinates: scope.__dlineCoordinateHistory ?? [],
            sizeChanges: scope.__dlineSizeChanges ?? [],
            sizeCorrections: scope.__dlineSizeCorrections ?? [],
        }
    })
}
export async function captureVisibleRows(sidebar: Frame): Promise<Array<{ ts: number; top: number; text: string }>> {
    return sidebar.locator('[data-virtuoso-scroller="true"]').evaluate((scroller) => {
        const bounds = scroller.getBoundingClientRect()
        return [...scroller.querySelectorAll<HTMLElement>("[data-message-ts]")]
            .map((element) => {
                const rect = element.getBoundingClientRect()
                return {
                    ts: Number(element.dataset.messageTs),
                    top: rect.top - bounds.top,
                    bottom: rect.bottom - bounds.top,
                    text: (element.innerText || element.textContent || "").trim().slice(0, 120),
                }
            })
            .filter((row) => Number.isFinite(row.ts) && row.bottom > 0 && row.top < scroller.clientHeight)
            .map(({ ts, top, text }) => ({ ts, top, text }))
    })
}
export async function attachDiagnostics(testInfo: TestInfo, diagnostics: JitterDiagnostics): Promise<void> {
    await testInfo.attach("chat-scroll-jitter-diagnostics.json", {
        body: JSON.stringify(
            {
                netTravel: diagnostics.netTravel,
                totalTravel: diagnostics.totalTravel,
                excessTravel: diagnostics.excessTravel,
                reversals: diagnostics.reversals,
                peakToPeak: diagnostics.peakToPeak,
                events: diagnostics.events.slice(-120),
                samples: diagnostics.samples,
            },
            null,
            2,
        ),
        contentType: "application/json",
    })
}
