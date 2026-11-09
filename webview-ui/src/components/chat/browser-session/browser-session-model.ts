import { type BrowserAction, browserActions, type UiMessage } from "@shared/ExtensionMessage"
import { englishUiTranslator, type UiTranslator } from "@/i18n/messages"
import type { BrowserSessionEnd } from "../chat-view/utils/chatRowKinds"
import { isRoundStartCheckpoint, restoresSameFiles } from "../chat-view/utils/checkpointRows"

export interface BrowserSessionState {
    url?: string
    screenshot?: string
    mousePosition?: string
    consoleLogs?: string
}

export interface BrowserSessionAction {
    messageTs: number
    action: BrowserAction
    coordinate?: string
    text?: string
}

export interface BrowserSessionPage {
    state: BrowserSessionState
    actions: BrowserSessionAction[]
}

/**
 * One request round of a browser session: what the round wrote before its
 * browser call, the call itself, and the frame page that shows its outcome.
 */
export interface BrowserSessionStep {
    /** Stable identity: the first row of the step. */
    key: number
    /** The restore point written before this step's request. */
    checkpoint?: UiMessage
    thoughts: UiMessage[]
    actions: BrowserSessionAction[]
    /** Rows that must stay readable while the session is folded: request failures, retries, attachments. */
    notices: UiMessage[]
    /** The frame page that shows this step's outcome. */
    pageIndex: number
}

export interface BrowserSessionProjection {
    pages: BrowserSessionPage[]
    steps: BrowserSessionStep[]
    initialUrl: string
    isAutoApproved: boolean
    hasBrowserResult: boolean
    hasPendingApproval: boolean
}

/** What the session card says it is doing. */
export type BrowserSessionPhase = "awaiting_approval" | "declined" | "running" | "completed" | "interrupted" | "failed"

function parseRecord(text: string | undefined): Record<string, unknown> | undefined {
    if (!text) return undefined
    try {
        const value: unknown = JSON.parse(text)
        return typeof value === "object" && value !== null && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : undefined
    } catch {
        return undefined
    }
}

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined
}

function parseResult(message: UiMessage): BrowserSessionState {
    const result = parseRecord(message.text)
    return {
        url: optionalString(result?.currentUrl),
        screenshot: optionalString(result?.screenshot),
        mousePosition: optionalString(result?.currentMousePosition),
        consoleLogs: optionalString(result?.logs),
    }
}

function parseAction(message: UiMessage): BrowserSessionAction | undefined {
    const value = parseRecord(message.text)
    const action = optionalString(value?.action)
    if (!action || !browserActions.includes(action as BrowserAction)) return undefined
    return {
        messageTs: message.ts,
        action: action as BrowserAction,
        coordinate: optionalString(value?.coordinate),
        text: optionalString(value?.text),
    }
}

function isLaunch(message: UiMessage): boolean {
    return message.ask === "browser_action_launch" || message.say === "browser_action_launch"
}

function isBrowserRow(message: UiMessage): boolean {
    return isLaunch(message) || message.say === "browser_action" || message.say === "browser_action_result"
}

/**
 * The member whose expansion state stands for the whole session. A browser row
 * keeps no expansion of its own, so using one never collides with a thinking
 * row inside the session.
 */
export function browserSessionAnchor(messages: readonly UiMessage[]): UiMessage | undefined {
    return messages.find(isBrowserRow) ?? messages[0]
}

export function hasCancelledBrowserApiRequest(messages: UiMessage[]): boolean {
    const lastApiRequest = [...messages].reverse().find((message) => message.say === "api_req_started")
    const value = parseRecord(lastApiRequest?.text)
    return value?.cancelReason !== undefined && value?.cancelReason !== null
}

/** The one-line description of a browser action, as the session card and its steps list it. */
export function describeBrowserAction(
    action: Pick<BrowserSessionAction, "action" | "coordinate" | "text">,
    t: UiTranslator = englishUiTranslator,
): string {
    switch (action.action) {
        case "launch":
            return t("chatRows.browser.action.launch", { url: action.text ?? "" })
        case "click":
            return t("chatRows.browser.action.click", { coordinate: action.coordinate?.replace(",", ", ") ?? "" })
        case "type":
            return t("chatRows.browser.action.type", { text: action.text ?? "" })
        case "scroll_down":
            return t("chatRows.browser.action.scrollDown")
        case "scroll_up":
            return t("chatRows.browser.action.scrollUp")
        case "close":
            return t("chatRows.browser.action.close")
        default:
            // An action the product does not name is reported by its protocol name.
            return action.action
    }
}

