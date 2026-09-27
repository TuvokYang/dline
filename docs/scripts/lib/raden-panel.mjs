/**
 * The raden panel behind the documentation pages: one full-page
 * composition of gold-wire vines carrying shell leaves, flowers and buds.
 *
 * `compose()` lays the ornament out on the 1600 x 1000 design grid (y down)
 * and returns plain data, so tests can check that every piece hangs on its
 * vine. `renderRaden()` turns that layout into the SVG committed as
 * src/assets/brand/raden.svg; run `npm run raden` after changing this file.
 *
 * Raden technique: pieces are painted in stacking order with a black
 * outline, and the "inlay" filter turns black transparent. Seams between
 * pieces, leaf midribs and engraved veins therefore show the page's own
 * lacquer in both the dark and the light theme.
 */
import { curve, direction, mulberry32, pathData, tendrilPoints } from "./raden-geometry.mjs"

export const PANEL = Object.freeze({ width: 1600, height: 1000 })

/**
 * The page anchors the panel at its top-right corner and scales it to cover
 * the window. On windows wider than 16:10 the bottom is cropped, down to
 * this line on a 16:9 screen; flowers and buds stay above it.
 */
export const SAFE_BOTTOM = 900

/** Areas that stay empty lacquer: the corner where the mascot stands. */
export const CLEAR_ZONES = Object.freeze([Object.freeze({ x: 1160, y: 560, width: 440, height: 440 })])

/** Size of every motif relative to its drawing; large enough to show the engraved detail. */
const MOTIF = 1.4
const OUTLINE = 1.2
const DETAIL = 0.7
const WIRE = 3.2
const WIRE_SPLIT = 0.7
const STALK = 2
const TENDRIL = 1.3
const GOLD_WIRE = "#cf9f45"
const DEG = Math.PI / 180

const GRADIENTS = {
	"nacre-a": { to: [1, 1], stops: ["#e3f6fb", "#7fcbe0", "#dd92b8"] },
	"nacre-b": { from: [1, 0], to: [0, 1], stops: ["#f3d58f", "#e9f5f8", "#66abd8"] },
	"nacre-c": { from: [0, 1], to: [1, 0], stops: ["#e98bb2", "#f5dbe7", "#86a9e6"] },
	"nacre-d": { to: [1, 1], stops: ["#ab98e6", "#e0f4ec", "#4fbcab"] },
	sheen: { from: [0, 1], to: [1, 0], stops: ["#f2fbfd", "#c6ebf3", "#f0cfe0"] },
	"leaf-a": { to: [1, 1], stops: ["#cdf0dc", "#5fbf9b", "#26847a"] },
	"leaf-b": { from: [1, 0], to: [0, 1], stops: ["#257f7d", "#78cfb5", "#cfeee5"] },
	gold: { to: [1, 1], stops: ["#fff0bd", "#cf9c3f"] },
	abalone: { to: [1, 1], stops: ["#6dd3c5", "#3c6fcc", "#a45cb2"] },
}
const PETAL_FILLS = ["nacre-a", "nacre-c", "nacre-b", "nacre-d", "nacre-c"]

/**
 * Vines. `points` are design-grid points the vine passes through; a branch
 * starts `from` a point sampled on its parent vine, so it always joins it.
 * Items are placed by arc-length fraction `s` along the vine; `side` +1 is
 * the clockwise (right-hand) side of the direction of growth.
 *   leaves:   [s, side, scale, lean in degrees]
 *   flowers:  [s, side, scale, petals, stalk length]
 *   buds:     [s, side, scale, stalk length]
 *   tendrils: [s, side, length]
 */
