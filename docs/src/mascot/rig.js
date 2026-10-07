/**
 * Skeleton of the Dline mascot, shared by the renderer and the tests.
 *
 * Units follow the original 2D artwork (1 unit = 1 px of the first robot
 * drawing). The ground is y = 0, the robot faces +z and its left side is +x
 * (the viewer's right). Every degree of freedom is its own Object3D, so one
 * pose parameter maps to exactly one rotation, and forward kinematics runs
 * in Node as well as in the browser.
 */
import { Euler, MathUtils, Object3D, Quaternion, Vector3 } from "three"

const DEG = MathUtils.DEG2RAD
const RAD = MathUtils.RAD2DEG

/** Body measurements. Joint positions are relative to the parent joint. */
export const DIM = Object.freeze({
	hip: Object.freeze({ x: 19, y: 111 }),
	thigh: 37,
	shin: 50.5,
	ankleToSole: 23.5,
	footLength: 46,
	heel: 14,
	waist: Object.freeze({ y: 131 }),
	shoulder: Object.freeze({ x: 58, y: 76 }),
	/**
	 * Ball-and-socket shoulder. A round cup fixed to the torso opens outward
	 * and reaches `cupOpening` degrees around the ball from its inner pole.
	 * Seen from the joint centre across the cup's radius band, the upper arm
	 * spans at most `armHalfAngle` degrees around its own axis, so the arm
	 * clears the cup while the angle between the arm and the inner pole
	 * exceeds their sum.
	 */
	shoulderJoint: Object.freeze({ ball: 12, cupOuter: 16, cupInner: 12.8, cupOpening: 44, armHalfAngle: 42 }),
	upperArm: 46,
	palm: 50,
	fingertips: 66,
	grip: 70,
	neck: Object.freeze({ y: 96 }),
	perch: Object.freeze({ x: 18, y: 64, z: 4 }),
	/**
	 * Solid volumes the limbs must stay out of: the chest and the abdomen in
	 * the chest frame, the head (with its ear brackets) in the head frame
	 * and the pelvis with the hip plates in the root frame.
	 */
	solids: Object.freeze({
		chest: Object.freeze({ joint: "chest", min: Object.freeze([-42, 22, -24]), max: Object.freeze([42, 90, 32]) }),
		abdomen: Object.freeze({ joint: "chest", min: Object.freeze([-28, 0, -20]), max: Object.freeze([28, 30, 30]) }),
		head: Object.freeze({ joint: "head", min: Object.freeze([-47, 5, -27]), max: Object.freeze([47, 63, 32]) }),
		pelvis: Object.freeze({ joint: "root", min: Object.freeze([-38, 100, -18]), max: Object.freeze([38, 124, 18]) }),
	}),
})

/** The robot's left side is +x; the right side mirrors it. */
export const SIDES = Object.freeze([Object.freeze({ key: "L", sign: 1 }), Object.freeze({ key: "R", sign: -1 })])

/**
 * Builds the joint hierarchy.
 *
 * Legs: hip (abduction) > thigh (flexion) > knee > ankle (flexion) > foot
 * (roll). Arms use the usual shoulder angles: shoulder (plane of
 * elevation) > armRaise (elevation) > upperArm (axial twist) > elbow
 * (hinge) > forearm, which only carries the hand. The upper body:
 * waist (yaw) > waistLean > chest (pitch) > neck (yaw) > neckTilt > head
 * (nod). Markers without children locate soles, palms, fingertips, the
 * bird's grip on each hand and its perch on the head.
 */
