import fs from "node:fs/promises"
import path from "node:path"
import sharp from "sharp"
import { describe, expect, it } from "vitest"
import {
	designToFont,
	FONT,
	faviconSvg,
	fontSvg,
	glyphSvg,
	headSize,
	logoSvg,
	markBounds,
	markCenter,
	markPath,
	// @ts-expect-error -- brand scripts are plain ESM without type declarations.
} from "../../scripts/brand/dline-mark.mjs"
// @ts-expect-error -- brand scripts are plain ESM without type declarations.
import { buildBrandAssets } from "../../scripts/generate-brand-icons.mjs"

/**
 * Every brand asset is generated from one robot by `npm run icons`. These tests
 * keep the committed files in sync with the generator and guard the properties
 * that are easy to break silently: the eyes must be cut out of the head
 * (nonzero winding), the icon font must place the glyph inside the em, and the
 * docs site marks must stay transparent.
 */

const ROOT = path.resolve(__dirname, "../..")

type Asset = { file: string; content: string | Uint8Array; kind: "text" | "binary" | "raster" }
type Point = [number, number]

describe("brand icons", () => {
	it("committed assets match the generator output", async () => {
		const assets: Asset[] = await buildBrandAssets()
		for (const asset of assets) {
			const committed = await fs.readFile(path.join(ROOT, asset.file))
			if (asset.kind === "text") {
				expect(committed.toString("utf8"), `${asset.file} is stale; run npm run icons`).toBe(asset.content)
			} else if (asset.kind === "binary") {
				expect(Buffer.compare(committed, Buffer.from(asset.content as Uint8Array)), `${asset.file} is stale`).toBe(0)
			} else {
				const { width, height } = await sharp(committed).metadata()
				const expected = await sharp(Buffer.from(asset.content as Uint8Array)).metadata()
				expect([width, height], `${asset.file} has the wrong size; run npm run icons`).toEqual([
					expected.width,
					expected.height,
				])
			}
		}
	})

	it("uses a 24-pixel activity-bar canvas", async () => {
		const { width, height } = await sharp(Buffer.from(glyphSvg())).metadata()
		expect([width, height]).toEqual([24, 24])
	})

	it("fills the activity-bar icon without clipping or losing centering", async () => {
		// Oversample the actual SVG mask to measure its silhouette independently of theme color.
		const { data, info } = await sharp(Buffer.from(glyphSvg()), { density: 720 })
			.resize(240, 240)
			.ensureAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true })
		let left = info.width
		let top = info.height
		let right = -1
		let bottom = -1
		let borderAlpha = 0
		for (let y = 0; y < info.height; y++) {
			for (let x = 0; x < info.width; x++) {
				const alpha = data[(y * info.width + x) * info.channels + info.channels - 1]
				if (x === 0 || y === 0 || x === info.width - 1 || y === info.height - 1) {
					borderAlpha = Math.max(borderAlpha, alpha)
				}
				if (alpha >= 128) {
					left = Math.min(left, x)
					top = Math.min(top, y)
					right = Math.max(right, x)
					bottom = Math.max(bottom, y)
				}
			}
		}
		expect(right - left + 1).toBeGreaterThanOrEqual(220)
		expect(bottom - top + 1).toBeGreaterThanOrEqual(200)
		expect(borderAlpha).toBe(0)
		expect(Math.abs((left + right) / 2 - (info.width - 1) / 2)).toBeLessThanOrEqual(1)
		expect(Math.abs((top + bottom) / 2 - (info.height - 1) / 2)).toBeLessThanOrEqual(1)
	})

	it("cuts the eyes out of the head", async () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="320" height="320"><path fill="#000" d="${markPath()}"/></svg>`
		const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
		const alphaAt = ([x, y]: Point) => data[(Math.round(y * 10) * info.width + Math.round(x * 10)) * 4 + 3]
		// Head above the eyes, both eyes, the mouth, the antenna fork, both ear tips,
		// the gap between an ear and the head, and outside the robot.
		expect(alphaAt([16, 13])).toBe(255)
		expect(alphaAt([12.3, 18.3])).toBe(0)
		expect(alphaAt([19.7, 18.3])).toBe(0)
		expect(alphaAt([16, 24.2])).toBe(0)
		expect(alphaAt([16, 7.5])).toBe(255)
		expect(alphaAt([3.6, 19.5])).toBe(255)
		expect(alphaAt([28.4, 19.5])).toBe(255)
		expect(alphaAt([6.2, 19.5])).toBe(0)
		expect(alphaAt([1, 2])).toBe(0)
	})

	it("keeps the head square and the robot horizontally centered", () => {
		const { width, height } = headSize()
		expect(width).toBe(height)
		const { left, right } = markBounds()
		expect((left + right) / 2).toBeCloseTo(16, 6)
		expect(markCenter()[0]).toBeCloseTo(16, 6)
	})

	it("centers the icon-font glyph inside the em box", () => {
		const [x, y] = designToFont(markCenter())
		expect(x).toBeCloseTo(FONT.unitsPerEm / 2, 6)
		expect(y).toBeCloseTo((FONT.ascent + FONT.descent) / 2, 6)
		const { left, top, right, bottom } = markBounds()
		const [fontLeft, fontTop] = designToFont([left, top])
		const [fontRight, fontBottom] = designToFont([right, bottom])
		expect(fontLeft).toBeGreaterThanOrEqual(0)
		expect(fontRight).toBeLessThanOrEqual(FONT.unitsPerEm)
		expect(fontTop).toBeLessThanOrEqual(FONT.ascent)
		expect(fontBottom).toBeGreaterThanOrEqual(FONT.descent)
		expect(fontSvg()).toContain('unicode="&#xe900;"')
	})

	it("keeps the documentation site marks transparent", () => {
		for (const svg of [faviconSvg(), logoSvg("light"), logoSvg("dark")]) {
			expect(svg).not.toContain("<rect")
		}
	})
})
