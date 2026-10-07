/**
 * Camera planning for focused demo recordings.
 *
 * A recording declares focus keyframes in viewport coordinates. Every rendered
 * frame is cropped from the full-resolution source video, so the camera can
 * pan and zoom toward the active control without re-rendering the product UI.
 * Crops never shrink below `minWidth`, which keeps the tightest zoom at or
 * above a 1:1 source-to-output pixel ratio instead of upscaling blurry text.
 */

export const DEFAULT_FOCUS_PADDING = 32
export const DEFAULT_TRANSITION_SECONDS = 0.4

function fail(message) {
	throw new Error(`demo-camera: ${message}`)
}

function clamp(value, minimum, maximum) {
	return Math.min(Math.max(value, minimum), maximum)
}

function isFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value)
}

function assertRect(rect, label) {
	if (
		!rect ||
		!isFiniteNumber(rect.x) ||
		!isFiniteNumber(rect.y) ||
		!isFiniteNumber(rect.width) ||
		!isFiniteNumber(rect.height) ||
		rect.width <= 0 ||
		rect.height <= 0
	) {
		fail(`${label} must be a rectangle with finite coordinates and a positive size`)
	}
}

function assertPositive(value, label) {
	if (!isFiniteNumber(value) || value <= 0) fail(`${label} must be a positive number`)
}

/**
 * Symmetric cubic easing: slow start, fast middle, slow settle.
 * @param {number} progress Linear progress in [0, 1]; values outside are clamped.
 */
export function easeInOutCubic(progress) {
	const t = clamp(progress, 0, 1)
	return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
}

function interpolateFrame(from, to, amount) {
	return {
		x: from.x + (to.x - from.x) * amount,
		y: from.y + (to.y - from.y) * amount,
		width: from.width + (to.width - from.width) * amount,
		height: from.height + (to.height - from.height) * amount,
	}
}

/**
 * Fit a fixed-aspect camera frame around a focus rectangle.
 *
 * The frame is centred on the focus, grows to include padding, never becomes
 * narrower than `minWidth`, and is clamped inside `bounds`. A focus larger than
 * the bounds yields the widest frame the bounds allow.
 */
export function fitFocusFrame(focus, spec) {
	assertRect(focus, "focus")
	assertRect(spec.bounds, "bounds")
	assertPositive(spec.aspectRatio, "aspectRatio")
	assertPositive(spec.minWidth, "minWidth")
	const padding = spec.padding ?? DEFAULT_FOCUS_PADDING
	const { bounds, aspectRatio } = spec

	const maxWidth = Math.min(bounds.width, bounds.height * aspectRatio)
	const minWidth = Math.min(spec.minWidth, maxWidth)
	const neededWidth = Math.max(focus.width + padding * 2, (focus.height + padding * 2) * aspectRatio)
	const width = clamp(neededWidth, minWidth, maxWidth)
	const height = width / aspectRatio

	const centerX = focus.x + focus.width / 2
	const centerY = focus.y + focus.height / 2
	return {
		x: clamp(centerX - width / 2, bounds.x, bounds.x + bounds.width - width),
		y: clamp(centerY - height / 2, bounds.y, bounds.y + bounds.height - height),
		width,
		height,
	}
}

/**
 * Validate a manifest camera block and return it with defaults applied.
 */
export function normalizeCamera(camera) {
	if (!camera || typeof camera !== "object") fail("camera must be an object")
	assertRect(camera.bounds, "camera.bounds")
	assertPositive(camera.aspectRatio, "camera.aspectRatio")
	assertPositive(camera.minWidth, "camera.minWidth")
	const transitionSeconds = camera.transitionSeconds ?? DEFAULT_TRANSITION_SECONDS
	assertPositive(transitionSeconds, "camera.transitionSeconds")
	const padding = camera.padding ?? DEFAULT_FOCUS_PADDING
	if (!isFiniteNumber(padding) || padding < 0) fail("camera.padding must be a non-negative number")
	if (!Array.isArray(camera.keyframes) || camera.keyframes.length === 0) {
		fail("camera.keyframes must contain at least one keyframe")
	}
	const keyframes = camera.keyframes.map((keyframe, index) => {
		if (!isFiniteNumber(keyframe?.atSeconds) || keyframe.atSeconds < 0) {
			fail(`camera.keyframes[${index}].atSeconds must be a non-negative number`)
		}
		assertRect(keyframe.rect, `camera.keyframes[${index}].rect`)
		return { atSeconds: keyframe.atSeconds, rect: keyframe.rect }
	})
	return {
		bounds: camera.bounds,
		aspectRatio: camera.aspectRatio,
		minWidth: camera.minWidth,
		padding,
		transitionSeconds,
		keyframes,
	}
}

