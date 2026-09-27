import { removeStaleAtomicTempFiles, writeFileAtomic } from "@shared/storage/atomic-file"
import { createHash } from "crypto"
import type { Stats } from "fs"
import fs from "fs/promises"
import { imageSize } from "image-size"
import path from "path"

const ARTIFACT_MANIFEST_SCHEMA_VERSION = 1 as const
const IMAGE_ARTIFACT_SCHEMA_VERSION = 1 as const
const ARTIFACT_ID_PATTERN = /^image:sha256:([a-f0-9]{64})$/
/** Temporary suffix of the writer that predates the shared atomic-file primitive. */
const LEGACY_PARTIAL_SUFFIX = ".partial"

export type ImageArtifactFormat = "png" | "jpeg" | "webp"

export type ArtifactStoreErrorCode =
	| "invalid_configuration"
	| "invalid_artifact_id"
	| "artifact_not_found"
	| "unsupported_format"
	| "mime_type_mismatch"
	| "invalid_image"
	| "artifact_size_exceeded"
	| "task_quota_exceeded"
	| "image_dimensions_exceeded"
	| "image_pixels_exceeded"
	| "invalid_base64"
	| "unsafe_artifact_url"
	| "url_download_unavailable"
	| "unsupported_manifest_version"
	| "invalid_manifest"
	| "artifact_integrity_failed"
	| "artifact_io_error"

export class ArtifactStoreError extends Error {
	readonly code: ArtifactStoreErrorCode

	constructor(code: ArtifactStoreErrorCode, message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = "ArtifactStoreError"
		this.code = code
	}
}

export interface ImageArtifactProvenance {
	providerId?: string
	modelId?: string
	requestId?: string
	providerOutputId?: string
	revisedPrompt?: string
	sourceKind?: "bytes" | "base64" | "url"
	parentArtifactIds?: string[]
}

export interface ImageArtifact {
	schemaVersion: typeof IMAGE_ARTIFACT_SCHEMA_VERSION
	id: string
	kind: "image"
	sha256: string
	mimeType: string
	format: ImageArtifactFormat
	byteLength: number
	width: number
	height: number
	relativePath: string
	createdAtMs: number
	provenance?: ImageArtifactProvenance
}

interface ArtifactManifestV1 {
	schemaVersion: typeof ARTIFACT_MANIFEST_SCHEMA_VERSION
	taskId: string
	artifacts: ImageArtifact[]
}

export interface TaskArtifactStoreLimits {
	maxArtifactBytes: number
	maxTaskBytes: number
	maxWidth: number
	maxHeight: number
	maxPixels: number
	stalePartialAgeMs: number
}

export interface TaskArtifactStoreOptions {
	taskId: string
	taskDirectory: string
	limits?: Partial<TaskArtifactStoreLimits>
	now?: () => number
}

export interface StoreImageInput {
	bytes: Uint8Array
	declaredMimeType: string
	provenance?: ImageArtifactProvenance
}

export interface ResolvedImageArtifact {
	artifact: ImageArtifact
	bytes: Uint8Array
	absolutePath: string
}

const DEFAULT_LIMITS: TaskArtifactStoreLimits = {
	maxArtifactBytes: 25 * 1024 * 1024,
	maxTaskBytes: 250 * 1024 * 1024,
	maxWidth: 4096,
	maxHeight: 4096,
	maxPixels: 16_777_216,
	stalePartialAgeMs: 60_000,
}

