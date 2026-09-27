/**
 * Regenerate every Dline brand asset from the mark geometry in
 * scripts/brand/dline-mark.mjs. Run with `npm run icons` after changing the
 * geometry; src/__tests__/brand-icons.test.ts fails when a committed asset
 * drifts from this output.
 */
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import sharp from "sharp"
import svg2ttf from "svg2ttf"
import ttf2woff from "ttf2woff"
import { fontSvg, GRID, glyphSvg, logoSvg, markSvg, webviewPathsModule } from "./brand/dline-mark.mjs"

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
/** Marketplace icon size; the Marketplace requires at least 128 px. */
const PNG_SIZE = 256

/**
 * @typedef {{ file: string, content: string | Uint8Array, kind: "text" | "binary" | "raster" }} BrandAsset
 *   `file` is relative to the repository root; `raster` output depends on the
 *   installed image library and is compared by size only.
 */

/** @returns {Promise<BrandAsset[]>} */
export async function buildBrandAssets() {
	const mark = markSvg()
	return [
		{ file: "assets/icons/dline-mark.svg", content: mark, kind: "text" },
		{ file: "docs/public/favicon.svg", content: mark, kind: "text" },
		{ file: "docs/src/assets/brand/logo-light.svg", content: logoSvg("light"), kind: "text" },
		{ file: "docs/src/assets/brand/logo-dark.svg", content: logoSvg("dark"), kind: "text" },
		{ file: "assets/icons/icon.svg", content: glyphSvg(), kind: "text" },
		{ file: "webview-ui/src/assets/dlineMarkPaths.ts", content: webviewPathsModule(), kind: "text" },
		{ file: "assets/icons/dline-icon.woff", content: iconFont(), kind: "binary" },
		{ file: "assets/icons/icon.png", content: await rasterize(mark, PNG_SIZE), kind: "raster" },
	]
}

/** Icon font for the `$(dline-icon)` product icon. A fixed timestamp keeps the output reproducible. */
function iconFont() {
	const ttf = svg2ttf(fontSvg(), { ts: 0, version: "Version 1.0", description: "Dline product icon" })
	return ttf2woff(new Uint8Array(ttf.buffer))
}

/**
 * @param {string} svg
 * @param {number} size
 */
async function rasterize(svg, size) {
	// Render the vector at the target size instead of upscaling a 32 px bitmap.
	const density = (72 * size) / GRID
	return new Uint8Array(await sharp(Buffer.from(svg), { density }).resize(size, size).png().toBuffer())
}

async function main() {
	for (const asset of await buildBrandAssets()) {
		const target = path.join(PROJECT_ROOT, asset.file)
		await mkdir(path.dirname(target), { recursive: true })
		await writeFile(target, asset.content)
		console.log(`wrote ${asset.file}`)
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main()
}