/**
 * Describe a browser row drawn without its session card.
 *
 * The result payload carries a full screenshot data URL, so only the fields a
 * reader needs are taken from it; the payload itself is never shown.
 */
export function describeBrowserMessage(message: UiMessage, t: UiTranslator = englishUiTranslator): string {
    if (isLaunch(message)) return describeBrowserAction({ action: "launch", text: message.text }, t)
    if (message.say === "browser_action") {
        const action = parseAction(message)
        return action ? describeBrowserAction(action, t) : t("chatRows.browser.message.action")
    }
    if (message.say === "browser_action_result") {
        if (!message.text) return t("chatRows.browser.message.opening")
        const url = parseResult(message).url
        return url ? t("chatRows.browser.message.page", { url }) : t("chatRows.browser.message.pageCaptured")
    }
    return t("chatRows.browser.message.activity")
}

interface StepDraft extends Omit<BrowserSessionStep, "pageIndex"> {
    pageIndex?: number
    hasResult: boolean
}

/**
 * Project a browser session into frame pages and request-round steps.
 *
 * Each round writes its restore point and thinking before its browser call and
 * the page it produced after it, so a step is everything from one round's
 * first row through its browser result.
 */
export function projectBrowserSession(messages: UiMessage[]): BrowserSessionProjection {
    const pages: BrowserSessionPage[] = []
    const drafts: StepDraft[] = []
    let pendingActions: BrowserSessionAction[] = []
    let awaitingPage: StepDraft[] = []
    let step: StepDraft | undefined
    let initialUrl = ""
    let isAutoApproved = false
    let hasLaunch = false
    let hasBrowserResult = false

    const begin = (message: UiMessage): StepDraft => {
        step = { key: message.ts, thoughts: [], actions: [], notices: [], hasResult: false }
        drafts.push(step)
        return step
    }
    /** A row written before a browser call opens the next step once the current one has acted. */
    const stepForLead = (message: UiMessage, startsRound = false): StepDraft => {
        if (!step || step.actions.length > 0 || step.hasResult || (startsRound && step.checkpoint)) return begin(message)
        return step
    }
    const stepForAction = (message: UiMessage): StepDraft => {
        const current = !step || step.hasResult ? begin(message) : step
        if (!awaitingPage.includes(current)) awaitingPage.push(current)
        return current
    }
    const settlePage = () => {
        for (const draft of awaitingPage) draft.pageIndex = pages.length - 1
        awaitingPage = []
    }

    for (const message of messages) {
        if (isLaunch(message)) {
            hasLaunch = true
            initialUrl = message.text ?? ""
            isAutoApproved = message.say === "browser_action_launch"
            stepForAction(message).actions.push({ messageTs: message.ts, action: "launch", text: initialUrl })
            continue
        }

        if (message.say === "browser_action") {
            const action = parseAction(message)
            const current = stepForAction(message)
            if (action) {
                current.actions.push(action)
                pendingActions.push(action)
            }
            continue
        }

        if (message.say === "browser_action_result") {
            hasBrowserResult = true
            // The empty result only starts the launch spinner; the page arrives with the next result.
            if (message.text === "") continue
            const current = step && !step.hasResult ? step : begin(message)
            if (!awaitingPage.includes(current)) awaitingPage.push(current)
            pages.push({ state: parseResult(message), actions: pendingActions })
            pendingActions = []
            current.hasResult = true
            settlePage()
            continue
        }

        if (message.say === "checkpoint_created" && isRoundStartCheckpoint(message)) {
            stepForLead(message, true).checkpoint = message
            continue
        }

        if (message.say === "reasoning") {
            stepForLead(message).thoughts.push(message)
            continue
        }

        stepForLead(message).notices.push(message)
    }

    if (pages.length === 0 || pendingActions.length > 0) {
        pages.push({ state: {}, actions: pendingActions })
    }
    settlePage()
    const lastPage = pages.length - 1

    return {
        pages: hasLaunch || hasBrowserResult ? pages : [],
        steps: drafts.map(({ hasResult: _hasResult, pageIndex, ...draft }) => ({
            ...draft,
            pageIndex: Math.min(pageIndex ?? lastPage, lastPage),
        })),
        initialUrl,
        isAutoApproved,
        hasBrowserResult,
        hasPendingApproval: messages.some((message) => message.ask === "browser_action_launch") && !hasBrowserResult,
    }
}

