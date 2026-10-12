import type { ReactNode, SVGProps } from "react"

/**
 * Icons drawn for the composer's action button.
 *
 * Each action has its own glyph so the button tells what a click will do
 * before it is pressed: send goes out now, queue appends the message to the
 * input queue of the running task, and cancel stops that task. All three share
 * one 16px grid and line icon style so swapping between them does not shift
 * the button.
 */
type IconProps = Omit<SVGProps<SVGSVGElement>, "children" | "viewBox">

const STROKE = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
} as const

function Icon({ width = 16, height = 16, ...props }: IconProps & { children: ReactNode }) {
    return <svg aria-hidden="true" focusable="false" height={height} viewBox="0 0 16 16" width={width} {...props} />
}

/** Send now: one bold arrow pointing up. */
export function SendIcon(props: IconProps) {
    return (
        <Icon {...props}>
            <path d="M8 12.5v-9M4 7.5l4-4 4 4" {...STROKE} />
        </Icon>
    )
}

/** Resume: a bar the task stopped at, and the play mark that carries it on. */
export function ResumeIcon(props: IconProps) {
    return (
        <Icon {...props}>
            <path d="M3.5 3.5v9" {...STROKE} />
            <path d="M7.25 3.9v8.2a.6.6 0 0 0 .92.5l6.1-4.1a.6.6 0 0 0 0-1L8.17 3.4a.6.6 0 0 0-.92.5Z" fill="currentColor" />
        </Icon>
    )
}

/** Add to queue: the queued lines, with the send arrow joining them. */
export function QueueIcon(props: IconProps) {
    return (
        <Icon {...props}>
            <path d="M2 3.5h9M2 7.75h5M2 12h5" {...STROKE} strokeWidth={1.75} />
            <path d="M12 13.5V7.25M9.5 9.75l2.5-2.5 2.5 2.5" {...STROKE} />
        </Icon>
    )
}

/** Stop: a ring around a solid square. */
export function CancelIcon(props: IconProps) {
    return (
        <Icon {...props}>
            <circle cx="8" cy="8" fill="none" r="6.25" stroke="currentColor" strokeWidth={1.5} />
            <rect fill="currentColor" height="5" rx="1" width="5" x="5.5" y="5.5" />
        </Icon>
    )
}
