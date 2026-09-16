import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { expect, type Frame, type TestInfo } from "@playwright/test"
import { COMMAND_OUTPUT_STRING } from "@shared/combineCommandSequences"
import type { HistoryItem } from "@shared/HistoryItem"
import type { ElectronApplication } from "playwright"
import { E2ETestHelper, e2e } from "./utils/helpers"
import { seedLegacyTaskHistory } from "./utils/task-history-store"

/**
 * Reproduction for the chat viewport shaking reported against BUGFIX-066.
 *
 * The symptom is a short up/down tremor rather than one wrong jump, so a test
 * that only samples `scrollTop` cannot tell it apart from a legitimate single
 * correction or from the library's own dynamic-height compensation. Two things
 * are therefore required here and are the reason this file exists separately
 * from `chat-message-window-scroll.test.ts`, which owns window paging:
 *
 * 1. Rows whose height changes after mount. Collapsing command cards measure
 *    themselves through a ResizeObserver once mounted, which is what keeps the
 *    anchor error from settling. A plain-text fixture cannot produce this.
 * 2. The origin of every scroll. Three owners can move this viewport: the
 *    pending-anchor path calling `scrollToIndex`, the browsing anchor calling
 *    `scrollBy` through the arbiter, and Virtuoso compensating internally.
 *    Attributing a tremor to one of them is impossible without recording which
 *    one issued each movement.
 *
 * The failing condition is excess travel while no user input is in flight: a
 * single legitimate correction moves the anchor once, whereas a tremor keeps
 * spending distance without changing where the anchor ends up.
 */

const TASK_ID = "e2e-chat-virtual-scroll-jitter"
const TASK_TEXT = "E2E_CHAT_SCROLL_JITTER_TASK"
const BODY_MESSAGE_COUNT = 1_200
const BROWSE_TARGET_INDEX = 620
/**
 * Row mix, chosen to match what a real session renders.
 *
 * Every one of these settles to a different height after it mounts: edit rows
 * resolve a diff badge, reasoning and tool groups collapse once the step
 * finishes, and command cards measure their own output. A fixture of plain text
 * rows measures nothing, because nothing about it changes after layout.
 */
const COMMAND_CARD_INTERVAL = 7
const CODE_BLOCK_INTERVAL = 11
const FILE_EDIT_INTERVAL = 5
const REASONING_INTERVAL = 9
const TOOL_GROUP_INTERVAL = 13
const PROGRESS_UPDATE_INTERVAL = 17
const SKILL_LOAD_INTERVAL = 23
const SETTLE_SAMPLE_COUNT = 90
const SETTLE_SAMPLE_INTERVAL_MS = 16
const STREAM_CONTINUATION = "E2E_JITTER_STREAM_CONTINUATION"
const STREAM_PARTIAL_MARKER = "E2E_JITTER_STREAM_PARTIAL"
const STREAM_COMPLETION_MARKER = "E2E_JITTER_STREAM_COMPLETE"
/**
 * Work a streaming task emits while the reader scrolls.
 *
 * Reasoning is long enough to be a tall row before it collapses to a single
 * "Thinking" line, and the file the task writes is long enough that its edit
 * row is taller than the viewport once it resolves. Both are heights that
 * change after the row is already on screen, which is what makes them worth
 * streaming here.
 */
const STREAM_REASONING_LINES = Array.from(
	{ length: 16 },
	(_, line) => `streaming reasoning step ${line + 1} about the seeded conversation`,
).join("\n")
const STREAM_WRITE_PATH = "e2e-jitter-streamed-file.ts"
const STREAM_WRITE_CONTENT = `${Array.from({ length: 40 }, (_, line) => `export const streamedValue${line} = ${line} * 2`).join("\n")}\n`
const STREAM_REPLACE_DIFF = [
	"------- SEARCH",
	"export const streamedValue0 = 0 * 2",
	"=======",
	"export const streamedValue0 = 0 * 2 // adjusted while streaming",
	"+++++++ REPLACE",
].join("\n")

interface ScrollEventRecord {
	time: number
	source: string
	scrollTop: number
	delta: number
}

/** Where one mounted row sat in the viewport when a sample was taken. */
interface RowObservation {
	ts: string
	top: number
}

interface AnchorSample {
	time: number
	scrollTop: number
	anchorTop: number | null
	/**
	 * Which row `anchorTop` was measured against.
	 *
	 * Virtual scrolling unmounts a row once it leaves the viewport, so a
	 * long scroll cannot follow a single row. Recording which row each sample
	 * used is what makes it possible to compare only measurements of the same
	 * row: two different rows have different tops, and treating that
	 * difference as movement reports a reversal that never happened.
	 */
	trackedTs: string | null
	/**
	 * Every row visible in this frame, not just the tracked one.
	 *
	 * A single tracked row cannot survive the frame this test exists to catch:
	 * a displacement large enough to be felt is also large enough to unmount
	 * the anchor, and a comparison keyed on one identity then discards exactly
	 * that frame. Recording all of them lets two frames be compared through
	 * whichever row they both still hold.
	 */
	rows?: RowObservation[]
	/** The scroller's own height, so frames are classified without a constant. */
	viewportHeight?: number
	/**
	 * The top spacer's height, and the content element's own offset.
	 *
	 * Every visible row moving by the same amount means the content block was
	 * translated rather than reflowed. A virtual list has exactly two ways to do
	 * that: resize the padding that stands in for the rows above, or rebase the
	 * coordinates the rows are placed against. Recording both on the frame is
	 * what separates them from each other.
	 */
	paddingTop?: number
	contentTop?: number
	/** Non-zero while the list is animating a prepend into place. */
	marginTop?: number
	/**
	 * Real height of the mounted rows above the measured one.
	 *
	 * The decisive quantity. A row's position is the list's own top, plus the
	 * padding standing in for everything not rendered, plus the real height of
	 * the rows mounted before it. Recording only the first two leaves the third
	 * to be inferred, and it is exactly where the defect lives: the padding
	 * shrinks by what the list *believes* an arriving row is worth while the row
	 * itself immediately occupies what it *really* is.
	 */
	flowPrefix?: number
	/**
	 * The timestamp the browser handed this animation-frame batch.
	 *
	 * Two samples taken in different rAF callbacks are not necessarily two
	 * painted frames: every callback registered for the same frame runs before
	 * the browser paints once. If the sampler runs before the library's own
	 * callback in that batch, it can read a state that was corrected before
	 * anything reached the screen. Frames sharing this value therefore cannot
	 * be claimed as separate things the reader saw.
	 */
	frameTime?: number
	/**
	 * Who wrote the scroll offset during this frame.
	 *
	 * The per-shift report matches writes to shifts by timestamp window, which
	 * cannot say whether a write landed in the frame that moved or the one
	 * after it. Carrying the sources on the sample removes the guess.
	 */
	programmaticSources?: string[]
}

interface JitterDiagnostics {
	samples: AnchorSample[]
	events: ScrollEventRecord[]
	netTravel: number
	totalTravel: number
	excessTravel: number
	reversals: number
	peakToPeak: number
}

function bodyMarker(index: number): string {
	return `E2E_JITTER_MESSAGE_${String(index).padStart(4, "0")}`
}

/**
 * Build one seeded row.
 *
 * The mix is deliberate: command cards collapse and therefore change height
 * after mount, code blocks are tall enough to move the anchor when they are
 * measured, and the plain rows keep the list realistic instead of making every
 * row a worst case.
 */