const VINES = [
	{
		id: "upper",
		points: [
			[292, 30],
			[350, 96],
			[446, 124],
			[552, 108],
			[650, 132],
			[748, 116],
			[842, 128],
			[920, 112],
		],
		leaves: [
			[0.05, 1, 1.0],
			[0.12, -1, 0.9, 32],
			[0.27, 1, 1.0],
			[0.36, -1, 0.85, 32],
			[0.45, 1, 0.9],
			[0.56, -1, 0.8, 32],
			[0.68, 1, 0.8],
			[0.79, -1, 0.7, 32],
			[0.9, 1, 0.62],
		],
		flowers: [
			[0.32, 1, 1.35, 5, 18],
			[0.63, 1, 0.95, 5, 14],
		],
		buds: [[0.5, 1, 0.8, 12]],
		tendrils: [
			[0.41, -1, 28],
			[0.74, 1, 24],
		],
		end: { kind: "tendril", side: 1, length: 40 },
	},
	{
		id: "left",
		from: { vine: "upper", s: 0.12 },
		points: [
			[344, 196],
			[354, 266],
			[338, 330],
		],
		leaves: [
			[0.2, 1, 0.85],
			[0.42, -1, 0.8],
			[0.64, 1, 0.75],
			[0.82, -1, 0.65],
		],
		flowers: [],
		buds: [],
		tendrils: [[0.5, 1, 22]],
		end: { kind: "flower", scale: 0.95, petals: 5 },
	},
	{
		id: "right",
		points: [
			[1600, 40],
			[1578, 120],
			[1572, 210],
			[1588, 300],
			[1570, 390],
		],
		leaves: [
			[0.14, 1, 0.9],
			[0.26, -1, 0.7],
			[0.4, 1, 0.85],
			[0.56, -1, 0.65],
			[0.7, 1, 0.75],
			[0.84, -1, 0.55],
		],
		flowers: [],
		buds: [[0.48, 1, 0.75, 12]],
		tendrils: [[0.62, 1, 22]],
		end: { kind: "flower", scale: 1.0, petals: 5 },
	},
	{
		id: "lower",
		points: [
			[196, 960],
			[262, 896],
			[356, 858],
			[462, 846],
			[566, 860],
			[660, 842],
			[742, 850],
		],
		leaves: [
			[0.12, -1, 1.0],
			[0.22, 1, 0.9],
			[0.36, -1, 0.95],
			[0.48, 1, 0.8],
			[0.62, -1, 0.85],
			[0.74, 1, 0.75],
			[0.86, -1, 0.65],
		],
		flowers: [[0.56, -1, 1.0, 5, 14]],
		buds: [],
		tendrils: [[0.68, -1, 24]],
		end: { kind: "bud", scale: 0.8 },
	},
	{
		id: "lower-branch",
		from: { vine: "lower", s: 0.3 },
		points: [
			[410, 800],
			[398, 752],
		],
		leaves: [
			[0.3, 1, 0.8],
			[0.58, -1, 0.75],
		],
		flowers: [],
		buds: [],
		tendrils: [],
		end: { kind: "flower", scale: 1.25, petals: 5 },
	},
]

/**
 * Petals drifting just past the vine tips, [x, y, rotation in degrees
 * (0 points up), scale]. They stay beside the ornament, never over the
 * reading column, so they read as fallen petals rather than stray pieces.
 */
const LOOSE_PETALS = [
	[968, 150, -60, 0.6],
	[1528, 452, 120, 0.55],
	[792, 876, 30, 0.6],
]
const FLECKS = 44
const SHARDS = 16

// ---------------------------------------------------------------- shapes
// Motifs are drawn pointing up (-y) from their base at the origin, in
// design units at scale 1. Commands are [letter, x, y, ...].

const PETAL = [
	["M", 0, 0],
	["C", -8, -5, -10.5, -16, -4.2, -21.5],
	["Q", 0, -24, 4.2, -21.5],
	["C", 10.5, -16, 8, -5, 0, 0],
	["Z"],
]
const PETAL_SHEEN = [
	["M", 0, -3.5],
	["C", -4.6, -7, -6, -14, -2.5, -18],
	["Q", 0, -19.6, 2.5, -18],
	["C", 6, -14, 4.6, -7, 0, -3.5],
	["Z"],
]
const PETAL_LINES = [
	[
		["M", 0, -5],
		["L", 0, -16.5],
	],
	[
		["M", 0, -8.5],
		["L", -2.8, -12.2],
	],
	[
		["M", 0, -8.5],
		["L", 2.8, -12.2],
	],
	[
		["M", -4.2, -20.4],
		["Q", 0, -22.4, 4.2, -20.4],
	],
]
const leafHalf = (side) => [["M", side * 0.8, 0], ["C", side * 9, -6, side * 10.5, -20, side * 0.8, -31], ["Z"]]
const leafVeins = (side) =>
	[
		[5, 6],
		[11, 6],
		[17, 5],
		[23, 3],
	].map(([y, length]) => [
		["M", side * 1.6, -y],
		["L", side * (1.6 + length * 0.72), -(y + length * 0.7)],
	])
