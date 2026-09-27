/**
 * Writes the full-page raden panel, src/assets/brand/raden.svg, from the
 * composition in scripts/lib/raden-panel.mjs. The output is deterministic;
 * a test fails when the committed file differs from the generator.
 *
 * Usage: npm run raden
 */
import { writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { renderRaden } from "./lib/raden-panel.mjs"

export const RADEN_SVG = fileURLToPath(new URL("../src/assets/brand/raden.svg", import.meta.url))

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const svg = renderRaden()
	await writeFile(RADEN_SVG, svg, "utf8")
	console.log(`Wrote ${RADEN_SVG} (${(svg.length / 1024).toFixed(1)} KB)`)
}