/** The restore point that heads the session card: the first one the session holds. */
export function headCheckpoint(steps: readonly BrowserSessionStep[]): UiMessage | undefined {
    return steps.find((step) => step.checkpoint)?.checkpoint
}

/**
 * Restore points that stay visible while the session is folded.
 *
 * Browser calls change no workspace files, so a later restore point normally
 * brings back what the head one does and folds away. One that brings back
 * different files — the user edited them meanwhile — or that is checked out
 * is a point the user must still be able to find.
 */
export function unfoldableCheckpoints(steps: readonly BrowserSessionStep[]): UiMessage[] {
    const head = headCheckpoint(steps)
    if (!head) return []
    return steps.flatMap(({ checkpoint }) =>
        checkpoint && checkpoint !== head && (checkpoint.isCheckpointCheckedOut || !restoresSameFiles(head, checkpoint))
            ? [checkpoint]
            : [],
    )
}

/**
 * How the summary counts browser calls, in the order it lists them. Closing
 * the browser is how a session ends, which the header already reports.
 */
const ACTION_TALLIES: readonly { readonly actions: readonly BrowserAction[] }[] = [
    { actions: ["launch"] },
    { actions: ["click"] },
    { actions: ["type"] },
    { actions: ["scroll_down", "scroll_up"] },
]

/** "1 launch, 3 clicks, 2 scrolls · 2 thoughts · 6 rounds", counted the way an exploration run counts its calls. */
export function summarizeBrowserSession(steps: readonly BrowserSessionStep[], t: UiTranslator = englishUiTranslator): string {
    const actions = steps.flatMap((step) => step.actions)
    const calls = ACTION_TALLIES.flatMap(({ actions: kinds }) => {
        const count = actions.filter((entry) => kinds.includes(entry.action)).length
        if (count === 0) return []
        switch (kinds[0]) {
            case "launch":
                return [t("chatRows.browser.summary.launch", { count })]
            case "click":
                return [t("chatRows.browser.summary.click", { count })]
            case "type":
                return [t("chatRows.browser.summary.input", { count })]
            default:
                return [t("chatRows.browser.summary.scroll", { count })]
        }
    })
    const thoughts = steps.reduce((count, step) => count + step.thoughts.length, 0)
    const rounds = steps.filter((step) => step.actions.length > 0).length
    const parts: string[] = []
    if (calls.length > 0) parts.push(calls.join(", "))
    if (thoughts > 0) parts.push(t("chatRows.browser.summary.thought", { count: thoughts }))
    if (rounds > 1) parts.push(t("chatRows.browser.summary.rounds", { count: rounds }))
    return parts.join(" · ")
}

interface BrowserSessionPhaseInput {
    end: BrowserSessionEnd
    isLast: boolean
    projection: Pick<BrowserSessionProjection, "hasPendingApproval">
    messages: UiMessage[]
    lastModifiedMessage?: UiMessage
}

/**
 * Resolve what the session card reports.
 *
 * How the session stopped is known when it was grouped; only a session the
 * transcript still ends in depends on the task's latest row.
 */
export function resolveBrowserSessionPhase(input: BrowserSessionPhaseInput): BrowserSessionPhase {
    switch (input.end) {
        case "closed":
        case "ended":
            // A launch that never produced a page was not approved.
            return input.projection.hasPendingApproval ? "declined" : "completed"
        case "failed":
            return "failed"
        case "interrupted":
            return "interrupted"
    }
    if (!input.isLast) return "completed"
    const latestAsk = input.lastModifiedMessage?.ask
    if (latestAsk === "resume_task" || latestAsk === "resume_completed_task" || latestAsk === "api_req_failed") {
        return "interrupted"
    }
    if (hasCancelledBrowserApiRequest(input.messages)) return "interrupted"
    return input.projection.hasPendingApproval ? "awaiting_approval" : "running"
}

/** Message keys for each phase, resolved where the card header renders. */
const PHASE_LABEL_KEYS = {
    awaiting_approval: "chatRows.browser.phase.awaitingApproval",
    declined: "chatRows.browser.phase.declined",
    running: "chatRows.browser.phase.running",
    completed: "chatRows.browser.phase.completed",
    interrupted: "chatRows.browser.phase.interrupted",
    failed: "chatRows.browser.phase.failed",
} as const

/** The header sentence for a phase, in the rendering surface's language. */
export function browserSessionPhaseLabel(phase: BrowserSessionPhase, t: UiTranslator = englishUiTranslator): string {
    return t(PHASE_LABEL_KEYS[phase])
}
