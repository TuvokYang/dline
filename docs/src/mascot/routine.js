/**
 * The mascot's warm-up routine: named poses, a keyframed timeline and a
 * sampler that resolves the full pose at any time. Pure data and math, so
 * the renderer and the tests share exactly the same motion.
 *
 * Angles are in degrees and follow human joint conventions (see rig.js):
 * the arm moves with the plane of elevation, elevation, axial twist and an
 * elbow that only flexes. Every keyframe is a full pose; consecutive
 * keyframes are joined with a cosine ease, so each keyframe is a stop and
 * motion eases in and out like a servo. A move that should not stop is
 * simply not given an intermediate keyframe.
 *
 * An arm may be posed by a fingertip target instead of angles (see
 * rig.js). Such keyframes are solved once, against their own body pose, and
 * stored as angles, so interpolation always runs on joint angles.
 */
import { CatmullRomCurve3, Vector3 } from "three"
import { applyPose, createRig, worldPosition } from "./rig.js"

/**
 * Hard joint limits. The tests assert that every sampled pose stays inside
 * them. A negative elevation in the front plane (plane 90) swings the arm
 * behind the body, like the back swing of a running arm.
 */
export const LIMITS = Object.freeze({
	arm: Object.freeze({ plane: [-45, 135], elevation: [-45, 180], twist: [-95, 95], elbow: [0, 145] }),
	leg: Object.freeze({ abduct: [-5, 30], flex: [-20, 110], knee: [0, 140] }),
	waist: Object.freeze({ yaw: [-50, 50], lean: [-25, 25], pitch: [-15, 30] }),
	neck: Object.freeze({ yaw: [-60, 60], tilt: [-25, 25], nod: [-30, 30] }),
	hop: [0, 20],
})

const ARM_REST = { plane: 14, elevation: 9, twist: 10, elbow: 16 }
const LEG_REST = { abduct: 2, flex: 0, knee: 0 }

/** Neutral standing pose; every other pose is a partial override of it. */
export const STAND = deepFreeze({
	hop: 0,
	waist: { yaw: 0, lean: 0, pitch: 0 },
	neck: { yaw: 0, tilt: 0, nod: 0 },
	armL: ARM_REST,
	armR: ARM_REST,
	legL: LEG_REST,
	legR: LEG_REST,
})

/** Arm poses, named after the exercise step they belong to. */
export const ARM = deepFreeze({
	rest: ARM_REST,
	// Chest expansion: elbows at shoulder height, fists in front of the chest.
	bentFront: { plane: 14, elevation: 86, twist: 0, elbow: 140 },
	bentBack: { plane: -24, elevation: 86, twist: 0, elbow: 140 },
	// Arms held level to the sides, and pulled back for the chest expansion.
	level: { plane: 0, elevation: 90, twist: 0, elbow: 0 },
	levelBack: { plane: -26, elevation: 90, twist: 0, elbow: 0 },
	// Side bend: one arm arcs over the head, the other hand rests on the hip.
	overhead: { plane: 6, elevation: 164, twist: -90, elbow: 42 },
	onHip: { target: [44, 117, 4], pole: [1, 0.2, -0.6] },
	// Jumping jack and deep breath.
	jackDown: { plane: 0, elevation: 10, twist: 0, elbow: 8 },
	jackUp: { plane: 0, elevation: 158, twist: -90, elbow: 8 },
	reachUp: { plane: 12, elevation: 170, twist: -90, elbow: 0 },
	forward: { plane: 88, elevation: 84, twist: 0, elbow: 0 },
	// Running: elbows bent to a right angle, the arm swinging in the front plane.
	run: { plane: 90, elevation: 0, twist: -90, elbow: 90 },
	runForward: { plane: 90, elevation: 38, twist: -90, elbow: 90 },
	runBack: { plane: 90, elevation: -32, twist: -90, elbow: 90 },
})

const LEG = deepFreeze({
	rest: LEG_REST,
	apart: { abduct: 7, flex: 0, knee: 0 },
	jackOpen: { abduct: 16, flex: 0, knee: 0 },
	squat: { abduct: 6, flex: 62, knee: 104 },
	kneeUp: { abduct: 2, flex: 60, knee: 95 },
})

