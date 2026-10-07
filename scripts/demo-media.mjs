#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import sharp from "sharp"
import { createCameraTrack, projectRect, toSourceCrop } from "./demo-camera.mjs"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.join(__dirname, "..")
const MANIFEST_DIR = path.join(PROJECT_ROOT, "tmp", "demo-media")
const DEFAULT_OUTPUT_DIR = path.join(PROJECT_ROOT, "assets", "docs", "marketplace")
const FRAME_ROOT = path.join(MANIFEST_DIR, "frames")
const PLAYWRIGHT_BROWSERS = path.join(PROJECT_ROOT, "node_modules", "playwright-core", "browsers.json")
const MAX_GIF_BYTES = 3_000_000
const MAX_GIF_DURATION_SECONDS = 20
const GIF_ENCODING_PROFILES = [
	{ name: "quality", dither: 0.75, interFrameMaxError: 4, interPaletteMaxError: 3 },
	{ name: "balanced", dither: 0.5, interFrameMaxError: 6, interPaletteMaxError: 4 },
	{ name: "compact", dither: 0.25, interFrameMaxError: 8, interPaletteMaxError: 6 },
]
const SPOTLIGHT_DIM_OPACITY = 0.45
const SPOTLIGHT_PADDING = 6
const SPOTLIGHT_RADIUS = 6
const SPOTLIGHT_RING_COLOR = "#3794ff"

function printUsage() {
	console.log(
		`Usage: node scripts/demo-media.mjs [options]\n\nOptions:\n  --id <asset-id>       Convert one manifest; may be repeated\n  --out-dir <path>      Override the output directory\n  --crop <x:y:w:h>      Override the manifest crop for all selected assets\n  --fps <number>        Override the manifest frame rate\n  --help                Show this help text`,
	)
}

function fail(message) {
	throw new Error(`demo-media: ${message}`)
}

function parsePositiveNumber(value, option) {
	const parsed = Number(value)
	if (!Number.isFinite(parsed) || parsed <= 0) fail(`${option} must be a positive number`)
	return parsed
}

function parseCrop(value) {
	const parts = value.split(":").map(Number)
	if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
		fail("--crop must use x:y:width:height with non-negative numbers")
	}
	const [x, y, width, height] = parts
	if (width <= 0 || height <= 0) fail("--crop width and height must be greater than zero")
	return { x, y, width, height }
}

function parseArguments(argv) {
	const result = { ids: [], outDir: DEFAULT_OUTPUT_DIR, crop: undefined, fps: undefined }
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index]
		if (argument === "--help") {
			printUsage()
			process.exit(0)
		}
		if (argument === "--id") {
			const id = argv[++index]
			if (!id) fail("--id requires an asset id")
			result.ids.push(id)
			continue
		}
		if (argument === "--out-dir") {
			const outDir = argv[++index]
			if (!outDir) fail("--out-dir requires a path")
			result.outDir = path.resolve(PROJECT_ROOT, outDir)
			continue
		}
		if (argument === "--crop") {
			const crop = argv[++index]
			if (!crop) fail("--crop requires x:y:width:height")
			result.crop = parseCrop(crop)
			continue
		}
		if (argument === "--fps") {
			const fps = argv[++index]
			if (!fps) fail("--fps requires a number")
			result.fps = parsePositiveNumber(fps, "--fps")
			continue
		}
		fail(`unknown option ${argument}`)
	}
	return result
}

function defaultPlaywrightCache() {
	if (process.platform === "win32") {
		return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "ms-playwright")
	}
	if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "ms-playwright")
	return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "ms-playwright")
}

function playwrightCacheRoot() {
	const configured = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim()
	if (!configured) return defaultPlaywrightCache()
	if (configured === "0") return path.join(PROJECT_ROOT, "node_modules", "playwright-core", ".local-browsers")
	return path.resolve(PROJECT_ROOT, configured)
}

function pathCandidates(directory, names) {
	return names.map((name) => path.join(directory, name))
}

