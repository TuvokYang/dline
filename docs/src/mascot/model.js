/**
 * Meshes of the Dline mascot, attached to the joints built by rig.js.
 *
 * Every part is a separate piece of shell, like raden inlay: rounded blocks
 * for the armour, thin bevelled slabs for plates and facial features.
 * Measurements follow the original artwork; the robot faces +z. Browser
 * only, because the ground shadow paints a canvas.
 */
import {
	CanvasTexture,
	CapsuleGeometry,
	CatmullRomCurve3,
	ConeGeometry,
	CylinderGeometry,
	DoubleSide,
	Group,
	LatheGeometry,
	MathUtils,
	Mesh,
	MeshBasicMaterial,
	PlaneGeometry,
	SphereGeometry,
	TorusGeometry,
	TubeGeometry,
	Vector2,
	Vector3,
} from "three"
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js"
import { DIM, SIDES } from "./rig.js"
import { ellipse, face, leafHalf, petal, roundedPolygon, roundedRect, slab } from "./shapes.js"

const FACE_Z = 30.2
const EYE_X = 13
const EYE_Y = 38
const MOUTH_Y = 20

function block(parent, material, [w, h, d], [x, y, z], radius = 3) {
	const r = Math.min(radius, Math.min(w, h, d) / 2 - 0.01)
	const mesh = new Mesh(new RoundedBoxGeometry(w, h, d, 3, r), material)
	mesh.position.set(x, y, z)
	parent.add(mesh)
	return mesh
}

function piece(parent, shapes, material, [x, y, z], depth = 1.2) {
	const mesh = new Mesh(slab(shapes, depth), material)
	mesh.position.set(x, y, z)
	parent.add(mesh)
	return mesh
}

/** A rod between two points in a joint's frame, like a bent wire of shell. */
function rod(parent, material, from, to, radius) {
	const a = new Vector3(...from)
	const b = new Vector3(...to)
	const mesh = new Mesh(new CapsuleGeometry(radius, a.distanceTo(b), 6, 16), material)
	mesh.position.copy(a).add(b).multiplyScalar(0.5)
	mesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), b.clone().sub(a).normalize())
	parent.add(mesh)
	return mesh
}

function buildLeg(j, key, M) {
	block(j[`thigh${key}`], M.shell, [20, 34, 20], [0, -17, 0], 7)
	const thigh = j[`thigh${key}`]
	block(thigh, M.abalone, [23, 20, 23], [0, -38, 0], 3)
	piece(thigh, roundedRect(20, 14, 3), M.shell2, [0, -37, 11], 1.4)
	block(thigh, M.gold, [4.4, 4.4, 1.6], [0, -37, 13.6], 0.6)

	const knee = j[`knee${key}`]
	block(knee, M.shellScroll, [22, 40, 22], [0, -29, 0], 8)
	block(knee, M.ink, [12, 2.2, 1], [0, -17.1, 11], 0.4)
	block(knee, M.ink, [12, 2.2, 1], [0, -23.1, 11], 0.4)

	block(j[`ankle${key}`], M.abalone, [12, 7, 12], [0, 0, 0], 2)
	const foot = j[`foot${key}`]
	block(foot, M.shell2, [26, 14, 46], [0, -9.5, 9], 5)
	block(foot, M.gold, [3.6, 3.6, 1.4], [0, -9.5, 32.3], 0.5)
	block(foot, M.abalone, [28, 6, 48], [0, -20.5, 9], 2.5)
}

/** Shoulder measurements live in rig.js, where the tests check the arm clears the cup. */
const SOCKET = {
	outer: DIM.shoulderJoint.cupOuter,
	inner: DIM.shoulderJoint.cupInner,
	opening: MathUtils.degToRad(DIM.shoulderJoint.cupOpening),
}
const BALL_RADIUS = DIM.shoulderJoint.ball

/**
 * The shoulder cup: a thick spherical cap around the lathe's y axis, open
 * toward -y. Like the human glenoid it is shallow, so the ball can swing
 * the arm down, out, up, forward and back without the rim catching it.
 */
