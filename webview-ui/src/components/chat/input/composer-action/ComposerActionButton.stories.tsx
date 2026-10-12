import type { Meta, StoryObj } from "@storybook/react-vite"
import { useEffect, useState } from "react"
import { composerShortcutLabels } from "@/utils/chat-input-shortcut"
import { ComposerActionButton } from "./ComposerActionButton"
import type { ComposerActionState } from "./composer-action"
import { formatOutputSpeed, OUTPUT_SPEED_TIER_FLOORS, outputSpeedTier } from "./output-speed"

const SHORTCUTS = composerShortcutLabels("enter")

const IDLE_SEND: ComposerActionState = { canSend: true, canQueue: false, canCancel: false, hasContent: true }
const IDLE_EMPTY: ComposerActionState = { canSend: true, canQueue: false, canCancel: false, hasContent: false }
const PAUSED_RESUME: ComposerActionState = {
    canSend: true,
    submitKind: "resume",
    canQueue: false,
    canCancel: false,
    hasContent: false,
}
const RESUME_NOT_READY: ComposerActionState = {
    canSend: false,
    submitKind: "resume",
    canQueue: false,
    canCancel: false,
    hasContent: false,
}
const RUNNING_DRAFT: ComposerActionState = { canSend: false, canQueue: true, canCancel: true, hasContent: true }
const RUNNING_EMPTY: ComposerActionState = { canSend: false, canQueue: true, canCancel: true, hasContent: false }
const NO_INPUT: ComposerActionState = { canSend: false, canQueue: false, canCancel: false, hasContent: true }

const caption = { fontSize: 11, color: "var(--vscode-descriptionForeground)" } as const

/**
 * The composer's action button inside a frame sized like the real composer
 * (three rows). Hover the queue button for three seconds to see it turn into
 * cancel; the tooltip lists the shortcuts.
 */
function ComposerFrame({
    label,
    state,
    outputTokensPerSecond,
}: {
    label: string
    state: ComposerActionState
    outputTokensPerSecond?: number
}) {
    const [log, setLog] = useState<string>("—")
    const onSend = () => {
        if (state.canSend) setLog(state.submitKind ?? "send")
        else setLog(state.canQueue ? "queue" : "refused")
    }
    return (
        <div style={{ width: 360 }}>
            <div style={{ ...caption, fontSize: 12, marginBottom: 4 }}>{label}</div>
            <div
                style={{
                    position: "relative",
                    minHeight: "calc(3 * calc(var(--vscode-editor-font-size, 13px) * 1.5) + 18px)",
                    border: "1px solid var(--vscode-input-border)",
                    background: "var(--vscode-input-background)",
                    borderRadius: 2,
                    padding: "9px 36px 9px 9px",
                    fontSize: "var(--vscode-editor-font-size, 13px)",
                    lineHeight: "calc(var(--vscode-editor-font-size, 13px) * 1.5)",
                    color: "var(--vscode-input-foreground)",
                }}>
                {state.hasContent ? "Refactor the composer action button" : ""}
                <div style={{ position: "absolute", right: 6, bottom: 6 }}>
                    <ComposerActionButton
                        onCancel={async () => setLog("cancel")}
                        onSend={onSend}
                        outputTokensPerSecond={outputTokensPerSecond}
                        shortcuts={SHORTCUTS}
                        state={state}
                    />
                </div>
            </div>
            <div style={{ ...caption, marginTop: 4 }}>Last click: {log}</div>
        </div>
    )
}

function AllStates() {
    return (
        <div style={{ display: "grid", gap: 20, padding: 16 }}>
            <ComposerFrame label="Idle task, draft typed → Send" state={IDLE_SEND} />
            <ComposerFrame label="Idle task, empty composer → Send (muted)" state={IDLE_EMPTY} />
            <ComposerFrame label="Paused task → Resume (a draft goes with it)" state={PAUSED_RESUME} />
            <ComposerFrame label="History task still preparing → Resume unavailable" state={RESUME_NOT_READY} />
            <ComposerFrame
                label="Running task, draft typed → Queue (hover 3s → Cancel)"
                outputTokensPerSecond={75}
                state={RUNNING_DRAFT}
            />
            <ComposerFrame label="Running task, empty composer → Cancel" outputTokensPerSecond={75} state={RUNNING_EMPTY} />
            <ComposerFrame label="Nothing can take input → Unavailable" state={NO_INPUT} />
        </div>
    )
}