export function createRig() {
	const joints = {}
	const add = (name, parent, [x, y, z] = [0, 0, 0]) => {
		const joint = new Object3D()
		joint.name = name
		joint.position.set(x, y, z)
		parent?.add(joint)
		joints[name] = joint
		return joint
	}

	const root = add("root", null)
	for (const { key, sign } of SIDES) {
		const hip = add(`hip${key}`, root, [sign * DIM.hip.x, DIM.hip.y, 0])
		const thigh = add(`thigh${key}`, hip)
		const knee = add(`knee${key}`, thigh, [0, -DIM.thigh, 0])
		const ankle = add(`ankle${key}`, knee, [0, -DIM.shin, 0])
		const foot = add(`foot${key}`, ankle)
		add(`sole${key}`, foot, [0, -DIM.ankleToSole, DIM.footLength / 2 - DIM.heel])
	}

	const waist = add("waist", root, [0, DIM.waist.y, 0])
	const waistLean = add("waistLean", waist)
	const chest = add("chest", waistLean)
	for (const { key, sign } of SIDES) {
		const shoulder = add(`shoulder${key}`, chest, [sign * DIM.shoulder.x, DIM.shoulder.y, 0])
		const armRaise = add(`armRaise${key}`, shoulder)
		const upperArm = add(`upperArm${key}`, armRaise)
		const elbow = add(`elbow${key}`, upperArm, [0, -DIM.upperArm, 0])
		const forearm = add(`forearm${key}`, elbow)
		add(`palm${key}`, forearm, [0, -DIM.palm, 0])
		add(`fingertips${key}`, forearm, [0, -DIM.fingertips, 0])
		add(`grip${key}`, forearm, [0, -DIM.grip, 0])
	}

	const neck = add("neck", chest, [0, DIM.neck.y, 0])
	const neckTilt = add("neckTilt", neck)
	const head = add("head", neckTilt)
	add("perch", head, [DIM.perch.x, DIM.perch.y, DIM.perch.z])

	return { root, joints }
}

/**
 * Sets every joint from a pose (see routine.js), moves the root so the feet
 * rest on the ground lifted by `pose.hop`, and returns the resolved arm
 * angles.
 *
 * Signs are chosen so each parameter means the same on both sides. Arm
 * `elevation` lifts the arm from hanging (0) to overhead (180) within the
 * plane given by `plane`: 0 is the side plane, 90 the front, negative
 * values reach behind. A positive `twist` rotates the upper arm inward, so
 * the bent elbow folds the forearm across the body; a negative twist lets
 * a raised arm fold over the head. `elbow` only flexes. A positive waist
 * `yaw` turns the chest toward the robot's left, a positive `lean` or neck
 * `tilt` bends to the left, and a positive `pitch` or `nod` bends forward.
 *
 * An arm may instead give a `target` for its fingertips and a `pole`
 * direction for its elbow, both in the root frame with x measured outward
 * from the midline, so the same values work for either side. The arm is
 * then solved with two-bone inverse kinematics after the body is placed,
 * which keeps a hand on the hip while the waist bends.
 */
export function applyPose(rig, pose) {
	const j = rig.joints
	for (const { key, sign } of SIDES) {
		const leg = pose[`leg${key}`]
		j[`hip${key}`].rotation.z = sign * leg.abduct * DEG
		j[`thigh${key}`].rotation.x = -leg.flex * DEG
		j[`knee${key}`].rotation.x = leg.knee * DEG
		// The ankle cancels everything above it, so the soles stay flat.
		j[`ankle${key}`].rotation.x = (leg.flex - leg.knee) * DEG
		j[`foot${key}`].rotation.z = -sign * leg.abduct * DEG
	}
	j.waist.rotation.y = pose.waist.yaw * DEG
	j.waistLean.rotation.z = -pose.waist.lean * DEG
	j.chest.rotation.x = pose.waist.pitch * DEG
	j.neck.rotation.y = pose.neck.yaw * DEG
	j.neckTilt.rotation.z = -pose.neck.tilt * DEG
	j.head.rotation.x = pose.neck.nod * DEG

	const arms = {}
	for (const { key } of SIDES) {
		const arm = pose[`arm${key}`]
		if (!arm.target) arms[key] = setArm(rig, key, arm)
	}
	groundFeet(rig, pose.hop)
	for (const { key } of SIDES) {
		const arm = pose[`arm${key}`]
		if (arm.target) arms[key] = setArm(rig, key, solveArm(rig, key, arm))
	}
	rig.root.updateMatrixWorld(true)
	return { armL: arms.L, armR: arms.R }
}