function socketGeometry() {
	const profile = []
	const steps = 24
	for (let i = 0; i <= steps; i++) {
		const a = (SOCKET.opening * i) / steps
		profile.push(new Vector2(SOCKET.outer * Math.sin(a), SOCKET.outer * Math.cos(a)))
	}
	for (let i = steps; i >= 0; i--) {
		const a = (SOCKET.opening * i) / steps
		profile.push(new Vector2(SOCKET.inner * Math.sin(a), SOCKET.inner * Math.cos(a)))
	}
	return new LatheGeometry(profile, 48)
}

/**
 * A ball-and-socket shoulder, built like a human one: a round cup fixed to
 * the torso holds a ball that belongs to the upper arm, so the ball turns
 * with every shoulder motion. A gold meridian ring and a pin on the front
 * of the ball make that rotation visible: from the front the ring reads as
 * a line that tilts as the arm lifts and swings.
 */
function buildShoulder(j, key, sign, M) {
	const chest = j.chest
	const cup = new Group()
	cup.position.set(sign * DIM.shoulder.x, DIM.shoulder.y, 0)
	// The cup's closed pole faces the torso; its opening faces outward.
	cup.rotation.z = sign * (Math.PI / 2)
	chest.add(cup)
	const shell = M.shell2.clone()
	shell.side = DoubleSide
	cup.add(new Mesh(socketGeometry(), shell))
	const lipRadius = ((SOCKET.outer + SOCKET.inner) / 2) * Math.sin(SOCKET.opening)
	const lipHeight = ((SOCKET.outer + SOCKET.inner) / 2) * Math.cos(SOCKET.opening)
	const lip = new Mesh(new TorusGeometry(lipRadius, 1.9, 12, 48), M.shell)
	lip.rotation.x = Math.PI / 2
	lip.position.y = lipHeight
	cup.add(lip)
	for (let i = 0; i < 6; i++) {
		const angle = (i * Math.PI * 2) / 6 + Math.PI / 6
		const rivet = new Mesh(new SphereGeometry(1.3, 12, 8), M.gold)
		rivet.position.set(lipRadius * Math.cos(angle), lipHeight + 1.6, lipRadius * Math.sin(angle))
		cup.add(rivet)
	}
	// A round boss mounts the cup on the side of the torso.
	const boss = new Mesh(new CylinderGeometry(15, 15, 4, 40), M.abalone)
	boss.position.y = SOCKET.outer - 1
	cup.add(boss)

	const upper = j[`upperArm${key}`]
	upper.add(new Mesh(new SphereGeometry(BALL_RADIUS, 40, 28), M.abalone))
	// The ring stays inside the cup's inner radius, so it never cuts the cup.
	const meridian = new Mesh(new TorusGeometry(BALL_RADIUS - 0.2, 0.9, 10, 64), M.gold)
	meridian.rotation.y = Math.PI / 2
	upper.add(meridian)
	const pin = new Mesh(new SphereGeometry(2.2, 16, 12), M.gold)
	pin.position.set(0, 0, BALL_RADIUS + 0.4)
	upper.add(pin)
	const neck = new Mesh(new CylinderGeometry(7, 8, 6, 24), M.abalone)
	neck.position.y = -BALL_RADIUS + 1
	upper.add(neck)
}

function buildArm(j, key, sign, M) {
	buildShoulder(j, key, sign, M)

	const upper = j[`upperArm${key}`]
	block(upper, M.shellCloud, [22, 28, 22], [0, -26, 0], 8)
	block(upper, M.ink, [22.4, 2.2, 22.4], [0, -24, 0], 1)
	block(upper, M.abalone, [20, 18, 20], [0, -46, 0], 3)
	block(upper, M.gold, [1.4, 5.2, 5.2], [sign * 10.4, -46, 0], 0.5)

	const fore = j[`forearm${key}`]
	block(fore, M.shell, [24, 32, 24], [0, -22, 0], 9)
	piece(fore, roundedRect(15, 19, 5), M.shell2, [0, -20, 12.2], 1.2)
	for (const y of [-14.5, -24.5]) block(fore, M.gold, [3.2, 3.2, 1.2], [0, y, 14.6], 0.4)
	block(fore, M.abalone, [18, 6, 18], [0, -41, 0], 2)
	block(fore, M.shell2, [22, 14, 18], [0, -51, 0], 5)
	for (const x of [-7.5, 0, 7.5]) block(fore, M.shell, [6, 12, 6], [x, -61, 1], 2.8)
	const thumb = block(fore, M.shell, [6, 12, 6], [sign * 12, -50, 2], 2.8)
	thumb.rotation.z = sign * 0.45
}