function seededMessage(baseTimestamp: number, index: number): Record<string, unknown> {
	const ts = baseTimestamp + index

	if (index % COMMAND_CARD_INTERVAL === 0) {
		// The output only becomes an output section when the separator is
		// present; without it the whole blob is parsed as the command itself and
		// the collapsing output area never exists.
		const outputLines = Array.from(
			{ length: 40 + (index % 30) },
			(_, line) => `${bodyMarker(index)} output line ${line + 1} with enough width to wrap on a narrow sidebar`,
		).join("\n")
		return {
			ts,
			type: "ask",
			ask: "command",
			text: `echo ${bodyMarker(index)}${COMMAND_OUTPUT_STRING}${outputLines}`,
			partial: false,
		}
	}

	if (index % CODE_BLOCK_INTERVAL === 0) {
		const code = Array.from({ length: 18 }, (_, line) => `  const value_${line} = ${index} * ${line + 1}`).join("\n")
		return {
			ts,
			type: "say",
			say: "text",
			text: `${bodyMarker(index)}\n\`\`\`ts\n${code}\n\`\`\``,
		}
	}

	if (index % FILE_EDIT_INTERVAL === 0) {
		// The renderer reads `content`, not `diff`. Supplying the wrong field
		// produces a row with no body at all rather than an edit row.
		const patch = Array.from({ length: 12 }, (_, line) => `+ added line ${line + 1} for ${bodyMarker(index)}`).join("\n")
		return {
			ts,
			type: "say",
			say: "tool",
			text: JSON.stringify({
				tool: "editedExistingFile",
				path: `src/integrations/terminal/module_${index}/CommandExecutor.ts`,
				content: patch,
			}),
		}
	}

	if (index % REASONING_INTERVAL === 0) {
		// Reasoning collapses to a single "Thinking" line once the step ends, so
		// its mounted height and its settled height differ sharply.
		const thought = Array.from({ length: 14 }, (_, line) => `reasoning step ${line + 1} for ${bodyMarker(index)}`).join("\n")
		return { ts, type: "say", say: "reasoning", text: thought }
	}

	if (index % TOOL_GROUP_INTERVAL === 0) {
		return {
			ts,
			type: "say",
			say: "tool",
			text: JSON.stringify({
				tool: "readFile",
				path: `src/core/task/tools/handlers/Handler_${index}.ts`,
				content: `${bodyMarker(index)} file body`,
			}),
		}
	}

	if (index % PROGRESS_UPDATE_INTERVAL === 0) {
		// The dedicated row is selected by the JSON tool name, not by a say kind.
		return {
			ts,
			type: "say",
			say: "tool",
			text: JSON.stringify({
				tool: "actModeRespond",
				content: `${bodyMarker(index)} progress update spanning enough words to wrap across several lines in a narrow sidebar`,
			}),
		}
	}

	if (index % SKILL_LOAD_INTERVAL === 0) {
		return {
			ts,
			type: "say",
			say: "load_mcp_documentation",
			text: `${bodyMarker(index)} loaded capability documentation`,
		}
	}

	const detailCount = (index % 4) + 1
	const details = Array.from({ length: detailCount }, (_, line) => `detail-${index}-${line + 1}`).join("\n")
	return { ts, type: "say", say: "text", text: `${bodyMarker(index)}\n${details}` }
}

/**
 * Index of the last row that renders its marker as ordinary visible text.
 *
 * Rows such as a file edit show a path rather than the seeded marker, so the
 * highest index is not necessarily something the test can wait for.
 */
function lastPlainTextIndex(): number {
	for (let index = BODY_MESSAGE_COUNT; index > 0; index--) {
		if (
			index % COMMAND_CARD_INTERVAL !== 0 &&
			index % CODE_BLOCK_INTERVAL !== 0 &&
			index % FILE_EDIT_INTERVAL !== 0 &&
			index % REASONING_INTERVAL !== 0 &&
			index % TOOL_GROUP_INTERVAL !== 0 &&
			index % PROGRESS_UPDATE_INTERVAL !== 0 &&
			index % SKILL_LOAD_INTERVAL !== 0
		) {
			return index
		}
	}
	throw new Error("the fixture must contain at least one plain text row")
}

const TAIL_TEXT_INDEX = lastPlainTextIndex()

/**
 * Seed a transcript whose rows all render at the same height.
 *
 * The control for every displacement probe. Uniform single-line rows give the
 * list nothing to re-measure, so a correct probe must report no displacement
 * here no matter how far the reader scrolls. Anything it does report is its
 * own error, and a probe that misreports on this fixture cannot be trusted on
 * the real one.
 */
async function seedUniformHeightTask(dlineDocsDir: string, workspaceDir: string): Promise<void> {
	const taskDir = path.join(dlineDocsDir, "tasks", TASK_ID)
	await mkdir(taskDir, { recursive: true })

	const baseTimestamp = Date.now() - 120_000
	const historyItem: HistoryItem = {
		id: TASK_ID,
		ts: baseTimestamp,
		task: TASK_TEXT,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		cwdOnTaskInitialization: workspaceDir,
	}
	// Short, punctuation-free text so no row wraps at any sidebar width; a
	// wrapped row would be twice the height of its neighbours and reintroduce
	// exactly the variation this fixture exists to remove.
	const messages = [
		{ ts: baseTimestamp, type: "say", say: "task", text: TASK_TEXT },
		...Array.from({ length: BODY_MESSAGE_COUNT }, (_, offset) => ({
			ts: baseTimestamp + offset + 1,
			type: "say" as const,
			say: "text" as const,
			text: `uniform row ${offset + 1}`,
		})),
	]

	await Promise.all([
		seedLegacyTaskHistory(dlineDocsDir, [historyItem]),
		writeFile(
			path.join(taskDir, "ui_messages.jsonl"),
			`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
			"utf8",
		),
		writeFile(path.join(taskDir, "api_conversation_history.jsonl"), "", "utf8"),
		writeFile(
			path.join(taskDir, ".lock"),
			JSON.stringify({ held_by: "e2e-chat-jitter-other-instance", locked_at: Date.now(), pid: 4343 }),
			"utf8",
		),
	])
}

async function seedJitterTask(dlineDocsDir: string, workspaceDir: string): Promise<void> {
	const taskDir = path.join(dlineDocsDir, "tasks", TASK_ID)
	await mkdir(taskDir, { recursive: true })

	const baseTimestamp = Date.now() - 120_000
	const historyItem: HistoryItem = {
		id: TASK_ID,
		ts: baseTimestamp,
		task: TASK_TEXT,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		cwdOnTaskInitialization: workspaceDir,
	}
	const messages = [
		{ ts: baseTimestamp, type: "say", say: "task", text: TASK_TEXT },
		...Array.from({ length: BODY_MESSAGE_COUNT }, (_, offset) => seededMessage(baseTimestamp, offset + 1)),
	]

	await Promise.all([
		seedLegacyTaskHistory(dlineDocsDir, [historyItem]),
		writeFile(
			path.join(taskDir, "ui_messages.jsonl"),
			`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
			"utf8",
		),
		writeFile(path.join(taskDir, "api_conversation_history.jsonl"), "", "utf8"),
		writeFile(
			path.join(taskDir, ".lock"),
			JSON.stringify({ held_by: "e2e-chat-jitter-other-instance", locked_at: Date.now(), pid: 4343 }),
			"utf8",
		),
	])
}

/**
 * Record who moves the viewport.
 *
 * Wrapping the scroller's own methods is what separates the browsing anchor's
 * `scrollBy` from the pending-anchor `scrollToIndex` and from the library's
 * internal compensation, which arrives as a bare scroll event with no
 * preceding call of ours.
 */
