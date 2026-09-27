/**
 * Dline brand mark: the robot drawn on a 32-unit design grid (y down), and the
 * renderers that turn it into SVG paths and icon-font glyphs.
 *
 * Every brand asset is derived from this one geometry by
 * `scripts/generate-brand-icons.mjs` (`npm run icons`). Filled shapes are wound
 * clockwise and cut-outs (eyes, mouth) counter-clockwise, so the nonzero fill
 * rule used by both SVG and TrueType renders the cut-outs as holes.
 */

/** Side of the square design grid. */
export const GRID = 32

const DESIGN = Object.freeze({
	tile: { radius: 7, from: "#5CC8B8", to: "#1F7A6F" },
	body: { x: 5.4, y: 10.6, width: 21.2, height: 17.4, radius: 5.4 },
	antenna: {
		radius: 1.15,
		segments: [
			[
				[16, 11],
				[16, 7.6],
			],
			[
				[16, 7.6],
				[12.4, 4.6],
			],
			[
				[16, 7.6],
				[19.6, 4.6],
			],
		],
	},
	ears: {
		radius: 1.1,
		segments: [
			[
				[3.9, 15.3],
				[1.9, 18.6],
			],
			[
				[1.9, 18.6],
				[3.9, 21.9],
			],
			[
				[28.1, 15.3],
				[30.1, 18.6],
			],
			[
				[30.1, 18.6],
				[28.1, 21.9],
			],
		],
	},
	eyes: {
		radius: 2.7,
		centers: [
			[11.8, 18.2],
			[20.2, 18.2],
		],
	},
	mouth: { x: 12.4, y: 23.1, width: 7.2, height: 2.5, radius: 1.25 },
	sleepyEyes: {
		radius: 0.95,
		segments: [
			[
				[9.8, 18.8],
				[13.8, 18.8],
			],
			[
				[18.2, 18.8],
				[22.2, 18.8],
			],
		],
	},
	sleepyMouth: { center: [16, 24.3], radius: 1.2 },
})

/** Icon-font metrics shared by the glyph and the font header. */
export const FONT = Object.freeze({ unitsPerEm: 1024, ascent: 960, descent: -64, codepoint: 0xe900 })

/**
 * @typedef {[number, number]} Point
 * @typedef {{ type: "M" | "L", to: Point } | { type: "A", to: Point, radius: number, clockwise: boolean }} Command
 * @typedef {Command[]} Contour
 * @typedef {"default" | "sleepy"} Expression
 */

/**
 * Contours of the robot: antenna, ears and body as filled outlines, the face
 * as cut-outs.
 * @param {Expression} [expression]
 * @returns {Contour[]}
 */
export function markContours(expression = "default") {
	const face =
		expression === "sleepy"
			? [
					...DESIGN.sleepyEyes.segments.map(([a, b]) => capsule(a, b, DESIGN.sleepyEyes.radius, false)),
					circle(DESIGN.sleepyMouth.center, DESIGN.sleepyMouth.radius, false),
				]
			: [
					...DESIGN.eyes.centers.map((center) => circle(center, DESIGN.eyes.radius, false)),
					roundedRect(DESIGN.mouth, false),
				]
	return [
		...DESIGN.antenna.segments.map(([a, b]) => capsule(a, b, DESIGN.antenna.radius, true)),
		...DESIGN.ears.segments.map(([a, b]) => capsule(a, b, DESIGN.ears.radius, true)),
		roundedRect(DESIGN.body, true),
		...face,
	]
}

/**
 * Center of the robot's bounding box on the design grid.
 * @returns {Point}
 */
export function markCenter() {
	const strokes = [...DESIGN.antenna.segments.flat(), ...DESIGN.ears.segments.flat()]
	const radius = Math.max(DESIGN.antenna.radius, DESIGN.ears.radius)
	const xs = [
		...strokes.map(([x]) => x - radius),
		...strokes.map(([x]) => x + radius),
		DESIGN.body.x,
		DESIGN.body.x + DESIGN.body.width,
	]
	const ys = [...strokes.map(([, y]) => y - radius), DESIGN.body.y, DESIGN.body.y + DESIGN.body.height]
	return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]
}

