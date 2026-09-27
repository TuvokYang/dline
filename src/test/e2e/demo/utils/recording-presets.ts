/**
 * Recording presets shared by the README and documentation demos.
 *
 * Every preset keeps `camera.minWidth` equal to `outputWidth`, so the tightest zoom
 * stays at a 1:1 source-to-output pixel ratio and UI text is never upscaled.
 */

/** Documentation flows that stay inside the Dline sidebar: a 4:3 frame sized for the docs column. */
export const SIDEBAR_RECORDING = {
	crop: "sidebar",
	fps: 12,
	outputWidth: 560,
	camera: { aspectRatio: 4 / 3, minWidth: 560, spotlight: true },
} as const

/**
 * Every README GIF (rendered 1200 px wide) and documentation flows that leave the sidebar.
 * The camera may use the whole window, so a diff editor, a notebook, or a second task
 * panel stays in one continuous shot.
 */
export const WINDOW_RECORDING = {
	crop: "full",
	fps: 10,
	outputWidth: 1_200,
	camera: { aspectRatio: 16 / 9, minWidth: 1_200, spotlight: true },
} as const

/** Multi-step flows move the camera often; a short settle keeps them inside the 20 s GIF budget. */
export const STEP_SETTLE_MS = 250