/** Torso outline: a trapezoid, wide at the shoulders and narrow at the waist. */
const TORSO = Object.freeze({ top: 88, bottom: 60, bottomY: -4, topY: 90, depth: 50, radius: 14 })

/**
 * The torso shell: a rounded trapezoid extruded to the body's depth, with a
 * bevelled edge so it reads as one solid piece of inlaid shell.
 */
function torsoGeometry() {
	const { top, bottom, bottomY, topY, depth, radius } = TORSO
	const outline = roundedPolygon(
		[
			[-bottom / 2, bottomY],
			[bottom / 2, bottomY],
			[top / 2, topY],
			[-top / 2, topY],
		],
		radius,
	)
	// Centre the slab on the joint so the chest plate, screen and belly bands
	// (z ≈ 27) sit flush on its front face instead of floating in front of it.
	const geometry = slab(outline, depth)
	geometry.translate(0, 0, -depth / 2)
	return geometry
}

function buildTorso(j, M) {
	const chest = j.chest
	const shell = new Mesh(torsoGeometry(), M.shellScroll)
	shell.position.z = 2
	chest.add(shell)
	block(chest, M.abalone, [26, 8, 26], [0, 93, 0], 3)
	piece(chest, roundedRect(64, 42, 14), M.shell2, [0, 59, 27.2], 1.6)
	piece(chest, roundedRect(46, 32, 4), M.abalone, [0, 59, 29.6], 1.2)
	block(chest, M.ink, [46, 1.4, 0.6], [0, 67.9, 31.6], 0.2)
	for (const x of [-19, -15, -11]) block(chest, M.gold, [2.4, 2.4, 0.8], [x, 71.9, 31.6], 0.3)
	for (const [x, y] of [
		[-26, 74],
		[26, 74],
		[-26, 44],
		[26, 44],
	])
		block(chest, M.gold, [3.6, 3.6, 1.2], [x, y, 29.4], 0.5)

	// The ">_" prompt on the terminal screen.
	const prompt = new Group()
	prompt.position.z = 31.6
	chest.add(prompt)
	const glow = M.prompt
	rod(prompt, glow, [-17, 62.5, 0], [-10.5, 56.5, 0], 1.4)
	rod(prompt, glow, [-10.5, 56.5, 0], [-17, 50.5, 0], 1.4)
	const cursor = block(prompt, M.gold, [11, 2.8, 1], [-1.5, 51.8, 0], 0.4)

	for (const [w, y] of [
		[58, 28.5],
		[52, 17.5],
		[44, 7],
	])
		piece(chest, roundedRect(w, 9, 4.5), y === 17.5 ? M.shell : M.shell2, [0, y, 27.4], 1.6)
	// Side vents follow the slanted flanks of the trapezoid.
	const halfWidthAt = (y) =>
		TORSO.bottom / 2 + ((TORSO.top - TORSO.bottom) / 2) * ((y - TORSO.bottomY) / (TORSO.topY - TORSO.bottomY))
	for (const sign of [-1, 1]) {
		for (const y of [66, 61, 56]) block(chest, M.ink, [1, 1.6, 10], [sign * (halfWidthAt(y) + 0.1), y, 2], 0.3)
	}
	buildSprig(chest, M)
	return { cursor }
}