const BUD_BODY = [["M", 0, -1], ["C", -7, -6, -7, -16, 0, -22], ["C", 7, -16, 7, -6, 0, -1], ["Z"]]
const BUD_SHEEN = [["M", 0, -5], ["C", -2.2, -9, -2.2, -14, 0, -17], ["C", 2.2, -14, 2.2, -9, 0, -5], ["Z"]]
const BUD_STRIPES = [
	[
		["M", 0, -3],
		["C", -4, -8, -4, -15, 0, -19.5],
	],
	[
		["M", 0, -3],
		["C", 4, -8, 4, -15, 0, -19.5],
	],
]

// ------------------------------------------------------------ composition

function sideDirection(angle, side, lean) {
	return angle + side * lean * DEG
}

/** A short curved stalk from the vine point to the motif's base. */
function stalk(point, tangentAngle, angle, length) {
	const d = direction(angle)
	const t = direction(tangentAngle)
	const to = [point[0] + d[0] * length, point[1] + d[1] * length]
	const control = [
		point[0] + t[0] * length * 0.45 + d[0] * length * 0.25,
		point[1] + t[1] * length * 0.45 + d[1] * length * 0.25,
	]
	return { from: point, control, to }
}

/**
 * Lays out the whole panel. Every leaf, flower and bud records the vine it
 * grows from and the point where its stalk leaves that vine.
 */
export function compose() {
	const vines = new Map()
	const layout = { vines: [], stalks: [], tendrils: [], leaves: [], flowers: [], buds: [], petals: [], shards: [], flecks: [] }

	for (const spec of VINES) {
		const start = spec.from ? vines.get(spec.from.vine).at(spec.from.s).point : null
		const path = curve(start ? [start, ...spec.points] : spec.points)
		vines.set(spec.id, path)
		layout.vines.push({ id: spec.id, from: spec.from ?? null, start: path.at(0).point, segments: path.segments })

		for (const [s, side, size, lean = 52] of spec.leaves) {
			const { point, angle } = path.at(s)
			const scale = size * MOTIF
			const heading = sideDirection(angle, side, lean)
			const st = stalk(point, angle, heading, 4 * scale)
			layout.stalks.push({ vine: spec.id, ...st })
			layout.leaves.push({ vine: spec.id, attach: point, at: st.to, angle: heading, scale })
		}
		for (const [s, side, size, petals, length] of spec.flowers) {
			const { point, angle } = path.at(s)
			const heading = sideDirection(angle, side, 60)
			const st = stalk(point, angle, heading, length * MOTIF)
			layout.stalks.push({ vine: spec.id, ...st })
			layout.flowers.push({ vine: spec.id, attach: point, at: st.to, angle: heading, scale: size * MOTIF, petals })
		}
		for (const [s, side, size, length] of spec.buds) {
			const { point, angle } = path.at(s)
			const heading = sideDirection(angle, side, 48)
			const st = stalk(point, angle, heading, length * MOTIF)
			layout.stalks.push({ vine: spec.id, ...st })
			layout.buds.push({ vine: spec.id, attach: point, at: st.to, angle: heading, scale: size * MOTIF })
		}
		for (const [s, side, length] of spec.tendrils) {
			const { point, angle } = path.at(s)
			layout.tendrils.push({
				vine: spec.id,
				attach: point,
				points: tendrilPoints(point, sideDirection(angle, side, 38), side, length * MOTIF),
			})
		}
		const end = path.at(1)
		const endScale = (spec.end.scale ?? 1) * MOTIF
		if (spec.end.kind === "tendril") {
			layout.tendrils.push({
				vine: spec.id,
				attach: end.point,
				points: tendrilPoints(end.point, end.angle, spec.end.side, spec.end.length * MOTIF),
			})
		} else if (spec.end.kind === "bud") {
			layout.buds.push({ vine: spec.id, attach: end.point, at: end.point, angle: end.angle, scale: endScale })
		} else {
			layout.flowers.push({
				vine: spec.id,
				attach: end.point,
				at: end.point,
				angle: end.angle,
				scale: endScale,
				petals: spec.end.petals,
			})
		}
	}

	for (const [x, y, rotation, size] of LOOSE_PETALS)
		layout.petals.push({ at: [x, y], angle: (rotation - 90) * DEG, scale: size * MOTIF })

	// Flecks of cut gold and chips of shell scattered near the vines.
	const random = mulberry32(2026)
	const paths = [...vines.values()]
	const scatter = (count, near, far, push) => {
		let placed = 0
		for (let tries = 0; placed < count && tries < count * 40; tries++) {
			const path = paths[Math.floor(random() * paths.length)]
			const { point, tangent } = path.at(random())
			const offset = (near + random() * (far - near)) * (random() < 0.5 ? -1 : 1)
			const at = [point[0] - tangent[1] * offset, point[1] + tangent[0] * offset]
			if (!insidePanel(at, 8) || inClearZone(at)) continue
			push(at)
			placed++
		}
	}
	scatter(FLECKS, 14, 64, (at) =>
		layout.flecks.push({ at, size: 0.9 + random() * 1.4, diamond: random() < 0.45, angle: random() * 90 }),
	)
	scatter(SHARDS, 20, 58, (at) =>
		layout.shards.push({
			at,
			size: 3 + random() * 3,
			angle: random() * 360,
			fill: PETAL_FILLS[Math.floor(random() * PETAL_FILLS.length)],
		}),
	)
	return layout
}

