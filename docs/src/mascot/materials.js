/**
 * Raden materials: the palette of the original inlay artwork, set in
 * lacquer, with painted (彩绘) decoration on some shell pieces.
 *
 * Every piece is coloured by the same diagonal gradient the SVG artwork
 * used, as a texture, so the robot keeps its teal nacre, pink-white shell,
 * dark abalone and gold. Iridescence and clearcoat only add a thin shimmer
 * and gloss on top. `addSeams` rims each piece with a hole material that
 * writes fully transparent pixels, like the SVG "inlay" filter that turned
 * black transparent, so the seams between pieces show the page lacquer.
 */
import {
	BackSide,
	CanvasTexture,
	Color,
	FrontSide,
	Mesh,
	MeshPhysicalMaterial,
	MeshStandardMaterial,
	NoBlending,
	ShaderMaterial,
	SRGBColorSpace,
} from "three"

/**
 * A material that punches transparent holes into the canvas: it replaces
 * the pixel with transparent black, so the page behind shows through. With
 * `width` > 0 it is an outline hull pushed out along view-space normals.
 */
function holeMaterial(width, side) {
	const material = new ShaderMaterial({
		uniforms: { width: { value: width } },
		vertexShader: /* glsl */ `
			uniform float width;
			void main() {
				vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
				viewPosition.xyz += normalize(normalMatrix * normal) * width;
				gl_Position = projectionMatrix * viewPosition;
			}
		`,
		fragmentShader: /* glsl */ `
			void main() {
				gl_FragColor = vec4(0.0);
			}
		`,
		side,
		blending: NoBlending,
		polygonOffset: width > 0,
		polygonOffsetFactor: 1,
		polygonOffsetUnits: 1,
	})
	material.userData.hole = true
	return material
}

/** Gradients of the original artwork: direction (x1, y1, x2, y2) in a unit box, y down, and colour stops. */
const GRADIENTS = {
	shell: [
		[0, 0, 1, 1],
		[
			[0, "#f0fdfa"],
			[0.45, "#a6e3d8"],
			[0.8, "#5cc8b8"],
			[1, "#d6ecfa"],
		],
	],
	shell2: [
		[1, 0, 0, 1],
		[
			[0, "#5cc8b8"],
			[0.5, "#c9f2ea"],
			[1, "#fbeef4"],
		],
	],
	abalone: [
		[0, 0, 1, 1],
		[
			[0, "#1d4f6c"],
			[0.35, "#2a8f94"],
			[0.7, "#4d5aa6"],
			[1, "#8fd6c8"],
		],
	],
	gold: [
		[0, 0, 1, 1],
		[
			[0, "#fff6d8"],
			[1, "#d9b56a"],
		],
	],
	canary: [
		[0, 0, 1, 1],
		[
			[0, "#fff7cf"],
			[0.55, "#f5d56e"],
			[1, "#e0a93a"],
		],
	],
	beak: [
		[0, 0, 1, 1],
		[
			[0, "#ffc3a8"],
			[1, "#e2553d"],
		],
	],
	leafA: [
		[0, 0, 1, 1],
		[
			[0, "#e2f7ea"],
			[0.5, "#8fd6b8"],
			[1, "#4fa89a"],
		],
	],
	leafB: [
		[1, 0, 0, 1],
		[
			[0, "#4c9c9a"],
			[0.5, "#a6e3cf"],
			[1, "#e6f6f2"],
		],
	],
	petal: [
		[0, 0, 1, 1],
		[
			[0, "#ffffff"],
			[0.5, "#f8c9d6"],
			[1, "#e58aa6"],
		],
	],
}

/** Lacquer paint colours for the 彩绘 decoration. */
const PAINT = { vermilion: "#c8463a", gold: "#c99a3e", green: "#3d8a64", white: "#fff8ec" }

function paintFlower(ctx, x, y, r) {
	ctx.fillStyle = PAINT.vermilion
	for (let i = 0; i < 5; i++) {
		const a = (i * Math.PI * 2) / 5 - Math.PI / 2
		ctx.beginPath()
		ctx.arc(x + r * Math.cos(a), y + r * Math.sin(a), r * 0.62, 0, Math.PI * 2)
		ctx.fill()
	}
	ctx.fillStyle = PAINT.gold
	ctx.beginPath()
	ctx.arc(x, y, r * 0.5, 0, Math.PI * 2)
	ctx.fill()
}

