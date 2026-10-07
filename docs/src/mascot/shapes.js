/**
 * Flat outlines of the inlay pieces, in the units of the original artwork
 * with y up. They are extruded into thin slabs, like pieces of cut shell.
 */
import { ExtrudeGeometry, Shape } from "three"

/**
 * Extrudes shapes into a slab whose back face lies on z = 0. UVs span the
 * piece's bounding box, like an SVG objectBoundingBox gradient, so every
 * piece shows the whole gradient of its material.
 */
export function slab(shapes, depth = 1.4) {
	const bevel = Math.min(0.35, depth / 3)
	const geometry = new ExtrudeGeometry(shapes, {
		depth,
		bevelEnabled: true,
		bevelThickness: bevel,
		bevelSize: bevel * 0.85,
		bevelSegments: 2,
		curveSegments: 28,
	})
	geometry.translate(0, 0, bevel)
	geometry.computeBoundingBox()
	const { min, max } = geometry.boundingBox
	const position = geometry.attributes.position
	const uv = geometry.attributes.uv
	for (let i = 0; i < position.count; i++) {
		uv.setXY(i, (position.getX(i) - min.x) / (max.x - min.x || 1), (position.getY(i) - min.y) / (max.y - min.y || 1))
	}
	return geometry
}

export function ellipse(rx, ry = rx, cx = 0, cy = 0, rotation = 0) {
	const shape = new Shape()
	shape.absellipse(cx, cy, rx, ry, 0, Math.PI * 2, false, rotation)
	return shape
}

export function roundedRect(w, h, r, cx = 0, cy = 0) {
	const x = cx - w / 2
	const y = cy - h / 2
	const shape = new Shape()
	shape.moveTo(x + r, y)
	shape.lineTo(x + w - r, y)
	shape.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false)
	shape.lineTo(x + w, y + h - r)
	shape.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false)
	shape.lineTo(x + r, y + h)
	shape.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false)
	shape.lineTo(x, y + r)
	shape.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false)
	return shape
}

/** A closed polygon whose corners are rounded with quadratic curves of the given radius. */
export function roundedPolygon(points, radius) {
	const shape = new Shape()
	const n = points.length
	const toward = (from, to, distance) => {
		const dx = to[0] - from[0]
		const dy = to[1] - from[1]
		const length = Math.hypot(dx, dy)
		const k = Math.min(distance, length / 2) / length
		return [from[0] + dx * k, from[1] + dy * k]
	}
	for (let i = 0; i < n; i++) {
		const previous = points[(i + n - 1) % n]
		const corner = points[i]
		const next = points[(i + 1) % n]
		const start = toward(corner, previous, radius)
		const end = toward(corner, next, radius)
		if (i === 0) shape.moveTo(...start)
		else shape.lineTo(...start)
		shape.quadraticCurveTo(corner[0], corner[1], end[0], end[1])
	}
	shape.closePath()
	return shape
}

export function polygon(points) {
	const shape = new Shape()
	shape.moveTo(...points[0])
	for (const point of points.slice(1)) shape.lineTo(...point)
	shape.closePath()
	return shape
}

/** One half of a leaf, pointing up (+y) from its stem at the origin; the gap between halves is the midrib. */
export function leafHalf(side) {
	const s = side
	const shape = new Shape()
	shape.moveTo(s * 0.6, 0)
	shape.bezierCurveTo(s * 6.5, 5, s * 7.5, 15, s * 0.6, 23)
	shape.closePath()
	return shape
}

/** A petal pointing up (+y) from the flower centre at the origin. */
export function petal() {
	const shape = new Shape()
	shape.moveTo(0, 0)
	shape.bezierCurveTo(-6.5, 4, -8.5, 13, -3.4, 17.5)
	shape.quadraticCurveTo(0, 19.6, 3.4, 17.5)
	shape.bezierCurveTo(8.5, 13, 6.5, 4, 0, 0)
	return shape
}

/** Face features, relative to the centre of the eye or the mouth they replace. */
export const face = {
	/** A closed, smiling eye: an upward arch. */
	happyEye() {
		const shape = new Shape()
		shape.moveTo(-8.5, -3)
		shape.bezierCurveTo(-7, 7.5, 7, 7.5, 8.5, -3)
		shape.lineTo(5, -3)
		shape.bezierCurveTo(3.5, 3, -3.5, 3, -5, -3)
		shape.closePath()
		return shape
	},
	/** A squeezed eye pointing toward the nose: ">" for the eye at -x, "<" for the eye at +x. */
	squeezedEye(side) {
		const s = side
		return polygon([
			[s * 8, 6.5],
			[s * -7, 0],
			[s * 8, -6.5],
			[s * 8, -2.6],
			[s * 0.5, 0],
			[s * 8, 2.6],
		])
	},
	/** A drooping eye: the lower half of the open eye. */
	tiredEye() {
		const shape = new Shape()
		shape.moveTo(-8.2, 0)
		shape.absarc(0, 0, 8.2, Math.PI, Math.PI * 2, false)
		shape.closePath()
		return shape
	},
	openSmile() {
		const shape = new Shape()
		shape.moveTo(-14, 6)
		shape.lineTo(14, 6)
		shape.quadraticCurveTo(14, -7, 0, -7)
		shape.quadraticCurveTo(-14, -7, -14, 6)
		return shape
	},
	tongue() {
		const shape = new Shape()
		shape.moveTo(-7.5, -3.6)
		shape.quadraticCurveTo(0, 1.2, 7.5, -3.6)
		shape.quadraticCurveTo(4, -6.6, 0, -6.6)
		shape.quadraticCurveTo(-4, -6.6, -7.5, -3.6)
		return shape
	},
	grin() {
		const shape = new Shape()
		shape.moveTo(-14, 4)
		shape.quadraticCurveTo(0, -11, 14, 4)
		shape.quadraticCurveTo(0, -3, -14, 4)
		return shape
	},
	sweatDrop() {
		const shape = new Shape()
		shape.moveTo(0, 6)
		shape.bezierCurveTo(-2.6, 1.8, -3.6, -0.6, -3.6, -2.2)
		shape.absarc(0, -2.2, 3.6, Math.PI, Math.PI * 2, false)
		shape.bezierCurveTo(3.6, -0.6, 2.6, 1.8, 0, 6)
		return shape
	},
	sparkle() {
		const shape = new Shape()
		shape.moveTo(0, 5)
		shape.quadraticCurveTo(0.8, 0.8, 5, 0)
		shape.quadraticCurveTo(0.8, -0.8, 0, -5)
		shape.quadraticCurveTo(-0.8, -0.8, -5, 0)
		shape.quadraticCurveTo(-0.8, 0.8, 0, 5)
		return shape
	},
	/** An eighth note; the origin is the centre of the note head. */
	note() {
		const stem = new Shape()
		stem.moveTo(1.8, 0.5)
		stem.lineTo(1.8, 13)
		stem.bezierCurveTo(4.6, 12, 7.2, 10, 6.6, 6.4)
		stem.bezierCurveTo(6, 8.2, 4.6, 9.2, 3.2, 9.4)
		stem.lineTo(3.2, 0.5)
		stem.closePath()
		return [stem, ellipse(3.2, 2.4, 0, 0, 0.35)]
	},
}