const bothArms = (arm) => ({ armL: arm, armR: arm })
const bothLegs = (leg) => ({ legL: leg, legR: leg })

/** Swaps left and right, so a move defined to one side runs to the other. */
function mirror(layer) {
	const out = { ...layer, armL: layer.armR, armR: layer.armL, legL: layer.legR, legR: layer.legL }
	if (layer.waist) out.waist = { ...layer.waist, yaw: -(layer.waist.yaw ?? 0), lean: -(layer.waist.lean ?? 0) }
	if (layer.neck) out.neck = { ...layer.neck, yaw: -(layer.neck.yaw ?? 0), tilt: -(layer.neck.tilt ?? 0) }
	for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key]
	return out
}

/** Builds a full pose from STAND and partial layers; later layers win. */
export function pose(...layers) {
	const out = structuredClone(STAND)
	for (const layer of layers) {
		for (const [key, value] of Object.entries(layer)) {
			out[key] = typeof value === "object" ? { ...out[key], ...value } : value
		}
	}
	return deepFreeze(out)
}

const WIDE = bothLegs(LEG.apart)
const BEND_LEFT = { armL: ARM.onHip, armR: ARM.overhead, waist: { lean: 18 }, neck: { tilt: 7 }, ...WIDE }
/** The twist keeps the arms bent in front of the chest, so they turn with the upper body. */
const TWIST_LEFT = { ...bothArms(ARM.bentFront), ...WIDE, waist: { yaw: 42 }, neck: { yaw: 14 } }
const JACK_CLOSED = bothArms(ARM.jackDown)
const JACK_OPEN = { ...bothArms(ARM.jackUp), ...bothLegs(LEG.jackOpen) }
/** A running stride: the left knee lifts while the right arm swings forward. */
const RUN_READY = bothArms(ARM.run)
const STRIDE_LEFT = { legL: LEG.kneeUp, legR: LEG.rest, armL: ARM.runBack, armR: ARM.runForward }

/** Running in place: alternating strides, each a stop at full knee lift. */
export const RUN = Object.freeze({ start: 20.6, stride: 0.36, strides: 10, bounce: 7 })
export const strideTime = (i) => RUN.start + RUN.stride * (i + 1)
const RUNNING = Array.from({ length: RUN.strides }, (_, i) => [strideTime(i), pose(i % 2 ? mirror(STRIDE_LEFT) : STRIDE_LEFT)])
const RUN_END = strideTime(RUN.strides)

/**
 * Keyframes as [seconds, pose]. The routine:
 *   0.0 - 1.4  stand ready
 *   1.4 - 6.8  chest expansion: bent arms pull back twice, then the arms
 *              open sideways and the straight arms pull back twice
 *   6.8 - 14.0 arms bent in front of the chest while the waist twists
 *              left and right twice
 *  14.0 - 19.6 side bends: one hand on the hip, the other arm overhead
 *  19.6 - 24.6 running in place
 *  24.6 - 29.5 two jumping jacks
 *  29.5 - 34.4 deep breath with the arms overhead, then a knee bend
 *  34.4 - 35.6 stand
 */