async function installScrollObserver(sidebar: Frame): Promise<void> {
	await sidebar.evaluate(() => {
		const scroller = document.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]')
		if (!scroller) throw new Error("virtuoso scroller must exist before observing scroll origins")

		const records: ScrollEventRecord[] = []
		const state = { lastScrollTop: scroller.scrollTop }

		// Track which animation-frame batch is currently running.
		//
		// A write performed inside the same batch the sampler read in was never
		// painted separately, so knowing the batch is what separates "the list
		// corrected itself before the frame was shown" from "the reader saw the
		// uncorrected state". `requestAnimationFrame` is wrapped rather than
		// sampled because only the callback argument carries the batch time.
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
		Object.defineProperty(window, "__dlineCurrentFrame", {
			value: () => frameState.current,
			configurable: true,
		})
		interface ScrollEventRecord {
			time: number
			source: string
			scrollTop: number
			delta: number
		}

		const record = (source: string) => {
			const scrollTop = scroller.scrollTop
			records.push({ time: performance.now(), source, scrollTop, delta: scrollTop - state.lastScrollTop })
			state.lastScrollTop = scrollTop
		}

		// The application and react-virtuoso's own upward-scroll compensation both
		// end up calling the same `scrollByCallback`, so a stack taken at the DOM
		// method shows only the shared exit and cannot name the publisher. Marking
		// the moment the application asks for a scroll gives the two a way to be
		// told apart: a DOM call with no fresh application mark just before it came
		// from inside the library.
		const appMarks: number[] = []
		Object.defineProperty(window, "__dlineAppScrollMarks", { value: appMarks, configurable: true })
		const markApplicationScroll = () => appMarks.push(performance.now())
		Object.defineProperty(window, "__dlineMarkAppScroll", { value: markApplicationScroll, configurable: true })
		// A mark within a couple of frames means the application asked for this.
		// The arbiter marks synchronously right before it runs a request, so a
		// write with no fresh mark was published from inside the library.
		const publisherNow = () => {
			const lastMark = appMarks.length > 0 ? appMarks[appMarks.length - 1]! : Number.NEGATIVE_INFINITY
			return performance.now() - lastMark <= 32 ? "app" : "library"
		}

		const nativeScrollBy = scroller.scrollBy.bind(scroller)
		const nativeScrollTo = scroller.scrollTo.bind(scroller)
		scroller.scrollBy = ((...args: unknown[]) => {
			// Both the application and react-virtuoso itself can reach this method, and
			// the argument alone cannot tell them apart. The stack can, and the
			// before/after pair says what the call actually did rather than what had
			// already happened since the previous record.
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
		// Same ambiguity as `scrollBy`: `scrollToIndex` and the library's own
		// repositioning share this method, so the record has to name the
		// publisher rather than only the fact that a call happened.
		scroller.scrollTo = ((...args: unknown[]) => {
			// Measured around the native call, as `scrollBy` is. Recording before
			// it returns a delta of zero and leaves the movement to be picked up
			// by the passive `scroll` listener, where it is indistinguishable
			// from a scroll nobody claimed.
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

		// Assigning `scrollTop` is the path that was missing, and it is the one a
		// virtual list uses to compensate for its own layout changes. Without this
		// the observer sees the resulting `scroll` event but never learns who asked
		// for it, which is exactly the question here: a jump the reader did not
		// cause must have been written by somebody.
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
					// Only writes that actually move the list are interesting, and a
					// stack tells which owner performed it.
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

		// P1: what the reader was actually shown.
		//
		// The rAF sampler reads during the animation-frame callbacks, which run
		// before the resize-observation broadcast and before paint. It therefore
		// reports the same displacement whether or not the list corrects itself
		// later in the very same rendering cycle, and cannot tell a painted jump
		// apart from one that was fixed before it reached the screen.
		//
		// A layout shift is recorded against paint. Per the Layout Instability
		// spec a node moving only because the container scrolled is not a
		// candidate, so ordinary scrolling stays out; a row displaced in the
		// list's own content coordinates does count. `hadRecentInput` is
		// deliberately not filtered on: scrolling is continuous input, so every
		// entry that matters here carries it.
		interface RowShiftRecord {
			time: number
			dy: number
			index: string | null
			rows?: number
			firstIndex?: string | null
			lastIndex?: string | null
			scrollTop?: number
		}
		const rowShifts: RowShiftRecord[] = []
		Object.defineProperty(window, "__dlineRowShifts", { value: rowShifts, configurable: true })
		// Created so the product's anchor restore has somewhere to record
		// itself. Without this array the push is a no-op, which is what keeps
		// the trace test-only.
		// P3: was the item count stable across the displacement?
		//
		// The compensation at `index.mjs:2083` is guarded by `C === z`: the
		// previous total count must equal the current one. Only then is an
		// offset computed, and only a non-zero offset reaches the four
		// conditions at `:2089`. A growing window changes the total, so the
		// guard fails and no compensation is ever computed — which would
		// explain a run where every large shift is uncompensated.
		//
		// Reading the rendered row count and the scroll direction at the
		// moment of each shift decides that from observation rather than from
		// reading the bundle. `data-item-index` is emitted per row, so the
		// span of indices is the window the list currently believes in.
		const countAt = (): {
			rows: number
			firstIndex: string | null
			lastIndex: string | null
			padding: number
		} => {
			const items = scroller.querySelectorAll<HTMLElement>("[data-item-index]")
			const list = scroller.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]')
			// Rows do not change height here. This transcript is fully rendered
			// history: nothing expands, collapses or streams while the reader
			// browses it. The per-frame profile proves it independently — one
			// frame moves index 1000140 down 423px while moving 1000149 up
			// 535px, and a row growing can only push in one direction.
			//
			// What can move rows in opposite directions within a stable window
			// is the list re-seating the window: shifting `paddingTop` while
			// rewriting which rows sit after it. That is measured below.
			return {
				rows: items.length,
				firstIndex: items[0]?.getAttribute("data-item-index") ?? null,
				lastIndex: items[items.length - 1]?.getAttribute("data-item-index") ?? null,
				// The virtual space above the rendered window. The list
				// translates content by changing this, so a padding change
				// across a shift is the list re-seating the window rather than
				// a row growing.
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
						// Reading the window costs a layout query, so it is only
						// done for shifts large enough to be worth explaining.
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
						})
					}
				}
			}).observe({ buffered: true, type: "layout-shift" })
		} catch {
			// Left empty so the calibration gate fails loudly rather than a
			// missing probe being read as "no shifts occurred".
		}

		// P2: which phase the correction lands in.
		//
		// Resize observations are broadcast in creation order, so an observer
		// created after the list's own sees the state it left behind. A frame of
		// -1 means the write happened outside any animation-frame callback, which
		// is where a same-cycle correction runs.
		interface CorrectionPhaseRecord {
			time: number
			scrollTop: number
			frame: number
		}
		const correctionPhases: CorrectionPhaseRecord[] = []
		Object.defineProperty(window, "__dlineCorrectionPhases", { value: correctionPhases, configurable: true })
		const list = scroller.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]')
		if (list && typeof ResizeObserver !== "undefined") {
			new ResizeObserver(() => {
				correctionPhases.push({
					time: performance.now(),
					scrollTop: scroller.scrollTop,
					frame: frameState.current,
				})
			}).observe(list)
		}
	})
}

/** One row displacement that survived to paint. */
interface RowShiftRecord {
	time: number
	dy: number
	index: string | null
	/** The rendered window at the moment of the shift; only captured for large ones. */
	rows?: number
	firstIndex?: string | null
	lastIndex?: string | null
	scrollTop?: number
	padding?: number
}