const FORMAT_METADATA: Record<ImageArtifactFormat, { mimeType: string; extension: string }> = {
	png: { mimeType: "image/png", extension: "png" },
	jpeg: { mimeType: "image/jpeg", extension: "jpeg" },
	webp: { mimeType: "image/webp", extension: "webp" },
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isSafePositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function isSafeNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function normalizeMimeType(value: string): string {
	return value.trim().toLowerCase().split(";", 1)[0]
}

function detectFormat(bytes: Uint8Array): ImageArtifactFormat | undefined {
	if (
		bytes.byteLength >= 24 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	) {
		return "png"
	}
	if (bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "jpeg"
	}
	if (
		bytes.byteLength >= 30 &&
		Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
		Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP" &&
		Buffer.from(bytes.subarray(12, 15)).toString("ascii") === "VP8"
	) {
		return "webp"
	}
	return undefined
}

function artifactIdForHash(sha256: string): string {
	return `image:sha256:${sha256}`
}

function expectedRelativePath(sha256: string, format: ImageArtifactFormat): string {
	return `images/${sha256}.${FORMAT_METADATA[format].extension}`
}

function parseArtifactId(artifactId: string): string {
	const match = ARTIFACT_ID_PATTERN.exec(artifactId)
	if (!match) {
		throw new ArtifactStoreError("invalid_artifact_id", "Image artifact ID is invalid.")
	}
	return match[1]
}

function validateLimits(limits: TaskArtifactStoreLimits): void {
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value <= 0) {
			throw new ArtifactStoreError("invalid_configuration", `Artifact store limit ${name} must be a positive integer.`)
		}
	}
}

function validateProvenance(value: unknown): ImageArtifactProvenance | undefined {
	if (value === undefined) return undefined
	if (!isRecord(value)) throw new ArtifactStoreError("invalid_manifest", "Image artifact provenance is invalid.")
	const allowedKeys = new Set([
		"providerId",
		"modelId",
		"requestId",
		"providerOutputId",
		"revisedPrompt",
		"sourceKind",
		"parentArtifactIds",
	])
	for (const key of Object.keys(value)) {
		if (!allowedKeys.has(key)) {
			throw new ArtifactStoreError("invalid_manifest", `Image artifact provenance field ${key} is not supported.`)
		}
	}
	for (const key of ["providerId", "modelId", "requestId", "providerOutputId", "revisedPrompt", "sourceKind"] as const) {
		if (value[key] !== undefined && typeof value[key] !== "string") {
			throw new ArtifactStoreError("invalid_manifest", `Image artifact provenance field ${key} is invalid.`)
		}
	}
	if (
		value.sourceKind !== undefined &&
		value.sourceKind !== "bytes" &&
		value.sourceKind !== "base64" &&
		value.sourceKind !== "url"
	) {
		throw new ArtifactStoreError("invalid_manifest", "Image artifact provenance source kind is invalid.")
	}
	let parentArtifactIds: string[] | undefined
	if (value.parentArtifactIds !== undefined) {
		if (!Array.isArray(value.parentArtifactIds)) {
			throw new ArtifactStoreError("invalid_manifest", "Image artifact parent IDs must be an array.")
		}
		parentArtifactIds = []
		const seen = new Set<string>()
		for (const artifactId of value.parentArtifactIds) {
			if (typeof artifactId !== "string") {
				throw new ArtifactStoreError("invalid_manifest", "Image artifact parent ID is invalid.")
			}
			try {
				parseArtifactId(artifactId)
			} catch {
				throw new ArtifactStoreError("invalid_manifest", "Image artifact parent ID is invalid.")
			}
			if (seen.has(artifactId)) {
				throw new ArtifactStoreError("invalid_manifest", "Image artifact parent IDs contain duplicates.")
			}
			seen.add(artifactId)
			parentArtifactIds.push(artifactId)
		}
	}
	return {
		...(value as ImageArtifactProvenance),
		...(parentArtifactIds ? { parentArtifactIds } : {}),
	}
}