const GALLERY: readonly { label: string; state: ComposerActionState }[] = [
    { label: "Send", state: IDLE_SEND },
    { label: "Send (empty)", state: IDLE_EMPTY },
    { label: "Resume", state: PAUSED_RESUME },
    { label: "Queue", state: RUNNING_DRAFT },
    { label: "Cancel", state: RUNNING_EMPTY },
    { label: "Resume (unavailable)", state: RESUME_NOT_READY },
    { label: "Unavailable", state: NO_INPUT },
]

/** Every glyph side by side at 1x and enlarged, for checking the drawing up close. */
function Gallery() {
    return (
        <div style={{ display: "grid", gap: 24, padding: 16 }}>
            {[1, 3].map((scale) => (
                <div key={scale} style={{ display: "flex", gap: 28 * scale, alignItems: "flex-end" }}>
                    {GALLERY.map(({ label, state }) => (
                        <div key={label} style={{ display: "grid", justifyItems: "center", gap: 8 }}>
                            <div style={{ zoom: scale }}>
                                <ComposerActionButton
                                    onCancel={async () => {}}
                                    onSend={() => {}}
                                    shortcuts={SHORTCUTS}
                                    state={state}
                                />
                            </div>
                            <span style={caption}>
                                {label} {scale}x
                            </span>
                        </div>
                    ))}
                </div>
            ))}
        </div>
    )
}

/** One sample rate per tier, each in the middle of its band. */
const TIER_SAMPLES: readonly number[] = [
    30,
    (OUTPUT_SPEED_TIER_FLOORS.moderate + OUTPUT_SPEED_TIER_FLOORS.fast) / 2,
    (OUTPUT_SPEED_TIER_FLOORS.fast + OUTPUT_SPEED_TIER_FLOORS.very_fast) / 2,
    260,
]

/** A model whose output rate drifts through every tier, like a long response would. */
function useSimulatedOutputRate(): number {
    const [elapsedMs, setElapsedMs] = useState(0)
    useEffect(() => {
        const started = performance.now()
        const timer = setInterval(() => setElapsedMs(performance.now() - started), 200)
        return () => clearInterval(timer)
    }, [])
    // One sweep from 20 to 280 tokens/s and back every 16 seconds, with a little jitter.
    const phase = (elapsedMs % 16_000) / 16_000
    const sweep = phase < 0.5 ? phase * 2 : (1 - phase) * 2
    return 20 + sweep * 260 + Math.sin(elapsedMs / 350) * 6
}

/**
 * How the running task's output speed tints the button. The top row shows each
 * tier for both running states; the frame below sweeps a simulated rate
 * through all of them.
 */
function OutputSpeedTiers() {
    const rate = useSimulatedOutputRate()
    return (
        <div style={{ display: "grid", gap: 28, padding: 16 }}>
            {[RUNNING_DRAFT, RUNNING_EMPTY].map((state) => (
                <div key={state.hasContent ? "queue" : "cancel"} style={{ display: "flex", gap: 40, alignItems: "flex-end" }}>
                    {TIER_SAMPLES.map((sample) => (
                        <div key={sample} style={{ display: "grid", justifyItems: "center", gap: 8 }}>
                            <div style={{ zoom: 2 }}>
                                <ComposerActionButton
                                    onCancel={async () => {}}
                                    onSend={() => {}}
                                    outputTokensPerSecond={sample}
                                    shortcuts={SHORTCUTS}
                                    state={state}
                                />
                            </div>
                            <span style={caption}>
                                {outputSpeedTier(sample)} · {formatOutputSpeed(sample)}
                            </span>
                        </div>
                    ))}
                </div>
            ))}
            <div style={{ display: "grid", gap: 6 }}>
                <ComposerFrame label="Running task, simulated output rate" outputTokensPerSecond={rate} state={RUNNING_EMPTY} />
                <span style={caption}>
                    {formatOutputSpeed(rate)} → {outputSpeedTier(rate)}
                </span>
            </div>
        </div>
    )
}

const meta: Meta<typeof AllStates> = {
    title: "Chat/ComposerActionButton",
    component: AllStates,
}

export default meta

export const States: StoryObj<typeof AllStates> = {}

export const Glyphs: StoryObj<typeof AllStates> = { render: () => <Gallery /> }

export const OutputSpeed: StoryObj<typeof AllStates> = { render: () => <OutputSpeedTiers /> }