/**
 * SVG path data for contours placed with a uniform scale, a translation and an
 * optional vertical flip (font coordinates point up).
 * @param {Contour[]} contours
 * @param {{ scale?: number, translate?: Point, flipY?: boolean }} [placement]
 * @returns {string}
 */
export function toPathData(contours, { scale = 1, translate = [0, 0], flipY = false } = {}) {
	/** @param {Point} point */
	const place = ([x, y]) => `${fmt(translate[0] + x * scale)} ${fmt(translate[1] + (flipY ? -y : y) * scale)}`
	/** @param {Command} command */
	const draw = (command) => {
		if (command.type !== "A") {
			return `${command.type}${place(command.to)}`
		}
		const radius = fmt(command.radius * scale)
		// A vertical flip mirrors the turning direction of every arc.
		const sweep = command.clockwise !== flipY ? 1 : 0
		return `A${radius} ${radius} 0 0 ${sweep} ${place(command.to)}`
	}
	return contours.map((contour) => `${contour.map(draw).join("")}Z`).join("")
}

/**
 * Robot path on the design grid.
 * @param {Expression} [expression]
 */
export function markPath(expression = "default") {
	return toPathData(markContours(expression))
}

/** Glyph path in font units: the robot centered in the em box. */
export function fontGlyphPath() {
	const scale = FONT.unitsPerEm / GRID
	const [cx, cy] = markCenter()
	const middle = (FONT.ascent + FONT.descent) / 2
	return toPathData(markContours(), { scale, translate: [FONT.unitsPerEm / 2 - cx * scale, middle + cy * scale], flipY: true })
}

/**
 * Where a design-grid point lands in font units.
 * @param {Point} point
 * @returns {Point}
 */
export function designToFont([x, y]) {
	const scale = FONT.unitsPerEm / GRID
	const [cx, cy] = markCenter()
	return [FONT.unitsPerEm / 2 + (x - cx) * scale, (FONT.ascent + FONT.descent) / 2 - (y - cy) * scale]
}

const GENERATED_NOTE = "Generated by scripts/generate-brand-icons.mjs from scripts/brand/dline-mark.mjs; do not edit."

/** Full-color mark: the white robot on the teal tile. */
export function markSvg() {
	const { tile } = DESIGN
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${GRID}" height="${GRID}" viewBox="0 0 ${GRID} ${GRID}">`,
		`\t<!-- ${GENERATED_NOTE} -->`,
		"\t<defs>",
		'\t\t<linearGradient id="dline-mark-tile" x1="0" y1="0" x2="1" y2="1">',
		`\t\t\t<stop offset="0" stop-color="${tile.from}" />`,
		`\t\t\t<stop offset="1" stop-color="${tile.to}" />`,
		"\t\t</linearGradient>",
		"\t</defs>",
		`\t<rect width="${GRID}" height="${GRID}" rx="${tile.radius}" fill="url(#dline-mark-tile)" />`,
		`\t<path fill="#FFFFFF" d="${markPath()}" />`,
		"</svg>",
		"",
	].join("\n")
}

/**
 * Transparent logo in one brand color, used by the docs site header and home page.
 * @param {"light" | "dark"} theme
 */
export function logoSvg(theme) {
	const color = theme === "light" ? DESIGN.tile.to : DESIGN.tile.from
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${GRID}" height="${GRID}" viewBox="0 0 ${GRID} ${GRID}" role="img" aria-label="Dline">`,
		`\t<!-- ${GENERATED_NOTE} -->`,
		"\t<title>Dline</title>",
		`\t<path fill="${color}" d="${markPath()}" />`,
		"</svg>",
		"",
	].join("\n")
}

/** Single-color robot for VS Code, which uses the SVG as a mask and applies the theme color. */
export function glyphSvg() {
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${GRID}" height="${GRID}" viewBox="0 0 ${GRID} ${GRID}">`,
		`\t<!-- ${GENERATED_NOTE} -->`,
		`\t<path fill="currentColor" d="${markPath()}" />`,
		"</svg>",
		"",
	].join("\n")
}