function resolveFfmpeg() {
	const configured = process.env.DLINE_DEMO_FFMPEG?.trim()
	if (configured) {
		const resolved = path.resolve(PROJECT_ROOT, configured)
		if (!fs.existsSync(resolved)) fail(`DLINE_DEMO_FFMPEG does not exist: ${resolved}`)
		return resolved
	}

	const browsers = JSON.parse(fs.readFileSync(PLAYWRIGHT_BROWSERS, "utf8"))
	const ffmpeg = browsers.browsers.find((browser) => browser.name === "ffmpeg")
	if (!ffmpeg) fail(`Playwright ffmpeg metadata is missing from ${PLAYWRIGHT_BROWSERS}`)
	const ffmpegDir = path.join(playwrightCacheRoot(), `ffmpeg-${ffmpeg.revision}`)
	const executableNames =
		process.platform === "win32"
			? ["ffmpeg-win64.exe", "ffmpeg.exe"]
			: process.platform === "darwin"
				? ["ffmpeg-mac", "ffmpeg"]
				: ["ffmpeg-linux", "ffmpeg"]
	for (const candidate of pathCandidates(ffmpegDir, executableNames)) {
		if (fs.existsSync(candidate)) return candidate
	}

	for (const directory of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
		for (const candidate of pathCandidates(
			directory,
			process.platform === "win32" ? ["ffmpeg.exe", "ffmpeg.cmd"] : ["ffmpeg"],
		)) {
			if (fs.existsSync(candidate)) return candidate
		}
	}

	fail(
		`ffmpeg was not found. Expected Playwright ffmpeg under ${ffmpegDir}. ` +
			"Run the project's Playwright browser installation or set DLINE_DEMO_FFMPEG to an existing executable.",
	)
}

function selectedManifestPaths(ids) {
	if (!fs.existsSync(MANIFEST_DIR)) fail(`manifest directory does not exist: ${MANIFEST_DIR}`)
	if (ids.length > 0) return ids.map((id) => path.join(MANIFEST_DIR, `${id}.json`))
	return fs
		.readdirSync(MANIFEST_DIR)
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => path.join(MANIFEST_DIR, name))
}

function readManifest(manifestPath) {
	if (!fs.existsSync(manifestPath)) fail(`manifest does not exist: ${manifestPath}`)
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
	if (manifest.schemaVersion !== 1 || typeof manifest.id !== "string" || typeof manifest.sourceWebm !== "string") {
		fail(`invalid manifest: ${manifestPath}`)
	}
	if (!fs.existsSync(manifest.sourceWebm)) fail(`source recording does not exist: ${manifest.sourceWebm}`)
	return manifest
}

function runFfmpeg(ffmpegPath, args, action) {
	const result = spawnSync(ffmpegPath, args, { cwd: PROJECT_ROOT, encoding: "utf8" })
	if (result.error) fail(`${action} failed to start: ${result.error.message}`)
	if (result.status !== 0) {
		const diagnostic = [result.stdout, result.stderr].filter(Boolean).join("\n").trim()
		fail(`${action} exited with code ${result.status}${diagnostic ? `\n${diagnostic}` : ""}`)
	}
	return `${result.stdout || ""}\n${result.stderr || ""}`
}

function inspectMedia(ffmpegPath, mediaPath) {
	const result = spawnSync(ffmpegPath, ["-hide_banner", "-i", mediaPath], { cwd: PROJECT_ROOT, encoding: "utf8" })
	if (result.error) fail(`inspect ${mediaPath} failed to start: ${result.error.message}`)
	const output = `${result.stdout || ""}\n${result.stderr || ""}`
	const durationMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(output)
	const sizeMatch = /Video:.*?,\s*(\d{2,5})x(\d{2,5})(?:[,\s]|$)/.exec(output)
	const durationSeconds = durationMatch
		? Number(durationMatch[1]) * 3_600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
		: undefined
	return {
		durationSeconds,
		width: sizeMatch ? Number(sizeMatch[1]) : undefined,
		height: sizeMatch ? Number(sizeMatch[2]) : undefined,
	}
}

function evenFloor(value) {
	return Math.max(2, Math.floor(value / 2) * 2)
}

function scaleCrop(crop, viewport, source) {
	if (!crop) return undefined
	const scaleX = source.width / viewport.width
	const scaleY = source.height / viewport.height
	const x = Math.max(0, Math.floor((crop.x * scaleX) / 2) * 2)
	const y = Math.max(0, Math.floor((crop.y * scaleY) / 2) * 2)
	const width = Math.min(source.width - x, evenFloor(crop.width * scaleX))
	const height = Math.min(source.height - y, evenFloor(crop.height * scaleY))
	if (width <= 0 || height <= 0) fail("scaled crop is outside the recorded video")
	return { x, y, width, height }
}