/** A sprig of leaves and a flower growing from the robot's right shoulder line. */
function buildSprig(chest, M) {
	const sprig = new Group()
	sprig.position.set(-26, 91, 14)
	sprig.rotation.set(-0.5, 0, 0.15)
	sprig.scale.setScalar(0.62)
	chest.add(sprig)
	const leaf = (angle, x, y, scale) => {
		const g = new Group()
		g.position.set(x, y, 0)
		g.rotation.z = angle
		g.scale.setScalar(scale)
		piece(g, leafHalf(-1), M.leaf, [0, 0, 0], 1.2)
		piece(g, leafHalf(1), M.leaf2, [0, 0, 0.2], 1.2)
		sprig.add(g)
	}
	leaf(1.0, -4, -2, 0.95)
	leaf(-0.35, 3, -1, 0.85)
	const flower = new Group()
	flower.position.set(0, 4, 3)
	sprig.add(flower)
	for (let i = 0; i < 5; i++) {
		const g = new Group()
		g.rotation.z = (i * Math.PI * 2) / 5
		g.position.z = i * 0.25
		piece(g, petal(), i % 2 ? M.shell2 : M.petal, [0, 0, 0], 1.1)
		flower.add(g)
	}
	block(flower, M.gold, [7, 7, 3], [0, 0, 2], 3)
}

function buildHead(j, M) {
	const head = j.head
	block(head, M.abalone, [20, 8, 20], [0, 3.5, 0], 3)
	block(head, M.shellCloud, [72, 58, 56], [0, 34, 1], 10)
	piece(head, roundedRect(61, 46, 14), M.shell2, [0, 34, 27.8], 2.4)
	block(head, M.abalone, [16, 7, 16], [0, 64.5, 0], 3)
	rod(head, M.shell, [0, 64, 0], [0, 74, 0], 3)
	for (const sign of [-1, 1]) {
		rod(head, M.shell, [0, 74, 0], [sign * 11.5, 83.5, 0], 3)
		rod(head, M.shell, [sign * 40.5, 44, 1], [sign * 47, 35, 1], 3.5)
		rod(head, M.shell, [sign * 47, 35, 1], [sign * 40.5, 26, 1], 3.5)
	}
	for (const sign of [-1, 1]) {
		for (const y of [26.8, 23.2]) block(head, M.ink, [7, 1.6, 0.8], [sign * 22.5, y, FACE_Z - 0.4], 0.3)
	}
	return buildExpressions(head, M)
}

