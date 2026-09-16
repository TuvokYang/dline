import type { ImageProviderOutput } from "@core/image-generation/contracts"
import {
	ArtifactStoreError,
	type ImageArtifact,
	type ImageArtifactProvenance,
	type ResolvedImageArtifact,
	type StoreImageInput,
	TaskArtifactStore,
} from "./TaskArtifactStore"

export interface ArtifactUrlDownloadRequest {
	url: URL
	maxBytes: number
	signal?: AbortSignal
}

export interface ArtifactUrlDownloadResult {
	bytes: Uint8Array
	mimeType: string
}

export interface ArtifactUrlDownloader {
	download(request: ArtifactUrlDownloadRequest): Promise<ArtifactUrlDownloadResult>
}

export interface ArtifactResolverOptions {
	urlDownloader?: ArtifactUrlDownloader
	maxDownloadBytes?: number
}

export interface ProviderOutputProvenance {
	providerId: string
	modelId: string
	requestId: string
	parentArtifactIds?: readonly string[]
}

const DEFAULT_MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024
const STRICT_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function decodeStrictBase64(value: string): Uint8Array {
	if (!value || value.length % 4 !== 0 || !STRICT_BASE64_PATTERN.test(value)) {
		throw new ArtifactStoreError("invalid_base64", "Provider image output is not valid base64.")
	}
	const bytes = Buffer.from(value, "base64")
	if (bytes.toString("base64") !== value) {
		throw new ArtifactStoreError("invalid_base64", "Provider image output is not canonical base64.")
	}
	return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function parseSafeArtifactUrl(value: string): URL {
	let url: URL
	try {
		url = new URL(value)
	} catch (error) {
		throw new ArtifactStoreError("unsafe_artifact_url", "Provider image URL is invalid.", { cause: error })
	}
	if (url.protocol !== "https:" || url.username || url.password) {
		throw new ArtifactStoreError("unsafe_artifact_url", "Provider image URL must use HTTPS without embedded credentials.")
	}
	return url
}

export class ArtifactResolver {
	private readonly store: TaskArtifactStore
	private readonly urlDownloader?: ArtifactUrlDownloader
	private readonly maxDownloadBytes: number

	constructor(store: TaskArtifactStore, options: ArtifactResolverOptions = {}) {
		if (
			!Number.isSafeInteger(options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES) ||
			(options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES) <= 0
		) {
			throw new ArtifactStoreError("invalid_configuration", "Artifact download byte limit must be a positive integer.")
		}
		this.store = store
		this.urlDownloader = options.urlDownloader
		this.maxDownloadBytes = options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES
	}

	async persistProviderOutput(
		output: ImageProviderOutput,
		provenance: ProviderOutputProvenance,
		signal?: AbortSignal,
	): Promise<ImageArtifact> {
		const [artifact] = await this.persistProviderOutputs([output], provenance, signal)
		return artifact
	}

	async persistProviderOutputs(
		outputs: readonly ImageProviderOutput[],
		provenance: ProviderOutputProvenance,
		signal?: AbortSignal,
	): Promise<ImageArtifact[]> {
		const inputs: StoreImageInput[] = []
		for (const output of outputs) {
			if (signal?.aborted)
				throw signal.reason instanceof Error ? signal.reason : new Error("Image generation was cancelled.")
			inputs.push(await this.normalizeProviderOutput(output, provenance, signal))
		}
		return this.store.storeImages(inputs, signal)
	}

	private async normalizeProviderOutput(
		output: ImageProviderOutput,
		provenance: ProviderOutputProvenance,
		signal?: AbortSignal,
	): Promise<StoreImageInput> {
		const baseProvenance: ImageArtifactProvenance = {
			providerId: provenance.providerId,
			modelId: provenance.modelId,
			requestId: provenance.requestId,
			providerOutputId: output.id,
			revisedPrompt: output.revisedPrompt,
			sourceKind: output.source.kind,
			...(provenance.parentArtifactIds?.length ? { parentArtifactIds: [...new Set(provenance.parentArtifactIds)] } : {}),
		}
		switch (output.source.kind) {
			case "bytes":
				return { bytes: output.source.bytes, declaredMimeType: output.source.mimeType, provenance: baseProvenance }
			case "base64":
				return {
					bytes: decodeStrictBase64(output.source.data),
					declaredMimeType: output.source.mimeType,
					provenance: baseProvenance,
				}
			case "url": {
				const url = parseSafeArtifactUrl(output.source.url)
				if (!this.urlDownloader) {
					throw new ArtifactStoreError(
						"url_download_unavailable",
						"Provider image URL requires a configured secure artifact downloader.",
					)
				}
				const downloaded = await this.urlDownloader.download({ url, maxBytes: this.maxDownloadBytes, signal })
				if (downloaded.bytes.byteLength > this.maxDownloadBytes) {
					throw new ArtifactStoreError("artifact_size_exceeded", "Downloaded image exceeds the configured byte limit.")
				}
				const declaredMimeType = output.source.mimeType ?? downloaded.mimeType
				if (output.source.mimeType && output.source.mimeType !== downloaded.mimeType) {
					throw new ArtifactStoreError(
						"mime_type_mismatch",
						"Provider image URL MIME type does not match the downloaded response.",
					)
				}
				return { bytes: downloaded.bytes, declaredMimeType, provenance: baseProvenance }
			}
		}
	}

	resolveImage(artifactId: string): Promise<ResolvedImageArtifact> {
		return this.store.readImage(artifactId)
	}
}
