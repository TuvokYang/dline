import { describe, expect, it } from "vitest"
import {
	type CameraRect,
	type CameraSpec,
	createCameraTrack,
	easeInOutCubic,
	fitFocusFrame,
	normalizeCamera,
	projectRect,
	toSourceCrop,
} from "../../scripts/demo-camera.mjs"

const BOUNDS: CameraRect = { x: 0, y: 0, width: 1920, height: 1080 }
const FRAME_SPEC = { bounds: BOUNDS, aspectRatio: 4 / 3, minWidth: 600, padding: 32 }
const CENTER_FOCUS: CameraRect = { x: 900, y: 500, width: 40, height: 20 }
const CORNER_FOCUS: CameraRect = { x: 100, y: 900, width: 20, height: 20 }
const CENTER_FRAME: CameraRect = { x: 620, y: 285, width: 600, height: 450 }
const CORNER_FRAME: CameraRect = { x: 0, y: 630, width: 600, height: 450 }

function camera(keyframes: CameraSpec["keyframes"]): CameraSpec {
	return { ...FRAME_SPEC, transitionSeconds: 0.4, keyframes }
}

function expectFrame(actual: CameraRect, expected: CameraRect): void {
	expect(actual.x).toBeCloseTo(expected.x, 6)
	expect(actual.y).toBeCloseTo(expected.y, 6)
	expect(actual.width).toBeCloseTo(expected.width, 6)
	expect(actual.height).toBeCloseTo(expected.height, 6)
}

describe("easeInOutCubic", () => {
	it("starts at zero, settles at one, and is symmetric around the midpoint", () => {
		expect(easeInOutCubic(0)).toBe(0)
		expect(easeInOutCubic(1)).toBe(1)
		expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 10)
		expect(easeInOutCubic(0.25) + easeInOutCubic(0.75)).toBeCloseTo(1, 10)
	})

	it("clamps progress outside the unit interval", () => {
		expect(easeInOutCubic(-3)).toBe(0)
		expect(easeInOutCubic(7)).toBe(1)
	})

	it("never moves backwards", () => {
		let previous = 0
		for (let step = 1; step <= 20; step += 1) {
			const value = easeInOutCubic(step / 20)
			expect(value).toBeGreaterThanOrEqual(previous)
			previous = value
		}
	})
})

describe("fitFocusFrame", () => {
	it("centres a small focus inside a frame no narrower than minWidth", () => {
		expectFrame(fitFocusFrame(CENTER_FOCUS, FRAME_SPEC), CENTER_FRAME)
	})

	it("clamps a focus near the edge back inside the bounds", () => {
		expectFrame(fitFocusFrame(CORNER_FOCUS, FRAME_SPEC), CORNER_FRAME)
	})

	it("grows to contain a large focus with padding while keeping the aspect ratio", () => {
		const focus = { x: 200, y: 100, width: 800, height: 300 }
		const frame = fitFocusFrame(focus, FRAME_SPEC)

		expectFrame(frame, { x: 168, y: 0, width: 864, height: 648 })
		expect(frame.width / frame.height).toBeCloseTo(4 / 3, 10)
		expect(frame.x).toBeLessThanOrEqual(focus.x)
		expect(frame.x + frame.width).toBeGreaterThanOrEqual(focus.x + focus.width)
		expect(frame.y + frame.height).toBeGreaterThanOrEqual(focus.y + focus.height)
	})

	it("caps a focus larger than the bounds at the widest frame the bounds allow", () => {
		expectFrame(fitFocusFrame(BOUNDS, FRAME_SPEC), { x: 240, y: 0, width: 1440, height: 1080 })
	})

	it("rejects an empty focus rectangle", () => {
		expect(() => fitFocusFrame({ x: 0, y: 0, width: 0, height: 10 }, FRAME_SPEC)).toThrow(/focus/)
	})
})

