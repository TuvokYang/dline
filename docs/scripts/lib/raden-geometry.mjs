/**
 * Plane geometry for the raden panel generator: smooth vines through
 * authored points, arc-length sampling along them, and curling tendrils.
 * Coordinates are SVG user units with y pointing down, so a positive turn
 * is clockwise on screen.
 */

const SAMPLES_PER_SEGMENT = 48

/** Deterministic PRNG, so the generated panel is identical on every run. */
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
 * Converts a uniform Catmull-Rom spline through `points` into cubic Bézier
 * segments `[p0, c1, c2, p1]`, so the curve passes through every point.
 */
export function catmullRom(points) {
	if (points.length < 2) throw new Error("A vine needs at least two points")
	const at = (i) => points[Math.max(0, Math.min(points.length - 1, i))]
	const segments = []
	for (let i = 0; i < points.length - 1; i++) {
		const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)]
		segments.push([
			p1,
			[p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6],
			[p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6],
			p2,
		])
	}
	return segments
}

function bezierPoint([p0, c1, c2, p1], t) {
	const u = 1 - t
	const a = u * u * u
	const b = 3 * u * u * t
	const c = 3 * u * t * t
	const d = t * t * t
	return [a * p0[0] + b * c1[0] + c * c2[0] + d * p1[0], a * p0[1] + b * c1[1] + c * c2[1] + d * p1[1]]
}

function bezierTangent([p0, c1, c2, p1], t) {
	const u = 1 - t
	const x = 3 * u * u * (c1[0] - p0[0]) + 6 * u * t * (c2[0] - c1[0]) + 3 * t * t * (p1[0] - c2[0])
	const y = 3 * u * u * (c1[1] - p0[1]) + 6 * u * t * (c2[1] - c1[1]) + 3 * t * t * (p1[1] - c2[1])
	const length = Math.hypot(x, y) || 1
	return [x / length, y / length]
}

/**
 * A curve that can be sampled by arc length. `at(s)` takes s in [0, 1] of
 * the total length and returns the point, the unit tangent and the tangent
 * angle in radians.
 */
export function curve(points) {
	const segments = catmullRom(points)
	const table = [{ length: 0, segment: 0, t: 0 }]
	let total = 0
	let previous = segments[0][0]
	segments.forEach((segment, index) => {
		for (let k = 1; k <= SAMPLES_PER_SEGMENT; k++) {
			const t = k / SAMPLES_PER_SEGMENT
			const point = bezierPoint(segment, t)
			total += Math.hypot(point[0] - previous[0], point[1] - previous[1])
			table.push({ length: total, segment: index, t })
			previous = point
		}
	})

	function at(s) {
		const target = Math.max(0, Math.min(1, s)) * total
		let high = table.length - 1
		let low = 0
		while (high - low > 1) {
			const mid = (low + high) >> 1
			if (table[mid].length < target) low = mid
			else high = mid
		}
		const a = table[low]
		const b = table[high]
		const span = b.length - a.length || 1
		const f = (target - a.length) / span
		const segment = b.segment
		const t0 = a.segment === segment ? a.t : 0
		const t = t0 + (b.t - t0) * f
		const point = bezierPoint(segments[segment], t)
		const tangent = bezierTangent(segments[segment], t)
		return { point, tangent, angle: Math.atan2(tangent[1], tangent[0]) }
	}

	/** Shortest distance from `point` to the sampled curve. */
	function distanceTo([x, y]) {
		let best = Number.POSITIVE_INFINITY
		for (const entry of table) {
			const [px, py] = bezierPoint(segments[entry.segment], entry.t)
			best = Math.min(best, Math.hypot(px - x, py - y))
		}
		return best
	}

	return { segments, length: total, at, distanceTo }
}

/** SVG path data for Bézier segments. */
export function pathData(segments, format) {
	const [start] = segments[0]
	let d = `M${format(start[0])} ${format(start[1])}`
	for (const [, c1, c2, p1] of segments) {
		d += `C${format(c1[0])} ${format(c1[1])} ${format(c2[0])} ${format(c2[1])} ${format(p1[0])} ${format(p1[1])}`
	}
	return d
}

/**
 * Points of a tendril that leaves `start` along `heading` (radians) and
 * curls towards `side` (+1 clockwise, -1 counter-clockwise), tightening
 * like a real vine tendril.
 */
export function tendrilPoints(start, heading, side, length, turns = 1.4) {
	const steps = 28
	const points = [start]
	let [x, y] = start
	let angle = heading
	// The step shrinks and the turn grows along the tendril, forming a spiral.
	const weights = Array.from({ length: steps }, (_, k) => 1 - 0.72 * (k / steps))
	const scale = length / weights.reduce((sum, w) => sum + w, 0)
	const turnWeights = Array.from({ length: steps }, (_, k) => (k / steps) ** 1.6)
	const turnScale = (turns * Math.PI * 2) / turnWeights.reduce((sum, w) => sum + w, 0)
	for (let k = 0; k < steps; k++) {
		angle += side * turnWeights[k] * turnScale
		x += Math.cos(angle) * weights[k] * scale
		y += Math.sin(angle) * weights[k] * scale
		points.push([x, y])
	}
	return points
}

/** Unit vector for an angle in radians. */
export function direction(angle) {
	return [Math.cos(angle), Math.sin(angle)]
}

/**
 * SVG rotation, in degrees, that turns a motif drawn pointing up (-y)
 * so that it points along `angle`.
 */
export function upRotation(angle) {
	return (angle * 180) / Math.PI + 90
}