function extractFrames(ffmpegPath, manifest, options, source) {
	const viewport = manifest.viewport ?? { width: 1_200, height: 900 }
	const crop = scaleCrop(options.crop ?? manifest.crop, viewport, source)
	const fps = options.fps ?? manifest.fps ?? 10
	const outputWidth = manifest.outputWidth ?? 1_200
	const frameDir = path.join(FRAME_ROOT, manifest.id)
	fs.rmSync(frameDir, { recursive: true, force: true })
	fs.mkdirSync(frameDir, { recursive: true })

	// A camera track crops every frame individually, so frames stay at source
	// resolution here and are reframed afterwards by applyCamera().
	const filters = []
	if (!manifest.camera) {
		if (crop) filters.push(`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`)
		filters.push(`scale=${outputWidth}:-1:flags=lanczos`)
	}
	const args = ["-hide_banner", "-loglevel", "warning"]
	if (manifest.trim?.fromEndSeconds) args.push("-sseof", `-${manifest.trim.fromEndSeconds}`)
	args.push("-i", manifest.sourceWebm)
	if (manifest.trim?.durationSeconds) args.push("-t", String(manifest.trim.durationSeconds))
	if (filters.length > 0) args.push("-vf", filters.join(","))
	args.push("-r", String(fps), "-y", path.join(frameDir, "frame-%04d.png"))
	runFfmpeg(ffmpegPath, args, `extract ${manifest.id} frames`)

	const framePaths = fs
		.readdirSync(frameDir)
		.filter((name) => name.endsWith(".png"))
		.sort()
		.map((name) => path.join(frameDir, name))
	if (framePaths.length === 0) fail(`${manifest.id} produced no PNG frames`)
	return { fps, frameDir, framePaths, outputWidth }
}

function evenRound(value) {
	return Math.max(2, Math.round(value / 2) * 2)
}

/**
 * Render an SVG that dims everything except the focused control and outlines it.
 * The cut-out uses an even-odd path so the control keeps its original pixels.
 */
function spotlightOverlay(focus, width, height) {
	const x = Math.max(0, focus.x - SPOTLIGHT_PADDING)
	const y = Math.max(0, focus.y - SPOTLIGHT_PADDING)
	const w = Math.min(width - x, focus.width + SPOTLIGHT_PADDING * 2)
	const h = Math.min(height - y, focus.height + SPOTLIGHT_PADDING * 2)
	const r = SPOTLIGHT_RADIUS
	const hole = `M${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h - r}A${r},${r} 0 0 1 ${x + w - r},${y + h}H${x + r}A${r},${r} 0 0 1 ${x},${y + h - r}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}Z`
	return Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
			`<path fill="#000" fill-opacity="${SPOTLIGHT_DIM_OPACITY}" fill-rule="evenodd" d="M0,0H${width}V${height}H0Z ${hole}"/>` +
			`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="none" stroke="${SPOTLIGHT_RING_COLOR}" stroke-width="2"/>` +
			"</svg>",
	)
}

/**
 * Reframe each extracted frame through the manifest camera track.
 * Frame N is sampled at N / fps seconds after the recording started.
 */
async function applyCamera(manifest, extracted, source) {
	const viewport = manifest.viewport ?? { width: 1_200, height: 900 }
	const track = createCameraTrack(manifest.camera)
	const width = extracted.outputWidth
	const height = evenRound(width / manifest.camera.aspectRatio)
	for (const [index, framePath] of extracted.framePaths.entries()) {
		const seconds = index / extracted.fps
		const frame = track.frameAt(seconds)
		const crop = toSourceCrop(frame, viewport, source)
		const pipeline = sharp(fs.readFileSync(framePath))
			.extract(crop)
			.resize(width, height, { fit: "fill", kernel: "lanczos3" })
		if (manifest.camera.spotlight) {
			const focus = projectRect(track.focusAt(seconds), frame, { width, height })
			pipeline.composite([{ input: spotlightOverlay(focus, width, height), top: 0, left: 0 }])
		}
		// Read and write through buffers so Windows never holds the file open while it is rewritten.
		fs.writeFileSync(framePath, await pipeline.png().toBuffer())
	}
}

