import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Quaternion, Vector3 } from "three"
import { applyPose, createRig, DIM, REST_SOLE_Z, SIDES, toJointFrame, worldPosition } from "../../src/mascot/rig.js"
import {
	BIRD_FLIGHT,
	birdWorldPosition,
	DURATION,
	KEYFRAMES,
	LIMITS,
	STILL,
	sample,
	strideTime,
} from "../../src/mascot/routine.js"

const STEP = 1 / 30
const times = Array.from({ length: Math.round(DURATION / STEP) }, (_, i) => i * STEP)
const rig = createRig()

function posed(t) {
	const frame = sample(t)
	applyPose(rig, frame.pose)
	return frame
}

/** Points along the bone axis of both arm segments, skipping the part inside the shoulder joint. */
function armPoints(key) {
	const points = []
	for (let y = -16; y >= -DIM.upperArm; y -= 3) points.push(worldPosition(rig, `upperArm${key}`, [0, y, 0]))
	for (let y = 0; y >= -DIM.fingertips; y -= 3) points.push(worldPosition(rig, `forearm${key}`, [0, y, 0]))
	return points
}

function insideSolid(point, margin) {
	for (const [name, { joint, min, max }] of Object.entries(DIM.solids)) {
		const p = toJointFrame(rig, joint, point)
		const inside = [p.x, p.y, p.z].every((v, i) => v > min[i] - margin && v < max[i] + margin)
		if (inside) return name
	}
	return null
}

function inRange(value, [min, max]) {
	return value >= min - 1e-6 && value <= max + 1e-6
}

describe("routine timeline", () => {
	it("starts at 0, is sorted and loops seamlessly", () => {
		assert.equal(KEYFRAMES[0][0], 0)
		for (let i = 1; i < KEYFRAMES.length; i++)
			assert.ok(KEYFRAMES[i][0] > KEYFRAMES[i - 1][0], `keyframe ${i} is not after ${i - 1}`)
		assert.deepEqual(KEYFRAMES.at(-1)[1], KEYFRAMES[0][1])
		assert.deepEqual(sample(DURATION - 1e-9).pose, sample(0).pose)
	})

	it("keeps every joint inside its human range", () => {
		for (const t of times) {
			const { pose } = sample(t)
			for (const side of ["armL", "armR"]) {
				for (const [dof, range] of Object.entries(LIMITS.arm)) {
					assert.ok(
						inRange(pose[side][dof], range),
						`${side}.${dof} = ${pose[side][dof].toFixed(1)} at t=${t.toFixed(2)}`,
					)
				}
			}
			for (const side of ["legL", "legR"]) {
				for (const [dof, range] of Object.entries(LIMITS.leg)) {
					assert.ok(inRange(pose[side][dof], range), `${side}.${dof} = ${pose[side][dof]} at t=${t.toFixed(2)}`)
				}
			}
			for (const part of ["waist", "neck"]) {
				for (const [dof, range] of Object.entries(LIMITS[part])) {
					assert.ok(inRange(pose[part][dof], range), `${part}.${dof} = ${pose[part][dof]} at t=${t.toFixed(2)}`)
				}
			}
			assert.ok(inRange(pose.hop, LIMITS.hop))
		}
	})

	it("moves every joint smoothly, without jumps between frames", () => {
		let previous = sample(0).pose
		for (const t of times.slice(1)) {
			const { pose } = sample(t)
			for (const side of ["armL", "armR"]) {
				for (const dof of Object.keys(LIMITS.arm)) {
					const change = Math.abs(pose[side][dof] - previous[side][dof])
					assert.ok(change < 12, `${side}.${dof} jumps ${change.toFixed(1)} deg at t=${t.toFixed(2)}`)
				}
			}
			previous = pose
		}
	})
})