export function insidePanel([x, y], margin = 0) {
	return x >= margin && y >= margin && x <= PANEL.width - margin && y <= PANEL.height - margin
}

export function inClearZone([x, y]) {
	return CLEAR_ZONES.some((zone) => x >= zone.x && y >= zone.y && x <= zone.x + zone.width && y <= zone.y + zone.height)
}

// --------------------------------------------------------------- rendering

function fmt(n) {
	const v = Math.round(n * 10) / 10
	return Object.is(v, -0) ? "0" : String(v)
}

/** Maps motif coordinates into the design grid: the motif's up axis points along `angle`. */
function frame([x, y], angle, scale) {
	const r = angle + Math.PI / 2
	const c = Math.cos(r) * scale
	const s = Math.sin(r) * scale
	return ([u, v]) => [x + u * c - v * s, y + u * s + v * c]
}

function d(commands, map) {
	return commands
		.map(([letter, ...coords]) => {
			const values = []
			for (let i = 0; i < coords.length; i += 2) {
				const [x, y] = map([coords[i], coords[i + 1]])
				values.push(fmt(x), fmt(y))
			}
			return letter + values.join(" ")
		})
		.join("")
}

const fill = (commands, map, name) => `<path d="${d(commands, map)}" fill="url(#${name})"/>`
const lines = (list, map) =>
	`<path d="${list.map((commands) => d(commands, map)).join("")}" fill="none" stroke-width="${DETAIL}"/>`

function renderPetal(at, angle, scale, name) {
	const map = frame(at, angle, scale)
	return fill(PETAL, map, name) + fill(PETAL_SHEEN, map, "sheen") + lines(PETAL_LINES, map)
}

function renderLeaf(at, angle, scale) {
	const map = frame(at, angle, scale)
	return fill(leafHalf(-1), map, "leaf-a") + fill(leafHalf(1), map, "leaf-b") + lines([...leafVeins(-1), ...leafVeins(1)], map)
}

function renderFlower({ at, angle, scale, petals }) {
	let out = ""
	const step = (Math.PI * 2) / petals
	for (let i = 0; i < petals; i++) out += renderPetal(at, angle + i * step, scale, PETAL_FILLS[i % PETAL_FILLS.length])
	// A smaller inner ring, offset by half a petal, makes the flower layered.
	for (let i = 0; i < petals; i++) {
		const map = frame(at, angle + (i + 0.5) * step, scale * 0.56)
		out += fill(PETAL, map, i % 2 ? "sheen" : "nacre-a") + lines([PETAL_LINES[0]], map)
	}
	const [cx, cy] = at
	out += `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(4.8 * scale)}" fill="url(#abalone)"/>`
	out += `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(2.6 * scale)}" fill="none" stroke-width="${DETAIL}"/>`
	// Gold stamens ring the heart of the flower.
	for (let i = 0; i < 8; i++) {
		const a = angle + (i * Math.PI) / 4 + Math.PI / 8
		out += `<circle cx="${fmt(cx + Math.cos(a) * 7 * scale)}" cy="${fmt(cy + Math.sin(a) * 7 * scale)}" r="${fmt(1.25 * scale)}" fill="url(#gold)"/>`
	}
	return out
}

