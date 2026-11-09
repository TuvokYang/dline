import { useCallback, useEffect, useRef, useState } from "react"
import type { UiTranslator } from "@/i18n/messages"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import type { ComposerShortcutLabels } from "@/utils/chat-input-shortcut"
import { CancelIcon, QueueIcon, ResumeIcon, SendIcon } from "./ComposerActionIcons"
import {
    CANCEL_REVEAL_HOVER_MS,
    type ComposerAction,
    type ComposerActionState,
    type ComposerSubmitKind,
    hoverRevealedAction,
    resolveComposerAction,
} from "./composer-action"
import { formatOutputSpeed, outputSpeedTier } from "./output-speed"
import "./composer-action.css"

export interface ComposerActionButtonProps {
    readonly state: ComposerActionState
    /** Sends, resumes with or queues the draft; the composer decides which from its own state. */
    readonly onSend: () => void
    /** Stops the running task. Resolves once the request settled, failed or not. */
    readonly onCancel?: () => Promise<void>
    /** The keyboard shortcuts under the configured send shortcut, shown in the tooltip. */
    readonly shortcuts: ComposerShortcutLabels
    /**
     * How fast the model is writing its answer, in output tokens per second.
     * Present only while a response streams; the button then tints by speed tier.
     */
    readonly outputTokensPerSecond?: number
    /** Overrides the hover delay before cancel replaces queue; tests and stories shorten it. */
    readonly cancelRevealMs?: number
}

const ACTION_LABEL = {
    send: "chatInput.action.send",
    resume: "chatInput.action.resume",
    queue: "chatInput.action.queue",
    cancel: "chatInput.action.cancel",
} as const

interface TooltipContext {
    readonly shortcuts: ComposerShortcutLabels
    readonly state: ComposerActionState
    readonly revealsCancel: boolean
    readonly outputTokensPerSecond?: number
}

function tooltipOf(
    action: ComposerAction,
    { shortcuts, state, revealsCancel, outputTokensPerSecond }: TooltipContext,
    t: UiTranslator,
): string {
    const lines: string[] = []
    switch (action) {
        case "send":
        case "resume":
            lines.push(
                t(action === "send" ? "chatInput.action.sendShortcut" : "chatInput.action.resumeShortcut", {
                    shortcut: shortcuts.send,
                }),
            )
            // With nothing running to steer, the steer shortcut just sends, so it is not offered.
            if (state.canQueue) lines.push(t("chatInput.action.steerShortcut", { shortcut: shortcuts.steer }))
            break
        case "queue":
            lines.push(
                t("chatInput.action.queueShortcut", { shortcut: shortcuts.send }),
                t("chatInput.action.steerShortcut", { shortcut: shortcuts.steer }),
            )
            if (revealsCancel) lines.push(t("chatInput.action.hoverCancel"))
            break
        case "cancel":
            lines.push(t("chatInput.action.cancel"))
            break
        case "unavailable":
            lines.push(
                t(state.submitKind === "resume" ? "chatInput.action.resumeUnavailable" : "chatInput.action.inputUnavailable"),
            )
            break
    }
    if (outputTokensPerSecond !== undefined)
        lines.push(t("chatInput.action.output", { speed: formatOutputSpeed(outputTokensPerSecond) }))
    return lines.join("\n")
}

function labelOf(action: ComposerAction, submitKind: ComposerSubmitKind, t: UiTranslator): string {
    return t(action === "unavailable" ? ACTION_LABEL[submitKind] : ACTION_LABEL[action])
}

/** The glyph for an action; an unavailable button keeps the glyph of what a send would do. */
function iconOf(action: ComposerAction, submitKind: ComposerSubmitKind) {
    switch (action === "unavailable" ? submitKind : action) {
        case "resume":
            return <ResumeIcon />
        case "queue":
            return <QueueIcon />
        case "cancel":
            return <CancelIcon />
        default:
            return <SendIcon />
    }
}

/**
 * The composer's one action button.
 *
 * It shows what a click does now, worked out by `resolveComposerAction`: send,
 * resume the paused task, queue, or cancel the running task. It replaces the
 * footer's Resume and Cancel buttons. While a draft is waiting to be queued the
 * cancel action is hidden behind it; resting the pointer on the button for
 * `CANCEL_REVEAL_HOVER_MS` turns it into cancel until the pointer leaves.
 *
 * The test id stays `send-button` in every state, and `data-action` names the
 * current one, so a check for "the task takes a send now" reads `data-action`.
 * While a response streams, `data-output-speed` names the speed tier that
 * tints the button.
 */
export function ComposerActionButton({
    state,
    onSend,
    onCancel,
    shortcuts,
    outputTokensPerSecond,
    cancelRevealMs = CANCEL_REVEAL_HOVER_MS,
}: ComposerActionButtonProps) {
    const { t } = useUiTranslation()
    const primary = resolveComposerAction(state)
    const submitKind = state.submitKind ?? "send"
    const revealable = onCancel ? hoverRevealedAction(primary, state) : undefined
    const [hovering, setHovering] = useState(false)
    const [revealed, setRevealed] = useState(false)
    const [cancelPending, setCancelPending] = useState(false)
    const mountedRef = useRef(true)
    useEffect(
        () => () => {
            mountedRef.current = false
        },
        [],
    )

    // Arms only while the pointer rests on a button that can reveal cancel; a
    // change of primary action or leaving the button starts over.
    useEffect(() => {
        setRevealed(false)
        if (!hovering || !revealable) return
        const timer = setTimeout(() => setRevealed(true), cancelRevealMs)
        return () => clearTimeout(timer)
    }, [cancelRevealMs, hovering, revealable])

    const action: ComposerAction = revealed && revealable ? revealable : primary
    const cancel = action === "cancel" ? onCancel : undefined
    const disabled = action === "unavailable" || (action === "cancel" && (!cancel || cancelPending))
    const arming = hovering && revealable !== undefined && !revealed

    const handleClick = useCallback(() => {
        if (action === "cancel") {
            if (!cancel || cancelPending) return
            setCancelPending(true)
            void cancel().finally(() => {
                if (mountedRef.current) setCancelPending(false)
            })
            return
        }
        // An unavailable send still runs, so the composer can say why nothing went out.
        onSend()
    }, [action, cancel, cancelPending, onSend])

    return (
        <button
            aria-busy={cancelPending || undefined}
            aria-disabled={disabled}
            aria-label={labelOf(action, submitKind, t)}
            className={[
                "composer-action",
                `composer-action--${action}`,
                action === "send" && !state.hasContent ? "composer-action--empty" : "",
            ]
                .filter(Boolean)
                .join(" ")}
            data-action={action}
            data-output-speed={outputTokensPerSecond === undefined ? undefined : outputSpeedTier(outputTokensPerSecond)}
            data-testid="send-button"
            onClick={handleClick}
            onPointerEnter={() => setHovering(true)}
            onPointerLeave={() => setHovering(false)}
            title={tooltipOf(action, { shortcuts, state, revealsCancel: revealable !== undefined, outputTokensPerSecond }, t)}
            type="button">
            {iconOf(action, submitKind)}
            {arming ? (
                <svg
                    aria-hidden="true"
                    className="composer-action__arming"
                    style={{ ["--composer-action-arming-ms" as string]: `${cancelRevealMs}ms` }}
                    viewBox="0 0 30 30">
                    <circle cx="15" cy="15" pathLength={100} r="14" />
                </svg>
            ) : null}
        </button>
    )
}