describe("normalizeCamera", () => {
	it("applies default padding and transition timing", () => {
		const normalized = normalizeCamera({
			bounds: BOUNDS,
			aspectRatio: 16 / 9,
			minWidth: 640,
			keyframes: [{ atSeconds: 0, rect: CENTER_FOCUS }],
		})

		expect(normalized.padding).toBe(32)
		expect(normalized.transitionSeconds).toBe(0.4)
	})

	it("rejects a camera without keyframes", () => {
		expect(() => normalizeCamera(camera([]))).toThrow(/keyframes/)
	})

	it("rejects a keyframe with a negative timestamp", () => {
		expect(() => normalizeCamera(camera([{ atSeconds: -1, rect: CENTER_FOCUS }]))).toThrow(/atSeconds/)
	})
})

describe("createCameraTrack", () => {
	it("holds the first framing, eases toward the next focus, then settles on it", () => {
		const track = createCameraTrack(
			camera([
				{ atSeconds: 0, rect: CENTER_FOCUS },
				{ atSeconds: 2, rect: CORNER_FOCUS },
			]),
		)

		expectFrame(track.frameAt(-1), CENTER_FRAME)
		expectFrame(track.frameAt(0), CENTER_FRAME)
		expectFrame(track.frameAt(1.9), CENTER_FRAME)
		expectFrame(track.frameAt(2), CENTER_FRAME)
		expectFrame(track.frameAt(2.2), { x: 310, y: 457.5, width: 600, height: 450 })
		expectFrame(track.frameAt(2.4), CORNER_FRAME)
		expectFrame(track.frameAt(10), CORNER_FRAME)
	})

	it("continues an interrupted pan from the current position instead of jumping", () => {
		const track = createCameraTrack(
			camera([
				{ atSeconds: 0, rect: CENTER_FOCUS },
				{ atSeconds: 1, rect: CORNER_FOCUS },
				{ atSeconds: 1.2, rect: CENTER_FOCUS },
			]),
		)
		const interruptedAt = { x: 310, y: 457.5, width: 600, height: 450 }

		expectFrame(track.segments[2].from, interruptedAt)
		expectFrame(track.frameAt(1.2), interruptedAt)
		expectFrame(track.frameAt(1.6), CENTER_FRAME)
	})

	it("orders keyframes by time regardless of declaration order", () => {
		const track = createCameraTrack(
			camera([
				{ atSeconds: 2, rect: CORNER_FOCUS },
				{ atSeconds: 0, rect: CENTER_FOCUS },
			]),
		)

		expectFrame(track.frameAt(0.5), CENTER_FRAME)
		expectFrame(track.frameAt(3), CORNER_FRAME)
	})
})

describe("toSourceCrop", () => {
	it("maps viewport coordinates onto an equally sized recording", () => {
		expect(toSourceCrop(CENTER_FRAME, BOUNDS, BOUNDS)).toEqual({ left: 620, top: 285, width: 600, height: 450 })
	})

	it("scales coordinates when the recording is smaller than the viewport", () => {
		expect(toSourceCrop(CENTER_FRAME, BOUNDS, { width: 960, height: 540 })).toEqual({
			left: 310,
			top: 143,
			width: 300,
			height: 225,
		})
	})

	it("clips a crop that would extend past the recorded frame", () => {
		expect(toSourceCrop({ x: 1800, y: 1000, width: 600, height: 450 }, BOUNDS, BOUNDS)).toEqual({
			left: 1800,
			top: 1000,
			width: 120,
			height: 80,
		})
	})
})

describe("focus highlighting", () => {
	it("eases the highlighted control between focus targets on the same timeline as the camera", () => {
		const track = createCameraTrack(
			camera([
				{ atSeconds: 0, rect: CENTER_FOCUS },
				{ atSeconds: 2, rect: CORNER_FOCUS },
			]),
		)

		expectFrame(track.focusAt(1), CENTER_FOCUS)
		expectFrame(track.focusAt(2.2), { x: 500, y: 700, width: 30, height: 20 })
		expectFrame(track.focusAt(3), CORNER_FOCUS)
	})

	it("projects a focused control into the pixels of a zoomed output frame", () => {
		expectFrame(projectRect(CENTER_FOCUS, CENTER_FRAME, { width: 1200, height: 900 }), {
			x: 560,
			y: 430,
			width: 80,
			height: 40,
		})
	})

	it("rejects an output frame without a positive size", () => {
		expect(() => projectRect(CENTER_FOCUS, CENTER_FRAME, { width: 0, height: 900 })).toThrow(/output.width/)
	})
})
