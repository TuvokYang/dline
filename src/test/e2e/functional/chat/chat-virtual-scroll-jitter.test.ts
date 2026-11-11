import { writeFile } from "node:fs/promises"
import {
    openSeededTask,
    SETTLE_SAMPLE_COUNT,
    STREAM_COMPLETION_MARKER,
    STREAM_CONTINUATION,
    STREAM_PARTIAL_MARKER,
    STREAM_REASONING_LINES,
    STREAM_REPLACE_DIFF,
    STREAM_WRITE_CONTENT,
    STREAM_WRITE_PATH,
    seedJitterTask,
    seedUniformHeightTask,
    setAutoApproveAction,
    unlockAndContinueTask,
} from "@e2e/utils/chat-scroll-jitter/fixture"
import {
    type AnchorSample,
    classifyLegacyDiscards,
    countBackwardFrames,
    countTrackedRowSwitches,
    describeCadence,
    describeFlash,
    describeRendering,
    describeRowMotion,
    describeSettleSamples,
    largestAnchorJump,
    largestContentDisplacement,
    largestVisualError,
    measurePaintedDirection,
    measurePaintedDisplacements,
    paintedFlashes,
    paintedShifts,
    unexplainedShift,
    worstVisualErrorFrames,
} from "@e2e/utils/chat-scroll-jitter/measurements"
import {
    attachDiagnostics,
    captureVisibleRows,
    installScrollObserver,
    persistSamplingEvidence,
    readContinuousSamples,
    readDisplacementCauses,
    readPaintedFrames,
    readPaintProbes,
    readRenderingState,
    sampleSettling,
    startContinuousSampling,
    startPaintSampling,
} from "@e2e/utils/chat-scroll-jitter/probes"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect } from "@playwright/test"
import type { ElectronApplication } from "playwright"