describe("body kinematics", () => {
	it("keeps the soles flat and on the ground, lifted only by the hop", () => {
		const flat = new Quaternion()
		for (const t of times) {
			const { pose } = posed(t)
			const soles = SIDES.map(({ key }) => worldPosition(rig, `sole${key}`))
			assert.ok(Math.abs(Math.min(...soles.map((s) => s.y)) - pose.hop) < 1e-6, `feet float at t=${t.toFixed(2)}`)
			for (const { key } of SIDES) {
				const angle = rig.joints[`foot${key}`].getWorldQuaternion(new Quaternion()).angleTo(flat)
				assert.ok(angle < 1e-6, `foot${key} tilts at t=${t.toFixed(2)}`)
			}
			const meanZ = (soles[0].z + soles[1].z) / 2
			assert.ok(Math.abs(meanZ - REST_SOLE_Z) < 1e-6, `feet slide at t=${t.toFixed(2)}`)
		}
	})

	it("never pushes an arm through the body or the head", () => {
		for (const t of times) {
			posed(t)
			for (const { key } of SIDES) {
				for (const point of armPoints(key)) {
					const hit = insideSolid(point, 4)
					assert.equal(hit, null, `arm${key} enters the ${hit} at t=${t.toFixed(2)}`)
				}
			}
		}
	})

	it("swings each upper arm freely in its shoulder cup", () => {
		const { cupOpening, armHalfAngle } = DIM.shoulderJoint
		const chestTurn = new Quaternion()
		const armTurn = new Quaternion()
		const check = (label) => {
			rig.joints.chest.getWorldQuaternion(chestTurn)
			for (const { key, sign } of SIDES) {
				rig.joints[`upperArm${key}`].getWorldQuaternion(armTurn)
				const arm = new Vector3(0, -1, 0).applyQuaternion(chestTurn.clone().invert().multiply(armTurn))
				const cosine = Math.min(1, Math.max(-1, -sign * arm.x))
				const fromPole = (Math.acos(cosine) * 180) / Math.PI
				assert.ok(
					fromPole > cupOpening + armHalfAngle,
					`arm${key} hits its shoulder cup (${fromPole.toFixed(1)} deg) ${label}`,
				)
			}
		}
		for (const t of times) {
			posed(t)
			check(`at t=${t.toFixed(2)}`)
		}
		applyPose(rig, STILL)
		check("in the still pose")
	})

	it("keeps the two hands apart", () => {
		for (const t of times) {
			posed(t)
			const gap = worldPosition(rig, "palmL").distanceTo(worldPosition(rig, "palmR"))
			assert.ok(gap > 30, `hands collide (${gap.toFixed(1)}) at t=${t.toFixed(2)}`)
		}
	})
})