function validateManifestArtifact(value: unknown): ImageArtifact {
	if (!isRecord(value)) throw new ArtifactStoreError("invalid_manifest", "Image artifact manifest entry is invalid.")
	if (value.schemaVersion !== IMAGE_ARTIFACT_SCHEMA_VERSION || value.kind !== "image") {
		throw new ArtifactStoreError("invalid_manifest", "Image artifact manifest entry version or kind is invalid.")
	}
	if (typeof value.id !== "string" || typeof value.sha256 !== "string") {
		throw new ArtifactStoreError("invalid_manifest", "Image artifact identity is invalid.")
	}
	const hashFromId = parseArtifactId(value.id)
	if (hashFromId !== value.sha256) {
		throw new ArtifactStoreError("invalid_manifest", "Image artifact ID does not match its content hash.")
	}
	if (value.format !== "png" && value.format !== "jpeg" && value.format !== "webp") {
		throw new ArtifactStoreError("invalid_manifest", "Image artifact format is invalid.")
	}
	const expectedMetadata = FORMAT_METADATA[value.format]
	if (value.mimeType !== expectedMetadata.mimeType) {
		throw new ArtifactStoreError("invalid_manifest", "Image artifact MIME type does not match its format.")
	}
	if (value.relativePath !== expectedRelativePath(value.sha256, value.format)) {
		throw new ArtifactStoreError("invalid_manifest", "Image artifact path is outside the managed artifact layout.")
	}
	if (
		!isSafeNonNegativeInteger(value.byteLength) ||
		!isSafePositiveInteger(value.width) ||
		!isSafePositiveInteger(value.height) ||
		!isSafeNonNegativeInteger(value.createdAtMs)
	) {
		throw new ArtifactStoreError("invalid_manifest", "Image artifact numeric metadata is invalid.")
	}
	return {
		schemaVersion: IMAGE_ARTIFACT_SCHEMA_VERSION,
		id: value.id,
		kind: "image",
		sha256: value.sha256,
		mimeType: value.mimeType,
		format: value.format,
		byteLength: value.byteLength,
		width: value.width,
		height: value.height,
		relativePath: value.relativePath,
		createdAtMs: value.createdAtMs,
		provenance: validateProvenance(value.provenance),
	}
}

function cloneProvenance(provenance: ImageArtifactProvenance): ImageArtifactProvenance {
	return {
		...provenance,
		...(provenance.parentArtifactIds ? { parentArtifactIds: [...provenance.parentArtifactIds] } : {}),
	}
}

function cloneArtifact(artifact: ImageArtifact): ImageArtifact {
	const clone: ImageArtifact = { ...artifact }
	if (artifact.provenance) {
		clone.provenance = cloneProvenance(artifact.provenance)
	} else {
		delete clone.provenance
	}
	return clone
}

export class TaskArtifactStore {
	private readonly taskId: string
	private readonly taskDirectory: string
	private readonly artifactRoot: string
	private readonly imagesDirectory: string
	private readonly manifestPath: string
	private readonly limits: TaskArtifactStoreLimits
	private readonly now: () => number
	private operationTail: Promise<void> = Promise.resolve()

	constructor(options: TaskArtifactStoreOptions) {
		if (!options.taskId.trim()) {
			throw new ArtifactStoreError("invalid_configuration", "Artifact store task ID must not be empty.")
		}
		if (!path.isAbsolute(options.taskDirectory)) {
			throw new ArtifactStoreError("invalid_configuration", "Artifact store task directory must be absolute.")
		}
		this.taskId = options.taskId
		this.taskDirectory = path.resolve(options.taskDirectory)
		this.artifactRoot = path.join(this.taskDirectory, "artifacts")
		this.imagesDirectory = path.join(this.artifactRoot, "images")
		this.manifestPath = path.join(this.artifactRoot, "manifest.json")
		this.limits = { ...DEFAULT_LIMITS, ...options.limits }
		this.now = options.now ?? Date.now
		validateLimits(this.limits)
	}

	async storeImage(input: StoreImageInput, signal?: AbortSignal): Promise<ImageArtifact> {
		const [artifact] = await this.storeImages([input], signal)
		return artifact
	}

