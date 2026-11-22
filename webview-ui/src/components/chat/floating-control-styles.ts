import type { CSSProperties } from "react"
import styles from "./floating-control-styles.module.css"

export const TRAJECTORY_RAIL_WIDTH_PX = 35

/** Reserve the rail width, its right inset, and an 8px gap for inline actions. */
export const FLOATING_CONTROL_LAYOUT_STYLE = {
    "--chat-trajectory-clearance": `${TRAJECTORY_RAIL_WIDTH_PX + 12}px`,
} as CSSProperties

/** One translucent surface for the trajectory and every floating action. */
export const FLOATING_CONTROL_SURFACE = "bg-background/35 backdrop-blur-sm"

/** Scroll activity reveals the group; pointer interaction and keyboard focus keep it usable. */
export const FLOATING_CONTROL_VISIBILITY = styles.visibility