/** Where a size correction ran relative to the animation-frame callbacks. */
interface CorrectionPhaseRecord {
	time: number
	scrollTop: number
	frame: number
}

/**
 * Read the paint-level probes.
 *
 * Reported separately from the rAF diagnostics because the two answer
 * different questions: this one is whether the reader saw the jump.
 */
async function readPaintProbes(sidebar: Frame): Promise<{
	rowShifts: RowShiftRecord[]
	correctionPhases: CorrectionPhaseRecord[]
}> {
	return sidebar.evaluate(() => {
		const scope = window as unknown as {
			__dlineRowShifts?: RowShiftRecord[]
			__dlineCorrectionPhases?: CorrectionPhaseRecord[]
		}
		return {
			rowShifts: scope.__dlineRowShifts ?? [],
			correctionPhases: scope.__dlineCorrectionPhases ?? [],
		}
	})
}

/**
 * Sample the anchor while nothing is being driven from the test.
 *
 * The anchor's viewport-relative top is the quantity the user perceives;
 * `scrollTop` alone moves for legitimate reasons whenever row heights resolve.
 */
async function sampleSettling(sidebar: Frame, anchorTs: number): Promise<JitterDiagnostics> {
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

/**
 * Count frames where the content moved against the direction being scrolled.
 *
 * The settled-phase checks deliberately ignore everything that happens while
 * input is in flight, but the reported symptom is a tremor felt *during*
 * scrolling. While the reader scrolls one way, content must move the other way
 * on screen; a frame where it briefly travels back the way the reader came is
 * the viewport being pulled by something other than the wheel, which is what a
 * tremor looks like from the inside.
 *
 * Small reversals are expected at direction changes and at the list edges, so
 * only displacements large enough to be visible are counted.
 */
function countBackwardFrames(samples: AnchorSample[], expectedAnchorDirection: number): number {
	const MIN_VISIBLE_PX = 6
	let backward = 0

	// `anchorTop` is already the row's position in the viewport, read from
	// `getBoundingClientRect()`. It was a content offset once, and subtracting
	// `scrollTop` here converted it; doing that now would subtract the scroll a
	// second time and invert the direction this function reports.
	const onScreen = (sample: AnchorSample): number | null => sample.anchorTop

	// Consecutive positions in the original series only. Compacting the array
	// first would let two samples that are seconds apart, or that measured
	// different rows, look adjacent.
	for (let index = 1; index < samples.length; index++) {
		const previous = samples[index - 1]
		const current = samples[index]
		if (!previous || !current) continue
		if (previous.trackedTs === null || previous.trackedTs !== current.trackedTs) continue
		// The scroller must also have moved the way the input asked, otherwise
		// the frame says nothing about fighting the input.
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

/** How often the sampler had to switch rows, which is expected, not a defect. */
function countTrackedRowSwitches(samples: AnchorSample[]): number {
	let switches = 0
	for (let index = 1; index < samples.length; index++) {
		const previous = samples[index - 1]
		const current = samples[index]
		if (!previous || !current) continue
		if (previous.trackedTs !== null && current.trackedTs !== null && previous.trackedTs !== current.trackedTs) {
			switches++
		}
	}
	return switches
}

/**
 * The largest single-frame content displacement, in pixels.
 *
 * `anchorTop` here is the anchor's `offsetTop`: its position inside the scrolled
 * content. Scrolling does not change it, so it needs no correction and the
 * comparison is simply whether one row's place in the document moved between two
 * frames. When it does, everything below it moved too, which is precisely what a
 * reader perceives as the transcript shifting under them.
 *
 * Only consecutive frames holding the *same* anchor are compared. Two different
 * rows legitimately have different offsets, so a handover says nothing about
 * movement and is skipped rather than being corrected for.
 *
 * This can see a defect lasting exactly one painted frame: it makes no
 * assumption about which row is nearest an edge, and does not require the
 * displacement to persist into later frames.
 */
/**
 * How far content moved on screen beyond what scrolling accounts for.
 *
 * Between two frames a row's on-screen position changes for two reasons: the
 * reader scrolled, or the content moved underneath them. Only the second is a
 * defect, so the scroll is subtracted out and what remains is the unexplained
 * part.
 *
 * This also disposes of a measurement artifact. When the tracked row is replaced
 * the reported offset can shift by exactly the amount just scrolled, producing
 * pairs like `onScreen: -336, scrolled: 336`. Those net to zero here, while a
 * genuine shake — the reader scrolls 120px up and the transcript lurches 500px
 * down — leaves a residue of several hundred pixels.
 *
 * Frames where the list was sent somewhere else entirely — jumping to the
 * bottom, following a new reply — are not comparable at all. The anchor is no
 * longer near where it was, so the subtraction above describes the jump rather
 * than anything the reader could perceive as content moving.
 */
function unexplainedShift(previous: AnchorSample, current: AnchorSample): number | null {
	if (previous.trackedTs === null || previous.trackedTs !== current.trackedTs) return null
	if (previous.anchorTop === null || current.anchorTop === null) return null

	// A wheel cannot move a viewport's worth of content in a single frame, so
	// anything larger is the list being repositioned rather than scrolled.
	//
	// The bound is the scroller's own height as measured in this frame. A
	// hard-coded 308 happened to sit below the ~343-365px compensations this
	// investigation is chasing, so those frames were discarded here while the
	// same compensation *coalesced with a wheel* stayed under the cutoff and
	// was counted — which is enough on its own to make this metric swing
	// between runs. `frameMovement` supersedes this function and applies no
	// such cutoff; the classification is kept only so the two can be compared.
	const jumpThreshold = current.viewportHeight ?? previous.viewportHeight ?? Number.POSITIVE_INFINITY
	if (Math.abs(current.scrollTop - previous.scrollTop) >= jumpThreshold) return null

	// `anchorTop` is now the row's position in the viewport, read from
	// `getBoundingClientRect()`. Scrolling is expected to move it: scrolling down
	// by N moves the row N pixels up the screen. Adding the scroll back cancels
	// the part the reader asked for, so what remains is movement they did not.
	const onScreen = current.anchorTop - previous.anchorTop
	const scrolled = current.scrollTop - previous.scrollTop
	return onScreen + scrolled
}

/** How many frames the legacy metric refused to score, and why. */
function classifyLegacyDiscards(samples: AnchorSample[]): { anchorChanged: number; repositioned: number } {
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

/**
 * Split a frame's movement into the part the reader asked for and the rest.
 *
 * `unexplainedShift` above returns `ΔV + ΔS`, which equals the change in the
 * anchor's *content* coordinate. That is a useful quantity, but it is not what
 * the reader sees: a list that grows by 363px and scrolls by 363px to stay put
 * reports 363 there while the screen never moved, and a stray 363px scroll over
 * unchanged content reports 0 while the whole viewport lurches.
 *
 * What the reader perceives is the anchor's viewport position changing by more
 * than their own input explains. The reader's share is taken as the residue of
 * the frame's scrolling after every recorded programmatic write, so clamping
 * and sub-pixel rounding need no separate model.
 */
type FrameMovement =
	| {
			kind: "measured"
			/** Which row the two frames were compared through. */
			via: string
			visualError: number
			layoutDelta: number
			nonUserScroll: number
	  }
	/**
	 * The two frames share no row, so nothing can be compared through them.
	 *
	 * This is reported rather than skipped. A frame that replaced the whole
	 * rendered window is the most suspicious frame in the run, and a metric
	 * that quietly drops it reports a clean result precisely when the defect
	 * is at its worst.
	 */
	| { kind: "coverageGap" }
	/**
	 * Both samples belong to the same animation-frame batch.
	 *
	 * Nothing is painted between two callbacks of one frame, so a difference
	 * here is an intermediate state the reader could not have seen. Counting it
	 * would report a jolt that never reached the screen.
	 */
	| { kind: "sameFrame" }
	/**
	 * The list was deliberately sent somewhere else.
	 *
	 * Jumping to a new region moves the viewport by far more than a viewport
	 * height in one frame, and the anchor ends up nowhere near where it was.
	 * Subtracting one from the other then describes the jump rather than
	 * anything the reader would call content shifting under them, and its size
	 * hides every ordinary jolt behind it. Navigation is a separate behaviour
	 * with separate expectations, so it is classified instead of scored.
	 */
	| { kind: "navigation"; scrolled: number }

/**
 * Pick the row both frames still hold, preferring one near the viewport centre.
 *
 * Rows near an edge are about to be unmounted and are the likeliest to be
 * mid-correction, so the centre-most shared row is the steadiest choice
 * available. No arithmetic is carried across a handover: the movement is read
 * from a row that was mounted on *both* frames, so there is nothing to
 * reconcile. An earlier revision carried a running offset instead and reported
 * ~336px of displacement in a control run where nothing moved.
 */
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
	if (previous.frameTime !== undefined && current.frameTime !== undefined && previous.frameTime === current.frameTime) {
		return { kind: "sameFrame" }
	}

	const shared = sharedRow(previous, current)

	// Older sample sets carry no row list; fall back to the tracked anchor so
	// they still report something rather than reading as a gap.
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
	const nonUserScroll = current.programmaticPx
	const userScroll = scrolled - nonUserScroll

	// Measured against the scroller rather than a constant: a single frame
	// cannot scroll a whole viewport by wheel, so anything beyond that was a
	// deliberate reposition.
	const viewportHeight = current.viewportHeight ?? previous.viewportHeight
	if (viewportHeight !== undefined && Math.abs(scrolled) >= viewportHeight) {
		return { kind: "navigation", scrolled }
	}

	return {
		kind: "measured",
		via: measurement.via,
		// Movement the reader did not ask for. Zero when their own scrolling
		// accounts for everything the anchor did.
		visualError: measurement.onScreen + userScroll,
		// How far the content coordinate moved, i.e. what the old metric read.
		layoutDelta: measurement.onScreen + scrolled,
		nonUserScroll,
	}
}

function largestVisualError(samples: AnchorSample[]): {
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

/**
 * The frames carrying the most visual error, with who wrote the scroll on each.
 *
 * Reported together because a single worst frame cannot distinguish a one-off
 * from a repeating signature, and because the writer recorded on the same frame
 * is the only attribution that does not rely on a timestamp window.
 */
function worstVisualErrorFrames(
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
			// Scrolling left over after every recorded write is subtracted.
			//
			// This drive sends real wheel events throughout, so a residue here is
			// normally the reader's own input and is exactly what `visualError`
			// must cancel. It is reported rather than asserted on: the residue
			// also absorbs smooth-scroll animation, UA clamping after the scroll
			// range shrinks, and any writer the observer failed to wrap, and this
			// value alone cannot tell those apart.
			residualScroll: Math.round(current.scrollTop - previous.scrollTop - movement.nonUserScroll),
			via: movement.via,
			sources: current.programmaticSources ?? [],
		})
	}
	scored.sort((left, right) => Math.abs(right.visualError) - Math.abs(left.visualError))
	return scored.slice(0, limit)
}

/**
 * Did the rows move together, or did one of them change size?
 *
 * Reserving height for the tall rows did not change the displacement, which
 * rules out a row growing under the reader and leaves the question of what
 * else moved. The two remaining shapes look completely different here: if
 * every shared row shifts by the same amount, the whole content was
 * translated — a spacer resized, or the list rebased its coordinates — while a
 * row resizing moves only the rows below it and leaves the ones above in
 * place.
 */
function describeRowMotion(
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
		// Sub-pixel rounding across a dozen rows, not a resize.
		uniform: spread < 2,
	}
}