async function encodeGif(framePaths, fps, outputPath, profile) {
	const delayMs = Math.max(20, Math.round(1_000 / fps))
	const frameDelays = Array(framePaths.length).fill(delayMs)
	await sharp(framePaths, { join: { animated: true } })
		.gif({
			loop: 0,
			delay: frameDelays,
			colours: 256,
			effort: 10,
			dither: profile.dither,
			interFrameMaxError: profile.interFrameMaxError,
			interPaletteMaxError: profile.interPaletteMaxError,
		})
		.toFile(outputPath)

	const metadata = await sharp(outputPath, { animated: true }).metadata()
	const encodedFrameCount = metadata.pages ?? framePaths.length
	const encodedDelays = metadata.delay ?? []
	if (encodedDelays.length !== encodedFrameCount || encodedDelays.some((delay) => delay <= 0)) {
		fail(`Sharp produced invalid frame delays for ${outputPath}`)
	}
	const durationSeconds = encodedDelays.reduce((total, delay) => total + delay, 0) / 1_000
	const height =
		metadata.pageHeight ??
		(metadata.height && encodedFrameCount > 0 ? Math.round(metadata.height / encodedFrameCount) : undefined)
	return { width: metadata.width, height, durationSeconds, encodedFrameCount }
}

async function convertManifest(ffmpegPath, manifest, options) {
	const source = inspectMedia(ffmpegPath, manifest.sourceWebm)
	if (!source.width || !source.height) fail(`${manifest.id} source dimensions could not be inspected`)
	const extracted = extractFrames(ffmpegPath, manifest, options, source)
	if (manifest.camera) await applyCamera(manifest, extracted, source)
	const outputPath = path.join(options.outDir, manifest.outputFile || `${manifest.id}.gif`)
	fs.mkdirSync(path.dirname(outputPath), { recursive: true })

	let encoded
	let bytes = Number.POSITIVE_INFINITY
	let encodingProfile = GIF_ENCODING_PROFILES[0]
	try {
		for (const [index, profile] of GIF_ENCODING_PROFILES.entries()) {
			encodingProfile = profile
			encoded = await encodeGif(extracted.framePaths, extracted.fps, outputPath, profile)
			bytes = fs.statSync(outputPath).size
			if (bytes <= MAX_GIF_BYTES) break

			const nextProfile = GIF_ENCODING_PROFILES[index + 1]
			if (nextProfile) {
				console.warn(
					`demo-media: ${manifest.id} produced ${(bytes / 1_000_000).toFixed(2)} MB with ${profile.name}; retrying with ${nextProfile.name}`,
				)
			}
		}
	} finally {
		fs.rmSync(extracted.frameDir, { recursive: true, force: true })
	}
	if (!encoded) fail(`${manifest.id} was not encoded`)

	console.log(
		`demo-media: ${manifest.id} -> ${path.relative(PROJECT_ROOT, outputPath)} ` +
			`(${encoded.width}x${encoded.height}, ${encoded.durationSeconds.toFixed(2)}s, ` +
			`${(bytes / 1_000_000).toFixed(2)} MB, ${encoded.encodedFrameCount} encoded frames, ` +
			`256 colors, ${encodingProfile.name} profile)`,
	)
	if (bytes > MAX_GIF_BYTES) fail(`${manifest.id} exceeds ${MAX_GIF_BYTES} bytes`)
	if (encoded.durationSeconds > MAX_GIF_DURATION_SECONDS) fail(`${manifest.id} exceeds ${MAX_GIF_DURATION_SECONDS} seconds`)
	if (encoded.width !== extracted.outputWidth) {
		fail(`${manifest.id} width is ${encoded.width}, expected ${extracted.outputWidth}`)
	}
}

try {
	const options = parseArguments(process.argv.slice(2))
	const manifests = selectedManifestPaths(options.ids)
	if (manifests.length === 0) fail(`no manifests found in ${MANIFEST_DIR}`)
	const ffmpegPath = resolveFfmpeg()
	console.log(`demo-media: using ffmpeg ${ffmpegPath}`)
	for (const manifestPath of manifests) await convertManifest(ffmpegPath, readManifest(manifestPath), options)
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error))
	process.exit(1)
}