/** One group per expression; the renderer shows exactly one of them. */
function buildExpressions(head, M) {
	const faceGroup = new Group()
	faceGroup.position.z = FACE_Z
	head.add(faceGroup)
	const groups = {}
	const add = (name) => {
		const g = new Group()
		g.visible = false
		faceGroup.add(g)
		groups[name] = g
		return g
	}
	const blinkers = []
	/** Round eyes with a gold glint; `look` shifts the glints, `ry` flattens the eyes. */
	const roundEyes = (g, ry = 8.2, dy = 0) => {
		const eyes = []
		for (const sign of [-1, 1]) {
			const eye = new Group()
			eye.position.set(sign * EYE_X, EYE_Y + dy, 0)
			piece(eye, ellipse(8.2, ry), M.abalone, [0, 0, 0], 1.2)
			const glint = piece(eye, ellipse(2.5), M.gold, [2.6, 2.6, 1.6], 0.6)
			g.add(eye)
			eyes.push({ eye, glint })
		}
		blinkers.push(eyes)
		return eyes
	}
	const blush = (g) => {
		for (const sign of [-1, 1]) piece(g, ellipse(5.6, 3.4), M.petal, [sign * 22.5, 25, 0.4], 1)
	}
	const grilleMouth = (g) => {
		piece(g, roundedRect(26, 8, 4), M.abalone, [0, MOUTH_Y, 0], 1.2)
		for (const x of [-4, 4]) block(g, M.ink, [1.6, 8, 1], [x, MOUTH_Y, 1.6], 0.2)
	}

	const calm = add("calm")
	roundEyes(calm)
	grilleMouth(calm)

	const determined = add("determined")
	for (const sign of [-1, 1]) {
		const brow = piece(determined, roundedRect(17, 3.4, 1.2), M.gold, [sign * 13.5, 49.5, 0], 1)
		brow.rotation.z = sign * 0.25
	}
	roundEyes(determined, 7, -0.6)
	piece(determined, roundedRect(22, 4.4, 2.2), M.abalone, [0, MOUTH_Y, 0], 1.2)

	const humming = add("humming")
	const hummingEyes = roundEyes(humming)
	const hum = piece(humming, ellipse(4.4, 4.6), M.abalone, [0, MOUTH_Y - 1, 0], 1.2)
	const notes = []
	for (const [x, y, scale, phase] of [
		[42, 44, 1, 0],
		[50, 52, 0.75, 0.5],
	]) {
		const note = piece(humming, face.note(), M.gold, [x, y, -4], 1)
		note.userData = { x, y, scale, phase }
		notes.push(note)
	}

	const straining = add("straining")
	for (const sign of [-1, 1]) piece(straining, face.squeezedEye(sign), M.abalone, [sign * EYE_X, EYE_Y, 0], 1.2)
	piece(straining, roundedRect(30, 10, 3), M.shell, [0, MOUTH_Y, 0], 1.2)
	block(straining, M.ink, [30, 1.2, 1], [0, MOUTH_Y, 1.6], 0.2)
	for (const x of [-7.5, 0, 7.5]) block(straining, M.ink, [1.2, 10, 1], [x, MOUTH_Y, 1.6], 0.2)

	const joyful = add("joyful")
	for (const sign of [-1, 1]) piece(joyful, face.happyEye(), M.abalone, [sign * EYE_X, EYE_Y - 1, 0], 1.2)
	piece(joyful, face.openSmile(), M.abalone, [0, MOUTH_Y - 1, 0], 1.2)
	piece(joyful, face.tongue(), M.petal, [0, MOUTH_Y - 1, 1.2], 0.8)
	blush(joyful)

	const tired = add("tired")
	for (const sign of [-1, 1]) piece(tired, face.tiredEye(), M.abalone, [sign * EYE_X, EYE_Y, 0], 1.2)
	const wobble = new CatmullRomCurve3(
		Array.from({ length: 9 }, (_, i) => new Vector3(-12 + i * 3, MOUTH_Y + (i % 2 ? 1.6 : -1.2), 0.8)),
	)
	tired.add(new Mesh(new TubeGeometry(wobble, 48, 1.6, 10), M.abalone))
	const sweat = piece(tired, face.sweatDrop(), M.shell, [40, 52, -2], 1.4)

	const cheeky = add("cheeky")
	const open = new Group()
	open.position.set(-EYE_X, EYE_Y, 0)
	piece(open, ellipse(8.2), M.abalone, [0, 0, 0], 1.2)
	piece(open, ellipse(2.5), M.gold, [2.6, 2.6, 1.6], 0.6)
	cheeky.add(open)
	piece(cheeky, face.happyEye(), M.abalone, [EYE_X, EYE_Y - 1, 0], 1.2)
	piece(cheeky, face.grin(), M.abalone, [0, MOUTH_Y, 0], 1.2)
	blush(cheeky)
	const sparkle = piece(cheeky, face.sparkle(), M.gold, [29, 49, 0.6], 1)

	// The still pose: looking at the bird with a gentle grin.
	const content = add("content")
	const contentEyes = roundEyes(content)
	piece(content, face.grin(), M.abalone, [0, MOUTH_Y, 0], 1.2)
	blush(content)

	return {
		groups,
		/** Shows one expression and animates its small details at time t. */
		update(expression, blink, t, lookX = 0) {
			for (const [name, g] of Object.entries(groups)) g.visible = name === expression
			for (const eyes of blinkers) for (const { eye } of eyes) eye.scale.y = 1 - 0.88 * blink
			for (const { glint } of hummingEyes) glint.position.x = 2.6 * lookX
			for (const { glint } of contentEyes) glint.position.x = 2.6 * lookX
			hum.scale.y = 0.75 + 0.25 * Math.cos((t * Math.PI * 2) / 1.2)
			for (const note of notes) {
				const { x, y, scale, phase } = note.userData
				const u = (t / 1.6 + phase) % 1
				note.position.set(x + 6 * u, y + 16 * u, -4)
				note.scale.setScalar(scale * Math.sin(Math.PI * u))
			}
			const drip = (t % 1.4) / 1.4
			sweat.position.y = 52 - 9 * drip
			sweat.scale.setScalar(drip < 0.75 ? 1 : 1 - (drip - 0.75) / 0.25)
			sparkle.scale.setScalar(0.6 + 0.4 * Math.abs(Math.sin((t * Math.PI) / 0.7)))
		},
	}
}

