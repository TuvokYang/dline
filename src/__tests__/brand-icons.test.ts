import fs from "node:fs/promises"
import path from "node:path"
import sharp from "sharp"
import { describe, expect, it } from "vitest"
// @ts-expect-error -- brand scripts are plain ESM without type declarations.
import { designToFont, FONT, fontSvg, markCenter, markPath } from "../../scripts/brand/dline-mark.mjs"
// @ts-expect-error -- brand scripts are plain ESM without type declarations.
import { buildBrandAssets } from "../../scripts/generate-brand-icons.mjs"

/**
 * Every brand asset is generated from one geometry by `npm run icons`. These
 * tests keep the committed files in sync with the generator and guard the two
 * properties that are easy to break silently: the face must be cut out of the
 * body (nonzero winding), and the icon font must place the glyph inside the em.
 */

const ROOT = path.resolve(__dirname, "../..")

type Asset = { file: string; content: string | Uint8Array; kind: "text" | "binary" | "raster" }

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

	it("cuts the eyes and mouth out of the body", async () => {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="320" height="320"><path fill="#000" d="${markPath()}"/></svg>`
		const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
		const alphaAt = ([x, y]: [number, number]) => data[(Math.round(y * 10) * info.width + Math.round(x * 10)) * 4 + 3]
		// Body between the eyes, eye centers, mouth center, antenna stem, and outside the robot.
		expect(alphaAt([16, 14])).toBe(255)
		expect(alphaAt([11.8, 18.2])).toBe(0)
		expect(alphaAt([20.2, 18.2])).toBe(0)
		expect(alphaAt([16, 24.35])).toBe(0)
		expect(alphaAt([16, 9])).toBe(255)
		expect(alphaAt([1, 2])).toBe(0)
	})

	it("centers the icon-font glyph inside the em box", () => {
		const [x, y] = designToFont(markCenter())
		expect(x).toBeCloseTo(FONT.unitsPerEm / 2, 6)
		expect(y).toBeCloseTo((FONT.ascent + FONT.descent) / 2, 6)
		const [left, top] = designToFont([0.9, 3.4])
		const [right, bottom] = designToFont([31.1, 28])
		expect(left).toBeGreaterThanOrEqual(0)
		expect(right).toBeLessThanOrEqual(FONT.unitsPerEm)
		expect(top).toBeLessThanOrEqual(FONT.ascent)
		expect(bottom).toBeGreaterThanOrEqual(FONT.descent)
		expect(fontSvg()).toContain('unicode="&#xe900;"')
	})
})
