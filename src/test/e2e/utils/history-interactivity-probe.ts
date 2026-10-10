import type { Frame } from "@playwright/test"

export type HistoryExpectedInteraction = "resume" | "send" | "start-new-task"

export interface HistoryInteractivitySample {
    atMs: number
    footerActions: Array<{ disabled: boolean; label: string }>
    interactionUnavailable: boolean
    lockTakeoverVisible: boolean
    sendAriaDisabled: string | null
    taskSurfaceVisible: boolean
}

export interface HistoryInteractivityReport {
    clickAtMs?: number
    current: HistoryInteractivitySample
    expectedAtMs?: number
    observedAtMs: number
    firstLegalInteractionAtMs?: number
    historyClickToExpectedMs?: number
    historyClickToFirstLegalInteractionMs?: number
    historyClickToTaskSurfaceMs?: number
    samples: HistoryInteractivitySample[]
    taskSurfaceAtMs?: number
    taskSurfaceToExpectedMs?: number
    taskSurfaceToObservedMs?: number
}

interface BrowserProbeState {
    clickAtMs?: number
    expected: HistoryExpectedInteraction
    expectedAtMs?: number
    firstLegalInteractionAtMs?: number
    samples: HistoryInteractivitySample[]
    stop: () => void
    taskSurfaceAtMs?: number
}

/** Observe the full dead window from a History click until the first legal Task interaction. */
export async function startHistoryInteractivityProbe(frame: Frame, expected: HistoryExpectedInteraction): Promise<void> {
    await frame.evaluate((expectedInteraction) => {
        const root = globalThis as typeof globalThis & { __dlineHistoryInteractivityProbe?: BrowserProbeState }
        root.__dlineHistoryInteractivityProbe?.stop()

        const samples: HistoryInteractivitySample[] = []
        let previousSignature = ""
        const state: BrowserProbeState = {
            expected: expectedInteraction,
            samples,
            stop: () => {},
        }

        const read = (): HistoryInteractivitySample => {
            const footer = document.querySelector("footer")
            const footerActions = [...(footer?.querySelectorAll<HTMLElement>("vscode-button[aria-label]") ?? [])].map(
                (element) => ({
                    disabled: element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true",
                    label: element.getAttribute("aria-label") ?? "",
                }),
            )
            return {
                atMs: performance.now(),
                footerActions,
                interactionUnavailable: document.body.textContent?.includes("Task interaction state is unavailable") === true,
                lockTakeoverVisible:
                    document.body.textContent?.includes("read-only mode") === true ||
                    [...document.querySelectorAll<HTMLElement>("button, vscode-button")].some(
                        (element) => (element.getAttribute("aria-label") ?? element.textContent?.trim()) === "Unlock",
                    ),
                sendAriaDisabled:
                    document.querySelector<HTMLElement>('[data-testid="send-button"]')?.getAttribute("aria-disabled") ?? null,
                taskSurfaceVisible: Boolean(document.querySelector('[aria-label="Close Task"]')),
            }
        }

        const sample = (): void => {
            const current = read()
            const signature = JSON.stringify({
                footerActions: current.footerActions,
                interactionUnavailable: current.interactionUnavailable,
                lockTakeoverVisible: current.lockTakeoverVisible,
                sendAriaDisabled: current.sendAriaDisabled,
                taskSurfaceVisible: current.taskSurfaceVisible,
            })
            if (signature !== previousSignature) {
                previousSignature = signature
                samples.push(current)
            }
            if (current.taskSurfaceVisible && state.taskSurfaceAtMs === undefined) state.taskSurfaceAtMs = current.atMs
            const enabledLabels = new Set(
                current.footerActions.filter((action) => !action.disabled).map((action) => action.label),
            )
            const taskActionLabels = new Set([
                "Resume",
                "Retry",
                "Start New Task",
                "Approve",
                "Reject",
                "Cancel",
                "Process Anyway",
                "Acknowledge",
                "Stop",
                "Condense Conversation",
                "Regenerate Summary",
                "Regenerate Context",
                "Continue in Background",
            ])
            const hasEnabledTaskAction = [...enabledLabels].some((label) => taskActionLabels.has(label))
            const sendEnabled = current.sendAriaDisabled === "false"
            if (
                current.taskSurfaceVisible &&
                (hasEnabledTaskAction || sendEnabled || current.lockTakeoverVisible) &&
                state.firstLegalInteractionAtMs === undefined
            ) {
                state.firstLegalInteractionAtMs = current.atMs
            }
            const expectedReached =
                current.taskSurfaceVisible &&
                (expectedInteraction === "resume"
                    ? enabledLabels.has("Resume") && sendEnabled
                    : expectedInteraction === "start-new-task"
                      ? enabledLabels.has("Start New Task") && sendEnabled
                      : sendEnabled)
            if (expectedReached && state.expectedAtMs === undefined) state.expectedAtMs = current.atMs
        }

        const onClick = (event: MouseEvent): void => {
            const target = event.target instanceof Element ? event.target : undefined
            if (!target?.closest(".history-item, .history-preview-item")) return
            state.clickAtMs ??= performance.now()
            sample()
        }
        document.addEventListener("click", onClick, true)
        const observer = new MutationObserver(sample)
        observer.observe(document.body, { attributes: true, childList: true, subtree: true })
        const timer = window.setInterval(sample, 10)
        state.stop = () => {
            document.removeEventListener("click", onClick, true)
            observer.disconnect()
            window.clearInterval(timer)
        }
        root.__dlineHistoryInteractivityProbe = state
        sample()
    }, expected)
}

