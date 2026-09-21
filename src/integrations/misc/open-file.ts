import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import { TextDecoder } from "node:util"
import { getTaskTempSectionDirectoryFor, TaskTempSection } from "@core/storage/task-temp"
import * as path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/dline/host/window"

const IMAGE_VIEWER_DATA_URI_PATTERN = /^data:(image\/(?:png|jpeg|webp)|image\/svg\+xml);base64,([A-Za-z0-9+/]+={0,2})$/
const IMAGE_VIEWER_EXTENSIONS: Readonly<Record<string, string>> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/svg+xml": "svg",
}
const MAX_IMAGE_VIEWER_BYTES = 25 * 1024 * 1024
const SVG_ROOT_PATTERN = /^\s*<svg(?:\s|>)[\s\S]*<\/svg>\s*$/i
const UNSAFE_SVG_DECLARATION_PATTERN = /<!doctype|<!entity|<\?xml-stylesheet/i
const UNSAFE_SVG_ELEMENT_PATTERN =
	/<\s*(?:script|iframe|object|embed|audio|video|source|track|canvas|img|image|link|meta|base|form|input|button|textarea|select|option|animate|animatemotion|animatetransform|set)\b/i
const SVG_EVENT_ATTRIBUTE_PATTERN = /\son[a-z][\w:.-]*\s*=/i
const SVG_PROTOCOL_PATTERN = /(?:javascript|vbscript)\s*:/i
const SVG_IMPORT_PATTERN = /@import\b/i
const SVG_REFERENCE_ATTRIBUTE_PATTERN =
	/\b(?:href|xlink:href|src|srcset|action|formaction)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi
const SVG_CSS_URL_PATTERN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi
const viewerRootInitializations = new Map<string, Promise<void>>()

function assertInternalSvgReferences(svg: string): void {
	for (const match of svg.matchAll(SVG_REFERENCE_ATTRIBUTE_PATTERN)) {
		const value = (match[1] ?? match[2] ?? match[3] ?? "").trim()
		if (!value.startsWith("#")) {
			throw new Error("Unsafe SVG viewer reference")
		}
	}
	for (const match of svg.matchAll(SVG_CSS_URL_PATTERN)) {
		const value = (match[1] ?? match[2] ?? match[3] ?? "").trim()
		if (!value.startsWith("#")) {
			throw new Error("Unsafe SVG viewer reference")
		}
	}
}

function assertSafeSvgViewerContent(imageBuffer: Buffer): void {
	let svg: string
	try {
		svg = new TextDecoder("utf-8", { fatal: true }).decode(imageBuffer)
	} catch {
		throw new Error("Invalid SVG viewer content")
	}
	if (
		!SVG_ROOT_PATTERN.test(svg) ||
		UNSAFE_SVG_DECLARATION_PATTERN.test(svg) ||
		UNSAFE_SVG_ELEMENT_PATTERN.test(svg) ||
		SVG_EVENT_ATTRIBUTE_PATTERN.test(svg) ||
		SVG_PROTOCOL_PATTERN.test(svg) ||
		SVG_IMPORT_PATTERN.test(svg)
	) {
		throw new Error("Unsafe SVG viewer content")
	}
	assertInternalSvgReferences(svg)
}

function initializeViewerRoot(viewerRoot: string): Promise<void> {
	const existing = viewerRootInitializations.get(viewerRoot)
	if (existing) return existing
	const initialization = fs
		.rm(viewerRoot, { recursive: true, force: true })
		.then(() => fs.mkdir(viewerRoot, { recursive: true }))
		.then(() => undefined)
		.catch((error) => {
			viewerRootInitializations.delete(viewerRoot)
			throw error
		})
	viewerRootInitializations.set(viewerRoot, initialization)
	return initialization
}

export async function materializeTaskImageViewer(dataUri: string, taskDirectory: string): Promise<string> {
	const matches = IMAGE_VIEWER_DATA_URI_PATTERN.exec(dataUri)
	if (!matches || !path.isAbsolute(taskDirectory)) {
		throw new Error("Invalid task image viewer request")
	}
	const [, mimeType, base64Data] = matches
	const imageBuffer = Buffer.from(base64Data, "base64")
	if (
		imageBuffer.byteLength === 0 ||
		imageBuffer.byteLength > MAX_IMAGE_VIEWER_BYTES ||
		imageBuffer.toString("base64") !== base64Data
	) {
		throw new Error("Invalid image viewer content")
	}
	if (mimeType === "image/svg+xml") {
		assertSafeSvgViewerContent(imageBuffer)
	}
	const extension = IMAGE_VIEWER_EXTENSIONS[mimeType]
	const hash = createHash("sha256").update(imageBuffer).digest("hex")
	const viewerRoot = getTaskTempSectionDirectoryFor(taskDirectory, TaskTempSection.ImageViewer)
	const viewerFilePath = path.join(viewerRoot, `${hash}.${extension}`)
	await initializeViewerRoot(viewerRoot)
	await fs.writeFile(viewerFilePath, imageBuffer)
	return viewerFilePath
}

export async function openImage(dataUri: string, taskDirectory: string) {
	try {
		const viewerFilePath = await materializeTaskImageViewer(dataUri, taskDirectory)
		await HostProvider.window.openFile({ filePath: viewerFilePath })
	} catch (error) {
		HostProvider.window.showMessage({
			type: ShowMessageType.ERROR,
			message: `Error opening image: ${error}`,
		})
	}
}

/**
 * File extensions opened through the generic `vscode.open` command because
 * the text editor cannot display them (binary/media/document files).
 */
const GENERIC_OPEN_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".webp",
	".gif",
	".bmp",
	".svg",
	".ico",
	".pdf",
	".doc",
	".docx",
	".xls",
	".xlsx",
	".ppt",
	".pptx",
	".zip",
	".gz",
	".tar",
])

/**
 * Decides whether a file should be opened through the generic open command
 * instead of the text editor. Text files stay on the text editor path so
 * line-number selection keeps working.
 */
export function shouldOpenViaGenericCommand(absolutePath: string): boolean {
	const extension = path.extname(absolutePath).toLowerCase()
	return GENERIC_OPEN_EXTENSIONS.has(extension)
}

export async function openFile(absolutePath: string, preserveFocus = false, preview = false, lineNumber?: number) {
	try {
		if (!existsSync(absolutePath)) {
			return
		}
		if (shouldOpenViaGenericCommand(absolutePath)) {
			await HostProvider.window.openFile({ filePath: absolutePath })
			return
		}
		const options: Record<string, unknown> = {
			preserveFocus: lineNumber ? true : preserveFocus,
			preview,
		}
		if (lineNumber && lineNumber > 0) {
			options.selection = { start: { line: lineNumber - 1, character: 0 }, end: { line: lineNumber - 1, character: 0 } }
		}
		await HostProvider.window.showTextDocument({
			path: absolutePath,
			options,
		})
	} catch (_error) {
		HostProvider.window.showMessage({
			type: ShowMessageType.ERROR,
			message: `Could not open file!`,
		})
	}
}