/** SVG font holding the single `dline-icon` glyph, the input of svg2ttf. */
export function fontSvg() {
	const codepoint = FONT.codepoint.toString(16)
	return [
		'<svg xmlns="http://www.w3.org/2000/svg"><defs>',
		`<font id="dline-icon" horiz-adv-x="${FONT.unitsPerEm}">`,
		`<font-face font-family="dline-icon" units-per-em="${FONT.unitsPerEm}" ascent="${FONT.ascent}" descent="${FONT.descent}" />`,
		`<missing-glyph horiz-adv-x="${FONT.unitsPerEm}" />`,
		`<glyph unicode="&#x${codepoint};" glyph-name="dline" horiz-adv-x="${FONT.unitsPerEm}" d="${fontGlyphPath()}" />`,
		"</font></defs></svg>",
	].join("")
}

/** TypeScript module exposing the Webview's copy of the robot paths. */
export function webviewPathsModule() {
	return [
		`// ${GENERATED_NOTE}`,
		"",
		"/** View box of the Dline mark paths: the 32-unit design grid. */",
		`export const DLINE_MARK_VIEW_BOX = "0 0 ${GRID} ${GRID}"`,
		"",
		// Biome keeps an over-long string initializer on its own indented line.
		"/** The Dline robot; eyes and mouth are cut-outs. */",
		"export const DLINE_MARK_PATH =",
		`\t"${markPath()}"`,
		"",
		"/** The sleepy robot shown in Lazy Teammate Mode. */",
		"export const DLINE_MARK_SLEEPY_PATH =",
		`\t"${markPath("sleepy")}"`,
		"",
	].join("\n")
}

/**
 * Capsule around the segment A→B: the outline of a stroke with round caps.
 * @param {Point} a
 * @param {Point} b
 * @param {number} radius
 * @param {boolean} clockwise
 * @returns {Contour}
 */
function capsule([ax, ay], [bx, by], radius, clockwise) {
	const length = Math.hypot(bx - ax, by - ay)
	// Normal on the side that makes A+n → B+n → B−n → A−n run clockwise on screen.
	const nx = ((by - ay) / length) * radius
	const ny = ((ax - bx) / length) * radius
	/** @type {Point[]} */
	const [p0, p1, p2, p3] = [
		[ax + nx, ay + ny],
		[bx + nx, by + ny],
		[bx - nx, by - ny],
		[ax - nx, ay - ny],
	]
	return clockwise
		? [move(p0), line(p1), arc(p2, radius, true), line(p3), arc(p0, radius, true)]
		: [move(p0), arc(p3, radius, false), line(p2), arc(p1, radius, false)]
}

/**
 * @param {{ x: number, y: number, width: number, height: number, radius: number }} rect
 * @param {boolean} clockwise
 * @returns {Contour}
 */
function roundedRect({ x, y, width, height, radius: r }, clockwise) {
	const [left, top, right, bottom] = [x, y, x + width, y + height]
	return clockwise
		? [
				move([left + r, top]),
				line([right - r, top]),
				arc([right, top + r], r, true),
				line([right, bottom - r]),
				arc([right - r, bottom], r, true),
				line([left + r, bottom]),
				arc([left, bottom - r], r, true),
				line([left, top + r]),
				arc([left + r, top], r, true),
			]
		: [
				move([left + r, top]),
				arc([left, top + r], r, false),
				line([left, bottom - r]),
				arc([left + r, bottom], r, false),
				line([right - r, bottom]),
				arc([right, bottom - r], r, false),
				line([right, top + r]),
				arc([right - r, top], r, false),
			]
}

/**
 * @param {Point} center
 * @param {number} radius
 * @param {boolean} clockwise
 * @returns {Contour}
 */
function circle([cx, cy], radius, clockwise) {
	return [move([cx - radius, cy]), arc([cx + radius, cy], radius, clockwise), arc([cx - radius, cy], radius, clockwise)]
}

/** @param {Point} to @returns {Command} */
function move(to) {
	return { type: "M", to }
}

/** @param {Point} to @returns {Command} */
function line(to) {
	return { type: "L", to }
}

/** @param {Point} to @param {number} radius @param {boolean} clockwise @returns {Command} */
function arc(to, radius, clockwise) {
	return { type: "A", to, radius, clockwise }
}

/** @param {number} value */
function fmt(value) {
	const rounded = Number(value.toFixed(3))
	return String(Object.is(rounded, -0) ? 0 : rounded)
}
