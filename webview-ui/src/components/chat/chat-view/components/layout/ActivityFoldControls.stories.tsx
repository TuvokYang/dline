import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { cn } from "@/lib/utils"

/**
 * Design preview for the bulk activity-fold control.
 *
 * This file is a proposal, not the production implementation: it draws the
 * current two-button toolbar and the proposed single floating button against
 * the same chat stack, so the overlap can be judged side by side.
 */

/** Stands in for StickyUserMessage so the preview needs no task state. */
function PreviewStickyMessage({ text }: { text: string }) {
    return (
        <button
            aria-label={`Scroll to your message: ${text}`}
            className={cn(
                "pointer-events-auto relative flex w-full items-center px-2.5 pt-2 pb-2 cursor-pointer select-none",
                "backdrop-blur-sm border-0 text-left hover:brightness-110",
            )}
            style={{ backgroundColor: "var(--vscode-badge-background)", borderRadius: "3px" }}
            type="button">
            <div className="flex-1 min-w-0 text-sm text-badge-foreground overflow-hidden text-ellipsis whitespace-nowrap">
                {text}
            </div>
        </button>
    )
}

/** A few folded activity rows, enough to see what the controls act on. */
function PreviewFold({ label, members, open }: { label: string; members: number; open: boolean }) {
    return (
        <div className="mb-2 rounded-sm border border-(--vscode-panel-border) bg-(--vscode-editor-background)">
            <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs">
                <span className={cn("codicon text-[11px]", open ? "codicon-chevron-down" : "codicon-chevron-right")} />
                <span className="font-medium">{label}</span>
                <span className="text-description">{members} steps</span>
            </div>
            {open && (
                <div className="border-t border-(--vscode-panel-border) px-3 py-1.5 text-xs text-description">
                    {Array.from({ length: members }, (_, index) => (
                        <div className="py-0.5" key={index}>
                            step {index + 1}
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}

/** Shared frame so every panel is the same size and clips the same way. */
function Panel({ children }: { children: React.ReactNode }) {
    return (
        <div
            className="relative overflow-hidden rounded-sm border border-(--vscode-panel-border) bg-(--vscode-editor-background)"
            style={{ height: 240 }}>
            {children}
        </div>
    )
}

/** A fold list, with room reserved at the top for whatever overlays it. */
function FoldList({ open, topPadding }: { open: boolean; topPadding: number }) {
    return (
        <div className="overflow-hidden px-3" style={{ paddingTop: topPadding }}>
            <PreviewFold label="Turn 1 · read and edit" members={4} open={open} />
            <PreviewFold label="Turn 2 · run tests" members={6} open={open} />
            <PreviewFold label="Turn 3 · provider wiring" members={3} open={open} />
        </div>
    )
}

/**
 * The current shape: a text toolbar in normal flow, with an absolutely
 * positioned sticky message starting at the same top edge.
 *
 * `stickyVisible=false` shows the toolbar on its own; `true` reproduces the
 * collision that hides it.
 */
function CurrentControls({ stickyVisible }: { stickyVisible: boolean }) {
    return (
        <Panel>
            <div className="flex shrink-0 justify-end gap-3 px-4 py-1 text-xs text-description">
                <button className="border-0 bg-transparent p-0 cursor-pointer" type="button">
                    Expand all activity
                </button>
                <button className="border-0 bg-transparent p-0 cursor-pointer" type="button">
                    Collapse all activity
                </button>
            </div>
            <FoldList open={false} topPadding={4} />
            {stickyVisible && (
                <div className="pointer-events-none absolute top-0 left-0 right-0 z-10 bg-background px-3 pt-0 pb-2">
                    <PreviewStickyMessage text="Show me the folded activity in this turn and why the header was cut off" />
                </div>
            )}
        </Panel>
    )
}

/**
 * The proposal: one circular button in the floating control column, below the
 * existing scroll button, switching action with fold state.
 */
function ProposedControl({ initialExpanded }: { initialExpanded: boolean }) {
    const [expanded, setExpanded] = useState(initialExpanded)
    const label = expanded ? "Collapse all activity" : "Expand all activity"
    return (
        <Panel>
            {/* No in-flow toolbar: the top edge belongs to the sticky message alone. */}
            <div className="pointer-events-none absolute top-0 left-0 right-0 z-10 bg-background px-3 pb-2">
                <PreviewStickyMessage text="Show me the folded activity in this turn and why the header was cut off" />
            </div>
            <FoldList open={expanded} topPadding={48} />
            <div className="absolute bottom-3 right-3 z-20 flex flex-col items-center gap-2">
                <button
                    aria-label={label}
                    className={cn(
                        "w-9 h-9 rounded-full flex items-center justify-center cursor-pointer",
                        "border border-(--vscode-panel-border) bg-(--vscode-button-secondaryBackground) text-(--vscode-button-secondaryForeground)",
                        "shadow-md transition-all duration-200",
                        "hover:brightness-125 hover:shadow-lg hover:scale-105 active:scale-95",
                    )}
                    onClick={() => setExpanded((current) => !current)}
                    title={label}
                    type="button">
                    <span className={cn("codicon text-sm", expanded ? "codicon-fold" : "codicon-unfold")} />
                </button>
                <button
                    aria-label="Scroll to bottom"
                    className={cn(
                        "w-9 h-9 rounded-full flex items-center justify-center cursor-pointer",
                        "border border-(--vscode-panel-border) bg-(--vscode-button-secondaryBackground) text-(--vscode-button-secondaryForeground)",
                        "shadow-md transition-all duration-200",
                        "hover:brightness-125 hover:shadow-lg hover:scale-105 active:scale-95",
                    )}
                    title="Scroll to bottom"
                    type="button">
                    <span className="codicon codicon-chevron-down text-sm" />
                </button>
            </div>
        </Panel>
    )
}

/**
 * One complete proposal: the glyph pair plus the button shape and copy it needs.
 *
 * The picker below draws every proposal at real size, in both states, so the
 * set can be chosen without a second round of questions.
 */
type Design = {
    readonly id: string
    readonly name: string
    readonly shape: "circle" | "pill"
    readonly folded: string
    readonly open: string
    readonly why: string
}

const DESIGNS: readonly Design[] = [
    {
        id: "A",
        name: "Tree ⇄ flat",
        shape: "circle",
        folded: "codicon-list-tree",
        open: "codicon-list-flat",
        why: "A tree while blocks are nested, a flat list once everything is open. Says what changes, not which direction.",
    },
    {
        id: "B",
        name: "Double arrow",
        shape: "circle",
        folded: "codicon-arrow-small-down",
        open: "codicon-arrow-small-up",
        why: "Everything spreads downwards, or gathers upwards. Reads clearly at 16px but shares the scroll button's vocabulary.",
    },
    {
        id: "C",
        name: "Layers",
        shape: "circle",
        folded: "codicon-layers",
        open: "codicon-layers-active",
        why: "A stack of blocks, lit when open. Compact and unambiguous as an object, weaker as an action.",
    },
    {
        id: "D",
        name: "Counted pill",
        shape: "pill",
        folded: "codicon-list-tree",
        open: "codicon-list-flat",
        why: 'Carries the number: "3 folded" tells you what will happen and how much. Widest, but needs no legend.',
    },
    {
        id: "E",
        name: "Eye ⇄ eye-closed",
        shape: "circle",
        folded: "codicon-eye-closed",
        open: "codicon-eye",
        why: "Hide or reveal the activity. Very legible, but collides with the meaning of a visibility toggle.",
    },
]

/** The proposal's button, drawn at the size it would ship. */
function DesignButton({ design, expanded, foldedCount }: { design: Design; expanded: boolean; foldedCount: number }) {
    const glyph = expanded ? design.open : design.folded
    const label = expanded ? "Collapse all activity" : "Expand all activity"
    if (design.shape === "pill") {
        return (
            <span
                className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs",
                    "border border-(--vscode-panel-border) bg-(--vscode-button-secondaryBackground) text-(--vscode-button-secondaryForeground)",
                )}>
                <span className={cn("codicon text-xs", glyph)} />
                {expanded ? "Collapse all" : `${foldedCount} folded`}
            </span>
        )
    }
    return (
        <span
            aria-label={label}
            className={cn(
                "w-9 h-9 rounded-full flex items-center justify-center",
                "border border-(--vscode-panel-border) bg-(--vscode-button-secondaryBackground) text-(--vscode-button-secondaryForeground)",
            )}>
            <span className={cn("codicon text-sm", glyph)} />
        </span>
    )
}

/**
 * Measures the two glyphs in the browser instead of guessing from the font.
 *
 * `list-tree` and `list-flat` are drawn from different shapes, so their ink is
 * not the same width even at the same font size. This reports the rendered
 * boxes so the chosen pair can be normalized with a per-glyph transform.
 */
function GlyphMeasure() {
    const [boxes, setBoxes] = useState<Record<string, { w: number; h: number }>>({})
    const glyphs = [
        { key: "tree", glyph: "codicon-list-tree" },
        { key: "flat", glyph: "codicon-list-flat" },
    ]

    return (
        <div className="flex flex-col gap-3 p-4" style={{ maxWidth: 640 }}>
            <div className="text-xs text-description">
                Ink box of each glyph at {16}px, measured after layout. Equal width is what "open the same length" needs.
            </div>
            {glyphs.map(({ key, glyph }) => {
                const box = boxes[key]
                return (
                    <div className="flex items-center gap-4" key={key}>
                        <span
                            className={cn(
                                "relative grid h-12 w-24 place-items-center rounded-sm border border-(--vscode-panel-border)",
                            )}>
                            <span
                                className={cn("codicon text-base leading-none", glyph)}
                                ref={(node) => {
                                    if (!node) return
                                    const rect = node.getBoundingClientRect()
                                    setBoxes((current) =>
                                        current[key]
                                            ? current
                                            : { ...current, [key]: { w: Math.round(rect.width), h: Math.round(rect.height) } },
                                    )
                                }}
                            />
                        </span>
                        <span className="text-xs">
                            {glyph} — {box ? `${box.w}×${box.h}px` : "measuring…"}
                        </span>
                    </div>
                )
            })}
        </div>
    )
}

/**
 * Design A with its two states normalized.
 *
 * Both glyphs render inside the same 16x16 em box, but `list-flat` draws its
 * rules across the full box while `list-tree` indents them, so at equal font
 * size the open state looks longer. `list-flat` is scaled horizontally to match
 * the tree's ink, and both are locked to one box so the button does not resize
 * when the action flips.
 */
function TreeFlatAligned({ expanded }: { expanded: boolean }) {
    return (
        <span
            className={cn(
                "grid w-9 h-9 place-items-center rounded-full",
                "border border-(--vscode-panel-border) bg-(--vscode-button-secondaryBackground) text-(--vscode-button-secondaryForeground)",
            )}>
            <span className="grid h-4 w-4 place-items-center overflow-hidden">
                <span
                    className={cn("codicon text-sm leading-none", expanded ? "codicon-list-flat" : "codicon-list-tree")}
                    style={{ transform: expanded ? "scaleX(0.86)" : undefined }}
                />
            </span>
        </span>
    )
}

/** Design A as it reads straight from the font, for comparison. */
function TreeFlatRaw({ expanded }: { expanded: boolean }) {
    return (
        <span
            className={cn(
                "grid w-9 h-9 place-items-center rounded-full",
                "border border-(--vscode-panel-border) bg-(--vscode-button-secondaryBackground) text-(--vscode-button-secondaryForeground)",
            )}>
            <span className={cn("codicon text-sm leading-none", expanded ? "codicon-list-flat" : "codicon-list-tree")} />
        </span>
    )
}

function AlignedPicker() {
    const states = [
        { key: "folded", expanded: false },
        { key: "open", expanded: true },
    ]
    return (
        <div className="flex flex-col gap-4 p-4" style={{ maxWidth: 660 }}>
            <div className="text-xs text-description">
                Design A. Top row is the raw font so the mismatch is visible; bottom row is the normalized pair where both states
                occupy the same ink width. Pick raw or aligned.
            </div>
            {[
                { title: "Raw font", render: TreeFlatRaw },
                { title: "Aligned (scaleX 0.86 on the flat glyph)", render: TreeFlatAligned },
            ].map(({ title, render: Cell }) => (
                <div className="flex flex-col gap-1.5" key={title}>
                    <span className="text-xs font-semibold">{title}</span>
                    <div className="flex gap-3">
                        {states.map((state) => (
                            <div className="flex flex-col items-center gap-1" key={state.key}>
                                <Cell expanded={state.expanded} />
                                <span className="text-[10px] text-description">{state.key}</span>
                            </div>
                        ))}
                        {/* Side by side, as they would appear one after another. */}
                        <div className="ml-2 flex items-center gap-1 rounded-sm border border-dashed border-(--vscode-panel-border) px-2">
                            <Cell expanded={false} />
                            <span className="text-description">→</span>
                            <Cell expanded />
                        </div>
                    </div>
                </div>
            ))}
        </div>
    )
}

/** Visibility models for the floating control, drawn in place. */
type VisibilityMode = "always" | "idle-dim" | "chat-hover" | "on-hover" | "on-scroll"

const VISIBILITY_MODES: ReadonlyArray<{ id: VisibilityMode; name: string; rest: string; active: string; why: string }> = [
    {
        id: "always",
        name: "Always on",
        rest: "opacity-100",
        active: "opacity-100",
        why: "Never disappears. Strongest discoverability, but a permanent mark on the conversation.",
    },
    {
        id: "idle-dim",
        name: "Always on, dims when idle",
        rest: "opacity-40",
        active: "opacity-100",
        why: "Same as the existing scroll button: stays in place and clickable, only loses prominence. Nothing is ever hidden.",
    },
    {
        id: "chat-hover",
        name: "When the pointer is anywhere over the chat",
        rest: "opacity-0",
        active: "opacity-100",
        why: "Any pointer over the message area reveals it, so discovery is solved: the whole conversation is the target. Still unreachable by touch and keyboard until something else opens it.",
    },
    {
        id: "on-hover",
        name: "Only on hover over the button",
        rest: "opacity-0",
        active: "opacity-100",
        why: "Clean when reading, but there is nothing to hover when it is invisible, and touch or keyboard cannot reach it.",
    },
    {
        id: "on-scroll",
        name: "Only while scrolling",
        rest: "opacity-0",
        active: "opacity-100",
        why: "Appears on movement only. It vanishes exactly when the reader stops to look at the content the button would fold.",
    },
]

function VisibilityButton({ rest, hovered }: { rest: string; hovered: boolean }) {
    return (
        <span
            className={cn(
                "flex w-9 h-9 items-center justify-center rounded-full transition-opacity duration-300",
                "border border-(--vscode-panel-border) bg-(--vscode-button-secondaryBackground) text-(--vscode-button-secondaryForeground)",
                hovered ? "opacity-100" : rest,
            )}>
            <span className="codicon codicon-list-tree text-sm" />
        </span>
    )
}

function VisibilityPicker() {
    return (
        <div className="flex flex-col gap-3 p-4" style={{ maxWidth: 660 }}>
            <div className="text-xs text-description">
                The control sits above the scroll button. Left of each pair is the resting state, right is the state while the
                pointer is over it or the list is moving.
            </div>
            {VISIBILITY_MODES.map((mode) => (
                <div
                    className="flex items-start gap-4 rounded-sm border border-(--vscode-panel-border) px-3 py-2.5"
                    key={mode.id}>
                    <div className="flex shrink-0 gap-3">
                        {[false, true].map((hovered) => (
                            <div className="flex flex-col items-center gap-1" key={String(hovered)}>
                                <div className="grid h-16 w-16 place-items-center rounded-sm bg-(--vscode-editor-background)">
                                    <VisibilityButton hovered={hovered} rest={mode.rest} />
                                </div>
                                <span className="text-[10px] text-description">{hovered ? "active" : "resting"}</span>
                            </div>
                        ))}
                    </div>
                    <div className="flex min-w-0 flex-col">
                        <span className="text-xs font-semibold">{mode.name}</span>
                        <span className="text-[11px] leading-snug text-description">{mode.why}</span>
                    </div>
                </div>
            ))}
        </div>
    )
}

function IconPicker() {
    return (
        <div className="flex flex-col gap-3 p-4" style={{ maxWidth: 640 }}>
            <div className="text-xs text-description">
                Five complete proposals. Left: the state with three folded blocks (tap to expand). Right: the state with
                everything open (tap to fold). Pick a letter.
            </div>
            {DESIGNS.map((design) => (
                <div
                    className="flex items-start gap-4 rounded-sm border border-(--vscode-panel-border) px-3 py-2.5"
                    key={design.id}>
                    <div className="flex shrink-0 items-center gap-3">
                        {[false, true].map((expanded) => (
                            <div className="flex flex-col items-center gap-1" key={String(expanded)}>
                                <DesignButton design={design} expanded={expanded} foldedCount={3} />
                                <span className="text-[10px] text-description">{expanded ? "open" : "folded"}</span>
                            </div>
                        ))}
                    </div>
                    <div className="flex min-w-0 flex-col">
                        <span className="text-xs font-semibold">
                            {design.id} · {design.name}
                        </span>
                        <span className="text-[11px] leading-snug text-description">{design.why}</span>
                    </div>
                </div>
            ))}
        </div>
    )
}

function Labelled({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-1.5" style={{ width: "100%", maxWidth: 560 }}>
            <div className="text-xs font-semibold">{title}</div>
            {children}
            <div className="text-[11px] leading-snug text-description">{note}</div>
        </div>
    )
}

function ThreeStates() {
    return (
        <div className="flex flex-col gap-5 p-4" style={{ maxWidth: 620 }}>
            <Labelled
                note="Baseline: the toolbar is visible only while no user message is pinned."
                title="A · Current, no sticky message">
                <CurrentControls stickyVisible={false} />
            </Labelled>
            <Labelled
                note="Same code, scrolled: the sticky message starts at the same top edge with z-10 and hides the toolbar. This is the reported bug."
                title="B · Current, sticky message pinned (the bug)">
                <CurrentControls stickyVisible />
            </Labelled>
            <Labelled
                note="One button in the floating column, below the scroll button. Action switches with fold state: expand when something is folded, collapse when everything is open."
                title="C · Proposed, one floating button">
                <ProposedControl initialExpanded={false} />
            </Labelled>
        </div>
    )
}

const meta = {
    title: "Chat/Activity Fold Controls",
    component: ThreeStates,
    parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ThreeStates>

export default meta
type Story = StoryObj<typeof meta>

export const ThreeStatesStory: Story = { name: "1 · A/B/C comparison" }

export const ProposedOnly: Story = {
    name: "2 · Proposed only",
    render: () => (
        <div className="p-4" style={{ maxWidth: 580 }}>
            <ProposedControl initialExpanded={false} />
        </div>
    ),
}

export const VisibilityOptions: Story = {
    name: "7 · Visibility models",
    render: () => <VisibilityPicker />,
}

export const AlignedTreeFlat: Story = {
    name: "6 · Design A raw vs aligned",
    render: () => <AlignedPicker />,
}

export const GlyphBoxes: Story = {
    name: "5 · Glyph ink boxes",
    render: () => <GlyphMeasure />,
}

export const IconOptions: Story = {
    name: "4 · Five button designs",
    render: () => <IconPicker />,
}

export const ProposedExpanded: Story = {
    name: "3 · Proposed, everything open (collapse icon)",
    render: () => (
        <div className="p-4" style={{ maxWidth: 580 }}>
            <ProposedControl initialExpanded />
        </div>
    ),
}