describe("exercise geometry", () => {
	const forwardOf = (joint) => new Vector3(0, 0, 1).applyQuaternion(rig.joints[joint].getWorldQuaternion(new Quaternion()))

	it("twists the upper body at the waist with bent arms held in front of the chest", () => {
		posed(8.0)
		const chest = forwardOf("chest")
		assert.ok(chest.x > 0.6, `chest should face the robot's left, got ${chest.x.toFixed(2)}`)
		assert.ok(forwardOf("root").z > 0.999, "hips must keep facing forward")
		const shoulderL = worldPosition(rig, "shoulderL")
		const shoulderR = worldPosition(rig, "shoulderR")
		assert.ok(shoulderL.z < -20 && shoulderR.z > 20, "the left shoulder moves back and the right one forward")
		const centre = worldPosition(rig, "chest")
		for (const { key } of SIDES) {
			const shoulder = worldPosition(rig, `shoulder${key}`)
			const elbow = worldPosition(rig, `elbow${key}`)
			const fist = worldPosition(rig, `fingertips${key}`)
			assert.ok(Math.abs(elbow.y - shoulder.y) < 10, `elbow${key} stays at shoulder height`)
			const ahead = fist.clone().sub(centre).dot(chest)
			assert.ok(ahead > 30, `fist${key} stays in front of the turned chest (${ahead.toFixed(1)})`)
		}
	})

	it("runs in place: knees lift in turn while the opposite arm swings forward", () => {
		for (const [i, lifted, planted] of [
			[0, "L", "R"],
			[1, "R", "L"],
		]) {
			const t = strideTime(i)
			posed(t)
			const knee = (key) => worldPosition(rig, `knee${key}`)
			const sole = (key) => worldPosition(rig, `sole${key}`)
			const fist = (key) => worldPosition(rig, `fingertips${key}`)
			assert.ok(knee(lifted).y > knee(planted).y + 12, `knee${lifted} lifts at t=${t.toFixed(2)}`)
			assert.ok(sole(lifted).y > 15, `foot${lifted} leaves the ground at t=${t.toFixed(2)}`)
			assert.ok(fist(planted).z > fist(lifted).z + 20, `arm${planted} swings forward at t=${t.toFixed(2)}`)
		}
	})

	it("folds the forearms in front of the chest in the chest expansion", () => {
		posed(2.3)
		for (const { key, sign } of SIDES) {
			const elbow = worldPosition(rig, `elbow${key}`)
			const hand = worldPosition(rig, `fingertips${key}`)
			const shoulder = worldPosition(rig, `shoulder${key}`)
			assert.ok(Math.abs(elbow.y - shoulder.y) < 10, `elbow${key} is at shoulder height`)
			assert.ok(sign * hand.x < sign * elbow.x - 20, `fist${key} is closer to the midline than the elbow`)
			assert.ok(hand.z > 30, `fist${key} is in front of the chest`)
			assert.ok(Math.abs(hand.y - elbow.y) < 10, `forearm${key} is level`)
		}
	})

	it("keeps the supporting hand on the hip during the side bend", () => {
		posed(15.5)
		const hand = worldPosition(rig, "fingertipsL")
		const hip = worldPosition(rig, "hipL")
		assert.ok(Math.abs(hand.y - hip.y) < 14, `left hand should rest at hip height, is ${(hand.y - hip.y).toFixed(1)} off`)
		assert.ok(hand.x > hip.x + 15, "left hand rests on the outside of the hip")
		const over = worldPosition(rig, "fingertipsR")
		const headTop = worldPosition(rig, "head", [0, 63, 0])
		assert.ok(over.y > headTop.y, "the right hand arcs over the head")
		assert.ok(over.x > worldPosition(rig, "elbowR").x, "the right forearm folds toward the bend")
	})
})

describe("songbird", () => {
	it("stays clear of the arms and out of the head while it flies", () => {
		for (const t of times.filter((time) => time > BIRD_FLIGHT.start && time < BIRD_FLIGHT.end)) {
			const { bird } = posed(t)
			const position = birdWorldPosition(rig, bird)
			for (const { key } of SIDES) {
				for (const point of armPoints(key)) {
					const gap = point.distanceTo(position)
					assert.ok(gap > 16, `bird is ${gap.toFixed(1)} from arm${key} at t=${t.toFixed(2)}`)
				}
			}
			// The feet leave from the top of the head, so test the bird's body, which sits above them.
			const body = position.clone().add(new Vector3(0, 9, 0))
			assert.equal(insideSolid(body, 0), null, `bird enters the body at t=${t.toFixed(2)}`)
		}
	})

	it("sits on the head whenever it is not flying", () => {
		for (const t of times.filter((time) => time <= BIRD_FLIGHT.start || time >= BIRD_FLIGHT.end)) {
			const { bird } = posed(t)
			assert.ok(birdWorldPosition(rig, bird).distanceTo(worldPosition(rig, "perch")) < 1e-6)
		}
	})
})

describe("still pose", () => {
	it("holds the perching hand up beside the head", () => {
		applyPose(rig, STILL)
		const grip = worldPosition(rig, "gripL")
		const headTop = worldPosition(rig, "head", [0, 63, 0])
		assert.ok(grip.y > headTop.y - 30, "the perching hand is raised near head height")
		assert.ok(grip.x > 60, "the perching hand is beside the head")
		for (const point of armPoints("L")) assert.equal(insideSolid(point, 4), null)
	})
})