/** Read the current probe without stopping it. */
export async function readHistoryInteractivityProbe(frame: Frame): Promise<HistoryInteractivityReport | undefined> {
    return await frame.evaluate(() => {
        const root = globalThis as typeof globalThis & { __dlineHistoryInteractivityProbe?: BrowserProbeState }
        const state = root.__dlineHistoryInteractivityProbe
        if (!state) return undefined
        const current = state.samples.at(-1)
        if (!current) return undefined
        const clickAtMs = state.clickAtMs
        const observedAtMs = performance.now()
        return {
            clickAtMs,
            current,
            expectedAtMs: state.expectedAtMs,
            observedAtMs,
            firstLegalInteractionAtMs: state.firstLegalInteractionAtMs,
            historyClickToExpectedMs:
                clickAtMs !== undefined && state.expectedAtMs !== undefined ? state.expectedAtMs - clickAtMs : undefined,
            historyClickToFirstLegalInteractionMs:
                clickAtMs !== undefined && state.firstLegalInteractionAtMs !== undefined
                    ? state.firstLegalInteractionAtMs - clickAtMs
                    : undefined,
            historyClickToTaskSurfaceMs:
                clickAtMs !== undefined && state.taskSurfaceAtMs !== undefined ? state.taskSurfaceAtMs - clickAtMs : undefined,
            samples: [...state.samples],
            taskSurfaceAtMs: state.taskSurfaceAtMs,
            taskSurfaceToExpectedMs:
                state.taskSurfaceAtMs !== undefined && state.expectedAtMs !== undefined
                    ? state.expectedAtMs - state.taskSurfaceAtMs
                    : undefined,
            taskSurfaceToObservedMs: state.taskSurfaceAtMs !== undefined ? observedAtMs - state.taskSurfaceAtMs : undefined,
        }
    })
}

/** Stop the probe and return its final timing report. */
export async function stopHistoryInteractivityProbe(frame: Frame): Promise<HistoryInteractivityReport | undefined> {
    const report = await readHistoryInteractivityProbe(frame)
    await frame.evaluate(() => {
        const root = globalThis as typeof globalThis & { __dlineHistoryInteractivityProbe?: BrowserProbeState }
        root.__dlineHistoryInteractivityProbe?.stop()
        delete root.__dlineHistoryInteractivityProbe
    })
    return report
}
