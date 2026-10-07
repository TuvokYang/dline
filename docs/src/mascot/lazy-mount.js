/**
 * Lazy mounting shared by every place that shows the 3D mascot. three.js is
 * large, so it is downloaded only once a layout that actually shows the
 * mascot is active. The container stays hidden otherwise, and also when
 * WebGL is unavailable, so no page depends on the mascot.
 */

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)"

/**
 * Shows the mascot in `stage` while the media query `layout` matches.
 *
 * @param {HTMLElement} stage Container sized by CSS; it starts hidden.
 * @param {string} layout Media query of the layouts that show the mascot.
 * @param {{ still?: boolean }} [options] `still` keeps the robot in its still
 *   pose; a reduced-motion preference implies it.
 * @returns {{ replay(): void }} Replays the warm-up once mounted; does nothing before.
 */
export function showMascotWhen(stage, layout, { still = false } = {}) {
	const query = window.matchMedia(layout)
	/** @type {{ replay(): void } | null} */
	let mounted = null
	let pending = false
	let unavailable = false

	async function mount() {
		pending = true
		// The stage needs its CSS size before the renderer measures it.
		stage.hidden = false
		try {
			const { mountMascot } = await import("./scene.js")
			mounted = mountMascot(stage, { still: still || window.matchMedia(REDUCED_MOTION).matches })
		} catch (error) {
			// WebGL may be unavailable; the page works without the mascot.
			console.warn("Dline mascot unavailable:", error)
			unavailable = true
		} finally {
			pending = false
		}
		// The layout may have changed while three.js was loading.
		update()
	}

	function update() {
		if (!query.matches || unavailable) {
			stage.hidden = true
		} else if (mounted) {
			stage.hidden = false
		} else if (!pending) {
			void mount()
		}
	}

	query.addEventListener("change", update)
	update()
	return { replay: () => mounted?.replay() }
}