function renderBud({ at, angle, scale }) {
	let out = ""
	for (const side of [-1, 1]) out += renderLeaf(at, angle + side * 40 * DEG, scale * 0.42)
	const map = frame(at, angle, scale)
	return out + fill(BUD_BODY, map, "nacre-c") + fill(BUD_SHEEN, map, "sheen") + lines(BUD_STRIPES, map)
}

function wire(dPath, width, split) {
	const gold = `<path d="${dPath}" fill="none" stroke="${GOLD_WIRE}" stroke-width="${width}" stroke-linecap="round"/>`
	// A black centre line reads as the gap between two twisted strands.
	return split ? `${gold}<path d="${dPath}" fill="none" stroke-width="${split}"/>` : gold
}

function polyline(points) {
	return points.map(([x, y], i) => `${i ? "L" : "M"}${fmt(x)} ${fmt(y)}`).join("")
}

function renderShard({ at, size, angle, fill: name }) {
	const map = frame(at, angle * DEG, size)
	return fill([["M", 0, -1], ["L", 0.9, 0.5], ["L", -0.2, 0.9], ["L", -0.8, 0.1], ["Z"]], map, name)
}

function renderFleck({ at, size, diamond, angle }) {
	const [x, y] = at
	if (!diamond) return `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${fmt(size)}"/>`
	const map = frame(at, angle * DEG, size * 1.4)
	return `<path d="${d([["M", 0, -1], ["L", 1, 0], ["L", 0, 1], ["L", -1, 0], ["Z"]], map)}"/>`
}

function gradientDefs() {
	return Object.entries(GRADIENTS)
		.map(([id, { from = [0, 0], to, stops }]) => {
			const stopTags = stops
				.map((color, i) => `<stop offset="${fmt(i / (stops.length - 1))}" stop-color="${color}"/>`)
				.join("")
			return `<linearGradient id="${id}" x1="${from[0]}" y1="${from[1]}" x2="${to[0]}" y2="${to[1]}">${stopTags}</linearGradient>`
		})
		.join("\n\t\t")
}

/** Renders the panel SVG. The output is deterministic. */
export function renderRaden(layout = compose()) {
	const { width, height } = PANEL
	const format = (n) => fmt(n)
	const wires = [
		...layout.vines.map((vine) => wire(pathData(vine.segments, format), WIRE, WIRE_SPLIT)),
		...layout.stalks.map(({ from, control, to }) =>
			wire(`M${fmt(from[0])} ${fmt(from[1])}Q${fmt(control[0])} ${fmt(control[1])} ${fmt(to[0])} ${fmt(to[1])}`, STALK),
		),
		...layout.tendrils.map(({ points }) => wire(polyline(points), TENDRIL)),
	]
	const body = [
		`<g>${wires.join("")}</g>`,
		`<g>${layout.leaves.map(({ at, angle, scale }) => renderLeaf(at, angle, scale)).join("")}</g>`,
		`<g>${layout.buds.map(renderBud).join("")}</g>`,
		`<g>${layout.flowers.map(renderFlower).join("")}</g>`,
		`<g>${layout.petals.map(({ at, angle, scale }, i) => renderPetal(at, angle, scale, PETAL_FILLS[i % PETAL_FILLS.length])).join("")}</g>`,
		`<g>${layout.shards.map(renderShard).join("")}</g>`,
		`<g fill="url(#gold)" stroke="none">${layout.flecks.map(renderFleck).join("")}</g>`,
	]
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMin slice">
	<!-- Generated by docs/scripts/generate-raden.mjs from scripts/lib/raden-panel.mjs. Do not edit by hand. -->
	<defs>
		${gradientDefs()}
		<!-- Alpha follows brightness: black seams turn transparent, every shell colour stays opaque. -->
		<filter id="inlay" filterUnits="userSpaceOnUse" x="-40" y="-40" width="${width + 80}" height="${height + 80}" color-interpolation-filters="sRGB">
			<feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  6 6 6 0 -0.3" result="shell"/>
			<feComposite in="SourceGraphic" in2="shell" operator="in"/>
		</filter>
	</defs>
	<g filter="url(#inlay)" stroke="#000" stroke-width="${OUTLINE}" stroke-linejoin="round">
		${body.join("\n\t\t")}
	</g>
</svg>
`
}