const RAW_KEYFRAMES = [
	[0, pose()],
	[1.4, pose()],
	[2.0, pose(bothArms(ARM.bentFront), WIDE)],
	[2.6, pose(bothArms(ARM.bentBack), WIDE)],
	[3.0, pose(bothArms(ARM.bentFront), WIDE)],
	[3.6, pose(bothArms(ARM.bentBack), WIDE)],
	[4.0, pose(bothArms(ARM.bentFront), WIDE)],
	[4.8, pose(bothArms(ARM.level), WIDE)],
	[5.4, pose(bothArms(ARM.levelBack), WIDE)],
	[5.8, pose(bothArms(ARM.level), WIDE)],
	[6.4, pose(bothArms(ARM.levelBack), WIDE)],
	[6.8, pose(bothArms(ARM.level), WIDE)],
	[7.8, pose(TWIST_LEFT)],
	[8.2, pose(TWIST_LEFT)],
	[9.4, pose(mirror(TWIST_LEFT))],
	[9.8, pose(mirror(TWIST_LEFT))],
	[11.0, pose(TWIST_LEFT)],
	[11.4, pose(TWIST_LEFT)],
	[12.6, pose(mirror(TWIST_LEFT))],
	[13.0, pose(mirror(TWIST_LEFT))],
	[14.0, pose(bothArms(ARM.level), WIDE)],
	[15.2, pose(BEND_LEFT)],
	[15.8, pose(BEND_LEFT)],
	[16.8, pose(bothArms(ARM.level), WIDE)],
	[18.0, pose(mirror(BEND_LEFT))],
	[18.6, pose(mirror(BEND_LEFT))],
	[19.6, pose(bothArms(ARM.level), WIDE)],
	[RUN.start, pose(RUN_READY)],
	...RUNNING,
	[RUN_END, pose(RUN_READY)],
	[25.2, pose(JACK_CLOSED)],
	[25.4, pose(JACK_CLOSED)],
	[26.1, pose(JACK_OPEN)],
	[26.4, pose(JACK_OPEN)],
	[27.1, pose(JACK_CLOSED)],
	[27.4, pose(JACK_CLOSED)],
	[28.1, pose(JACK_OPEN)],
	[28.4, pose(JACK_OPEN)],
	[29.1, pose(JACK_CLOSED)],
	[29.5, pose()],
	[30.9, pose(bothArms(ARM.reachUp), { waist: { pitch: -6 }, neck: { nod: -12 } })],
	[31.3, pose(bothArms(ARM.reachUp), { waist: { pitch: -6 }, neck: { nod: -12 } })],
	[32.7, pose(bothArms(ARM.forward), bothLegs(LEG.squat), { waist: { pitch: 16 }, neck: { nod: -10 } })],
	[33.2, pose(bothArms(ARM.forward), bothLegs(LEG.squat), { waist: { pitch: 16 }, neck: { nod: -10 } })],
	[34.4, pose()],
	[35.6, pose()],
]

const scratch = createRig()

/** Replaces fingertip targets with the joint angles that reach them. */
function resolveTargets(p) {
	if (!p.armL.target && !p.armR.target) return p
	const { armL, armR } = applyPose(scratch, p)
	return deepFreeze({ ...p, armL, armR })
}

export const KEYFRAMES = Object.freeze(RAW_KEYFRAMES.map(([t, p]) => Object.freeze([t, resolveTargets(p)])))

export const DURATION = KEYFRAMES.at(-1)[0]

/**
 * The routine is authored at a calm, servo-like pace in routine seconds and
 * plays back this many times faster. Renderers convert wall-clock time with
 * `routineTime`; the joint tests stay in routine time.
 */
export const PLAYBACK_RATE = 2
export const PLAYBACK_DURATION = DURATION / PLAYBACK_RATE
export const routineTime = (seconds) => seconds * PLAYBACK_RATE

/**
 * Airborne phases as [start, end, height]; the hop follows a parabola. The
 * running strides float briefly between two knee lifts, the jumping jacks
 * leave the ground properly.
 */
export const JUMPS = Object.freeze([
	...Array.from({ length: RUN.strides - 1 }, (_, i) => [strideTime(i), strideTime(i + 1), RUN.bounce]),
	[25.4, 26.1, 14],
	[26.4, 27.1, 14],
	[27.4, 28.1, 14],
	[28.4, 29.1, 14],
])

/** Facial expression by time; blinks are brief closures within an expression. */
export const EXPRESSIONS = Object.freeze([
	[0, "calm"],
	[1.8, "determined"],
	[6.9, "humming"],
	[14.0, "straining"],
	[20.2, "joyful"],
	[29.6, "tired"],
	[34.4, "cheeky"],
])
export const BLINKS = Object.freeze([0.8, 4.4, 10.3, 12.1, 35.0])
const BLINK_LENGTH = 0.16

/**
 * The songbird sits on the head and flies off while the arms sweep over it
 * in the side bends. The arms move in the frontal plane, so the bird circles
 * in front of the robot, above its head. Waypoints are offsets from where
 * the bird sits when the robot stands still.
 */
export const BIRD_FLIGHT = Object.freeze({
	start: 14.05,
	end: 20.0,
	waypoints: Object.freeze([
		[0, 0, 0],
		[-4, 24, 34],
		[-40, 48, 52],
		[0, 60, 58],
		[40, 48, 52],
		[8, 24, 34],
		[0, 0, 0],
	]),
})
const FLIGHT_BLEND = 0.35
const flightCurve = new CatmullRomCurve3(
	BIRD_FLIGHT.waypoints.map(([x, y, z]) => new Vector3(x, y, z)),
	false,
	"centripetal",
)