function paintLeaf(ctx, x, y, angle, length) {
	ctx.save()
	ctx.translate(x, y)
	ctx.rotate(angle)
	ctx.fillStyle = PAINT.green
	ctx.beginPath()
	ctx.ellipse(length / 2, 0, length / 2, length / 5, 0, 0, Math.PI * 2)
	ctx.fill()
	ctx.restore()
}

/** A curl of an auspicious cloud: a hooked spiral. */
function paintCurl(ctx, x, y, r, turn) {
	ctx.beginPath()
	for (let i = 0; i <= 40; i++) {
		const t = i / 40
		const a = turn * (t * Math.PI * 2.2)
		const radius = r * (1 - 0.72 * t)
		const px = x + radius * Math.cos(a)
		const py = y + radius * Math.sin(a)
		if (i === 0) ctx.moveTo(px, py)
		else ctx.lineTo(px, py)
	}
	ctx.stroke()
}

const MOTIFS = {
	/** 卷草: a gold scrolling vine with vermilion flowers and green leaves. */
	scroll(ctx, s) {
		ctx.lineCap = "round"
		ctx.lineJoin = "round"
		ctx.strokeStyle = PAINT.gold
		ctx.lineWidth = s * 0.022
		ctx.beginPath()
		ctx.moveTo(s * 0.06, s * 0.9)
		ctx.bezierCurveTo(s * 0.3, s * 0.62, s * 0.12, s * 0.42, s * 0.42, s * 0.4)
		ctx.bezierCurveTo(s * 0.7, s * 0.38, s * 0.6, s * 0.16, s * 0.92, s * 0.1)
		ctx.stroke()
		for (const [x, y, r, turn] of [
			[0.24, 0.66, 0.07, 1],
			[0.56, 0.34, 0.06, -1],
			[0.8, 0.2, 0.05, 1],
		]) {
			paintCurl(ctx, s * x, s * y, s * r, turn)
		}
		for (const [x, y, a, l] of [
			[0.14, 0.78, -0.9, 0.11],
			[0.34, 0.48, 2.4, 0.1],
			[0.5, 0.4, -1.2, 0.09],
			[0.72, 0.26, 2.2, 0.09],
		]) {
			paintLeaf(ctx, s * x, s * y, a, s * l)
		}
		paintFlower(ctx, s * 0.42, s * 0.4, s * 0.045)
		paintFlower(ctx, s * 0.9, s * 0.1, s * 0.035)
		paintFlower(ctx, s * 0.2, s * 0.56, s * 0.03)
	},
	/** 祥云: two vermilion cloud scrolls with a gold ribbon. */
	cloud(ctx, s) {
		ctx.lineCap = "round"
		ctx.lineJoin = "round"
		for (const [x, y, k] of [
			[0.3, 0.36, 1],
			[0.68, 0.7, 0.8],
		]) {
			ctx.strokeStyle = PAINT.vermilion
			ctx.lineWidth = s * 0.024
			paintCurl(ctx, s * x, s * y, s * 0.1 * k, 1)
			paintCurl(ctx, s * (x + 0.17 * k), s * (y + 0.02), s * 0.075 * k, -1)
			ctx.beginPath()
			ctx.moveTo(s * (x - 0.12 * k), s * (y + 0.12 * k))
			ctx.bezierCurveTo(
				s * (x - 0.02),
				s * (y + 0.2 * k),
				s * (x + 0.2 * k),
				s * (y + 0.2 * k),
				s * (x + 0.3 * k),
				s * (y + 0.1 * k),
			)
			ctx.stroke()
			ctx.strokeStyle = PAINT.gold
			ctx.lineWidth = s * 0.012
			ctx.beginPath()
			ctx.moveTo(s * (x - 0.16 * k), s * (y + 0.18 * k))
			ctx.bezierCurveTo(
				s * (x + 0.02),
				s * (y + 0.27 * k),
				s * (x + 0.26 * k),
				s * (y + 0.25 * k),
				s * (x + 0.38 * k),
				s * (y + 0.16 * k),
			)
			ctx.stroke()
		}
	},
}