	async storeImages(inputs: readonly StoreImageInput[], signal?: AbortSignal): Promise<ImageArtifact[]> {
		if (inputs.length === 0) return []
		return this.runExclusive(async () => {
			this.throwIfAborted(signal)
			const validatedInputs = inputs.map((input) => ({
				provenance: validateProvenance(input.provenance),
				validated: this.validateImage(input),
			}))
			await this.ensureManagedDirectories()
			const manifest = await this.loadManifest()
			const artifactsByHash = new Map(manifest.artifacts.map((artifact) => [artifact.sha256, artifact]))
			const pendingByHash = new Map<string, { artifact: ImageArtifact; bytes: Uint8Array }>()

			for (const { provenance, validated } of validatedInputs) {
				const existing = artifactsByHash.get(validated.sha256)
				if (existing) {
					await this.readAndVerifyArtifact(existing)
					continue
				}
				if (pendingByHash.has(validated.sha256)) continue
				const artifact: ImageArtifact = {
					schemaVersion: IMAGE_ARTIFACT_SCHEMA_VERSION,
					id: artifactIdForHash(validated.sha256),
					kind: "image",
					sha256: validated.sha256,
					mimeType: validated.mimeType,
					format: validated.format,
					byteLength: validated.bytes.byteLength,
					width: validated.width,
					height: validated.height,
					relativePath: expectedRelativePath(validated.sha256, validated.format),
					createdAtMs: this.now(),
					provenance: provenance ? cloneProvenance(provenance) : undefined,
				}
				pendingByHash.set(validated.sha256, { artifact, bytes: validated.bytes })
				artifactsByHash.set(validated.sha256, artifact)
			}

			const usedBytes = manifest.artifacts.reduce((total, artifact) => total + artifact.byteLength, 0)
			const pendingBytes = [...pendingByHash.values()].reduce((total, pending) => total + pending.artifact.byteLength, 0)
			if (usedBytes + pendingBytes > this.limits.maxTaskBytes) {
				throw new ArtifactStoreError("task_quota_exceeded", "Image artifact task byte quota would be exceeded.")
			}

			const createdPaths: string[] = []
			try {
				for (const { artifact, bytes } of pendingByHash.values()) {
					this.throwIfAborted(signal)
					const finalPath = this.resolveManagedArtifactPath(artifact)
					if (!(await this.pathExists(finalPath))) {
						await writeFileAtomic(finalPath, bytes)
						createdPaths.push(finalPath)
					} else {
						await this.verifyFileHash(finalPath, artifact)
					}
				}
				this.throwIfAborted(signal)
				manifest.artifacts.push(...[...pendingByHash.values()].map(({ artifact }) => artifact))
				await this.writeManifest(manifest)
				return validatedInputs.map(({ validated }) => cloneArtifact(artifactsByHash.get(validated.sha256)!))
			} catch (error) {
				await Promise.all(createdPaths.map((createdPath) => fs.unlink(createdPath).catch(() => undefined)))
				if (error instanceof ArtifactStoreError) throw error
				throw new ArtifactStoreError("artifact_io_error", "Failed to persist the image artifact batch.", { cause: error })
			}
		})
	}

	async listImages(): Promise<ImageArtifact[]> {
		return this.runExclusive(async () => {
			await this.ensureManagedDirectories()
			const manifest = await this.loadManifest()
			return manifest.artifacts.map(cloneArtifact)
		})
	}

	async getImage(artifactId: string): Promise<ImageArtifact> {
		return this.runExclusive(async () => {
			parseArtifactId(artifactId)
			await this.ensureManagedDirectories()
			const manifest = await this.loadManifest()
			const artifact = manifest.artifacts.find((entry) => entry.id === artifactId)
			if (!artifact) {
				throw new ArtifactStoreError("artifact_not_found", "Image artifact was not found in this task.")
			}
			return cloneArtifact(artifact)
		})
	}

	async readImage(artifactId: string): Promise<ResolvedImageArtifact> {
		return this.runExclusive(async () => {
			parseArtifactId(artifactId)
			await this.ensureManagedDirectories()
			const manifest = await this.loadManifest()
			const artifact = manifest.artifacts.find((entry) => entry.id === artifactId)
			if (!artifact) {
				throw new ArtifactStoreError("artifact_not_found", "Image artifact was not found in this task.")
			}
			const result = await this.readAndVerifyArtifact(artifact)
			return { artifact: cloneArtifact(artifact), bytes: result.bytes, absolutePath: result.absolutePath }
		})
	}