function largestContentDisplacement(samples: AnchorSample[]): { pixels: number; atTime: number | null } {
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

/**
 * Find the largest unexplained jump in the anchor's position.
 *
 * A tremor and a jump are different failures and neither implies the other: a
 * tremor spends distance without going anywhere, while a jump moves the reader
 * somewhere they did not ask to be, once. Excess travel cannot see the second
 * one, because a single large displacement has no excess at all.
 *
 * Only samples taken while no input is in flight are meaningful here, so the
 * caller is responsible for sampling during a settled phase.
 */
function largestAnchorJump(samples: AnchorSample[]): number {
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

/**
 * Count window merges answered by two competing position owners.
 *
 * A restore that is owned by one path moves the viewport once and stops. When
 * both the pending-anchor `scrollToIndex` and the browsing-anchor `scrollBy`
 * answer the same merge, the resulting scroll events undo each other, so the
 * same offset is paid back and forth. That signature — a programmatic call,
 * then a scroll, then the opposite scroll of comparable size arriving shortly
 * after from the other owner — is what this counts.
 */
function countContestedRestores(events: ScrollEventRecord[]): number {
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
		// Opposite direction and comparable magnitude means the second move gave
		// back what the first one just applied.
		if (Math.sign(current.delta) === Math.sign(previous.delta)) continue
		const ratio = Math.abs(current.delta) / Math.abs(previous.delta)
		if (Math.abs(ratio - 1) <= OPPOSITION_TOLERANCE) contested++
	}

	return contested
}

/**
 * Sample the anchor continuously in the page while the test drives the wheel.
 *
 * The settled-phase sampler cannot see a tremor felt during scrolling, because
 * it only starts once input has stopped. This one runs on animation frames for
 * a fixed window so the caller can scroll underneath it and read back what the
 * viewport actually did while the wheel was moving.
 */
async function startContinuousSampling(sidebar: Frame, durationMs: number): Promise<void> {
	await sidebar.evaluate(
		({ duration }) => {
			const scroller = document.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]')
			if (!scroller) throw new Error("virtuoso scroller must exist before sampling during input")

			const samples: Array<{
				time: number
				scrollTop: number
				anchorTop: number | null
				trackedTs: string | null
				programmaticPx: number
			}> = []
			const deadline = performance.now() + duration

			// Separate the reader's own movement from every other writer.
			//
			// `scrollTop` alone cannot say who moved the list: a wheel, the
			// library's compensation and the application's anchor restores all
			// land in the same number. A wheel's `deltaY` is only the amount the
			// browser is *expected* to scroll, so it cannot be subtracted
			// directly. The scroll observer already records what each
			// programmatic write actually moved, so the reader's share is taken
			// as the residue instead:
			//
			//   userScroll = ΔscrollTop - Σ(programmatic deltas)
			//
			// which absorbs clamping, sub-pixel rounding and partially applied
			// writes without having to model them.
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
					// A bare `scroll` event is the browser reporting that the
					// offset changed; it is the effect, not the writer. Counting
					// it as programmatic would subtract the reader's own wheel
					// from their own scrolling and report movement as unexplained
					// when it was entirely explained.
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

			// Hold ONE row for as long as it exists, and hand over deliberately when
			// virtual scrolling unmounts it.
			//
			// Re-picking the row nearest the top edge every frame cannot observe the
			// defect being hunted: when the list is displaced by a whole viewport for
			// a single painted frame, the row nearest the top edge becomes a
			// *different* row, so a comparison keyed on tracked identity discards
			// exactly the frame of interest. Pinning one row forever does not work
			// either, because a long scroll unmounts it within a few frames and the
			// series goes empty.
			//
			// So the anchor is held until it is unmounted, and the successor's offset
			// is aligned to the outgoing one at the moment of handover. Movement
			// within one anchor's lifetime is measured directly; movement across a
			// handover is carried over rather than being read as a jump.
			const viewportRelative = (element: HTMLElement): number =>
				element.getBoundingClientRect().top - scroller.getBoundingClientRect().top

			const pickAnchor = (): HTMLElement | null => {
				const bounds = scroller.getBoundingClientRect()
				const rows = [...scroller.querySelectorAll<HTMLElement>("[data-message-ts]")]
				// Prefer the row closest to the middle: it has the most runway before
				// being unmounted, whichever way the reader scrolls.
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

			// Report the anchor's own position in the content, not a running total.
			//
			// An earlier version accumulated a carry across handovers by subtracting
			// the scrolling that happened in between. That is fragile: the previous
			// reading and the successor's position are taken at different moments,
			// so any scrolling inside that gap leaves a residue, and a control run
			// where the content never moved still reported ~336px of "displacement".
			//
			// `offsetTop` was tried and rejected on review: in a virtual list it is
			// not a stable content coordinate. It moves when the top spacer is
			// resized, when an estimated height is replaced by a measured one, and
			// when the list applies its own deviation — all of which happen during
			// ordinary scrolling. What is recorded instead is the geometry the reader
			// actually sees, taken straight from `getBoundingClientRect()`, which does
			// not depend on the offset parent or on any layout bookkeeping.
			//
			// The old note below is kept only to mark what the rejected reasoning was:
			// `offsetTop` is an absolute position
			// inside the scrolled content and is directly comparable between two
			// different rows, so a handover carries no arithmetic at all. What each
			// sample records is where the anchor sits in the document; the caller
			// subtracts the anchor's own baseline to see whether content moved.
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

			// Record where every mounted row sits, not only the tracked one.
			//
			// Comparing two frames through a single identity fails on exactly the
			// frames worth having: a displacement big enough to feel also unmounts
			// the anchor, so the comparison returns nothing and the run looks
			// clean. With every row's position on both frames, two neighbouring
			// frames can be compared through any row they share.
			// The element Virtuoso pads to stand in for the rows above.
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

			// Virtuoso writes the size it currently believes a row has onto the row
			// wrapper. Reading it at the moment a tall row appears answers the
			// question the height history cannot: did the list already know this row
			// is 431px and lose it, or is it genuinely seeing it for the first time?
			// The distinction decides whether the fix is to preserve measurements
			// across data changes or to supply them up front.
			const knownSizeAtArrival: Array<{
				time: number
				ts: string
				height: number
				knownSize: string | null
				index: string | null
				itemIndex: string | null
			}> = []

			// Watch for rows whose height changes after they are already mounted.
			// The shift settles on one value, which a measurement correction would
			// produce and drift would not; if a row is remeasured at the same moment
			// the view lurches, that row is the cause rather than a coincidence.
			const heights = new Map<string, number>()
			const resizes: Array<{ time: number; ts: string; from: number; to: number }> = []
			// A row appearing for the first time has no previous height to compare
			// against, so a resize check alone is blind to exactly the case that
			// matters: a tall row mounting at a size the list had not estimated.
			// Recording arrivals separately keeps that visible.
			const arrivals: Array<{ time: number; ts: string; height: number; kind: string }> = []
			// A virtualized row is unmounted when it leaves the rendered window and
			// mounted again on the way back. If the same row measures the same
			// height every time, its height was a fixed fact all along and the list
			// merely failed to remember it; if it measures differently, the height
			// is not a property of the row at all. Those two findings call for
			// opposite fixes, so the remount history is recorded per row.
			const present = new Set<string>()
			const mountHistory = new Map<string, number[]>()
			const sizeCorrections: Array<{
				time: number
				ts: string
				believed: number
				measured: number
				correction: number
				itemIndex: string | null
				priorMounts: number
				priorHeights: number[]
			}> = []
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
						// A row whose remembered size is wrong corrects itself the
						// moment it mounts, and everything above the reader moves by
						// the difference. That correction is invisible to a resize
						// check — the row has no previous height here — and invisible
						// to a tall-row filter when the row turns out to be short.
						// Recording every disagreement between what the list believed
						// and what the row measures is what makes it visible.
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
								// Decides which defect this is. A row arriving for the
								// first time has never been measured, and a correction
								// there is the cost of not knowing. A row that has
								// mounted before at this same height was measured
								// already, so the correction means the measurement was
								// lost — a different fault with a different fix.
								priorMounts: (mountHistory.get(ts)?.length ?? 1) - 1,
								priorHeights: (mountHistory.get(ts) ?? []).slice(0, -1),
							})
						}
						if (height >= 200) {
							// Virtuoso stamps the size it currently believes this row has
							// onto the wrapper it positions (dist/index.mjs:2531-2533),
							// and reads it back when measuring (dist/index.mjs:347).
							// Sampling it on every arrival — not just the first — is what
							// separates "the measurement was lost" from "the row is
							// genuinely being seen for the first time".
							const wrapper = row.closest<HTMLElement>("[data-known-size]") ?? row.parentElement
							knownSizeAtArrival.push({
								time: performance.now(),
								ts,
								height,
								knownSize: wrapper?.getAttribute("data-known-size") ?? null,
								// `data-index` is the slot within the currently loaded
								// window and is expected to move when rows are added
								// ahead of it. `data-item-index` is the coordinate the
								// list is supposed to keep stable across those additions,
								// so it is the one that reveals whether measurements can
								// survive a window change.
								index: wrapper?.getAttribute("data-index") ?? null,
								itemIndex: wrapper?.getAttribute("data-item-index") ?? null,
							})
						}
					}
					const known = heights.get(ts)
					if (known === undefined) {
						// Tall arrivals are the ones worth identifying: record enough of
						// the row to tell which component mounted at that size.
						arrivals.push({
							time: performance.now(),
							ts,
							height,
							kind:
								height >= 200
									? `${row.querySelector("[data-testid]")?.getAttribute("data-testid") ?? "?"}:${(row.innerText || "").trim().slice(0, 60)}`
									: "",
						})
					} else if (known !== height && Math.abs(height - known) >= 20) {
						resizes.push({ time: performance.now(), ts, from: known, to: height })
					}
					heights.set(ts, height)
				}
				present.clear()
				for (const ts of seen) present.add(ts)
			}

			// Attribute a content displacement to whatever produced it.
			//
			// A shift measured at the anchor says content above it changed size,
			// but not what changed. Two causes are separable straight from the
			// DOM, and recording both is what turns a failing frame into an
			// explanation rather than a guess:
			//
			// - the row origin moved. `firstItemIndex` is not in the DOM, but
			//   every positioned wrapper carries its window slot (`data-index`)
			//   and its absolute coordinate (`data-item-index`), and the origin is
			//   the difference between them. A change there re-bases every
			//   remembered size at once;
			// - a row above the anchor changed height while it stayed mounted,
			//   which moves everything below it by that difference.
			//
			// `scrollHeight` is carried alongside so a change with neither cause
			// present — the list re-estimating rows it has never seen — is still
			// visible instead of appearing as an unexplained shift.
			const coordinateHistory: Array<{
				time: number
				origin: number | null
				scrollHeight: number
				anchorItemIndex: number | null
			}> = []
			const sizeChanges: Array<{
				time: number
				itemIndex: number | null
				ts: string
				from: number
				to: number
				aboveAnchor: boolean
			}> = []
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
					// A row that just mounted has no previous height here, and a
					// sub-pixel settle is not what moves a viewport.
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

				for (const ts of [...framePrevious.keys()]) {
					if (!seen.has(ts)) framePrevious.delete(ts)
				}

				const previous = coordinateHistory[coordinateHistory.length - 1]
				const scrollHeight = scroller.scrollHeight
				// Only transitions carry information; a per-frame dump of an
				// unchanged origin would bury them.
				if (
					!previous ||
					previous.origin !== origin ||
					previous.scrollHeight !== scrollHeight ||
					previous.anchorItemIndex !== anchorItemIndex
				) {
					coordinateHistory.push({ time, origin, scrollHeight, anchorItemIndex })
				}
			}

			const tick = (frameTime: number) => {
				const anchorTop = readAnchorTop()
				// Drained per frame so each sample carries only the writes
				// that landed since the previous one.
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
						// Measured on the library's own wrapper, not the message
						// node inside it: the wrapper is what the list lays out.
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

async function readContinuousSamples(sidebar: Frame): Promise<AnchorSample[]> {
	return sidebar.evaluate(() => (window as unknown as { __dlineLiveSamples?: AnchorSample[] }).__dlineLiveSamples ?? [])
}

interface CoordinateRecord {
	time: number
	origin: number | null
	scrollHeight: number
	anchorItemIndex: number | null
}

interface SizeChangeRecord {
	time: number
	itemIndex: number | null
	ts: string
	from: number
	to: number
	aboveAnchor: boolean
}

interface SizeCorrectionRecord {
	time: number
	ts: string
	believed: number
	measured: number
	correction: number
	itemIndex: string | null
	priorMounts: number
	priorHeights: number[]
}

/**
 * Read back what the sampler observed about the row origin and row sizes.
 *
 * A displacement reported by the samples is explained by one of these or by
 * neither, and "neither" is itself a finding: it would mean the list moved
 * content without any mounted row or coordinate changing.
 */
async function readDisplacementCauses(sidebar: Frame): Promise<{
	coordinates: CoordinateRecord[]
	sizeChanges: SizeChangeRecord[]
	sizeCorrections: SizeCorrectionRecord[]
}> {
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

async function captureVisibleRows(sidebar: Frame): Promise<Array<{ ts: number; top: number; text: string }>> {
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

/** Enable one auto-approve action so streamed tools run without a prompt. */
async function setAutoApproveAction(sidebar: Frame, label: string, enabled: boolean): Promise<void> {
	await sidebar.getByLabel("Open auto-approve settings").click()
	const checkbox = sidebar.locator("vscode-checkbox").filter({ hasText: label })
	const isChecked = async () => (await checkbox.getAttribute("current-checked")) === "true"
	if ((await isChecked()) !== enabled) {
		await checkbox.click()
	}
	await expect.poll(isChecked).toBe(enabled)
	await sidebar.getByLabel("Close auto-approve settings").click()
}

/**
 * Take over the seeded task so a real stream can be started against it.
 *
 * The fixture writes a held lock so the task opens as another instance's, which
 * is what keeps the seeded history stable until the test wants to extend it.
 */
async function unlockAndContinueTask(sidebar: Frame, text: string): Promise<void> {
	const unlockButton = sidebar.getByRole("button", { name: "Unlock", exact: true })
	await expect(unlockButton).toBeVisible({ timeout: 30_000 })
	await unlockButton.click()
	await expect(sidebar.getByText("Unlock Task", { exact: true })).toBeVisible({ timeout: 10_000 })
	await sidebar.getByRole("button", { name: "Confirm", exact: true }).click()
	await expect(unlockButton).toBeHidden({ timeout: 15_000 })

	const input = sidebar.getByTestId("chat-input")
	const sendButton = sidebar.getByTestId("send-button")
	const resumeButton = sidebar.getByRole("contentinfo").getByText("Resume", { exact: true })
	await expect(input).toBeEnabled({ timeout: 30_000 })
	await expect
		.poll(
			async () => (await resumeButton.isVisible().catch(() => false)) || (await sendButton.isEnabled().catch(() => false)),
			{ timeout: 30_000 },
		)
		.toBe(true)
	await input.fill(text)
	if (await resumeButton.isVisible().catch(() => false)) {
		await resumeButton.click()
	} else {
		await sendButton.click()
	}
	await expect(sidebar.getByText(text, { exact: true }).last()).toBeVisible({ timeout: 30_000 })
}

async function openSeededTask(
	app: ElectronApplication,
	helper: E2ETestHelper,
): Promise<{ page: Awaited<ReturnType<ElectronApplication["firstWindow"]>>; sidebar: Frame }> {
	const page = await app.firstWindow()
	await E2ETestHelper.openClineSidebar(page)
	const sidebar = await helper.getSidebar(page)
	await helper.signin(sidebar)
	await page.getByRole("button", { name: "History", exact: true }).click()
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	const historyTask = sidebar.locator(".history-item").filter({ hasText: TASK_TEXT })
	await expect(historyTask).toHaveCount(1)
	await historyTask.click()
	await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({ timeout: 30_000 })
	return { page, sidebar }
}

async function attachDiagnostics(testInfo: TestInfo, diagnostics: JitterDiagnostics): Promise<void> {
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
				const painted = rowShifts.filter((shift) => Math.abs(shift.dy) >= 120)
				const large = rowShifts.filter((shift) => Math.abs(shift.dy) >= 300)

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
				await testInfo.attach("chat-scroll-uniform-control.json", {
					body: JSON.stringify({ heights, visual, rowShifts: rowShifts.slice(0, 200), samples }, null, 2),
					contentType: "application/json",
				})

				// What this control established, and why only one of the two
				// probes is gated.
				//
				// The paint probe reads zero on this fixture: 305 shift entries,
				// none of them past 120px, the largest 60px at a paging boundary.
				// The list still pages windows and still repositions itself here,
				// so that silence is the Layout Instability rule working as
				// written — a node that moved only because its container
				// scrolled is not a shift candidate, and a programmatic jump
				// scrolls the container like any other. It can therefore be
				// trusted to report displacement rather than travel.
				//
				// `visualError` reads -183px on the same run, past the 120px it
				// is gated at elsewhere. Nothing on this fixture can grow after
				// mount, so there is no displacement for it to have found: the
				// figure is the probe's own error. It samples in the
				// animation-frame callbacks, before the resize-observation
				// broadcast and before paint, so it cannot subtract a correction
				// that has not been issued yet. It stays printed as a diagnostic
				// and must not be used to accept or reject a candidate fix until
				// it reads zero here.
				//
				// Absolute value matters: the figure is signed, and -183 passes
				// any bare `toBeLessThan(120)` while failing the property it is
				// supposed to express.
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
				}
				const visualFrames: VisualFrame[] = []
				const captureVisual = async (step: number): Promise<VisualFrame | null> =>
					sidebar.evaluate((currentStep) => {
						const scroller = document.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]')
						if (!scroller) return null
						const viewport = scroller.getBoundingClientRect()
						const rows: Record<string, number> = {}
						for (const row of scroller.querySelectorAll<HTMLElement>("[data-message-ts]")) {
							const ts = row.dataset.messageTs
							if (!ts) continue
							rows[ts] = Math.round(row.getBoundingClientRect().top - viewport.top)
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
						// Every row present in both frames is compared, and the
						// worst disagreement is reported. Rows that scrolled out
						// of the window simply do not appear in both.
						let worst: { ts: string; moved: number; residual: number } | null = null
						for (const [ts, top] of Object.entries(frame.rows)) {
							const before = previous.rows[ts]
							if (before === undefined) continue
							const moved = top - before
							const residual = moved + scrolled
							if (!worst || Math.abs(residual) > Math.abs(worst.residual)) {
								worst = { ts, moved, residual }
							}
						}
						if (!worst) return null
						return {
							step: frame.step,
							ts: worst.ts,
							scrolled,
							moved: worst.moved,
							// Zero when the row moved exactly as far as the
							// list scrolled.
							residual: worst.residual,
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
				expect(
					reversals.length,
					`content must not move against the direction of travel (${reversals.length} reversal(s): ${JSON.stringify(reversals.slice(0, 3))})`,
				).toBe(0)
			} finally {
				if (app) await app.close().catch(() => undefined)
			}
		},
	)

	e2e(
		"browsing a long history with collapsing rows settles without tremor",
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

				// Browse upward far enough to force leading window loads, which is
				// when both position owners are asked to restore at once.
				let visibleRows = await captureVisibleRows(sidebar)
				for (let attempt = 0; attempt < 40; attempt++) {
					const indexes = visibleRows.flatMap((row) => {
						const match = /E2E_JITTER_MESSAGE_(\d{4})/u.exec(row.text)
						return match ? [Number(match[1])] : []
					})
					if (indexes.some((index) => index <= BROWSE_TARGET_INDEX)) break
					await scroller.hover()
					await page.mouse.wheel(0, -2_400)
					await page.waitForTimeout(100)
					visibleRows = await captureVisibleRows(sidebar)
				}

				const reachedIndexes = visibleRows.flatMap((row) => {
					const match = /E2E_JITTER_MESSAGE_(\d{4})/u.exec(row.text)
					return match ? [Number(match[1])] : []
				})
				await testInfo.attach("chat-scroll-jitter-browse-state.json", {
					body: JSON.stringify({ reachedIndexes, visibleRows }, null, 2),
					contentType: "application/json",
				})
				// Without this the run can pass by never leaving the tail, which
				// proves nothing: the contested restore only happens once browsing
				// forces a leading window load.
				expect(reachedIndexes.length, "browsing must render identifiable seeded rows").toBeGreaterThan(0)
				expect(
					Math.min(...reachedIndexes),
					`browsing must reach the older history range that triggers leading loads (reached=${Math.min(...reachedIndexes)})`,
				).toBeLessThanOrEqual(BROWSE_TARGET_INDEX)

				// `captureVisibleRows` already returns only rows overlapping the
				// viewport. Asking additionally for a non-negative top rejected the
				// row straddling the top edge, which after scrolling up through
				// history is often the only one there is.
				const anchorRow = visibleRows[0]
				expect(anchorRow, "browsing must expose a visible anchor row").toBeDefined()
				if (!anchorRow) throw new Error("missing anchor row")

				// From here no input is issued. Anything that still moves the anchor
				// is the application restoring position, not the user scrolling.
				const diagnostics = await sampleSettling(sidebar, anchorRow.ts)
				await attachDiagnostics(testInfo, diagnostics)

				// A run that never resolved the anchor produced no measurement at
				// all, so its zero travel must not be read as a settled viewport.
				const resolvedSamples = diagnostics.samples.filter((sample) => sample.anchorTop !== null)
				expect(
					resolvedSamples.length,
					"the sampled anchor must stay resolvable, otherwise no jitter measurement was taken",
				).toBeGreaterThan(SETTLE_SAMPLE_COUNT / 2)

				// A single legitimate correction spends its distance once and stops.
				// A tremor keeps spending distance while ending up in the same place,
				// so excess travel is what separates the two.
				expect(
					diagnostics.excessTravel,
					`the anchor must not oscillate once input stops (net=${diagnostics.netTravel.toFixed(1)}, total=${diagnostics.totalTravel.toFixed(1)}, reversals=${diagnostics.reversals})`,
				).toBeLessThanOrEqual(12)
				expect(
					diagnostics.reversals,
					"a settled viewport must not reverse direction repeatedly without input",
				).toBeLessThanOrEqual(2)

				// Two position owners answering the same merge is the known cause,
				// and the recorded scroll origins are attached above so a failure can
				// be traced to it. It is deliberately not asserted: measured across
				// five runs of unmodified code the count moved between 0 and 3, so a
				// threshold on it would fail at random instead of on a regression.
				const contested = countContestedRestores(diagnostics.events)
				testInfo.annotations.push({ type: "contested-restores", description: String(contested) })

				// A jump is the other half of the complaint and excess travel cannot
				// detect it: one large displacement spends no excess distance at all.
				// With no input in flight, nothing should move the reader this far.
				const jump = largestAnchorJump(diagnostics.samples)
				expect(
					jump,
					`the anchor must not jump while no input is in flight (largest=${jump.toFixed(1)}px)`,
				).toBeLessThanOrEqual(24)

				await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
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
				await scroller.hover()
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
				await scroller.hover()
				for (let pass = 0; pass < 60; pass++) {
					await page.mouse.wheel(0, -80)
					await page.waitForTimeout(16)
				}
				await page.waitForTimeout(400)

				const liveSamples = await readContinuousSamples(sidebar)
				// The full series is passed through: `countBackwardFrames` owns the
				// filtering, because compacting the array here would let samples
				// that measured different rows look adjacent.
				const backward = countBackwardFrames(liveSamples, 1)
				const rowSwitches = countTrackedRowSwitches(liveSamples)
				const displacement = largestContentDisplacement(liveSamples)
				const resolved = liveSamples.filter((sample) => sample.anchorTop !== null)
				await testInfo.attach("chat-scroll-jitter-live-samples.json", {
					body: JSON.stringify(
						{ backward, rowSwitches, displacement, resolvedCount: resolved.length, samples: liveSamples },
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
				await scroller.hover()
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

				const streamingLive = await readContinuousSamples(sidebar)
				const streamingDisplacement = largestContentDisplacement(streamingLive)
				const causes = await readDisplacementCauses(sidebar)
				// Keep only what happened around the worst frame. The full series
				// runs to thousands of entries, and an attachment nobody can read
				// explains nothing.
				const nearWorst = <T extends { time: number }>(entries: T[]): T[] =>
					entries.filter((entry) => Math.abs(entry.time - streamingDisplacement.atTime) <= 600)
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
				const streamingBackward = countBackwardFrames(streamingLive, 1)
				console.log(
					"[probe] streaming content displacement (diagnostic):",
					Math.round(streamingDisplacement.pixels),
					"px at",
					streamingDisplacement.atTime,
					"; backward frames:",
					streamingBackward,
				)
				expect(
					streamingBackward,
					`a growing tail must not move content against the scroll direction (backwardFrames=${streamingBackward}, largest displacement=${Math.round(streamingDisplacement.pixels)}px at t=${streamingDisplacement.atTime})`,
				).toBeLessThanOrEqual(1)

				const visibleRows = await captureVisibleRows(sidebar)
				const anchorRow = visibleRows[0]
				expect(anchorRow, "two-way scrolling during streaming must leave a visible anchor").toBeDefined()
				if (!anchorRow) throw new Error("missing streaming anchor row")

				// Input stops here while the stream is still open, so the tail is the
				// only thing still changing.
				const diagnostics = await sampleSettling(sidebar, anchorRow.ts)
				await attachDiagnostics(testInfo, diagnostics)

				const resolvedSamples = diagnostics.samples.filter((sample) => sample.anchorTop !== null)
				expect(
					resolvedSamples.length,
					"the streaming anchor must stay resolvable, otherwise nothing was measured",
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