function gradientTexture(document, name, motif) {
	const size = 256
	const canvas = document.createElement("canvas")
	canvas.width = size
	canvas.height = size
	const ctx = canvas.getContext("2d")
	const [[x1, y1, x2, y2], stops] = GRADIENTS[name]
	const gradient = ctx.createLinearGradient(x1 * size, y1 * size, x2 * size, y2 * size)
	for (const [offset, color] of stops) gradient.addColorStop(offset, color)
	ctx.fillStyle = gradient
	ctx.fillRect(0, 0, size, size)
	if (motif) MOTIFS[motif](ctx, size)
	const texture = new CanvasTexture(canvas)
	texture.colorSpace = SRGBColorSpace
	texture.anisotropy = 4
	return texture
}

/** Shell under a thin lacquer coat: the texture gives the colour, iridescence only a shimmer. */
function lacquered(map, { iridescence = 0.3, clearcoat = 0.7, roughness = 0.34, metalness = 0 } = {}) {
	return new MeshPhysicalMaterial({
		map,
		roughness,
		metalness,
		clearcoat,
		clearcoatRoughness: 0.16,
		iridescence,
		iridescenceIOR: 1.4,
		iridescenceThicknessRange: [180, 520],
	})
}

export function createMaterials(document) {
	const tex = (name, motif) => gradientTexture(document, name, motif)
	return {
		/** Teal nacre, the main shell; the painted variants carry 彩绘 decoration. */
		shell: lacquered(tex("shell")),
		shellScroll: lacquered(tex("shell", "scroll")),
		shellCloud: lacquered(tex("shell", "cloud")),
		/** Pink-white nacre for plates and trims. */
		shell2: lacquered(tex("shell2")),
		/** The two halves of a leaf, and petals. */
		leaf: lacquered(tex("leafA")),
		leaf2: lacquered(tex("leafB")),
		petal: lacquered(tex("petal")),
		/** Dark abalone for joints, collars, soles and the facial features. */
		abalone: lacquered(tex("abalone"), { iridescence: 0.55, clearcoat: 1, roughness: 0.24 }),
		/** Gold leaf for rivets, axles and the terminal cursor. */
		gold: lacquered(tex("gold"), { iridescence: 0, clearcoat: 0.5, roughness: 0.32, metalness: 0.25 }),
		/** The lit ">" of the terminal prompt. */
		prompt: new MeshStandardMaterial({ color: "#c9f2ea", emissive: "#7fe0d0", emissiveIntensity: 0.5, roughness: 0.3 }),
		canary: lacquered(tex("canary"), { iridescence: 0.1, clearcoat: 0.3 }),
		beak: lacquered(tex("beak"), { iridescence: 0, clearcoat: 0.3 }),
		/** Engraved lines and vents: cut through, so they show the page like the seams. */
		ink: holeMaterial(0, FrontSide),
	}
}

/** Small deterministic PRNG, so every render produces the same shell pattern. */
export function mulberry32(seed) {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

/**
 * Gives every iridescent mesh under `root` its own copy of its material with
 * a shifted film thickness and a faint tint, like individually cut shell.
 */
export function inlay(root, random) {
	const tint = new Color()
	root.traverse((object) => {
		const material = object.isMesh ? object.material : null
		if (!material?.iridescence) return
		const piece = material.clone()
		const shift = (random() - 0.5) * 160
		const [low, high] = material.iridescenceThicknessRange
		piece.iridescenceThicknessRange = [Math.max(80, low + shift), high + shift]
		tint.setHSL(random(), 0.4, 0.8)
		piece.color = material.color.clone().lerp(tint, 0.05)
		object.material = piece
	})
}

/**
 * Adds a black outline of `width` world units around every shaded piece
 * under `root` (an inverted hull pushed out along view-space normals, so
 * the width stays even on scaled parts). Engraved black pieces and
 * see-through materials get none.
 */
export function addSeams(root, width) {
	const material = holeMaterial(width, BackSide)
	const pieces = []
	root.traverse((object) => {
		if (object.isMesh && !object.userData.seam && !object.material.userData.hole && !object.material.transparent)
			pieces.push(object)
	})
	for (const piece of pieces) {
		const hull = new Mesh(piece.geometry, material)
		hull.userData.seam = true
		piece.add(hull)
	}
}