	private validateImage(input: StoreImageInput): {
		bytes: Uint8Array
		sha256: string
		format: ImageArtifactFormat
		mimeType: string
		width: number
		height: number
	} {
		const bytes = new Uint8Array(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength)
		if (bytes.byteLength > this.limits.maxArtifactBytes) {
			throw new ArtifactStoreError("artifact_size_exceeded", "Image artifact exceeds the per-file byte limit.")
		}
		const format = detectFormat(bytes)
		if (!format) {
			throw new ArtifactStoreError("unsupported_format", "Only PNG, JPEG, and WebP image artifacts are supported.")
		}
		const mimeType = normalizeMimeType(input.declaredMimeType)
		if (mimeType !== FORMAT_METADATA[format].mimeType) {
			throw new ArtifactStoreError("mime_type_mismatch", "Declared image MIME type does not match the file signature.")
		}

		let dimensions: ReturnType<typeof imageSize>
		try {
			dimensions = imageSize(bytes)
		} catch (error) {
			throw new ArtifactStoreError("invalid_image", "Image dimensions could not be decoded safely.", { cause: error })
		}
		if (!isSafePositiveInteger(dimensions.width) || !isSafePositiveInteger(dimensions.height)) {
			throw new ArtifactStoreError("invalid_image", "Image dimensions are missing or invalid.")
		}
		if (dimensions.width > this.limits.maxWidth || dimensions.height > this.limits.maxHeight) {
			throw new ArtifactStoreError("image_dimensions_exceeded", "Image dimensions exceed the configured limit.")
		}
		if (dimensions.width * dimensions.height > this.limits.maxPixels) {
			throw new ArtifactStoreError("image_pixels_exceeded", "Image pixel count exceeds the configured limit.")
		}
		return {
			bytes,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			format,
			mimeType,
			width: dimensions.width,
			height: dimensions.height,
		}
	}

	private async ensureManagedDirectories(): Promise<void> {
		await fs.mkdir(this.taskDirectory, { recursive: true })
		await this.assertDirectoryIsNotSymlink(this.taskDirectory)
		await fs.mkdir(this.artifactRoot, { recursive: true })
		await this.assertDirectoryIsNotSymlink(this.artifactRoot)
		await fs.mkdir(this.imagesDirectory, { recursive: true })
		await this.assertDirectoryIsNotSymlink(this.imagesDirectory)
		await this.cleanupStalePartialFiles(this.artifactRoot)
		await this.cleanupStalePartialFiles(this.imagesDirectory)
	}

	private async assertDirectoryIsNotSymlink(directoryPath: string): Promise<void> {
		const stats = await fs.lstat(directoryPath)
		if (!stats.isDirectory() || stats.isSymbolicLink()) {
			throw new ArtifactStoreError("artifact_integrity_failed", "Managed artifact directory is not a regular directory.")
		}
	}

