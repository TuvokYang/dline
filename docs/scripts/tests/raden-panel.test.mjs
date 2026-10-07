import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { describe, it } from "node:test"
import { RADEN_SVG } from "../generate-raden.mjs"
import { catmullRom, curve } from "../lib/raden-geometry.mjs"
import { compose, inClearZone, insidePanel, PANEL, renderRaden, SAFE_BOTTOM } from "../lib/raden-panel.mjs"

const layout = compose()
const vinePaths = new Map(layout.vines.map((vine) => [vine.id, vine]))

const SAMPLES = 512

/** Distance from a point to a vine, sampled densely along its Bézier segments. */
function distanceToVine(id, [x, y]) {
	const { segments } = vinePaths.get(id)
	let best = Number.POSITIVE_INFINITY
	for (const [p0, c1, c2, p1] of segments) {
		for (let k = 0; k <= SAMPLES; k++) {
			const t = k / SAMPLES
			const u = 1 - t
			const px = u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0]
			const py = u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1]
			best = Math.min(best, Math.hypot(px - x, py - y))
		}
	}
	return best
}

describe("raden panel geometry", () => {
	it("passes every vine through its authored points", () => {
		const points = [
			[0, 0],
			[40, 20],
			[90, -10],
			[140, 30],
		]
		const segments = catmullRom(points)
		assert.equal(segments.length, points.length - 1)
		segments.forEach(([start, , , end], i) => {
			assert.deepEqual(start, points[i])
			assert.deepEqual(end, points[i + 1])
		})
	})

	it("samples a curve by arc length with unit tangents", () => {
		const line = curve([
			[0, 0],
			[100, 0],
		])
		assert.ok(Math.abs(line.length - 100) < 0.5)
		const middle = line.at(0.5)
		assert.ok(Math.abs(middle.point[0] - 50) < 0.5)
		assert.ok(Math.abs(Math.hypot(...middle.tangent) - 1) < 1e-9)
	})
})

describe("raden panel composition", () => {
	it("starts every branch on its parent vine", () => {
		for (const vine of layout.vines.filter((v) => v.from)) {
			assert.ok(distanceToVine(vine.from.vine, vine.start) < 0.5, `${vine.id} is detached from ${vine.from.vine}`)
		}
	})

	it("hangs every leaf, flower, bud and tendril on a vine", () => {
		const attached = [
			...layout.leaves,
			...layout.flowers,
			...layout.buds,
			...layout.tendrils,
			...layout.stalks.map((s) => ({ vine: s.vine, attach: s.from })),
		]
		assert.ok(attached.length > 40)
		for (const item of attached) {
			assert.ok(distanceToVine(item.vine, item.attach) < 0.75, `piece at ${item.attach} is off vine ${item.vine}`)
		}
		for (const tendril of layout.tendrils) assert.deepEqual(tendril.points[0], tendril.attach)
	})

	it("ends every stalk exactly at the piece it carries", () => {
		const bases = [...layout.leaves, ...layout.flowers, ...layout.buds].map((item) => item.at)
		for (const stalk of layout.stalks) {
			assert.ok(
				bases.some(([x, y]) => Math.hypot(x - stalk.to[0], y - stalk.to[1]) < 1e-9),
				`stalk ending at ${stalk.to} carries nothing`,
			)
		}
	})

	it("keeps the ornament on the panel and out of the mascot corner", () => {
		const pieces = [...layout.leaves, ...layout.flowers, ...layout.buds, ...layout.petals, ...layout.shards, ...layout.flecks]
		for (const { at } of pieces) {
			assert.ok(!inClearZone(at), `piece at ${at} is in a clear zone`)
		}
		for (const { at } of [...layout.flowers, ...layout.buds, ...layout.petals]) {
			assert.ok(insidePanel(at, 10), `piece at ${at} leaves the ${PANEL.width}x${PANEL.height} panel`)
			assert.ok(at[1] < SAFE_BOTTOM, `piece at ${at} is cropped on a 16:9 window`)
		}
	})

	it("keeps the reading column in the middle of the page open", () => {
		const middle = { x: 480, y: 260, width: 640, height: 440 }
		const inMiddle = ([x, y]) => x > middle.x && x < middle.x + middle.width && y > middle.y && y < middle.y + middle.height
		const dense = [...layout.leaves, ...layout.flowers, ...layout.buds, ...layout.petals].filter(({ at }) => inMiddle(at))
		assert.deepEqual(dense, [])
	})
})

describe("raden panel output", () => {
	it("renders deterministically", () => {
		assert.equal(renderRaden(), renderRaden())
	})

	it("matches the committed raden.svg (run `npm run raden` after changing the panel)", async () => {
		const committed = await readFile(RADEN_SVG, "utf8")
		assert.equal(committed, renderRaden())
	})
})
