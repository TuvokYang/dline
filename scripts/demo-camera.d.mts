export interface CameraRect {
	x: number
	y: number
	width: number
	height: number
}

export interface CameraSize {
	width: number
	height: number
}

export interface CameraKeyframe {
	atSeconds: number
	rect: CameraRect
}

export interface CameraSpec {
	bounds: CameraRect
	aspectRatio: number
	minWidth: number
	padding?: number
	transitionSeconds?: number
	keyframes: CameraKeyframe[]
}

export interface NormalizedCameraSpec extends Required<CameraSpec> {}

export interface CameraSegment {
	startSeconds: number
	from: CameraRect
	to: CameraRect
}

export interface CameraTrack {
	frameAt(seconds: number): CameraRect
	focusAt(seconds: number): CameraRect
	segments: CameraSegment[]
}

export interface SourceCrop {
	left: number
	top: number
	width: number
	height: number
}

export const DEFAULT_FOCUS_PADDING: number
export const DEFAULT_TRANSITION_SECONDS: number

export function easeInOutCubic(progress: number): number
export function fitFocusFrame(
	focus: CameraRect,
	spec: Pick<CameraSpec, "bounds" | "aspectRatio" | "minWidth" | "padding">,
): CameraRect
export function normalizeCamera(camera: CameraSpec): NormalizedCameraSpec
export function createCameraTrack(camera: CameraSpec): CameraTrack
export function toSourceCrop(frame: CameraRect, viewport: CameraSize, source: CameraSize): SourceCrop
export function projectRect(rect: CameraRect, frame: CameraRect, output: CameraSize): CameraRect