/** Servo-like ease: zero velocity at both ends of every segment. */
const ease = (u) => 0.5 - 0.5 * Math.cos(Math.PI * u)

function lerpPose(a, b, u) {
	const out = {}
	for (const [key, value] of Object.entries(a)) {
		if (typeof value === "number") {
			out[key] = value + (b[key] - value) * u
		} else {
			out[key] = {}
			for (const [k, v] of Object.entries(value)) out[key][k] = v + (b[key][k] - v) * u
		}
	}
	return out
}

function wrap(t) {
	return ((t % DURATION) + DURATION) % DURATION
}

function hopAt(t) {
	for (const [start, end, height] of JUMPS) {
		if (t > start && t < end) {
			const u = (t - start) / (end - start)
			return 4 * height * u * (1 - u)
		}
	}
	return 0
}

function expressionAt(t) {
	let name = EXPRESSIONS[0][1]
	for (const [start, value] of EXPRESSIONS) if (t >= start) name = value
	return name
}

/** 0 = open, 1 = closed; a quick close and reopen. */
function blinkAt(t) {
	for (const start of BLINKS) {
		const u = (t - start) / BLINK_LENGTH
		if (u >= 0 && u <= 1) return Math.sin(Math.PI * u)
	}
	return 0
}

/**
 * The bird's offset from its perch and how far it is into the flight
 * (0 = perched, 1 = flying freely). Near the ends the weight ramps, so the
 * bird leaves from and lands on the moving head.
 */
export function birdAt(t) {
	const { start, end } = BIRD_FLIGHT
	if (t <= start || t >= end) return { flying: false, weight: 0, offset: [0, 0, 0], heading: [0, 0, 1] }
	const u = (t - start) / (end - start)
	const point = flightCurve.getPoint(ease(u))
	const tangent = flightCurve.getTangent(Math.min(0.999, Math.max(0.001, ease(u))))
	const edge = Math.min(t - start, end - t)
	const weight = edge >= FLIGHT_BLEND ? 1 : ease(edge / FLIGHT_BLEND)
	return { flying: true, weight, offset: point.toArray(), heading: tangent.toArray() }
}

let homePerch = null

/**
 * World position of the bird's feet for a rig already posed at time t: on
 * the perch while perched, on its flight path while flying, blended near
 * take-off and landing so it leaves from and lands on the moving head.
 */
export function birdWorldPosition(rig, bird) {
	const perch = worldPosition(rig, "perch")
	if (!bird.flying) return perch
	if (!homePerch) {
		applyPose(scratch, STAND)
		homePerch = worldPosition(scratch, "perch")
	}
	const free = homePerch.clone().add(new Vector3(...bird.offset))
	return perch.lerp(free, bird.weight)
}

/** Resolves the full pose and presentation state at time t (seconds, wraps). */
export function sample(time) {
	const t = wrap(time)
	let i = 0
	while (i < KEYFRAMES.length - 2 && KEYFRAMES[i + 1][0] <= t) i++
	const [t0, a] = KEYFRAMES[i]
	const [t1, b] = KEYFRAMES[i + 1]
	const u = t1 > t0 ? ease(Math.min(1, Math.max(0, (t - t0) / (t1 - t0)))) : 0
	const resolved = lerpPose(a, b, u)
	resolved.hop = hopAt(t)
	return {
		time: t,
		pose: resolved,
		expression: expressionAt(t),
		blink: blinkAt(t),
		bird: birdAt(t),
	}
}

/** The still mascot: holding up one hand for the songbird, head tilted toward it. */
export const STILL = pose({
	armL: { plane: 22, elevation: 100, twist: -80, elbow: 112 },
	armR: { plane: 12, elevation: 11, twist: 12, elbow: 20 },
	neck: { yaw: 14, tilt: 8, nod: -4 },
	legL: { abduct: 3, flex: 0, knee: 0 },
	legR: { abduct: 4, flex: 0, knee: 0 },
})

function deepFreeze(value) {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		for (const inner of Object.values(value)) deepFreeze(inner)
		Object.freeze(value)
	}
	return value
}
