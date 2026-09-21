import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { getTaskTempSectionDirectoryFor, TaskTempSection } from "@core/storage/task-temp"
import { imageSize } from "image-size"
import { ArtifactStoreError } from "./TaskArtifactStore"

const PREVIEW_ID_PATTERN = /^image-preview:sha256:([a-f0-9]{64})$/
const STRICT_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const MAX_PREVIEW_BYTES = 25 * 1024 * 1024
const previewRootInitializations = new Map<string, Promise<void>>()

function initializePreviewRoot(previewRoot: string): Promise<void> {
	const existing = previewRootInitializations.get(previewRoot)
	if (existing) return existing
	const initialization = fs
		.rm(previewRoot, { recursive: true, force: true })
		.then(() => fs.mkdir(previewRoot, { recursive: true }))
		.then(() => undefined)
		.catch((error) => {
			previewRootInitializations.delete(previewRoot)
			throw error
		})
	previewRootInitializations.set(previewRoot, initialization)
	return initialization
}

export type ImagePreviewMimeType = "image/png" | "image/jpeg" | "image/webp"

export interface ImagePreview {
	readonly id: string
	readonly mimeType: ImagePreviewMimeType
	readonly width: number
	readonly height: number
	readonly sequence: number
}

export interface ResolvedImagePreview {
	readonly preview: ImagePreview
	readonly bytes: Uint8Array
	readonly absolutePath: string
}

function detectPreviewMimeType(buffer: Buffer): ImagePreviewMimeType | undefined {
	if (buffer.byteLength >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
		return "image/png"
	}
	if (buffer.byteLength >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
		return "image/jpeg"
	}
	if (buffer.byteLength >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
		return "image/webp"
	}
	return undefined
}

/** Ephemeral task-owned storage for provider partial images. */
export class TaskImagePreviewStore {
	private readonly previewRoot: string
	private readonly pathsByRequest = new Map<string, Set<string>>()

	constructor(taskDirectory: string) {
		if (!path.isAbsolute(taskDirectory)) {
			throw new ArtifactStoreError("invalid_configuration", "Image preview task directory must be absolute.")
		}
		this.previewRoot = getTaskTempSectionDirectoryFor(taskDirectory, TaskTempSection.ImagePreviews)
	}

	async persistPreview(requestId: string, sequence: number, base64: string): Promise<ImagePreview> {
		if (!requestId || !Number.isSafeInteger(sequence) || sequence < 0) {
			throw new ArtifactStoreError("invalid_configuration", "Image preview identity is invalid.")
		}
		if (!base64 || base64.length % 4 !== 0 || !STRICT_BASE64_PATTERN.test(base64)) {
			throw new ArtifactStoreError("invalid_base64", "Provider image preview is not valid base64.")
		}
		const buffer = Buffer.from(base64, "base64")
		if (buffer.toString("base64") !== base64) {
			throw new ArtifactStoreError("invalid_base64", "Provider image preview is not canonical base64.")
		}
		if (buffer.byteLength > MAX_PREVIEW_BYTES) {
			throw new ArtifactStoreError("artifact_size_exceeded", "Image preview exceeds the byte limit.")
		}
		const mimeType = detectPreviewMimeType(buffer)
		if (!mimeType) {
			throw new ArtifactStoreError("unsupported_format", "Image previews must be PNG, JPEG, or WebP.")
		}
		const dimensions = imageSize(buffer)
		if (!dimensions.width || !dimensions.height) {
			throw new ArtifactStoreError("invalid_image", "Image preview dimensions are invalid.")
		}
		const hash = createHash("sha256").update(buffer).digest("hex")
		const id = `image-preview:sha256:${hash}`
		await initializePreviewRoot(this.previewRoot)
		const absolutePath = path.join(this.previewRoot, hash)
		await fs.writeFile(absolutePath, buffer)
		const requestPaths = this.pathsByRequest.get(requestId) ?? new Set<string>()
		requestPaths.add(absolutePath)
		this.pathsByRequest.set(requestId, requestPaths)
		return { id, mimeType, width: dimensions.width, height: dimensions.height, sequence }
	}

	async readPreview(previewId: string): Promise<ResolvedImagePreview> {
		const match = PREVIEW_ID_PATTERN.exec(previewId)
		if (!match) throw new ArtifactStoreError("invalid_artifact_id", "Image preview ID is invalid.")
		await initializePreviewRoot(this.previewRoot)
		const absolutePath = path.join(this.previewRoot, match[1])
		// Previews are deleted as soon as their request stops running, so a missing
		// file is an expected outcome rather than a defect. The native error is not
		// propagated because it carries the host's absolute path into the log
		// channel and the webview.
		const buffer = await fs.readFile(absolutePath).catch(() => {
			throw new ArtifactStoreError("artifact_not_found", "Image preview is no longer available.")
		})
		const actualHash = createHash("sha256").update(buffer).digest("hex")
		if (actualHash !== match[1]) {
			throw new ArtifactStoreError("artifact_integrity_failed", "Image preview hash does not match its ID.")
		}
		const mimeType = detectPreviewMimeType(buffer)
		if (!mimeType) {
			throw new ArtifactStoreError("unsupported_format", "Image previews must be PNG, JPEG, or WebP.")
		}
		const dimensions = imageSize(buffer)
		if (!dimensions.width || !dimensions.height) {
			throw new ArtifactStoreError("invalid_image", "Image preview dimensions are invalid.")
		}
		return {
			preview: { id: previewId, mimeType, width: dimensions.width, height: dimensions.height, sequence: 0 },
			bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
			absolutePath,
		}
	}

	async clearRequest(requestId: string): Promise<void> {
		const paths = this.pathsByRequest.get(requestId)
		this.pathsByRequest.delete(requestId)
		if (!paths) return
		await Promise.all([...paths].map((filePath) => fs.unlink(filePath).catch(() => undefined)))
	}
}