	private async cleanupStalePartialFiles(directoryPath: string): Promise<void> {
		await removeStaleAtomicTempFiles(directoryPath, this.limits.stalePartialAgeMs, this.now())
		const entries = await fs.readdir(directoryPath, { withFileTypes: true })
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(LEGACY_PARTIAL_SUFFIX)) continue
			const partialPath = path.join(directoryPath, entry.name)
			const stats = await fs.stat(partialPath)
			if (this.now() - stats.mtimeMs >= this.limits.stalePartialAgeMs) {
				await fs.unlink(partialPath).catch(() => undefined)
			}
		}
	}

	private async loadManifest(): Promise<ArtifactManifestV1> {
		let raw: string
		try {
			raw = await fs.readFile(this.manifestPath, "utf8")
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				const emptyManifest: ArtifactManifestV1 = {
					schemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION,
					taskId: this.taskId,
					artifacts: [],
				}
				await this.cleanupOrphanImageFiles(emptyManifest)
				return emptyManifest
			}
			throw new ArtifactStoreError("artifact_io_error", "Failed to read the artifact manifest.", { cause: error })
		}

		let parsed: unknown
		try {
			parsed = JSON.parse(raw)
		} catch (error) {
			throw new ArtifactStoreError("invalid_manifest", "Artifact manifest is not valid JSON.", { cause: error })
		}
		if (!isRecord(parsed)) {
			throw new ArtifactStoreError("invalid_manifest", "Artifact manifest must be an object.")
		}
		if (parsed.schemaVersion !== ARTIFACT_MANIFEST_SCHEMA_VERSION) {
			throw new ArtifactStoreError("unsupported_manifest_version", "Artifact manifest version is not supported.")
		}
		if (parsed.taskId !== this.taskId || !Array.isArray(parsed.artifacts)) {
			throw new ArtifactStoreError("invalid_manifest", "Artifact manifest task identity or artifact list is invalid.")
		}
		const artifacts = parsed.artifacts.map(validateManifestArtifact)
		const ids = new Set<string>()
		for (const artifact of artifacts) {
			if (ids.has(artifact.id)) {
				throw new ArtifactStoreError("invalid_manifest", "Artifact manifest contains duplicate image IDs.")
			}
			ids.add(artifact.id)
		}
		const manifest: ArtifactManifestV1 = {
			schemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION,
			taskId: this.taskId,
			artifacts,
		}
		await this.cleanupOrphanImageFiles(manifest)
		return manifest
	}

	private async cleanupOrphanImageFiles(manifest: ArtifactManifestV1): Promise<void> {
		const referencedNames = new Set(manifest.artifacts.map((artifact) => path.basename(artifact.relativePath)))
		const entries = await fs.readdir(this.imagesDirectory, { withFileTypes: true })
		for (const entry of entries) {
			if (!entry.isFile() || entry.name.endsWith(LEGACY_PARTIAL_SUFFIX) || referencedNames.has(entry.name)) continue
			if (/^[a-f0-9]{64}\.(png|jpeg|webp)$/.test(entry.name)) {
				await fs.unlink(path.join(this.imagesDirectory, entry.name)).catch(() => undefined)
			}
		}
	}

	private async writeManifest(manifest: ArtifactManifestV1): Promise<void> {
		const serialized = `${JSON.stringify(manifest, null, 2)}\n`
		await writeFileAtomic(this.manifestPath, serialized)
	}

	private resolveManagedArtifactPath(artifact: ImageArtifact): string {
		const expected = expectedRelativePath(artifact.sha256, artifact.format)
		if (artifact.relativePath !== expected) {
			throw new ArtifactStoreError("artifact_integrity_failed", "Image artifact path does not match its content identity.")
		}
		const absolutePath = path.resolve(this.artifactRoot, ...artifact.relativePath.split("/"))
		const relativeToRoot = path.relative(this.artifactRoot, absolutePath)
		if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
			throw new ArtifactStoreError("artifact_integrity_failed", "Image artifact path escapes the task artifact root.")
		}
		return absolutePath
	}

	private async readAndVerifyArtifact(artifact: ImageArtifact): Promise<{ bytes: Uint8Array; absolutePath: string }> {
		const absolutePath = this.resolveManagedArtifactPath(artifact)
		let stats: Stats
		try {
			stats = await fs.lstat(absolutePath)
		} catch (error) {
			throw new ArtifactStoreError("artifact_integrity_failed", "Image artifact file is missing.", { cause: error })
		}
		if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== artifact.byteLength) {
			throw new ArtifactStoreError("artifact_integrity_failed", "Image artifact file metadata does not match the manifest.")
		}
		const bytes = await fs.readFile(absolutePath)
		await this.verifyFileHash(absolutePath, artifact, bytes)
		return { bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), absolutePath }
	}

	private async verifyFileHash(absolutePath: string, artifact: ImageArtifact, existingBytes?: Uint8Array): Promise<void> {
		const bytes = existingBytes ?? (await fs.readFile(absolutePath))
		const actualHash = createHash("sha256").update(bytes).digest("hex")
		if (actualHash !== artifact.sha256) {
			throw new ArtifactStoreError("artifact_integrity_failed", "Image artifact content hash does not match the manifest.")
		}
	}

	private throwIfAborted(signal?: AbortSignal): void {
		if (!signal?.aborted) return
		throw signal.reason instanceof Error ? signal.reason : new Error("Image artifact persistence was cancelled.")
	}

	private async pathExists(targetPath: string): Promise<boolean> {
		try {
			await fs.access(targetPath)
			return true
		} catch {
			return false
		}
	}

	private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
		let release: (() => void) | undefined
		const previous = this.operationTail
		this.operationTail = new Promise<void>((resolve) => {
			release = resolve
		})
		await previous
		try {
			return await operation()
		} finally {
			release?.()
		}
	}
}
