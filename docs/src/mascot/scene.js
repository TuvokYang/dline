/**
 * Live, in-page rendering of the Dline mascot. The robot is drawn by
 * WebGL at the device pixel ratio with multisampling, so it stays sharp at
 * any zoom level. It runs the warm-up routine once and then rests in the
 * still pose; activating the stage replays the routine from the start. A
 * still mount skips the routine and only ever draws the still pose.
 *
 * The page never blocks on this module: it is loaded lazily through
 * lazy-mount.js, and it renders only while its container is visible.
 */
import {
	AmbientLight,
	DirectionalLight,
	HemisphereLight,
	MathUtils,
	NeutralToneMapping,
	PerspectiveCamera,
	PMREMGenerator,
	Quaternion,
	Scene,
	SRGBColorSpace,
	Vector3,
	WebGLRenderer,
} from "three"
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js"
import { addSeams, createMaterials, inlay, mulberry32 } from "./materials.js"
import { buildMascot } from "./model.js"
import { applyPose, createRig, worldPosition } from "./rig.js"
import { birdWorldPosition, PLAYBACK_DURATION, routineTime, STILL, sample } from "./routine.js"

const UP = new Vector3(0, 1, 0)
const SEAM_WIDTH = 0.75
/** Upper bound for the drawing buffer's pixel ratio; beyond this the gain is invisible. */
const MAX_PIXEL_RATIO = 3

function light(scene, renderer) {
	const pmrem = new PMREMGenerator(renderer)
	scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
	pmrem.dispose()
	// Little flat fill and a strong key light: the shell keeps its saturated
	// colours and clear shading instead of washing out to white.
	scene.environmentIntensity = 0.3
	scene.add(new HemisphereLight("#ffffff", "#6f8c96", 0.5))
	scene.add(new AmbientLight("#ffffff", 0.12))
	const key = new DirectionalLight("#fffaf2", 2.1)
	key.position.set(-300, 520, 620)
	scene.add(key)
	const fill = new DirectionalLight("#eef8ff", 0.45)
	fill.position.set(520, 200, 300)
	scene.add(fill)
}

/** The bird perches facing forward and a little outward, relative to the head. */
function perchedQuaternion(rig) {
	const head = rig.joints.head.getWorldQuaternion(new Quaternion())
	return new Quaternion().setFromAxisAngle(UP, -Math.PI / 3).premultiply(head)
}

/**
 * Mounts the mascot into `container`, which must be sized by CSS. Returns
 * `{ replay, dispose }`. With `still` the robot only shows its still pose,
 * holding up the songbird on one hand, and `replay` does nothing.
 */
export function mountMascot(container, { still = false } = {}) {
	const renderer = new WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" })
	renderer.setClearColor(0x000000, 0)
	renderer.outputColorSpace = SRGBColorSpace
	// Neutral tone mapping keeps the hues of the artwork's palette.
	renderer.toneMapping = NeutralToneMapping
	renderer.domElement.style.cssText = "display:block;width:100%;height:100%"
	container.append(renderer.domElement)

	const scene = new Scene()
	light(scene, renderer)
	const rig = createRig()
	const mascot = buildMascot(rig, createMaterials(document), document)
	inlay(mascot.root, mulberry32(7))
	inlay(mascot.bird, mulberry32(11))
	addSeams(mascot.root, SEAM_WIDTH)
	addSeams(mascot.bird, SEAM_WIDTH * 0.8)
	scene.add(mascot.root, mascot.bird, mascot.shadow)

	// A fixed vertical field of view frames the robot with room for raised arms.
	const camera = new PerspectiveCamera(18, 1, 100, 4000)
	const target = new Vector3(0, 188, 0)
	const distance = 1420
	const azimuth = MathUtils.degToRad(16)
	const elevation = MathUtils.degToRad(7)
	camera.position.set(
		distance * Math.cos(elevation) * Math.sin(azimuth),
		target.y + distance * Math.sin(elevation),
		distance * Math.cos(elevation) * Math.cos(azimuth),
	)
	camera.lookAt(target)

	function resize() {
		const { width, height } = container.getBoundingClientRect()
		if (width === 0 || height === 0) return
		renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO))
		renderer.setSize(width, height, false)
		camera.aspect = width / height
		camera.updateProjectionMatrix()
	}

	function drawStill() {
		applyPose(rig, STILL)
		mascot.update({
			t: 0.25,
			expression: "content",
			blink: 0,
			lookX: 1,
			hop: 0,
			birdPosition: worldPosition(rig, "gripL"),
			birdQuaternion: new Quaternion().setFromAxisAngle(UP, Math.PI * 0.9),
			flying: false,
		})
		renderer.render(scene, camera)
	}

	function drawRoutine(seconds) {
		const t = routineTime(seconds)
		const state = sample(t)
		applyPose(rig, state.pose)
		const { bird } = state
		const flight = new Quaternion().setFromAxisAngle(UP, Math.atan2(-bird.heading[2], bird.heading[0]))
		mascot.update({
			t,
			expression: state.expression,
			blink: state.blink,
			lookX: MathUtils.clamp(state.pose.waist.yaw / 42, -1, 1),
			hop: state.pose.hop,
			birdPosition: birdWorldPosition(rig, bird),
			birdQuaternion: perchedQuaternion(rig).slerp(flight, bird.weight),
			flying: bird.flying,
		})
		renderer.render(scene, camera)
	}

	let started = null
	let frame = 0
	let visible = true

	function tick(now) {
		frame = 0
		if (started === null) started = now
		const seconds = (now - started) / 1000
		if (seconds >= PLAYBACK_DURATION) {
			started = null
			drawStill()
			return
		}
		drawRoutine(seconds)
		if (visible) frame = requestAnimationFrame(tick)
	}

	function replay() {
		if (still) return
		started = null
		if (!frame && visible) frame = requestAnimationFrame(tick)
	}

	// Pause while the stage is off screen or the tab is hidden; resume where it left off.
	let pausedAt = null
	function setVisible(next) {
		if (next === visible) return
		visible = next
		if (!visible && frame) {
			cancelAnimationFrame(frame)
			frame = 0
			pausedAt = performance.now()
		} else if (visible && pausedAt !== null) {
			if (started !== null) started += performance.now() - pausedAt
			pausedAt = null
			if (started !== null) frame = requestAnimationFrame(tick)
		}
	}
	const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting && !document.hidden))
	observer.observe(container)
	const onVisibility = () => setVisible(!document.hidden)
	document.addEventListener("visibilitychange", onVisibility)
	const resizer = new ResizeObserver(() => {
		resize()
		if (!frame) drawStill()
	})
	resizer.observe(container)

	resize()
	if (still) drawStill()
	else replay()

	return {
		replay,
		dispose() {
			cancelAnimationFrame(frame)
			observer.disconnect()
			resizer.disconnect()
			document.removeEventListener("visibilitychange", onVisibility)
			renderer.dispose()
			renderer.domElement.remove()
		},
	}
}