e2e.describe("Chat virtual scroll jitter", () => {
    /**
     * Calibrate the probes against a transcript that cannot jitter.
     *
     * Every displacement figure reported by this file is a difference between
     * two measurements, and a difference is only evidence if the instrument
     * reads zero when nothing moves. Uniform single-line rows give the list
     * nothing to re-measure: no row can grow after mount, so no correction is
     * owed and none should be observed. Whatever the probes report here is
     * their own error, and that error is the floor under every number the
     * reproduction below produces.
     *
     * The drive, the sampling window and the thresholds are deliberately
     * identical to the reproduction. The fixture is the only variable, so a
     * difference between the two runs can be attributed to row height and to
     * nothing else.
     */
    e2e(
        "the displacement probes report nothing when every row is the same height",
        async ({ dlineDocsDir, helper, openVSCode, workspaceDir }, testInfo) => {
            e2e.setTimeout(240_000)
            await seedUniformHeightTask(dlineDocsDir, workspaceDir)

            let app: ElectronApplication | undefined
            try {
                app = await openVSCode(workspaceDir)
                const { sidebar } = await openSeededTask(app, helper)
                await expect(sidebar.locator('[data-virtuoso-scroller="true"]')).toBeVisible({ timeout: 30_000 })
                await expect
                    .poll(async () => (await captureVisibleRows(sidebar)).length, {
                        message: "the seeded conversation must render rows",
                        timeout: 30_000,
                    })
                    .toBeGreaterThan(0)

                await installScrollObserver(sidebar)
                await startContinuousSampling(sidebar, 150_000)
                await startPaintSampling(sidebar, 150_000)

                // Byte-for-byte the reproduction's drive. Changing the plan here
                // would make the two runs incomparable and defeat the control.
                const scrollerLocator = sidebar.locator('[data-virtuoso-scroller="true"]')
                await scrollerLocator.hover()
                const legs = [
                    { delta: 75, steps: 27 },
                    { delta: 75, steps: 10 },
                    { delta: -75, steps: 47 },
                    { delta: 75, steps: 20 },
                    { delta: -75, steps: 60 },
                    { delta: -75, steps: 14 },
                    { delta: 75, steps: 20 },
                    { delta: -75, steps: 27 },
                ]
                const plan = legs.flatMap((leg) => Array.from({ length: leg.steps }, () => leg.delta))
                for (const delta of plan) {
                    await sidebar.page().mouse.wheel(0, delta)
                    await sidebar.page().waitForTimeout(130)
                }
                await sidebar.page().waitForTimeout(400)

                const samples = await readContinuousSamples(sidebar)
                const visual = largestVisualError(samples)
                const { rowShifts, correctionPhases } = await readPaintProbes(sidebar)
                const paintedFrames = await readPaintedFrames(sidebar)
                const displacement = measurePaintedDisplacements(paintedFrames)
                const painted = displacement.shifts.filter((shift) => Math.abs(shift.shift) >= 120)
                const large = displacement.shifts.filter((shift) => Math.abs(shift.shift) >= 300)

                // Confirm the fixture actually is uniform before reading anything
                // into the numbers above. A wrapped row would be twice the height
                // of its neighbours and would reintroduce the very variation this
                // control exists to remove, turning a real finding into a fixture
                // bug.
                const heights = await sidebar.evaluate(() => {
                    const scroller = document.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]')
                    if (!scroller) return null
                    const measured = [...scroller.querySelectorAll<HTMLElement>("[data-message-ts]")].map((row) =>
                        Math.round(row.getBoundingClientRect().height),
                    )
                    return { distinct: [...new Set(measured)].sort((left, right) => left - right), count: measured.length }
                })
                console.log("[control] row heights:", JSON.stringify(heights))
                console.log(
                    "[control] visualError:",
                    Math.round(visual.pixels),
                    "px at",
                    visual.atTime,
                    "; coverage gaps",
                    visual.coverageGaps,
                    "of",
                    Math.max(0, samples.length - 1),
                    "frames; sameFrame",
                    visual.sameFrame,
                    "navigations",
                    visual.navigations,
                )
                console.log("[paint] row shift entries:", rowShifts.length, "over120:", painted.length, "over300:", large.length)
                console.log(
                    "[paint] largest shifts:",
                    JSON.stringify(
                        [...rowShifts]
                            .sort((left, right) => Math.abs(right.dy) - Math.abs(left.dy))
                            .slice(0, 8)
                            .map((shift) => ({ t: Math.round(shift.time), dy: Math.round(shift.dy), index: shift.index })),
                    ),
                )
                console.log("[paint] size notifications:", correctionPhases.length)
                const scrollOrigins = await sidebar.evaluate(
                    () => (window as unknown as { __dlineScrollEvents: unknown[] }).__dlineScrollEvents,
                )
                const controlPath = testInfo.outputPath("chat-scroll-uniform-control.json")
                await writeFile(
                    controlPath,
                    JSON.stringify(
                        { heights, visual, rowShifts, correctionPhases, scrollOrigins, samples, paintedFrames, displacement },
                        null,
                        2,
                    ),
                )
                await testInfo.attach("chat-scroll-uniform-control.json", {
                    path: controlPath,
                    contentType: "application/json",
                })

                // LayoutShift attribution rectangles are clipped; an empty side is
                // (0,0,0,0), not a message positioned at the page origin. Preserve
                // those raw records, but gate actual same-message geometry after
                // resize delivery. Missing correspondence must fail calibration.
                expect(paintedFrames.length, "calibration must observe painted frames").toBeGreaterThan(SETTLE_SAMPLE_COUNT / 2)
                expect(displacement.coverageGaps, "every painted frame pair must retain an identifiable row").toBe(0)
                expect(painted.length, "equal-height rows have nothing to re-measure, so nothing may be displaced").toBe(0)
                expect(large.length, "no equal-height row may be displaced by half a viewport").toBe(0)
                console.log(
                    "[control] rAF visualError magnitude:",
                    Math.abs(Math.round(visual.pixels)),
                    "px — diagnostic only; this probe misreports on a fixture that cannot jitter",
                )
            } finally {
                await app?.close()
            }
        },
    )

    /**
     * Browse a long transcript the way a reader does and require that nothing
     * moves except what the wheel moved.
     *
     * This began as a control for the instrument and became the reproduction. The
     * measurement subtracts the scroll from the on-screen movement, so what it
     * reports is the part the reader did not ask for. Anchor handovers cancel out
     * — they produce equal and opposite terms — while the defect does not: with
     * 120px wheel steps the transcript lurches back 456-526px, leaving 336-406px
     * unaccounted for, about half a viewport, repeatedly.
     *
     * The drive covers both directions, keeps pushing at each end, and moves at a
     * wheel's pace rather than in jumps, because larger or one-directional steps
     * skip the window in which newly mounted rows are measured.
     */
    e2e(
        "browsing back and forth must not move content the reader did not scroll",
        async ({ dlineDocsDir, helper, openVSCode, workspaceDir }, testInfo) => {
            e2e.setTimeout(240_000)
            await seedJitterTask(dlineDocsDir, workspaceDir)

            let app: ElectronApplication | undefined
            try {
                app = await openVSCode(workspaceDir)
                const { sidebar } = await openSeededTask(app, helper)
                await expect(sidebar.locator('[data-virtuoso-scroller="true"]')).toBeVisible({ timeout: 30_000 })
                await expect
                    .poll(async () => (await captureVisibleRows(sidebar)).length, {
                        message: "the seeded conversation must render rows",
                        timeout: 30_000,
                    })
                    .toBeGreaterThan(0)

                // Installed before any sampling so every programmatic write is seen,
                // including the ones that assign `scrollTop` directly.
                await installScrollObserver(sidebar)
                // Long enough to outlast the wheel run below: 315 steps at ~45ms plus
                // evaluate overhead.
                // The reading-pace drive below spends roughly 87s at the wheel before
                // the settle wait, and the periodic DOM trace adds to that. The window
                // has to outlast the whole drive or the tail goes unmeasured.
                await startContinuousSampling(sidebar, 150_000)
                await startPaintSampling(sidebar, 150_000)

                // Drive it the way a reader does. An earlier version of this control
                // assigned `scrollTop` in a tight rAF loop, which moves the list
                // faster than it can measure newly mounted rows and made Virtuoso
                // correct the position by itself; that self-correction was then read
                // as 336px of "displacement". Real wheel events with time to settle
                // between them keep the list inside its normal operating regime, so a
                // reading here is about the product rather than the drive.
                const scrollerLocator = sidebar.locator('[data-virtuoso-scroller="true"]')
                await scrollerLocator.hover()
                // Cover real distance, both ways. Forty small upward steps travel a
                // few thousand pixels through a transcript of over a thousand rows —
                // far too little to reach the paging boundaries where windows load,
                // and one-directional travel never asks the list to reverse. The
                // symptom is reported while browsing back and forth through history,
                // so the drive has to do that.
                const domTrace: Array<Record<string, unknown>> = []
                // The boundaries are part of the complaint: pushing further down once
                // already at the bottom, or further up once at the top, must not shake
                // the view. Those are also where a list is most likely to correct its
                // own position, so the plan ends each direction with extra steps that
                // keep pushing after the end has been reached.
                // One wheel notch is roughly 100px, and a reader spinning the wheel
                // delivers those notches tens of milliseconds apart. Larger deltas jump
                // the list rather than scroll it, which skips the very window in which
                // newly mounted rows are measured — the moment the symptom is about.
                // Speed is deliberately a variable here: the jitter has already been
                // shown to be the same 363px at 192px/s and at 555px/s, so a faster
                // drive covers the same ground in less wall time without changing what
                // is being measured. The step counts shrink by the same factor the
                // delta grows, keeping the travelled distance fixed.
                const legs = [
                    { delta: 75, steps: 27 }, // settle at the bottom
                    { delta: 75, steps: 10 }, // keep pushing past it
                    { delta: -75, steps: 47 },
                    { delta: 75, steps: 20 },
                    { delta: -75, steps: 60 },
                    { delta: -75, steps: 14 }, // keep pushing past the top
                    { delta: 75, steps: 20 },
                    { delta: -75, steps: 27 },
                ]
                const plan = legs.flatMap((leg) => Array.from({ length: leg.steps }, () => leg.delta))
                // Visual ground truth, independent of every probe above.
                //
                // The instrumentation and the lived experience disagree: it
                // reports dozens of 300-600px displacements while the product
                // is described as browsing acceptably. Rather than refine the
                // arithmetic further, record what is on screen.
                //
                // Each entry pins one identifiable row by its text and stores
                // where that text actually sits in the viewport, together with
                // the scroll position. Between two consecutive entries the row
                // should move by exactly the scroll delta; whatever it moves
                // beyond that is displacement a reader would see.
                // Every rendered row, keyed by its message timestamp.
                //
                // An earlier version of this tracked "the row nearest the
                // middle of the viewport", which changes identity as soon as
                // the list scrolls: it compared two different rows and reported
                // a constant 75px — one wheel step — regardless of how far or
                // in which direction the list had moved. The fixture's repeated
                // message bodies made the text look stable, hiding the swap.
                //
                // Timestamps are unique per message, so following them compares
                // a row against itself.
                interface VisualFrame {
                    step: number
                    scrollTop: number
                    rows: Record<string, number>
                    /**
                     * Rows intersecting the viewport. `rows` also holds the
                     * overscan above and below it, which the reader cannot see:
                     * when the list corrects for a row measured above the
                     * viewport, the overscan rows above that row move on screen
                     * by the full correction while the visible content stays put.
                     */
                    visible: string[]
                    padding: number
                    /** Rendered item index keyed by message timestamp. */
                    indices: Record<string, string>
                    scrollHeight: number
                    /**
                     * Total rows the list believes exist, and the index of the
                     * first one. A fetch that merges older history changes both,
                     * so they say whether messages arrived on a given frame.
                     */
                    totalCount: number
                    firstIndex: string | null
                    /**
                     * Running total of the programmatic scroll writes so far.
                     *
                     * `scrollTop` moves for the reader's wheel and for every
                     * correction the list makes for rows measured above the
                     * viewport. Only the first is the reader's, so the
                     * difference between two frames' totals is taken out of
                     * their scroll change before it is compared with how far a
                     * row moved on screen.
                     */
                    programmaticTotal: number
                }
                const visualFrames: VisualFrame[] = []
                const captureVisual = async (step: number): Promise<VisualFrame | null> =>
                    sidebar.evaluate((currentStep) => {
                        const scroller = document.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]')
                        if (!scroller) return null
                        const viewport = scroller.getBoundingClientRect()
                        const rows: Record<string, number> = {}
                        const visible: string[] = []
                        for (const row of scroller.querySelectorAll<HTMLElement>("[data-message-ts]")) {
                            const ts = row.dataset.messageTs
                            if (!ts) continue
                            const rect = row.getBoundingClientRect()
                            rows[ts] = Math.round(rect.top - viewport.top)
                            if (rect.bottom > viewport.top && rect.top < viewport.bottom) visible.push(ts)
                        }
                        // The list expresses the space above the window as
                        // padding. When it re-seats the window it changes this
                        // and `scrollTop` together, so the two cancel and the
                        // content stays put. Recording it distinguishes that
                        // from a genuine jump.
                        const list = scroller.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]')
                        const padding = list ? Math.round(Number.parseFloat(getComputedStyle(list).paddingTop) || 0) : 0
                        // The index the list assigns to each rendered row. The
                        // flagged frame adds a single row while the window size
                        // stays at 18, so one row also left: the window slid.
                        // Whether the surviving rows kept their indices across
                        // that slide decides whether the jump is a paging
                        // artefact or a coordinate error.
                        const indices: Record<string, string> = {}
                        for (const item of scroller.querySelectorAll<HTMLElement>("[data-item-index]")) {
                            const ts = item.querySelector<HTMLElement>("[data-message-ts]")?.dataset.messageTs
                            const index = item.getAttribute("data-item-index")
                            if (ts && index) indices[ts] = index
                        }
                        // What the list believes each row measures, against what
                        // it actually renders at.
                        //
                        // No data is inserted during this run and no code writes
                        // the scroller, yet `scrollHeight` grows by 363px on the
                        // flagged frame. With the data fixed, the only quantity
                        // left that can change the total is the list's own record
                        // of row sizes: rows enter the window at an estimate and
                        // are corrected once measured. `data-known-size` is that
                        // record, so the gap between it and the rendered height
                        // is the correction still owed.
                        return {
                            step: currentStep,
                            scrollTop: Math.round(scroller.scrollTop),
                            rows,
                            visible,
                            padding,
                            indices,
                            // No code wrote the scroller on the flagged frame,
                            // yet `scrollTop` changed by +356 against the
                            // direction of travel. A scroll position is
                            // measured from the top of the content, so it also
                            // changes when the content above it does. If the
                            // total height moves by the same amount on that
                            // frame, nothing was repositioned: the origin was.
                            scrollHeight: Math.round(scroller.scrollHeight),
                            // Whether a window fetch landed on this frame.
                            //
                            // Older history is merged into `clineMessages` and
                            // the list is re-based by `firstItemIndex` so the
                            // indices keep pointing at the same messages. Both
                            // the number of rows and the first index shift when
                            // that happens, and the reversal is suspected to
                            // coincide with one of those merges.
                            totalCount: scroller.querySelectorAll("[data-item-index]").length,
                            firstIndex: scroller.querySelector("[data-item-index]")?.getAttribute("data-item-index") ?? null,
                            programmaticTotal: (() => {
                                const state = window as unknown as {
                                    __dlineScrollEvents?: Array<{ delta: number; source: string }>
                                    __dlineVisualWrites?: { counted: number; total: number }
                                }
                                const writes = state.__dlineScrollEvents ?? []
                                const tally = state.__dlineVisualWrites ?? { counted: 0, total: 0 }
                                state.__dlineVisualWrites = tally
                                for (; tally.counted < writes.length; tally.counted++) {
                                    const write = writes[tally.counted]
                                    // A bare `scroll` record is the effect of a write or of
                                    // the wheel, never a writer of its own.
                                    if (write && write.source !== "scroll") tally.total += write.delta
                                }
                                return tally.total
                            })(),
                        }
                    }, step)

                for (const [step, delta] of plan.entries()) {
                    // Sampling the DOM on every step would cost more time than the wheel
                    // interval itself and slow the drive back down to a crawl. The
                    // per-frame sampler above is what carries the measurement; this
                    // trace only needs enough resolution to locate what happened.
                    const frame =
                        step % 5 === 0
                            ? await sidebar.evaluate(() => {
                                  const scroller = document.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]')
                                  if (!scroller) throw new Error("scroller must exist")
                                  const rows = [...scroller.querySelectorAll<HTMLElement>("[data-message-ts]")]
                                  const counts = new Map<string, number>()
                                  for (const row of rows) {
                                      const ts = row.dataset.messageTs ?? ""
                                      counts.set(ts, (counts.get(ts) ?? 0) + 1)
                                  }
                                  const probe = rows[Math.floor(rows.length / 2)]
                                  return {
                                      scrollTop: Math.round(scroller.scrollTop),
                                      rowCount: rows.length,
                                      // A timestamp resolving to two elements would make
                                      // `querySelector` alternate between them, which reads as a
                                      // jump while nothing moved.
                                      duplicateTs: [...counts.entries()].filter(([, count]) => count > 1).map(([ts]) => ts),
                                      // The first and last rows currently held in the DOM. If the
                                      // window slides, these move; if the underlying data array is
                                      // also re-based while `firstItemIndex` stays at 0, every size
                                      // Virtuoso remembers by index now points at a different row.
                                      firstTs: rows[0]?.dataset.messageTs ?? null,
                                      lastTs: rows.at(-1)?.dataset.messageTs ?? null,
                                      totalHeight: Math.round(scroller.scrollHeight),
                                      probeTs: probe?.dataset.messageTs ?? null,
                                      probeOffsetTop: probe?.offsetTop ?? null,
                                      // `offsetTop` is relative to the offset parent, so a change
                                      // of parent moves the number without moving the content.
                                      probeOffsetParent: ((probe?.offsetParent as HTMLElement | null)?.className ?? "").slice(
                                          0,
                                          60,
                                      ),
                                  }
                              })
                            : null
                    if (frame) domTrace.push({ step, delta, ...frame })
                    // Sampled on every step, before and after the wheel, so a
                    // displacement cannot hide between two coarse samples.
                    const before = await captureVisual(step)
                    if (before) visualFrames.push(before)
                    await sidebar.page().mouse.wheel(0, delta)
                    await sidebar.page().waitForTimeout(130)
                }
                await sidebar.page().waitForTimeout(400)

                // Compare consecutive frames that show the same row.
                //
                // A row's position in the viewport should change by exactly
                // minus the scroll delta. Any remainder is movement the reader
                // did not ask for, measured from rendered geometry rather than
                // inferred from an event stream.
                const visualJumps = visualFrames
                    .map((frame, position) => {
                        const previous = visualFrames[position - 1]
                        if (!previous) return null
                        const scrolled = frame.scrollTop - previous.scrollTop
                        // Only the reader's own share of the scroll explains
                        // movement on screen. The rest of `scrolled` is the list
                        // correcting for rows measured above the viewport, and a
                        // correction that holds the content in place is exactly
                        // what must not be reported: adding it back counted every
                        // 363px compensation for a newly measured code card as a
                        // 363px jump, while the rows on screen moved by precisely
                        // one wheel step.
                        const programmatic = frame.programmaticTotal - previous.programmaticTotal
                        const readerScroll = scrolled - programmatic
                        // Every row visible in both frames is compared, and the
                        // worst disagreement is reported. Rows that scrolled out
                        // of the window simply do not appear in both.
                        const visibleBefore = new Set(previous.visible)
                        let worst: { ts: string; moved: number; residual: number } | null = null
                        for (const ts of frame.visible) {
                            const top = frame.rows[ts]
                            const before = previous.rows[ts]
                            if (top === undefined || before === undefined || !visibleBefore.has(ts)) continue
                            const moved = top - before
                            const residual = moved + readerScroll
                            if (!worst || Math.abs(residual) > Math.abs(worst.residual)) {
                                worst = { ts, moved, residual }
                            }
                        }
                        if (!worst) return null
                        return {
                            step: frame.step,
                            ts: worst.ts,
                            scrolled,
                            programmatic,
                            moved: worst.moved,
                            // Zero when the row moved exactly as far as the
                            // reader scrolled.
                            residual: worst.residual,
                            // The figure the gate used to read: the row's change of
                            // position in the content, which a compensated
                            // measurement moves without moving anything on screen.
                            contentResidual: worst.moved + scrolled,
                            // A scroll matched by an equal padding change is
                            // the list re-seating its window, which leaves the
                            // content where it was.
                            paddingDelta: frame.padding - previous.padding,
                        }
                    })
                    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
                // Jitter is a reversal, not a displacement.
                //
                // The screenshots settle what the arithmetic could not. At the
                // steps this run flagged, the frames show `MESSAGE_1199` being
                // pushed steadily down the viewport as `MESSAGE_1198`, its
                // details, and then a command card appear above it — history
                // loading in while the reader scrolls up. Three consecutive
                // frames move the same way by a similar amount and never come
                // back. A reader experiences that as continuing to scroll.
                //
                // `residual` cannot tell that apart from shaking, because it
                // only measures one frame against the one before it. What makes
                // the reported symptom a tremor is that the content returns:
                // down, then back up, within a few frames, with no scrolling to
                // account for either leg. So the gate is a sign change between
                // consecutive unexplained movements, both large enough to see.
                const reversals = visualJumps
                    .map((entry, position) => {
                        const previous = visualJumps[position - 1]
                        if (!previous) return null
                        const back = previous.residual
                        const forth = entry.residual
                        // Same row, opposite directions, both perceptible.
                        if (previous.ts !== entry.ts) return null
                        if (Math.abs(back) < 60 || Math.abs(forth) < 60) return null
                        if (Math.sign(back) === Math.sign(forth)) return null
                        return {
                            step: entry.step,
                            ts: entry.ts,
                            back: Math.round(back),
                            forth: Math.round(forth),
                            amplitude: Math.round(Math.abs(back) + Math.abs(forth)),
                        }
                    })
                    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
                // Why was a leading fetch allowed while the reader was scrolling?
                //
                // `decideWindowGrowth` defers speculative growth until the scroll
                // settles, but lets an urgent one through when the nearest edge is
                // close. It takes the minimum of the two edges, so a small trailing
                // buffer can release a *leading* fetch — and a leading fetch is the
                // insertion that moves content above the viewport.
                //
                // Reported on every run rather than only on the ones that reverse:
                // the reversal appears in roughly four runs out of five, so a
                // diagnostic gated on it is unavailable exactly when a clean run
                // needs explaining.
                {
                    const decisions = await sidebar.evaluate(
                        () =>
                            (window as unknown as { __dlineGrowthDecisions?: Array<Record<string, unknown>> })
                                .__dlineGrowthDecisions ?? [],
                    )
                    const ran = decisions.filter((entry) => entry.decision === "run")
                    // A run during a live scroll is the interesting case; one
                    // after the scroll settled is the intended behaviour.
                    const midScroll = ran.filter(
                        (entry) => typeof entry.msSinceLastScroll === "number" && entry.msSinceLastScroll < 180,
                    )
                    console.log(
                        "[trace] leading growth decisions:",
                        decisions.length,
                        "; ran:",
                        ran.length,
                        "; ran mid-scroll:",
                        midScroll.length,
                        "; deferred:",
                        decisions.length - ran.length,
                    )
                    console.log("[trace] sample of mid-scroll runs:", JSON.stringify(midScroll.slice(0, 6)))

                    // No growth decision was recorded at all, yet messages were
                    // merged in and `firstItemIndex` moved. The fetch therefore
                    // reaches the merge without passing the deferral, so the
                    // call sites are listed here instead of assumed.
                    const fetches = await sidebar.evaluate(
                        () =>
                            (
                                window as unknown as {
                                    __dlineFetches?: Array<{ start: number; count: number; anchored: boolean; stack: string }>
                                }
                            ).__dlineFetches ?? [],
                    )
                    console.log(
                        "[trace] window fetches:",
                        fetches.length,
                        "; anchored:",
                        fetches.filter((entry) => entry.anchored).length,
                    )
                    console.log(
                        "[trace] fetch call sites:",
                        JSON.stringify([...new Set(fetches.map((entry) => entry.stack))].slice(0, 4)),
                    )
                }
                console.log("[visual] direction reversals on one row:", reversals.length)
                console.log("[visual] reversals:", JSON.stringify(reversals.slice(0, 8)))

                // How much content arrived on the frame that jumped?
                //
                // The screenshots show two whole messages and seven detail rows
                // appearing above the anchor on the flagged step, against about
                // 75px of steady advance on ordinary steps. That is consistent
                // with one oversized batch, but it is equally consistent with
                // two ordinary batches landing in the same frame, and those
                // call for different fixes. Counting the rows present before
                // and after each step separates them.
                const batchSizes = reversals.map((reversal) => {
                    const frame = visualFrames.find((entry) => entry.step === reversal.step)
                    const previous = visualFrames.find((entry) => entry.step === reversal.step - 1)
                    if (!frame || !previous) return null
                    const before = Object.keys(previous.rows)
                    const after = Object.keys(frame.rows)
                    const added = after.filter((ts) => !before.includes(ts))
                    return {
                        step: reversal.step,
                        amplitude: reversal.amplitude,
                        rowsAdded: added.length,
                        rowsBefore: before.length,
                        rowsAfter: after.length,
                    }
                })
                console.log("[visual] rows added on reversal frames:", JSON.stringify(batchSizes))
                // Did a surviving row change index across the reversal frame?
                //
                // Virtuoso positions a row by its index and remembers the
                // height it measured under that index. `firstItemIndex` is what
                // keeps an index pointing at the same message while history is
                // prepended. If a row that is present both before and after
                // comes back under a different index, the coordinate moved out
                // from under it, and the list will place it using a height
                // belonging to some other row.
                for (const reversal of reversals) {
                    const frame = visualFrames.find((entry) => entry.step === reversal.step)
                    const previous = visualFrames.find((entry) => entry.step === reversal.step - 1)
                    if (!frame || !previous) continue
                    const moved = Object.entries(frame.indices)
                        .filter(([ts, index]) => previous.indices[ts] !== undefined && previous.indices[ts] !== index)
                        .map(([ts, index]) => ({ ts, from: previous.indices[ts], to: index }))
                    console.log(
                        "[coord] step",
                        reversal.step,
                        "rows whose index changed:",
                        moved.length,
                        "of",
                        Object.keys(frame.indices).length,
                        JSON.stringify(moved.slice(0, 6)),
                    )
                }
                // The reversal in context.
                //
                // Its signature repeats across runs — back about -70, forth
                // about +360, once per run — while the step it lands on moves
                // (64, 62, 135). Indices are intact and only one row arrives,
                // so neither a coordinate error nor an oversized batch explains
                // it. Printing the surrounding steps shows the whole trajectory
                // instead of the single pair the gate reports, including what
                // the reader was doing when it happened.
                for (const reversal of reversals) {
                    const around = visualJumps
                        .filter((entry) => Math.abs(entry.step - reversal.step) <= 4)
                        .map((entry) => ({
                            step: entry.step,
                            scrolled: entry.scrolled,
                            moved: entry.moved,
                            residual: entry.residual,
                            padding: entry.paddingDelta,
                        }))
                    console.log("[trace] around step", reversal.step, JSON.stringify(around))
                    // Which leg of the drive this fell on: the plan reverses
                    // direction at fixed step boundaries, and a reversal that
                    // always lands just after the reader changes direction is a
                    // different fault from one that happens mid-leg.
                    const legBoundaries: number[] = []
                    let cursor = 0
                    for (const leg of legs) {
                        cursor += leg.steps
                        legBoundaries.push(cursor)
                    }
                    const nearest = legBoundaries.reduce((best, boundary) =>
                        Math.abs(boundary - reversal.step) < Math.abs(best - reversal.step) ? boundary : best,
                    )
                    console.log(
                        "[trace] nearest direction change at step",
                        nearest,
                        "; reversal is",
                        reversal.step - nearest,
                        "steps from it",
                    )
                    // Who moved the scroller on that step?
                    //
                    // The trace shows the reader scrolling up throughout — the
                    // steps on either side report scrolls of -126 and -144 —
                    // while the flagged step reports +288, a reversal of the
                    // scroll position itself rather than of the content. The
                    // content kept advancing normally through it (`moved` stays
                    // at about 75). Something therefore wrote `scrollTop`
                    // against the direction of travel, and the observer
                    // installed at the top of this test records the origin of
                    // every programmatic write.
                    //
                    // The anchor restore records itself too, because the two
                    // candidates land on the same frame and are otherwise
                    // indistinguishable: the product repositioning the list, or
                    // the browser adjusting `scrollTop` by itself because the
                    // content above the viewport grew. A frame with no restore
                    // is the browser's doing and no change to the restore can
                    // affect it.
                    const restores = await sidebar.evaluate(
                        () =>
                            (window as unknown as { __dlineAnchorRestores?: Array<{ ts: number; offset?: number }> })
                                .__dlineAnchorRestores ?? [],
                    )
                    console.log(
                        "[trace] anchor restores during the run:",
                        restores.length,
                        "; carrying a measured offset:",
                        restores.filter((entry) => entry.offset !== undefined).length,
                        JSON.stringify(restores.slice(0, 4)),
                    )
                    const writes = await sidebar.evaluate(
                        () =>
                            (
                                window as unknown as {
                                    __dlineScrollEvents?: Array<{ time: number; source: string; delta: number }>
                                }
                            ).__dlineScrollEvents ?? [],
                    )
                    // Steps are paced at roughly 130ms plus evaluate overhead,
                    // so the window is generous enough to catch the write and
                    // narrow enough to exclude its neighbours.
                    const large = writes.filter((write) => Math.abs(write.delta) >= 150 && !write.source.startsWith("scroll"))
                    console.log(
                        "[trace] programmatic writes over 150px:",
                        large.length,
                        JSON.stringify(
                            large.slice(0, 6).map((write) => ({
                                t: Math.round(write.time),
                                delta: Math.round(write.delta),
                                source: write.source.slice(0, 200),
                            })),
                        ),
                    )
                    // Did the content above the viewport change size?
                    const frame = visualFrames.find((entry) => entry.step === reversal.step)
                    const previous = visualFrames.find((entry) => entry.step === reversal.step - 1)
                    if (frame && previous) {
                        console.log(
                            "[trace] step",
                            reversal.step,
                            "scrollTop",
                            previous.scrollTop,
                            "->",
                            frame.scrollTop,
                            "(delta",
                            frame.scrollTop - previous.scrollTop,
                            "); scrollHeight",
                            previous.scrollHeight,
                            "->",
                            frame.scrollHeight,
                            "(delta",
                            frame.scrollHeight - previous.scrollHeight,
                            "); padding delta",
                            frame.padding - previous.padding,
                            "; firstIndex",
                            previous.firstIndex,
                            "->",
                            frame.firstIndex,
                            "; rendered",
                            previous.totalCount,
                            "->",
                            frame.totalCount,
                        )
                    }
                }
                // The same count for every ordinary step, for comparison.
                const ordinaryAdds = visualFrames
                    .map((frame, position) => {
                        const previous = visualFrames[position - 1]
                        if (!previous) return 0
                        const before = Object.keys(previous.rows)
                        return Object.keys(frame.rows).filter((ts) => !before.includes(ts)).length
                    })
                    .filter((count) => count > 0)
                const histogram = new Map<number, number>()
                for (const count of ordinaryAdds) histogram.set(count, (histogram.get(count) ?? 0) + 1)
                console.log(
                    "[visual] rows-added histogram across all steps:",
                    JSON.stringify([...histogram.entries()].sort(([left], [right]) => left - right)),
                )
                const visibleJumps = visualJumps.filter((entry) => Math.abs(entry.residual) >= 120)
                // Are the compared frames actually adjacent?
                //
                // One wheel step is 75px, yet these pairs report scrolls of
                // 244-288px against a row movement of exactly 76px. A row
                // cannot stay still while its container scrolls four steps, so
                // the more likely reading is that the two frames are not one
                // step apart: a sample that returned null, or a step where the
                // wheel did not land, would leave a gap that this arithmetic
                // silently treats as adjacent.
                const stepGaps = visualFrames
                    .map((frame, position) => {
                        const previous = visualFrames[position - 1]
                        return previous ? frame.step - previous.step : 1
                    })
                    .filter((gap) => gap !== 1)
                console.log(
                    "[visual] captured frames:",
                    visualFrames.length,
                    "of",
                    plan.length,
                    "steps; non-adjacent pairs:",
                    stepGaps.length,
                )
                console.log(
                    "[visual] comparable frame pairs:",
                    visualJumps.length,
                    "; pairs where the row moved more than the scroll:",
                    visibleJumps.length,
                )
                console.log(
                    "[visual] largest:",
                    JSON.stringify(
                        [...visualJumps].sort((left, right) => Math.abs(right.residual) - Math.abs(left.residual)).slice(0, 8),
                    ),
                )
                await testInfo.attach("chat-scroll-visual-frames.json", {
                    body: JSON.stringify({ visualJumps, visualFrames }, null, 2),
                    contentType: "application/json",
                })

                // Export the pictures around each disputed step.
                //
                // Per-step screenshots used to be captured here and the frames
                // around each flagged step written out. They settled the
                // question they were added for — the images showed the
                // transcript advancing steadily in one direction, which is
                // scrolling rather than jitter, and that is what retired the
                // displacement gates in favour of the reversal ones. Keeping
                // them costs a screenshot on all 225 steps of every run for
                // evidence already recorded, so the capture is gone and the
                // geometry below carries the measurement.
                console.log("[visual] flagged steps:", JSON.stringify(visibleJumps.slice(0, 4).map((jump) => jump.step)))

                const samples = await readContinuousSamples(sidebar)
                // No direction filter: the drive above deliberately goes both ways, so
                // there is no single expected sign to compare against.
                const displacement = largestContentDisplacement(samples)
                const resolved = samples.filter((sample) => sample.anchorTop !== null)
                await testInfo.attach("chat-scroll-control-samples.json", {
                    body: JSON.stringify({ displacement, resolvedCount: resolved.length, samples, domTrace }, null, 2),
                    contentType: "application/json",
                })
                const parents = [...new Set(domTrace.map((frame) => frame.probeOffsetParent))]
                const duplicates = domTrace.filter((frame) => (frame.duplicateTs as string[]).length > 0).length
                // Printed rather than only attached: attachments have not survived
                // the failure path here, and this diagnosis must not be lost.
                console.log("[probe] distinct offset parents:", JSON.stringify(parents))
                console.log("[probe] frames with duplicate ts:", duplicates)
                // Whether browser scroll anchoring could even apply here.
                //
                // Anchoring needs a candidate box in normal flow; an absolutely
                // positioned row cannot hold one. Reading the computed values
                // from the live DOM settles that, which grepping the minified
                // bundle for a property name cannot.
                const anchoring = await sidebar.evaluate(() => {
                    const scroller = document.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]')
                    const row = scroller?.querySelector<HTMLElement>("[data-message-ts]")
                    const wrapper = row?.parentElement ?? null
                    const describe = (element: HTMLElement | null) => {
                        if (!element) return null
                        const computed = getComputedStyle(element)
                        return {
                            position: computed.position,
                            overflowAnchor: computed.overflowAnchor,
                        }
                    }
                    return {
                        scroller: describe(scroller ?? null),
                        itemWrapper: describe(wrapper),
                        row: describe(row ?? null),
                    }
                })
                console.log("[probe] anchoring:", JSON.stringify(anchoring))
                // Reported alongside the old metric, not in place of it, so one
                // run shows whether a reported displacement was content moving
                // under a compensated viewport or the viewport actually lurching.
                const visual = largestVisualError(samples)
                const legacyDiscards = classifyLegacyDiscards(samples)
                console.log(
                    "[probe] visualError:",
                    Math.round(visual.pixels),
                    "px at",
                    visual.atTime,
                    "layoutDelta:",
                    Math.round(visual.layoutDelta),
                    "nonUserScroll:",
                    Math.round(visual.nonUserScroll),
                )
                // A run with coverage gaps has frames nothing was measured on, so
                // a small `visualError` there is not yet evidence of a quiet run.
                console.log(
                    "[probe] coverage: gaps",
                    visual.coverageGaps,
                    "of",
                    Math.max(0, samples.length - 1),
                    "frames; sameFrame",
                    visual.sameFrame,
                    "navigations",
                    visual.navigations,
                    "; legacy discards anchorChanged",
                    legacyDiscards.anchorChanged,
                    "repositioned",
                    legacyDiscards.repositioned,
                )
                console.log("[probe] worst visual frames:", JSON.stringify(worstVisualErrorFrames(samples, 6)))
                {
                    // Take the worst frames again and ask what moved on each.
                    const worst = worstVisualErrorFrames(samples, 6)
                    const motions = worst.map((frame) => {
                        const index = samples.findIndex((sample) => Math.round(sample.time) === frame.at)
                        const previous = index > 0 ? samples[index - 1] : undefined
                        const current = index > 0 ? samples[index] : undefined
                        const motion = previous && current ? describeRowMotion(previous, current) : null
                        // Which of the two translation mechanisms moved.
                        const padding =
                            previous?.paddingTop !== undefined && current?.paddingTop !== undefined
                                ? Math.round(current.paddingTop - previous.paddingTop)
                                : null
                        const content =
                            previous?.contentTop !== undefined && current?.contentTop !== undefined
                                ? Math.round(current.contentTop - previous.contentTop)
                                : null
                        const delta = (read: (sample: AnchorSample) => number | undefined): number | null =>
                            previous && current && read(previous) !== undefined && read(current) !== undefined
                                ? Math.round((read(current) as number) - (read(previous) as number))
                                : null
                        return {
                            at: frame.at,
                            visualError: frame.visualError,
                            motion,
                            paddingDelta: padding,
                            contentDelta: content,
                            marginDelta: delta((sample) => sample.marginTop),
                            flowPrefixDelta: delta((sample) => sample.flowPrefix),
                        }
                    })
                    console.log("[probe] row motion at worst frames:", JSON.stringify(motions))

                    // Which rows moved, and by how much, on the single worst frame.
                    //
                    // The aggregate above says the rows disagreed; it cannot say
                    // whether one row grew and pushed the rest, or whether the set
                    // split into two blocks. Listing each shared row's shift in
                    // document order distinguishes them: a single growth shows one
                    // step down the list, and everything after it shares the same
                    // larger shift.
                    const worstFrame = worst[0]
                    if (worstFrame) {
                        const index = samples.findIndex((sample) => Math.round(sample.time) === worstFrame.at)
                        const previous = index > 0 ? samples[index - 1] : undefined
                        const current = index > 0 ? samples[index] : undefined
                        if (previous?.rows && current?.rows) {
                            const currentByTs = new Map(current.rows.map((row) => [row.ts, row.top]))
                            const perRow = previous.rows
                                .filter((row) => currentByTs.has(row.ts))
                                .map((row) => ({
                                    ts: row.ts,
                                    before: Math.round(row.top),
                                    shift: Math.round((currentByTs.get(row.ts) as number) - row.top),
                                }))
                            console.log("[probe] per-row shift on worst frame:", JSON.stringify(perRow))
                        }
                    }
                }
                console.log("[probe] displacement:", Math.round(displacement.pixels), "px")
                console.log("[probe] resolved samples:", resolved.length, "of", samples.length)
                // Separate the two halves of the movement. A row is expected to travel
                // across the viewport as the reader scrolls, so the raw on-screen step
                // says little on its own; the part that survives cancelling the scroll
                // is what the reader did not ask for.
                {
                    let worstOnScreen = 0
                    for (let index = 1; index < samples.length; index++) {
                        const previous = samples[index - 1]
                        const current = samples[index]
                        if (!previous || !current) continue
                        if (previous.trackedTs === null || previous.trackedTs !== current.trackedTs) continue
                        if (previous.anchorTop === null || current.anchorTop === null) continue
                        worstOnScreen = Math.max(worstOnScreen, Math.abs(current.anchorTop - previous.anchorTop))
                    }
                    console.log("[probe] worst raw on-screen step:", Math.round(worstOnScreen), "px")
                }
                // Calibration gate for the paint-level probe.
                //
                // The rAF diagnostics above cannot say whether a displacement
                // reached the screen. These entries can, but only if the probe
                // works at all: a silent PerformanceObserver failure would look
                // exactly like "nothing was ever shown". The baseline therefore
                // has to produce large entries before any A/B is meaningful.
                {
                    const { rowShifts, correctionPhases } = await readPaintProbes(sidebar)
                    const painted = rowShifts.filter((shift) => Math.abs(shift.dy) >= 120)
                    const large = rowShifts.filter((shift) => Math.abs(shift.dy) >= 300)
                    console.log(
                        "[paint] row shift entries:",
                        rowShifts.length,
                        "over120:",
                        painted.length,
                        "over300:",
                        large.length,
                    )
                    console.log(
                        "[paint] largest shifts:",
                        JSON.stringify(
                            [...rowShifts]
                                .sort((left, right) => Math.abs(right.dy) - Math.abs(left.dy))
                                .slice(0, 8)
                                .map((shift) => ({ t: Math.round(shift.time), dy: Math.round(shift.dy), index: shift.index })),
                        ),
                    )
                    // Note: this probe's own callback always runs in the broadcast
                    // phase, so `frame === -1` says nothing about the library. Kept
                    // only as a count of size-change notifications.
                    console.log("[paint] size notifications:", correctionPhases.length)

                    // Does a painted shift get compensated at all?
                    //
                    // This is the branch point. A shift followed by a library
                    // scroll means the correction exists but arrives after paint;
                    // a shift with no scroll at all means the library declined to
                    // compensate, which `index.mjs:2089` does whenever the
                    // direction is not "up" or a recalculation is in flight.
                    const writes = await sidebar.evaluate(
                        () =>
                            (
                                window as unknown as {
                                    __dlineScrollEvents?: Array<{ time: number; source: string; delta: number }>
                                }
                            ).__dlineScrollEvents ?? [],
                    )
                    const compensated = large.filter((shift) =>
                        writes.some(
                            (write) =>
                                write.time >= shift.time &&
                                write.time - shift.time <= 50 &&
                                Math.abs(write.delta) >= 100 &&
                                !write.source.startsWith("scroll"),
                        ),
                    )
                    console.log("[paint] large shifts with a compensating write:", compensated.length, "of", large.length)
                    // Did the rendered window change across the displacement?
                    //
                    // `index.mjs:2083` only computes a compensation offset when
                    // the previous total count equals the current one. If the
                    // window grew across these shifts, that guard fails, no
                    // offset is produced, and the four conditions at `:2089`
                    // are never even evaluated — the compensation is not late,
                    // it is never requested.
                    const windowChanges = large
                        .map((shift, position) => {
                            const previous = large[position - 1]
                            if (!previous || shift.rows === undefined || previous.rows === undefined) return null
                            return {
                                t: Math.round(shift.time),
                                dy: Math.round(shift.dy),
                                rowsBefore: previous.rows,
                                rowsAfter: shift.rows,
                                spanBefore: `${previous.firstIndex}..${previous.lastIndex}`,
                                spanAfter: `${shift.firstIndex}..${shift.lastIndex}`,
                            }
                        })
                        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
                    console.log("[paint] window across large shifts:", JSON.stringify(windowChanges.slice(0, 10)))
                    const distinctRowCounts = [
                        ...new Set(large.map((shift) => shift.rows).filter((count) => count !== undefined)),
                    ]
                    console.log("[paint] distinct rendered row counts at large shifts:", JSON.stringify(distinctRowCounts))

                    // Within one frame, does the displacement grow with position?
                    //
                    // The window guard turned out not to be the explanation:
                    // shifts of 350-500px occur while the rendered span is
                    // identical before and after. That leaves re-flow inside a
                    // stable window, and re-flow has a signature. If one row
                    // grew, every row below it moves by that same amount and
                    // every row above it stays; the profile is a step. If the
                    // list re-seated several rows at once, the amounts differ
                    // per row with no common step.
                    //
                    // Grouping by frame and sorting by item index separates the
                    // two, and tells which row is the origin.
                    const byFrame = new Map<number, typeof large>()
                    for (const shift of large) {
                        const key = Math.round(shift.time)
                        const bucket = byFrame.get(key) ?? []
                        bucket.push(shift)
                        byFrame.set(key, bucket)
                    }
                    const profiles = [...byFrame.entries()]
                        .filter(([, bucket]) => bucket.length >= 3)
                        .slice(0, 5)
                        .map(([time, bucket]) => ({
                            t: time,
                            rows: bucket[0]?.rows ?? null,
                            // The virtual space above the window. Rows move in
                            // opposite directions within one frame, which no row
                            // resize can produce, so the question is whether the
                            // list re-seated the window underneath them.
                            padding: [...new Set(bucket.map((shift) => shift.padding))],
                            span: `${bucket[0]?.firstIndex}..${bucket[0]?.lastIndex}`,
                            byIndex: [...bucket]
                                .sort((left, right) => Number(left.index ?? 0) - Number(right.index ?? 0))
                                .map((shift) => ({ i: shift.index, dy: Math.round(shift.dy) })),
                        }))
                    console.log("[paint] per-frame displacement profile:", JSON.stringify(profiles))

                    // Is the reported displacement something a reader can see?
                    //
                    // The product is reported as browsing acceptably while this
                    // probe reports 45-54 shifts of 300-600px. Both cannot be
                    // true of the same screen, so before any root cause is
                    // pursued the probe has to be reconciled against what is
                    // actually on display.
                    //
                    // A layout shift is scored against the viewport, but this
                    // list also scrolls the viewport programmatically when it
                    // pages. The question is whether a shift coincides with a
                    // scroll of its own size: if it does, the row stayed put
                    // relative to the content and only the frame moved, which
                    // the reader experiences as scrolling, not as jitter.
                    const scrollWrites = await sidebar.evaluate(
                        () =>
                            (window as unknown as { __dlineScrollEvents?: Array<{ time: number; delta: number }> })
                                .__dlineScrollEvents ?? [],
                    )
                    const withScroll = large.map((shift) => {
                        const nearby = scrollWrites.filter(
                            (write) => Math.abs(write.time - shift.time) <= 64 && Math.abs(write.delta) >= 1,
                        )
                        const travelled = nearby.reduce((sum, write) => sum + write.delta, 0)
                        return {
                            t: Math.round(shift.time),
                            dy: Math.round(shift.dy),
                            scrolled: Math.round(travelled),
                            // Movement the scroll does not account for. This is
                            // the part a reader could perceive as a jump.
                            residual: Math.round(shift.dy + travelled),
                        }
                    })
                    // Rows in one frame disagree about the direction they moved
                    // while sharing the same concurrent scroll, which a real
                    // scroll cannot produce. Before reading anything into the
                    // residuals, check how the entries are distributed in time:
                    // the observer is created with `buffered: true`, so entries
                    // recorded before the drive started are delivered too, and
                    // pairing those against a scroll that happened later is
                    // meaningless.
                    const wheelStart = Math.min(...scrollWrites.map((write) => write.time))
                    const beforeDrive = large.filter((shift) => shift.time < wheelStart).length
                    console.log(
                        "[perceive] first scroll write at:",
                        Math.round(wheelStart),
                        "; large shifts recorded before it:",
                        beforeDrive,
                        "of",
                        large.length,
                    )
                    const perceptible = withScroll.filter((entry) => Math.abs(entry.residual) >= 120)
                    console.log(
                        "[perceive] large shifts:",
                        withScroll.length,
                        "; explained by a concurrent scroll:",
                        withScroll.length - perceptible.length,
                        "; unexplained:",
                        perceptible.length,
                    )
                    console.log("[perceive] sample:", JSON.stringify(withScroll.slice(0, 8)))
                    console.log(
                        "[paint] sample unmatched shifts:",
                        JSON.stringify(
                            large
                                .filter((shift) => !compensated.includes(shift))
                                .slice(0, 5)
                                .map((shift) => ({ t: Math.round(shift.time), dy: Math.round(shift.dy), index: shift.index })),
                        ),
                    )
                }
                // Locate the shakes rather than reporting only the worst one. Each
                // entry says when it happened, how far the row moved on screen, and
                // how much of that the scroller itself accounts for: a large on-screen
                // step with a near-zero scroll step is content moving on its own.
                {
                    const jolts: Array<{ t: number; shift: number; onScreen: number; scrolled: number }> = []
                    for (let index = 1; index < samples.length; index++) {
                        const previous = samples[index - 1]
                        const current = samples[index]
                        if (!previous || !current) continue
                        const shift = unexplainedShift(previous, current)
                        if (shift === null || Math.abs(shift) < 150) continue
                        jolts.push({
                            t: Math.round(current.time),
                            shift: Math.round(shift),
                            onScreen: Math.round(current.anchorTop! - previous.anchorTop!),
                            scrolled: Math.round(current.scrollTop - previous.scrollTop),
                        })
                    }
                    console.log("[probe] unexplained shifts over 150px:", jolts.length)
                    console.log("[probe] first shifts:", JSON.stringify(jolts.slice(0, 10)))
                    // The shift settles on one value regardless of how far the reader
                    // scrolled, which is the signature of a fixed correction rather
                    // than of drift. Comparing it against the viewport and against the
                    // row heights on screen says where that constant comes from.
                    const geometry = await sidebar.evaluate(() => {
                        const scroller = document.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]')
                        if (!scroller) return null
                        const heights = [...scroller.querySelectorAll<HTMLElement>("[data-message-ts]")].map((row) =>
                            Math.round(row.getBoundingClientRect().height),
                        )
                        return {
                            viewport: Math.round(scroller.clientHeight),
                            scrollHeight: Math.round(scroller.scrollHeight),
                            rowHeights: heights.slice(0, 20),
                        }
                    })
                    console.log("[probe] geometry:", JSON.stringify(geometry))
                    // Correlate in time. If every lurch is immediately preceded by a row
                    // being remeasured, and the size of the remeasure matches the size
                    // of the lurch, the causal chain is closed.
                    const resizes = await sidebar.evaluate(
                        () =>
                            (
                                window as unknown as {
                                    __dlineRowResizes?: Array<{ time: number; ts: string; from: number; to: number }>
                                }
                            ).__dlineRowResizes ?? [],
                    )
                    console.log("[probe] row resizes:", resizes.length)
                    console.log(
                        "[probe] largest resizes:",
                        JSON.stringify(
                            [...resizes]
                                .sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from))
                                .slice(0, 6)
                                .map((entry) => ({
                                    t: Math.round(entry.time),
                                    delta: entry.to - entry.from,
                                    from: entry.from,
                                    to: entry.to,
                                })),
                        ),
                    )
                    console.log(
                        "[probe] resizes near each shift:",
                        JSON.stringify(
                            jolts.slice(0, 6).map((jolt) => ({
                                shiftAt: jolt.t,
                                shift: jolt.shift,
                                nearby: resizes
                                    .filter((entry) => Math.abs(entry.time - jolt.t) <= 120)
                                    .map((entry) => ({ delta: entry.to - entry.from, from: entry.from, to: entry.to })),
                            })),
                        ),
                    )
                    // Row heights held steady across every shift, so the position was
                    // not pushed by the layout — somebody wrote it. These are the
                    // writes that moved the list without going through the wheel.
                    const scrollWrites = await sidebar.evaluate(
                        () =>
                            (
                                window as unknown as {
                                    __dlineScrollEvents?: Array<{
                                        time: number
                                        source: string
                                        scrollTop: number
                                        delta: number
                                    }>
                                }
                            ).__dlineScrollEvents ?? [],
                    )
                    const programmatic = scrollWrites.filter((entry) => entry.source !== "scroll")
                    console.log("[probe] programmatic scroll writes:", programmatic.length)
                    // Which rows appeared at the moment the view lurched, and how tall
                    // they were. A row mounting far taller than the list assumed is the
                    // candidate source of a fixed correction.
                    const arrivals = await sidebar.evaluate(
                        () =>
                            (
                                window as unknown as {
                                    __dlineRowArrivals?: Array<{ time: number; ts: string; height: number; kind: string }>
                                }
                            ).__dlineRowArrivals ?? [],
                    )
                    console.log("[probe] row arrivals:", arrivals.length)
                    // The list is windowed: rows are loaded and dropped around the
                    // reader, so the same message does not keep the same index. Virtuoso
                    // keys measured sizes by index and relies on `firstItemIndex` to
                    // shift them when the window moves. If the row count changes while
                    // that prop stays put, every remembered size now describes a
                    // different row. Recording the row count per frame shows whether the
                    // window moved at the moments the view lurched.
                    {
                        // A window that only slides keeps total height roughly stable;
                        // one that is re-based changes it abruptly. Either way, a jump in
                        // total height while the reader is merely scrolling means the
                        // list re-derived positions rather than recalled them.
                        const heights = domTrace.map((frame) => Number(frame.totalHeight))
                        const totalJumps: Array<{ step: number; from: number; to: number; delta: number }> = []
                        for (let index = 1; index < heights.length; index++) {
                            const from = heights[index - 1]!
                            const to = heights[index]!
                            if (Math.abs(to - from) >= 100) {
                                totalJumps.push({ step: Number(domTrace[index]!.step), from, to, delta: to - from })
                            }
                        }
                        // A shift measured across a programmatic jump is not a shift the
                        // reader could see: the anchor relationship the metric depends on
                        // does not survive the list being sent somewhere else. Reporting
                        // what the scroll position did at each flagged moment separates a
                        // jump the app asked for from content moving under the reader.
                        console.log(
                            "[probe] scroll movement at each flagged shift:",
                            JSON.stringify(
                                samples
                                    .map((sample, index) => ({ sample, previous: samples[index - 1] }))
                                    .filter(({ sample, previous }) => {
                                        if (!previous) return false
                                        const shift = unexplainedShift(previous, sample)
                                        return shift !== null && Math.abs(shift) > 150
                                    })
                                    .map(({ sample, previous }) => ({
                                        at: Math.round(sample.time),
                                        shift: Math.round(unexplainedShift(previous!, sample) ?? 0),
                                        scrolled: Math.round(sample.scrollTop - previous!.scrollTop),
                                    })),
                            ),
                        )
                        console.log("[probe] total height jumps over 100px:", totalJumps.length)
                        console.log("[probe] first total height jumps:", JSON.stringify(totalJumps.slice(0, 10)))
                    }
                    // Does a row that leaves the window and comes back measure the same
                    // height every time? If it does, the height was a fixed fact and the
                    // list only failed to carry it across the unmount; if it does not,
                    // no amount of estimating would have been right.
                    {
                        const remounts = await sidebar.evaluate(() => {
                            const history = (window as unknown as { __dlineRowMountHistory?: Map<string, number[]> })
                                .__dlineRowMountHistory
                            if (!history) return []
                            return [...history.entries()]
                                .filter(([, heights]) => heights.length > 1)
                                .map(([ts, heights]) => ({ ts, heights }))
                        })
                        const inconsistent = remounts.filter((row) => Math.max(...row.heights) - Math.min(...row.heights) >= 20)
                        // The decisive reading. If a row that has already been measured
                        // at 431 comes back and the list still believes it is ~68, the
                        // measurement was lost rather than never taken. If instead the
                        // list already says 431 on the later arrivals, nothing was lost
                        // and the correction belongs to the genuine first sighting.
                        const knownSizes = await sidebar.evaluate(
                            () =>
                                (
                                    window as unknown as {
                                        __dlineKnownSizeAtArrival?: Array<{
                                            time: number
                                            ts: string
                                            height: number
                                            knownSize: string | null
                                            index: string | null
                                            itemIndex: string | null
                                        }>
                                    }
                                ).__dlineKnownSizeAtArrival ?? [],
                        )
                        const byTs = new Map<string, typeof knownSizes>()
                        for (const entry of knownSizes) {
                            const bucket = byTs.get(entry.ts)
                            if (bucket) bucket.push(entry)
                            else byTs.set(entry.ts, [entry])
                        }
                        const repeated = [...byTs.entries()].filter(([, entries]) => entries.length > 1)
                        console.log("[probe] tall rows that arrived more than once:", repeated.length)
                        console.log(
                            "[probe] known size on each arrival of a tall row:",
                            JSON.stringify(
                                repeated.slice(0, 6).map(([ts, entries]) => ({
                                    ts,
                                    arrivals: entries.map((entry) => ({
                                        knownSize: entry.knownSize,
                                        index: entry.index,
                                        itemIndex: entry.itemIndex,
                                        measured: entry.height,
                                    })),
                                })),
                            ),
                        )
                        // Whatever the list assumes about a row it has not measured has
                        // to come from the message itself. Before inventing a formula,
                        // record what the rows actually cost against the one signal
                        // available before render — how many lines of text they carry.
                        // A previous attempt guessed at this and inflated the list
                        // sixfold, so the distribution is measured first.
                        const shape = await sidebar.evaluate(() => {
                            const scroller = document.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]')
                            if (!scroller) return []
                            return [...scroller.querySelectorAll<HTMLElement>("[data-message-ts]")].map((row) => {
                                const text = row.innerText || ""
                                let lines = 1
                                for (const character of text) if (character === "\n") lines += 1
                                return {
                                    height: Math.round(row.getBoundingClientRect().height),
                                    lines,
                                    chars: text.length,
                                    hasCode: row.querySelector("pre") !== null,
                                }
                            })
                        })
                        console.log("[probe] rendered row shapes:", JSON.stringify(shape))
                        const withCode = shape.filter((entry) => entry.hasCode)
                        const withoutCode = shape.filter((entry) => !entry.hasCode)
                        const summarize = (entries: typeof shape) =>
                            entries.length === 0
                                ? null
                                : {
                                      count: entries.length,
                                      minHeight: Math.min(...entries.map((entry) => entry.height)),
                                      maxHeight: Math.max(...entries.map((entry) => entry.height)),
                                      perLine: entries.map((entry) => Math.round(entry.height / entry.lines)),
                                  }
                        console.log("[probe] rows containing a code block:", JSON.stringify(summarize(withCode)))
                        console.log("[probe] rows without a code block:", JSON.stringify(summarize(withoutCode)))
                        console.log("[probe] rows mounted more than once:", remounts.length)
                        console.log("[probe] rows whose height differed between mounts:", inconsistent.length)
                        console.log(
                            "[probe] tall row remount heights:",
                            JSON.stringify(remounts.filter((row) => Math.max(...row.heights) >= 200).slice(0, 6)),
                        )
                        console.log("[probe] inconsistent rows:", JSON.stringify(inconsistent.slice(0, 6)))
                    }
                    // How long after the tall row appeared did the correction run? A
                    // compensation performed inside the same synchronous layout pass
                    // lands within the same frame and the reader sees nothing. One that
                    // is scheduled first arrives a frame or more later, and the gap is
                    // exactly the window in which the displaced content is painted.
                    {
                        const corrections = programmatic.filter((entry) => Math.abs(entry.delta) >= 150)
                        const tallArrivals = arrivals.filter((entry) => entry.height >= 200)
                        console.log(
                            "[probe] correction lag after tall arrival:",
                            JSON.stringify(
                                corrections.slice(0, 6).map((correction) => {
                                    const preceding = tallArrivals
                                        .filter((entry) => entry.time <= correction.time)
                                        .sort((a, b) => b.time - a.time)[0]
                                    return {
                                        delta: Math.round(correction.delta),
                                        by: correction.source.includes("by=app") ? "app" : "library",
                                        lagMs: preceding ? Math.round(correction.time - preceding.time) : null,
                                        arrivalHeight: preceding?.height ?? null,
                                    }
                                }),
                            ),
                        )
                    }
                    console.log(
                        "[probe] arrivals near each shift:",
                        JSON.stringify(
                            jolts.slice(0, 4).map((jolt) => ({
                                shiftAt: jolt.t,
                                shift: jolt.shift,
                                rows: arrivals
                                    .filter((entry) => Math.abs(entry.time - jolt.t) <= 200)
                                    .map((entry) => (entry.kind ? `${entry.height}px ${entry.kind}` : `${entry.height}px`)),
                            })),
                        ),
                    )
                    console.log(
                        "[probe] writes near each shift:",
                        JSON.stringify(
                            jolts.slice(0, 5).map((jolt) => ({
                                shiftAt: jolt.t,
                                shift: jolt.shift,
                                writes: programmatic
                                    .filter((entry) => Math.abs(entry.time - jolt.t) <= 150)
                                    .map((entry) => ({ delta: Math.round(entry.delta), source: entry.source.slice(0, 200) })),
                            })),
                        ),
                    )
                }
                // Where in the run the list stopped responding to input tells which
                // boundary was involved: a stretch of unchanged scrollTop is the end
                // of the list, and any shake reported around it belongs to pushing
                // past that end rather than to ordinary browsing.
                {
                    const atRest = domTrace.filter((frame, index) => {
                        const previous = domTrace[index - 1]
                        return previous !== undefined && previous.scrollTop === frame.scrollTop
                    }).length
                    const tops = domTrace.map((frame) => frame.scrollTop as number)
                    console.log("[probe] scrollTop range:", Math.min(...tops), "..", Math.max(...tops))
                    console.log("[probe] frames where scrollTop did not move:", atRest, "of", domTrace.length)
                }
                console.log(
                    "[probe] first frames:",
                    JSON.stringify(
                        domTrace
                            .slice(0, 8)
                            .map((frame) => [frame.step, frame.scrollTop, frame.rowCount, frame.probeTs, frame.probeOffsetTop]),
                    ),
                )

                expect(resolved.length, "the control run must produce readings, otherwise it proves nothing").toBeGreaterThan(10)
                // A frame with no comparable row proves nothing either way, so a
                // run made mostly of gaps must not read as a quiet run.
                expect(
                    visual.coverageGaps,
                    `too many frames had no row in common to measure through (${visual.coverageGaps} of ${Math.max(0, samples.length - 1)})`,
                ).toBeLessThan(Math.max(5, Math.round(samples.length * 0.05)))

                // The failing quantity is what the reader sees: the anchor moving
                // by more than their own scrolling explains.
                //
                // `largestContentDisplacement` measures `ΔV + ΔS`, which is the
                // anchor's *content* coordinate and equals `visualError` only when
                // nothing compensates. A list that grows 363px and scrolls 363px to
                // hold its position reports 363 there while the screen never moved,
                // and a stray 363px scroll over unchanged content reports 0 while
                // the whole viewport lurches. It is kept above as a diagnostic
                // because the difference between the two names the defect, but it
                // cannot be the gate.
                // `visualError` is no longer the gate either, for a reason the
                // uniform-height control established: on a transcript where no
                // row can change size and nothing can therefore be displaced,
                // it still reported -183px on one run and +27px on the next.
                // It samples in the animation-frame callbacks, before the
                // resize-observation broadcast and before paint, so it cannot
                // subtract a correction that has not been issued yet. A figure
                // that misreports on a fixture that cannot jitter cannot decide
                // whether the product jitters.
                //
                // This run shows the same thing from the other side: the frames
                // it flags move every shared row by an identical amount
                // (`spread: 0`, `uniform: true`) while `paddingTop` changes by
                // the same order. That is the window sliding under the content
                // — a translation of the coordinate system, which a reader
                // experiences as scrolling — not the content shaking.
                //
                // Jitter is a reversal: the content goes one way and comes back
                // with no scrolling to account for either leg. That is what the
                // screenshots confirmed, and it is what this gates on.
                //
                // The step-level frames above are taken between wheel steps, so a
                // displacement painted for a frame or two and corrected before the
                // next step never reaches them. The painted series covers every
                // rendering cycle in the state it was shown, which is where a late
                // measurement correction would be seen.
                const paintedFrames = await readPaintedFrames(sidebar)
                const painted = paintedShifts(paintedFrames)
                const flashes = paintedFlashes(painted)
                console.log(
                    "[painted] frames:",
                    paintedFrames.length,
                    "; replaced after the resize broadcast:",
                    paintedFrames.filter((frame) => frame.afterResize).length,
                    "; flashes:",
                    flashes.length,
                    JSON.stringify(flashes.slice(0, 6)),
                )
                console.log(
                    "[painted] largest unexplained shifts:",
                    JSON.stringify(
                        [...painted]
                            .sort((a, b) => Math.abs(b.shift) - Math.abs(a.shift))
                            .slice(0, 6)
                            .map((entry) => ({
                                at: Math.round(entry.time),
                                shift: Math.round(entry.shift),
                                readerScroll: Math.round(entry.readerScroll),
                                rows: entry.sharedRows,
                            })),
                    ),
                )
                expect(painted.length, "the painted series must cover the drive, otherwise it proves nothing").toBeGreaterThan(
                    plan.length,
                )
                expect(
                    reversals.length,
                    `content must not move against the direction of travel (${reversals.length} reversal(s): ${JSON.stringify(reversals.slice(0, 3))})`,
                ).toBe(0)
                expect(
                    flashes.length,
                    `painted content must not jump and return without the reader scrolling (${JSON.stringify(flashes.slice(0, 3))})`,
                ).toBe(0)
            } finally {
                if (app) await app.close().catch(() => undefined)
            }
        },
    )

    e2e(
        "the viewport does not travel backwards while the reader is scrolling",
        async ({ dlineDocsDir, helper, openVSCode, userDataDir, workspaceDir }, testInfo) => {
            e2e.setTimeout(240_000)
            await seedJitterTask(dlineDocsDir, workspaceDir)

            let app: ElectronApplication | undefined
            try {
                app = await openVSCode(workspaceDir)
                const { page, sidebar } = await openSeededTask(app, helper)
                const scroller = sidebar.locator('[data-virtuoso-scroller="true"]')
                await expect(scroller).toBeVisible({ timeout: 30_000 })
                await expect
                    .poll(async () => (await captureVisibleRows(sidebar)).length, {
                        message: "the seeded conversation must render rows",
                        timeout: 30_000,
                    })
                    .toBeGreaterThan(0)
                await installScrollObserver(sidebar)

                // Move off the tail first so the upward run below crosses rows that
                // are still measuring rather than the already-settled bottom.
                // Use the transcript gutter, not a command card's nested output scroller.
                await scroller.hover({ position: { x: 4, y: 4 } })
                await page.mouse.wheel(0, -2_400)
                await page.waitForTimeout(200)

                // Without this the run can measure a list of plain paragraphs and
                // report a clean result that says nothing about collapsing rows.
                // A command card is the row whose height is only known after it
                // mounts, so its presence is the precondition being asserted.
                await expect(sidebar.getByTestId("command-card").first()).toBeVisible({ timeout: 30_000 })

                // Sample every frame while the wheel keeps moving upward. Scrolling
                // up moves content down the screen, so the tracked row's top must
                // only increase; a frame where it decreases is the viewport being
                // pulled back against the input.
                // High frequency, small steps. A few large jumps let each measure
                // settle in the gap between them, which is not how a trackpad or a
                // spun wheel drives the list: those deliver many small deltas while
                // rows are still resolving their height, which is the condition the
                // report describes.
                await startContinuousSampling(sidebar, 3_000)
                await startPaintSampling(sidebar, 3_000)
                await scroller.hover({ position: { x: 4, y: 4 } })
                for (let pass = 0; pass < 60; pass++) {
                    await page.mouse.wheel(0, -80)
                    await page.waitForTimeout(16)
                }
                await page.waitForTimeout(400)

                const liveSamples = await readContinuousSamples(sidebar)
                await persistSamplingEvidence(sidebar, testInfo, "chat-scroll-direction-phases.json")
                // rAF can read before Virtuoso compensates a measured row. Verify
                // the final coordinates of every shared visible row, keeping the
                // provisional series above for diagnosis rather than filtering it.
                const painted = await readPaintedFrames(sidebar)
                const direction = measurePaintedDirection(painted, 1)
                const backward = direction.backwardFrames
                expect(painted.length, "painted sampling must cover the scrolling drive").toBeGreaterThan(10)
                expect(direction.comparedFrames, "scrolling must include comparable painted frames").toBeGreaterThan(0)
                expect(direction.coverageGaps, "moving frames must retain shared row identities").toBe(0)
                const rowSwitches = countTrackedRowSwitches(liveSamples)
                const displacement = largestContentDisplacement(liveSamples)
                const resolved = liveSamples.filter((sample) => sample.anchorTop !== null)
                await testInfo.attach("chat-scroll-jitter-live-samples.json", {
                    body: JSON.stringify(
                        { backward, direction, rowSwitches, displacement, resolvedCount: resolved.length, samples: liveSamples },
                        null,
                        2,
                    ),
                    contentType: "application/json",
                })

                expect(
                    resolved.length,
                    "the anchor must stay resolvable while scrolling, otherwise nothing was measured",
                ).toBeGreaterThan(10)
                expect(
                    backward,
                    `content must not travel back against the scroll direction (backwardFrames=${backward}, rowSwitches=${rowSwitches}, samples=${resolved.length})`,
                ).toBeLessThanOrEqual(1)
                // The premise above — that adding `scrollTop` back fixes a pinned
                // row's position in the content — holds only while the content
                // coordinate system itself is fixed. This list slides a window
                // through the conversation: messages are merged in above the
                // viewport and released below it, and `firstItemIndex` re-bases
                // the coordinates each time. `ΔV + ΔS` counts that re-basing as
                // displacement even though every row moved by the same amount
                // and the reader simply saw the transcript scroll.
                //
                // The uniform-height control added to this file settles it: on a
                // fixture where no row can change size and nothing can therefore
                // be displaced, this same measurement still reported -183px on
                // one run and +27px on the next. It is kept as a diagnostic, and
                // `backward` above is the gate — content travelling *against* the
                // scroll is the symptom, and it cannot be produced by a window
                // sliding in one direction.
                console.log(
                    "[probe] content displacement (diagnostic):",
                    Math.round(displacement.pixels),
                    "px at",
                    displacement.atTime,
                )

                await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
            } finally {
                if (app) await app.close().catch(() => undefined)
            }
        },
    )

    e2e(
        "streaming while the reader scrolls both ways neither shakes nor jumps",
        async ({ dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }, testInfo) => {
            e2e.setTimeout(240_000)
            await seedJitterTask(dlineDocsDir, workspaceDir)
            // Reproduce what a working task actually emits, not just a text
            // stream. Reasoning, a file write and a replacement each mount a row
            // whose height changes after it appears — reasoning collapses when the
            // step ends, and an edit row resolves a diff once the tool finishes —
            // so they exercise tail growth that plain prose never reaches.
            //
            // Each step holds its stream open so the work is still arriving while
            // the reader scrolls underneath it.
            server.resetOpenAiMock()
            server.enqueueOpenAiResponses(
                {
                    type: "message",
                    text: `${STREAM_PARTIAL_MARKER}\n${"streaming detail ".repeat(40)}`,
                    reasoning: STREAM_REASONING_LINES,
                    afterReasoningDelayMs: 1_500,
                    afterChatContentDelayMs: 6_000,
                },
                {
                    type: "tool",
                    id: "call_jitter_stream_write",
                    name: "write_to_file",
                    arguments: { path: STREAM_WRITE_PATH, content: STREAM_WRITE_CONTENT },
                    reasoning: STREAM_REASONING_LINES,
                    afterReasoningDelayMs: 1_000,
                    afterChatContentDelayMs: 6_000,
                    // Streaming the arguments is what makes the edit row grow while
                    // it is on screen instead of appearing at its final height.
                    toolArgumentChunkSize: 200,
                    toolArgumentChunkDelayMs: 120,
                    expectedRequestIncludes: [STREAM_PARTIAL_MARKER],
                },
                {
                    type: "tool",
                    id: "call_jitter_stream_replace",
                    name: "replace_in_file",
                    arguments: { path: STREAM_WRITE_PATH, diff: STREAM_REPLACE_DIFF },
                    reasoning: STREAM_REASONING_LINES,
                    afterReasoningDelayMs: 1_000,
                    afterChatContentDelayMs: 6_000,
                    toolArgumentChunkSize: 200,
                    toolArgumentChunkDelayMs: 120,
                    expectedToolResults: [{ callId: "call_jitter_stream_write", contentIncludes: "successfully saved" }],
                },
                {
                    type: "tool",
                    id: "call_jitter_stream_complete",
                    name: "attempt_completion",
                    arguments: { result: STREAM_COMPLETION_MARKER },
                    expectedToolResults: [{ callId: "call_jitter_stream_replace", contentIncludes: STREAM_WRITE_PATH }],
                },
            )

            let app: ElectronApplication | undefined
            try {
                app = await openVSCode(workspaceDir)
                const { page, sidebar } = await openSeededTask(app, helper)
                const scroller = sidebar.locator('[data-virtuoso-scroller="true"]')
                await expect(scroller).toBeVisible({ timeout: 30_000 })
                await expect
                    .poll(async () => (await captureVisibleRows(sidebar)).length, {
                        message: "the seeded conversation must render rows",
                        timeout: 30_000,
                    })
                    .toBeGreaterThan(0)
                await installScrollObserver(sidebar)

                // Editing is approved up front so the write and the replacement run
                // as streamed work rather than stopping on an approval prompt,
                // which is the state this test is about.
                await setAutoApproveAction(sidebar, "Edit project files", true)
                await unlockAndContinueTask(sidebar, STREAM_CONTINUATION)
                await expect(sidebar.getByText(STREAM_PARTIAL_MARKER, { exact: false }).last()).toBeVisible({ timeout: 60_000 })

                // Alternate directions while the tail keeps growing. Scrolling only
                // one way lets the tail follow cover for a position conflict; going
                // back and forth is what makes the owners disagree.
                // Sample across the scrolling itself, not only after it stops. A
                // displacement that is corrected on the next frame is invisible to
                // any measurement that begins once the viewport has settled.
                // Read at a reading pace while the reply is still arriving. A single
                // 1800px throw is six viewports at once, which is a jump rather than
                // a scroll: it skips the frames where a newly mounted row is measured
                // and lands outside what the measurement can attribute to scrolling.
                await startContinuousSampling(sidebar, 20_000)
                await startPaintSampling(sidebar, 20_000)
                const samplingStart = await readRenderingState(sidebar)
                await scroller.hover()
                const driveStart = await readRenderingState(sidebar)
                const streamLegs = [
                    { delta: -75, steps: 24 },
                    { delta: 75, steps: 12 },
                    { delta: -75, steps: 20 },
                    { delta: 75, steps: 16 },
                ]
                for (const leg of streamLegs) {
                    for (let step = 0; step < leg.steps; step++) {
                        await page.mouse.wheel(0, leg.delta)
                        await page.waitForTimeout(130)
                    }
                }

                const driveEnd = await readRenderingState(sidebar)
                const streamingLive = await readContinuousSamples(sidebar)
                const streamingDisplacement = largestContentDisplacement(streamingLive)
                const causes = await readDisplacementCauses(sidebar)
                // Keep only what happened around the worst frame. The full series
                // runs to thousands of entries, and an attachment nobody can read
                // explains nothing.
                const nearWorst = <T extends { time: number }>(entries: T[]): T[] =>
                    entries.filter((entry) => Math.abs(entry.time - (streamingDisplacement.atTime as number)) <= 600)
                // Written to disk rather than attached inline: an inline body only
                // exists inside a report, and the failures worth diagnosing are the
                // ones read straight from the run output.
                const streamingEvidencePath = testInfo.outputPath("chat-scroll-streaming-live-samples.json")
                await writeFile(
                    streamingEvidencePath,
                    `${JSON.stringify(
                        {
                            displacement: streamingDisplacement,
                            coordinatesNearWorst: nearWorst(causes.coordinates),
                            sizeChangesNearWorst: nearWorst(causes.sizeChanges),
                            sizeCorrectionsNearWorst: nearWorst(causes.sizeCorrections),
                            sizeCorrectionTotal: causes.sizeCorrections.reduce((sum, entry) => sum + entry.correction, 0),
                            originTransitions: causes.coordinates.filter(
                                (entry, index, all) => index > 0 && all[index - 1]?.origin !== entry.origin,
                            ),
                            samplesNearWorst: nearWorst(streamingLive),
                        },
                        null,
                        2,
                    )}\n`,
                    "utf8",
                )
                await testInfo.attach("chat-scroll-streaming-live-samples.json", {
                    path: streamingEvidencePath,
                    contentType: "application/json",
                })
                // Same substitution as the scrolling case above, for the same
                // reason: `ΔV + ΔS` counts the window re-basing its coordinates
                // as displacement, and the uniform-height control in this file
                // shows it reporting ±180px on a fixture where nothing can be
                // displaced at all. Streaming makes that worse rather than
                // better — the tail grows while the window slides — so the
                // figure is reported and the gate is content travelling against
                // the scroll, which a one-way slide cannot produce.
                //
                // Counted on painted frames. The animation-frame series reads
                // before the resize broadcast, so a row measured smaller than its
                // estimate shows there as content stepping back by the difference
                // even when the list corrects it before the frame is painted.
                const streamingPainted = await readPaintedFrames(sidebar)
                const streamingBackward = countBackwardFrames(streamingPainted, 1)
                const streamingFlashes = paintedFlashes(paintedShifts(streamingPainted))
                console.log(
                    "[probe] streaming content displacement (diagnostic):",
                    Math.round(streamingDisplacement.pixels),
                    "px at",
                    streamingDisplacement.atTime,
                    "; backward painted frames:",
                    streamingBackward,
                    "; backward animation-frame reads (diagnostic):",
                    countBackwardFrames(streamingLive, 1),
                    "; painted frames:",
                    streamingPainted.length,
                    "; flashes:",
                    JSON.stringify(streamingFlashes.slice(0, 6)),
                )
                expect(
                    streamingPainted.length,
                    `the painted series must cover the streaming drive, otherwise it proves nothing (${[
                        describeRendering("samplingStart", samplingStart),
                        describeRendering("driveStart", driveStart),
                        describeRendering("driveEnd", driveEnd),
                        describeCadence(streamingPainted.map((frame) => frame.time)),
                    ].join("; ")})`,
                ).toBeGreaterThan(streamLegs.reduce((total, leg) => total + leg.steps, 0))
                expect(
                    streamingBackward,
                    `a growing tail must not move content against the scroll direction (backwardFrames=${streamingBackward}, largest displacement=${Math.round(streamingDisplacement.pixels)}px at t=${streamingDisplacement.atTime})`,
                ).toBeLessThanOrEqual(1)
                for (const flash of streamingFlashes.slice(0, 3)) {
                    const around = describeFlash(streamingPainted, flash)
                    const from = (around[0]?.t ?? 0) - 1
                    const to = (around[around.length - 1]?.t ?? 0) + 1
                    const writes = await sidebar.evaluate(
                        ({ from, to }) =>
                            (
                                (
                                    window as unknown as {
                                        __dlineScrollEvents?: Array<{ time: number; source: string; delta: number }>
                                    }
                                ).__dlineScrollEvents ?? []
                            )
                                .filter((event) => event.time >= from && event.time <= to && event.source !== "scroll")
                                .map((event) => ({
                                    t: Math.round(event.time),
                                    delta: Math.round(event.delta),
                                    source: event.source,
                                })),
                        { from, to },
                    )
                    console.log("[painted] streaming flash frames:", JSON.stringify(around))
                    console.log("[painted] streaming flash writes:", JSON.stringify(writes))
                }
                expect(
                    streamingFlashes.length,
                    `painted content must not jump and return while the tail grows (${JSON.stringify(streamingFlashes.slice(0, 3))})`,
                ).toBe(0)

                const visibleRows = await captureVisibleRows(sidebar)
                const anchorRow = visibleRows[0]
                expect(anchorRow, "two-way scrolling during streaming must leave a visible anchor").toBeDefined()
                if (!anchorRow) throw new Error("missing streaming anchor row")

                // Input stops here while the stream is still open, so the tail is the
                // only thing still changing.
                const settleStart = await readRenderingState(sidebar)
                const diagnostics = await sampleSettling(sidebar, anchorRow.ts)
                await attachDiagnostics(testInfo, diagnostics)

                const resolvedSamples = diagnostics.samples.filter((sample) => sample.anchorTop !== null)
                expect(
                    resolvedSamples.length,
                    `the streaming anchor must stay resolvable, otherwise nothing was measured (${describeRendering("settleStart", settleStart)}; ${describeSettleSamples(diagnostics.samples)})`,
                ).toBeGreaterThan(SETTLE_SAMPLE_COUNT / 2)

                const jump = largestAnchorJump(diagnostics.samples)
                expect(
                    jump,
                    `a growing tail must not move the reader's anchor while they are not scrolling (largest=${jump.toFixed(1)}px)`,
                ).toBeLessThanOrEqual(24)
                expect(
                    diagnostics.excessTravel,
                    `streaming must not shake the viewport (net=${diagnostics.netTravel.toFixed(1)}, total=${diagnostics.totalTravel.toFixed(1)})`,
                ).toBeLessThanOrEqual(12)

                await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
            } finally {
                if (app) await app.close().catch(() => undefined)
            }
        },
    )
})