function setArm(rig, key, arm) {
	const j = rig.joints
	const sign = key === "L" ? 1 : -1
	j[`shoulder${key}`].rotation.y = -sign * arm.plane * DEG
	j[`armRaise${key}`].rotation.z = sign * arm.elevation * DEG
	j[`upperArm${key}`].rotation.y = -sign * arm.twist * DEG
	j[`elbow${key}`].rotation.x = -arm.elbow * DEG
	return { plane: arm.plane, elevation: arm.elevation, twist: arm.twist, elbow: arm.elbow }
}

const FOREARM_REACH = DIM.fingertips

/**
 * Two-bone IK in the chest frame, where the shoulder lives. The elbow lies
 * on the circle of reachable positions, on the side the pole points to; the
 * result is converted back into the four arm angles.
 */
function solveArm(rig, key, { target, pole }) {
	const sign = key === "L" ? 1 : -1
	const chest = rig.joints.chest
	const toChest = chest.getWorldQuaternion(new Quaternion()).invert()
	const shoulder = new Vector3(sign * DIM.shoulder.x, DIM.shoulder.y, 0)
	const goal = chest.worldToLocal(rig.root.localToWorld(new Vector3(sign * target[0], target[1], target[2])))
	const hint = new Vector3(sign * pole[0], pole[1], pole[2]).applyQuaternion(toChest)

	const toGoal = goal.clone().sub(shoulder)
	const reach = MathUtils.clamp(
		toGoal.length(),
		Math.abs(DIM.upperArm - FOREARM_REACH) + 1e-3,
		DIM.upperArm + FOREARM_REACH - 1e-3,
	)
	const axis = toGoal.normalize()
	const along = (DIM.upperArm ** 2 + reach ** 2 - FOREARM_REACH ** 2) / (2 * reach)
	const out = Math.sqrt(Math.max(0, DIM.upperArm ** 2 - along ** 2))
	const bend = hint.sub(axis.clone().multiplyScalar(hint.dot(axis))).normalize()
	const elbow = shoulder.clone().addScaledVector(axis, along).addScaledVector(bend, out)
	const hand = shoulder.clone().addScaledVector(axis, reach)

	const upper = elbow.clone().sub(shoulder).normalize()
	const lower = hand.clone().sub(elbow).normalize()
	const elevation = Math.acos(MathUtils.clamp(-upper.y, -1, 1))
	const plane = Math.atan2(upper.z, sign * upper.x)
	const frame = new Quaternion()
		.setFromEuler(new Euler(0, -sign * plane, 0))
		.multiply(new Quaternion().setFromEuler(new Euler(0, 0, sign * elevation)))
	const flexDir = lower.clone().sub(upper.clone().multiplyScalar(lower.dot(upper)))
	const twist =
		flexDir.lengthSq() < 1e-10
			? 0
			: -sign *
				Math.atan2(
					flexDir.dot(new Vector3(1, 0, 0).applyQuaternion(frame)),
					flexDir.dot(new Vector3(0, 0, 1).applyQuaternion(frame)),
				)
	return {
		plane: plane * RAD,
		elevation: elevation * RAD,
		twist: twist * RAD,
		elbow: Math.acos(MathUtils.clamp(upper.dot(lower), -1, 1)) * RAD,
	}
}

export const REST_SOLE_Z = DIM.footLength / 2 - DIM.heel

/**
 * Places the root so the lower sole touches y = hop and the feet keep their
 * standing position front to back; a knee bend therefore sinks the body
 * instead of sliding the feet.
 */
function groundFeet(rig, hop) {
	const { root } = rig
	root.position.set(0, 0, 0)
	root.updateMatrixWorld(true)
	const soles = SIDES.map(({ key }) => worldPosition(rig, `sole${key}`))
	const lowest = Math.min(...soles.map((sole) => sole.y))
	const meanX = (soles[0].x + soles[1].x) / 2
	const meanZ = (soles[0].z + soles[1].z) / 2
	root.position.set(-meanX, hop - lowest, REST_SOLE_Z - meanZ)
	root.updateMatrixWorld(true)
}

/** World position of a joint or marker after the last applyPose. */
export function worldPosition(rig, name, local = [0, 0, 0]) {
	return rig.joints[name].localToWorld(new Vector3(...local))
}

/** Converts a world point into the local frame of a joint. */
export function toJointFrame(rig, name, point) {
	return rig.joints[name].worldToLocal(point.clone())
}