/**
 * Ease between time-ordered rectangles. Each target starts a transition from
 * wherever the track currently is, so a target that arrives before the
 * previous transition settles continues smoothly instead of jumping.
 */
function createEasedRectTrack(targets, transitionSeconds) {
	const segments = []
	const rectAt = (seconds) => {
		let active = segments[0]
		for (const segment of segments) {
			if (segment.startSeconds > seconds) break
			active = segment
		}
		const progress = (seconds - active.startSeconds) / transitionSeconds
		return interpolateFrame(active.from, active.to, easeInOutCubic(progress))
	}

	for (const [index, target] of targets.entries()) {
		const from = index === 0 ? target.rect : rectAt(target.atSeconds)
		segments.push({ startSeconds: target.atSeconds, from, to: target.rect })
	}
	return { rectAt, segments }
}

/**
 * Build a camera track that answers "which viewport rectangle is visible at t"
 * (`frameAt`) and "which control is being highlighted at t" (`focusAt`).
 */
export function createCameraTrack(camera) {
	const normalized = normalizeCamera(camera)
	const ordered = normalized.keyframes
		.map((keyframe, order) => ({ ...keyframe, order }))
		.sort((left, right) => left.atSeconds - right.atSeconds || left.order - right.order)

	const frames = createEasedRectTrack(
		ordered.map((keyframe) => ({ atSeconds: keyframe.atSeconds, rect: fitFocusFrame(keyframe.rect, normalized) })),
		normalized.transitionSeconds,
	)
	const focus = createEasedRectTrack(
		ordered.map((keyframe) => ({ atSeconds: keyframe.atSeconds, rect: keyframe.rect })),
		normalized.transitionSeconds,
	)

	return {
		frameAt: frames.rectAt,
		focusAt: focus.rectAt,
		segments: frames.segments.map((segment) => ({ ...segment })),
	}
}

/**
 * Project a viewport-space rectangle into the pixel space of a rendered frame
 * that shows `frame` scaled to `output`.
 */
export function projectRect(rect, frame, output) {
	assertRect(rect, "rect")
	assertRect(frame, "frame")
	assertPositive(output?.width, "output.width")
	assertPositive(output?.height, "output.height")
	const scaleX = output.width / frame.width
	const scaleY = output.height / frame.height
	return {
		x: (rect.x - frame.x) * scaleX,
		y: (rect.y - frame.y) * scaleY,
		width: rect.width * scaleX,
		height: rect.height * scaleY,
	}
}

/**
 * Convert a viewport-space frame into an integer crop of the recorded video.
 */
export function toSourceCrop(frame, viewport, source) {
	assertRect(frame, "frame")
	assertPositive(viewport?.width, "viewport.width")
	assertPositive(viewport?.height, "viewport.height")
	assertPositive(source?.width, "source.width")
	assertPositive(source?.height, "source.height")
	const scaleX = source.width / viewport.width
	const scaleY = source.height / viewport.height
	const left = clamp(Math.round(frame.x * scaleX), 0, source.width - 1)
	const top = clamp(Math.round(frame.y * scaleY), 0, source.height - 1)
	return {
		left,
		top,
		width: clamp(Math.round(frame.width * scaleX), 1, source.width - left),
		height: clamp(Math.round(frame.height * scaleY), 1, source.height - top),
	}
}
