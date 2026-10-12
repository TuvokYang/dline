import { useCallback, useEffect, useRef, useState } from "react"
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

const ACTION_LABEL: Record<Exclude<ComposerAction, "unavailable">, string> = {
    send: "Send message",
    resume: "Resume task",
    queue: "Queue message",
    cancel: "Cancel task",
}

interface TooltipContext {
    readonly shortcuts: ComposerShortcutLabels
    readonly state: ComposerActionState
    readonly revealsCancel: boolean
    readonly outputTokensPerSecond?: number
}

function tooltipOf(action: ComposerAction, { shortcuts, state, revealsCancel, outputTokensPerSecond }: TooltipContext): string {
    const lines: string[] = []
    switch (action) {
        case "send":
        case "resume":
            lines.push(`${ACTION_LABEL[action]} (${shortcuts.send})`)
            // With nothing running to queue behind, the plain-text chord sends right away.
            if (state.canQueue) {
                lines.push(`Queue instead (${shortcuts.queue})`, `Queue as plain text (${shortcuts.queuePlainText})`)
            } else {
                lines.push(`Send as plain text (${shortcuts.queuePlainText})`)
            }
            break
        case "queue":
            lines.push(`Queue message (${shortcuts.send})`, `Queue as plain text (${shortcuts.queuePlainText})`)
            if (revealsCancel) lines.push("Keep hovering to cancel the task instead")
            break
        case "cancel":
            lines.push("Cancel task")
            break
        case "unavailable":
            lines.push(
                state.submitKind === "resume" ? "The task cannot be resumed yet" : "The task does not accept input right now",
            )
            break
    }
    if (outputTokensPerSecond !== undefined) lines.push(`Model output: ${formatOutputSpeed(outputTokensPerSecond)}`)
    return lines.join("\n")
}

function labelOf(action: ComposerAction, submitKind: ComposerSubmitKind): string {
    return action === "unavailable" ? ACTION_LABEL[submitKind] : ACTION_LABEL[action]
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
            aria-label={labelOf(action, submitKind)}
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
            title={tooltipOf(action, { shortcuts, state, revealsCancel: revealable !== undefined, outputTokensPerSecond })}
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
