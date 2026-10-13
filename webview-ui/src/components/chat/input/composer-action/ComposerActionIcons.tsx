import type { ReactNode, SVGProps } from "react"

/**
 * Icons drawn for the composer's action button.
 *
 * Each action has its own glyph so the button tells what a click will do
 * before it is pressed: send goes out now, queue appends the message to the
 * input queue of the running task, and cancel stops that task. All of them are
 * drawn at one fixed pixel size, `GLYPH_PX`, with a viewBox of the same size:
 * one grid unit is one CSS pixel and nothing is ever scaled, so the lines keep
 * their place on the pixel grid instead of blurring. The button centers the
 * glyph, so swapping them does not shift it.
 */
type IconProps = Omit<SVGProps<SVGSVGElement>, "children" | "viewBox" | "width" | "height">

/** Every glyph's drawn size in CSS pixels; `.composer-action` is the same size. */
const GLYPH_PX = 20

const STROKE = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
} as const

function Icon(props: IconProps & { children: ReactNode }) {
    return (
        <svg
            aria-hidden="true"
            focusable="false"
            height={GLYPH_PX}
            viewBox={`0 0 ${GLYPH_PX} ${GLYPH_PX}`}
            width={GLYPH_PX}
            {...props}
        />
    )
}

/*
 * One style for every glyph: outline strokes of one width inside one live area
 * of about 13px centered on the grid. The one fill is stop's small square,
 * which keeps cancel unmistakable at a glance.
 */

/** Send now: the return key's arrow, the key that sends. */
export function SendIcon(props: IconProps) {
    return (
        <Icon {...props}>
            <path d="M15.5 5v5a1.5 1.5 0 0 1-1.5 1.5H4.5M8 8l-3.5 3.5L8 15" {...STROKE} />
        </Icon>
    )
}

/** Resume: a bar the task stopped at, and the play mark that carries it on. */
export function ResumeIcon(props: IconProps) {
    return (
        <Icon {...props}>
            <path d="M4 4.75v10.5" {...STROKE} />
            <path d="M8 4.75v10.5L15.875 10Z" {...STROKE} />
        </Icon>
    )
}

/** Add to queue: the queued lines, with the send arrow joining them. */
export function QueueIcon(props: IconProps) {
    return (
        <Icon {...props}>
            <path d="M3 4.5h9M3 10h5M3 15.5h5" {...STROKE} />
            <path d="M15 16V8M12 11l3-3 3 3" {...STROKE} />
        </Icon>
    )
}

/**
 * Stop: a ring around a solid square. A 1.5px ring cannot have both edges on
 * whole pixels, so its outer edge keeps the whole-pixel radius 7 and only the
 * inner edge, at 5.5, falls between pixels (and on whole device pixels at 2x).
 * The square spans whole pixels.
 */
export function CancelIcon(props: IconProps) {
    return (
        <Icon {...props}>
            <circle cx="10" cy="10" r="6.25" {...STROKE} />
            <rect fill="currentColor" height="4" rx="0.75" width="4" x="8" y="8" />
        </Icon>
    )
}
