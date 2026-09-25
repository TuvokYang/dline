import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Frame, Locator, Page } from "@playwright/test"
import sharp from "sharp"
import { E2ETestHelper } from "../../utils/helpers"
import { dismissDemoNotifications } from "./png-asset"

/** Documentation screenshots are served from the Starlight public directory. */
export const DOC_UI_ASSET_DIR = path.join(E2ETestHelper.CODEBASE_ROOT_DIR, "docs", "public", "assets", "ui")

const REGION_PADDING = 12
const MARKER_RADIUS = 9
const MARKER_GAP = 3
const MARKER_COLOR = "#e5484d"
const MARKER_MAX_BYTES = 400_000

interface Rect {
	x: number
	y: number
	width: number
	height: number
}

export interface DocMarker {
	label: string
	target: Locator
}

export interface DocCaptureOptions {
	/** Area of the window to keep; the union of these boxes plus padding becomes the image. */
	regions: Locator[]
	/** Numbered callouts drawn next to each target, in reading order. */
	markers?: DocMarker[]
	padding?: number
}

async function requireBox(locator: Locator, label: string): Promise<Rect> {
	const box = await locator.boundingBox()
	if (!box) throw new Error(`Documentation capture target "${label}" is not visible`)
	return box
}

function unionRect(rects: Rect[]): Rect {
	const left = Math.min(...rects.map((rect) => rect.x))
	const top = Math.min(...rects.map((rect) => rect.y))
	const right = Math.max(...rects.map((rect) => rect.x + rect.width))
	const bottom = Math.max(...rects.map((rect) => rect.y + rect.height))
	return { x: left, y: top, width: right - left, height: bottom - top }
}

function clipToPage(rect: Rect, padding: number, viewport: { width: number; height: number }): Rect {
	const x = Math.max(0, Math.floor(rect.x - padding))
	const y = Math.max(0, Math.floor(rect.y - padding))
	return {
		x,
		y,
		width: Math.min(viewport.width - x, Math.ceil(rect.width + padding * 2)),
		height: Math.min(viewport.height - y, Math.ceil(rect.height + padding * 2)),
	}
}

function escapeXml(value: string): string {
	return value.replace(/[<>&"']/g, (character) => `&#${character.charCodeAt(0)};`)
}

/**
 * Draw a numbered badge centred above each marker target so small icons stay visible.
 * Badges are clamped inside the image so a control at the edge keeps a readable label.
 */
function markerOverlay(markers: { label: string; box: Rect }[], clip: Rect): Buffer {
	const circles = markers
		.map(({ label, box }) => {
			const centerX = box.x - clip.x + box.width / 2
			const centerY = box.y - clip.y - MARKER_RADIUS - MARKER_GAP
			const cx = Math.min(Math.max(centerX, MARKER_RADIUS + 1), clip.width - MARKER_RADIUS - 1)
			const cy = Math.min(Math.max(centerY, MARKER_RADIUS + 1), clip.height - MARKER_RADIUS - 1)
			return (
				`<circle cx="${cx}" cy="${cy}" r="${MARKER_RADIUS}" fill="${MARKER_COLOR}" stroke="#fff" stroke-width="1.5"/>` +
				`<text x="${cx}" y="${cy + 4}" font-family="Segoe UI, Arial, sans-serif" font-size="11" font-weight="700" fill="#fff" text-anchor="middle">${escapeXml(label)}</text>`
			)
		})
		.join("")
	return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${clip.width}" height="${clip.height}">${circles}</svg>`)
}

/**
 * Remove transient chrome that would otherwise leak into a static screenshot:
 * notifications, hover tooltips, focus rings, and the blinking text caret.
 */
async function settleForStill(page: Page, frames: Frame[]): Promise<void> {
	await dismissDemoNotifications(page)
	await page.mouse.move(2, 2)
	for (const frame of frames) {
		await frame.evaluate(() => {
			const active = document.activeElement
			if (active instanceof HTMLElement) active.blur()
			const styleId = "dline-doc-capture-still"
			if (!document.getElementById(styleId)) {
				const style = document.createElement("style")
				style.id = styleId
				style.textContent = "* { caret-color: transparent !important; }"
				document.head.append(style)
			}
		})
	}
	await page.waitForTimeout(300)
}

/**
 * Capture a cropped, optionally numbered screenshot of real VS Code UI into the docs site.
 * Coordinates come from live bounding boxes, so labels always match the rendered controls.
 */
export async function captureDocScreenshot(
	page: Page,
	frame: Frame,
	id: string,
	options: DocCaptureOptions,
): Promise<{ path: string; width: number; height: number; bytes: number }> {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`Invalid documentation asset id: ${id}`)
	await settleForStill(page, [frame])

	const viewport = page.viewportSize()
	if (!viewport) throw new Error("Documentation capture requires a fixed viewport")
	const regionBoxes = await Promise.all(options.regions.map((region, index) => requireBox(region, `region ${index + 1}`)))
	const markers = await Promise.all(
		(options.markers ?? []).map(async (marker) => ({
			label: marker.label,
			box: await requireBox(marker.target, marker.label),
		})),
	)
	// Reserve room above the highest marker so its badge is never clipped.
	const markerHeadroom = markers.map(({ box }) => ({ ...box, y: box.y - MARKER_RADIUS * 2 - MARKER_GAP, height: 1 }))
	const clip = clipToPage(unionRect([...regionBoxes, ...markerHeadroom]), options.padding ?? REGION_PADDING, viewport)

	const raw = await page.screenshot({ clip, animations: "disabled" })
	const image = sharp(raw)
	if (markers.length > 0) image.composite([{ input: markerOverlay(markers, clip), top: 0, left: 0 }])
	const { data, info } = await image
		.png({ compressionLevel: 9, adaptiveFiltering: true, palette: true, quality: 100, colours: 256, effort: 10 })
		.toBuffer({ resolveWithObject: true })
	if (data.byteLength > MARKER_MAX_BYTES) {
		throw new Error(`Documentation PNG ${id} is ${data.byteLength} bytes, exceeding ${MARKER_MAX_BYTES}`)
	}

	await mkdir(DOC_UI_ASSET_DIR, { recursive: true })
	const outputPath = path.join(DOC_UI_ASSET_DIR, `${id}.png`)
	await writeFile(outputPath, data)
	return { path: outputPath, width: info.width, height: info.height, bytes: data.byteLength }
}
