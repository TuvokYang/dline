import type { ReactNode, SVGProps } from "react"

type IconProps = Omit<SVGProps<SVGSVGElement>, "children" | "viewBox">

const STROKE = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
} as const

function ModeIcon({ children, ...props }: IconProps & { children: ReactNode }) {
    return (
        <svg aria-hidden="true" focusable="false" viewBox="0 0 20 20" {...props}>
            {children}
        </svg>
    )
}

/** Queued input waits in list order; the upward arrow adds it to the queue. */
export function QueueModeIcon(props: IconProps) {
    return (
        <ModeIcon {...props}>
            <path d="M3 4.5h9M3 10h5M3 15.5h5" {...STROKE} />
            <path d="M15 16V8M12 11l3-3 3 3" {...STROKE} />
        </ModeIcon>
    )
}

/** Steering input bends into the final row of the list. */
export function SteeringModeIcon(props: IconProps) {
    return (
        <ModeIcon {...props}>
            <path d="M3 4h9M3 9h9M3 14h2.5" {...STROKE} />
            <path
                d="M16.5 4.5v7.75c0 .97-.78 1.75-1.75 1.75H8M10.5 12.5L8 14l2.5 1.5"
                data-steering-insertion-arrow="true"
                {...STROKE}
            />
        </ModeIcon>
    )
}