/** The songbird; its origin is where its feet grip and it faces +x. */
function buildBird(M) {
	const bird = new Group()
	const add = (geometry, material, [x, y, z], [sx, sy, sz] = [1, 1, 1], parent = bird) => {
		const mesh = new Mesh(geometry, material)
		mesh.position.set(x, y, z)
		mesh.scale.set(sx, sy, sz)
		parent.add(mesh)
		return mesh
	}
	const sphere = new SphereGeometry(1, 28, 20)
	for (const z of [-2.5, 2.5]) rod(bird, M.beak, [0, 0, z], [0.5, 2.5, z], 0.6)
	add(sphere, M.canary, [0, 9, 0], [10, 7.5, 7])
	add(sphere, M.shell2, [3, 6, 0], [6.5, 3.6, 5.6])
	add(sphere, M.canary, [9, 15.5, 0], [6.2, 6.2, 5.8])
	const beak = add(new ConeGeometry(1.8, 5.8, 16), M.beak, [16.6, 15.3, 0])
	beak.rotation.z = -Math.PI / 2
	for (const z of [-4.6, 4.6]) add(sphere, M.ink, [11, 17, z], [1.3, 1.3, 0.8])
	const tail = add(sphere, M.gold, [-13, 7.5, 0], [10, 1.8, 4])
	tail.rotation.z = 0.12
	const wings = []
	for (const side of [-1, 1]) {
		const wing = new Group()
		wing.position.set(0, 12, side * 5.5)
		bird.add(wing)
		const feather = add(sphere, M.gold, [-3, 0, side * 2.2], [9.5, 4.2, 2], wing)
		feather.rotation.z = 0.2
		wings.push({ wing, side })
	}
	bird.scale.setScalar(1.25)
	return {
		bird,
		/** Flaps while flying; folds the wings while perched. */
		flap(t, flying) {
			const angle = flying ? 0.35 + 0.9 * Math.sin(t * Math.PI * 2 * 5) : 0
			for (const { wing, side } of wings) wing.rotation.x = -side * angle
		},
	}
}

function groundShadow(document) {
	const canvas = document.createElement("canvas")
	canvas.width = 128
	canvas.height = 128
	const ctx = canvas.getContext("2d")
	const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
	gradient.addColorStop(0, "rgba(16, 60, 70, 0.42)")
	gradient.addColorStop(1, "rgba(16, 60, 70, 0)")
	ctx.fillStyle = gradient
	ctx.fillRect(0, 0, 128, 128)
	const mesh = new Mesh(
		new PlaneGeometry(1, 1),
		new MeshBasicMaterial({ map: new CanvasTexture(canvas), transparent: true, depthWrite: false }),
	)
	mesh.rotation.x = -Math.PI / 2
	mesh.position.y = 0.2
	return mesh
}

export function buildMascot(rig, M, document) {
	const j = rig.joints
	block(j.root, M.abalone, [52, 20, 30], [0, 125, 0], 3)
	for (const sign of [-1, 1]) block(j.root, M.shell2, [36, 24, 32], [sign * 20, 117, 0], 4)
	for (const { key, sign } of SIDES) {
		buildLeg(j, key, M)
		buildArm(j, key, sign, M)
	}
	const torso = buildTorso(j, M)
	const expressions = buildHead(j, M)
	const { bird, flap } = buildBird(M)
	const shadow = groundShadow(document)

	return {
		root: rig.root,
		bird,
		shadow,
		/**
		 * Updates everything that is not a joint for one frame: expression,
		 * blinking cursor, ground shadow and the songbird's placement.
		 */
		update({ t, expression, blink, lookX, hop, birdPosition, birdQuaternion, flying }) {
			expressions.update(expression, blink, t, lookX)
			torso.cursor.visible = t % 1 < 0.5
			const spread = 1 - hop / 40
			shadow.scale.set(130 * spread, 70 * spread, 1)
			bird.position.copy(birdPosition)
			bird.quaternion.copy(birdQuaternion)
			flap(t, flying)
		},
	}
}
