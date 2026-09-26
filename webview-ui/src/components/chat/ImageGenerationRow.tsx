import type { ImageGenerationPresentationV1 } from "@shared/image-generation"
import { StringRequest } from "@shared/proto/dline/common"
import { ImageArtifactRequest, ImagePreviewRequest } from "@shared/proto/dline/ui"
import {
	CheckIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	CopyIcon,
	ImageIcon,
	LoaderCircleIcon,
	Maximize2Icon,
	Minimize2Icon,
	PaperclipIcon,
	TriangleAlertIcon,
} from "lucide-react"
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react"
import { FileServiceClient, UiServiceClient } from "@/services/grpc-client"
import { TOOL_RESPONSE_SCROLL_CLASS } from "./constants"

interface ImageGenerationRowProps {
	presentation: ImageGenerationPresentationV1
	isExpanded: boolean
	onAddToInput?: (text: string) => void
	onToggleExpand: () => void
}

interface ArtifactPreviewState {
	dataUrl?: string
	error?: string
}

function bytesToBase64(bytes: Uint8Array): string {
	const chunks: string[] = []
	const chunkSize = 0x8000
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		chunks.push(String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length))))
	}
	return btoa(chunks.join(""))
}

function statusLabel(status: ImageGenerationPresentationV1["status"]): string {
	switch (status) {
		case "awaiting_approval":
			return "Dline wants to generate an image"
		case "queued":
			return "Image generation queued"
		case "started":
			return "Generating image"
		case "preview":
			return "Image preview"
		case "completed":
			return "Image generation completed"
		case "failed":
			return "Image generation failed"
		case "cancelled":
			return "Image generation cancelled"
		case "rejected":
			return "Image generation rejected"
	}
}

type ImageDisplayMode = "fit" | "fill"

interface ImageSurfaceProps {
	alt: string
	dataUrl?: string
	displayMode: ImageDisplayMode
	error?: string
	height: number
	onActivate?: () => void
	width: number
}

function ImageSurface({ alt, dataUrl, displayMode, error, height, onActivate, width }: ImageSurfaceProps) {
	const activateFromKeyboard = (event: KeyboardEvent<HTMLImageElement>) => {
		if (!onActivate || (event.key !== "Enter" && event.key !== " ")) return
		event.preventDefault()
		onActivate()
	}

	return (
		<div
			className={displayMode === "fit" ? "w-full overflow-hidden" : "h-64 w-full overflow-hidden"}
			style={displayMode === "fit" ? { aspectRatio: `${width} / ${height}`, maxHeight: "60vh" } : { maxHeight: "60vh" }}>
			{dataUrl ? (
				<img
					alt={alt}
					className={`block h-full w-full ${displayMode === "fit" ? "object-contain" : "object-cover"} ${onActivate ? "cursor-zoom-in" : ""}`}
					data-display-mode={displayMode}
					onClick={onActivate}
					onKeyDown={activateFromKeyboard}
					src={dataUrl}
					tabIndex={onActivate ? 0 : undefined}
				/>
			) : error ? (
				<div className="flex h-full min-h-32 items-center justify-center p-3 text-xs text-error">{error}</div>
			) : (
				<div className="flex h-full min-h-32 items-center justify-center">
					<LoaderCircleIcon aria-label={`Loading ${alt.toLowerCase()}`} className="size-5 animate-spin" />
				</div>
			)}
		</div>
	)
}

export default function ImageGenerationRow({ presentation, isExpanded, onAddToInput, onToggleExpand }: ImageGenerationRowProps) {
	const [previews, setPreviews] = useState<Record<string, ArtifactPreviewState>>({})
	const [displayMode, setDisplayMode] = useState<ImageDisplayMode>("fit")
	const artifacts = useMemo(() => presentation.artifacts ?? [], [presentation.artifacts])
	const transientPreviews = useMemo(
		() =>
			[...(presentation.previews ?? (presentation.preview ? [presentation.preview] : []))].sort(
				(left, right) => left.sequence - right.sequence,
			),
		[presentation.preview, presentation.previews],
	)
	const latestTransientPreview = artifacts.length === 0 ? transientPreviews.at(-1) : undefined
	// Previews are ephemeral: the extension deletes them as soon as a request
	// stops running, so a failed load will keep failing. Identity is tracked
	// separately from `previews` because that state is what the effect writes,
	// and reading it here would re-trigger the effect it just satisfied.
	const requestedPreviewIds = useRef(new Set<string>())
	const artifactIds = useMemo(() => artifacts.map((artifact) => artifact.id).join("\u0000"), [artifacts])
	const latestTransientPreviewId = latestTransientPreview?.id

	useEffect(() => {
		let active = true
		const load = (id: string, contentPromise: Promise<{ data: Uint8Array; mimeType: string }>) => {
			void contentPromise
				.then((content) => {
					if (!active) return
					const bytes = content.data instanceof Uint8Array ? content.data : new Uint8Array(content.data)
					setPreviews((current) => ({
						...current,
						[id]: { dataUrl: `data:${content.mimeType};base64,${bytesToBase64(bytes)}` },
					}))
				})
				.catch((error: unknown) => {
					if (!active) return
					setPreviews((current) => ({
						...current,
						[id]: { error: error instanceof Error ? error.message : "Failed to load image content." },
					}))
				})
		}

		for (const artifact of artifacts) {
			load(artifact.id, UiServiceClient.getImageArtifact(ImageArtifactRequest.create({ artifactId: artifact.id })))
		}
		if (latestTransientPreviewId && !requestedPreviewIds.current.has(latestTransientPreviewId)) {
			requestedPreviewIds.current.add(latestTransientPreviewId)
			load(
				latestTransientPreviewId,
				UiServiceClient.getImagePreview(ImagePreviewRequest.create({ previewId: latestTransientPreviewId })),
			)
		}
		return () => {
			active = false
		}
		// `artifactIds` and `latestTransientPreviewId` are the identities that decide
		// what to fetch; depending on the arrays themselves would refetch on every
		// state broadcast, because each broadcast rebuilds them.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [artifactIds, latestTransientPreviewId])

	const isRunning = presentation.status === "queued" || presentation.status === "started" || presentation.status === "preview"
	const isFailed = presentation.status === "failed" || presentation.status === "rejected"
	const fitActionLabel = displayMode === "fit" ? "Fill image preview" : "Keep image aspect ratio"

	return (
		<div className="overflow-hidden rounded-md border border-editor-group-border bg-code">
			<div className={`flex items-center gap-2 px-3 py-2 ${isExpanded ? "border-b border-editor-group-border" : ""}`}>
				<button
					aria-label={isExpanded ? "Collapse image generation" : "Expand image generation"}
					className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-foreground"
					onClick={onToggleExpand}
					type="button">
					{isRunning ? (
						<LoaderCircleIcon className="size-4 shrink-0 animate-spin" />
					) : isFailed ? (
						<TriangleAlertIcon className="size-4 shrink-0 text-error" />
					) : presentation.status === "completed" ? (
						<CheckIcon className="size-4 shrink-0 text-success" />
					) : (
						<ImageIcon className="size-4 shrink-0" />
					)}
					<span className="min-w-0 flex-1 truncate font-semibold">{statusLabel(presentation.status)}</span>
					{isExpanded ? (
						<ChevronDownIcon className="size-4 shrink-0" />
					) : (
						<ChevronRightIcon className="size-4 shrink-0" />
					)}
				</button>
			</div>
			{isExpanded && (
				<div className={`space-y-3 p-3 ${TOOL_RESPONSE_SCROLL_CLASS}`} data-testid="image-generation-scroll">
					<div className="whitespace-pre-wrap break-words text-sm">{presentation.prompt}</div>
					{presentation.count > 1 && (
						<div className="text-xs text-description">{presentation.count} images requested</div>
					)}
					{presentation.modelId && (
						<div className="text-xs text-description">
							{presentation.providerId ? `${presentation.providerId} · ` : ""}
							{presentation.modelId}
						</div>
					)}
					{presentation.error && <div className="text-sm text-error">{presentation.error.message}</div>}
					{latestTransientPreview && (
						<div
							className="overflow-hidden rounded border border-input-border"
							data-preview-sequence={latestTransientPreview.sequence}
							data-testid="image-generation-partial-preview">
							<div className="flex items-center justify-between gap-2 border-b border-input-border px-2 py-1.5 text-xs text-description">
								<span>{`${latestTransientPreview.width}×${latestTransientPreview.height} · PARTIAL ${latestTransientPreview.sequence + 1}`}</span>
								<button
									aria-label={fitActionLabel}
									className="rounded p-1 hover:bg-toolbar-hover"
									onClick={() => setDisplayMode((current) => (current === "fit" ? "fill" : "fit"))}
									type="button">
									{displayMode === "fit" ? (
										<Maximize2Icon className="size-3.5" />
									) : (
										<Minimize2Icon className="size-3.5" />
									)}
								</button>
							</div>
							<ImageSurface
								alt={`Generated image partial ${latestTransientPreview.sequence + 1}`}
								dataUrl={previews[latestTransientPreview.id]?.dataUrl}
								displayMode={displayMode}
								error={previews[latestTransientPreview.id]?.error}
								height={latestTransientPreview.height}
								width={latestTransientPreview.width}
							/>
						</div>
					)}
					{artifacts.length > 0 && (
						<div className="grid grid-cols-1 gap-3" data-testid="image-generation-artifacts">
							{artifacts.map((artifact, index) => {
								const preview = previews[artifact.id]
								return (
									<div className="overflow-hidden rounded border border-input-border" key={artifact.id}>
										<div className="flex items-center gap-1 border-b border-input-border px-2 py-1.5 text-xs text-description">
											<div className="min-w-0 flex-1">
												{`${artifact.width}×${artifact.height} · ${artifact.format.toUpperCase()}`}
											</div>
											<button
												aria-label={fitActionLabel}
												className="rounded p-1 hover:bg-toolbar-hover"
												onClick={() => setDisplayMode((current) => (current === "fit" ? "fill" : "fit"))}
												type="button">
												{displayMode === "fit" ? (
													<Maximize2Icon className="size-3.5" />
												) : (
													<Minimize2Icon className="size-3.5" />
												)}
											</button>
											<button
												aria-label="Copy Artifact ID"
												className="rounded p-1 hover:bg-toolbar-hover"
												onClick={() =>
													void FileServiceClient.copyToClipboard(
														StringRequest.create({ value: artifact.id }),
													)
												}
												type="button">
												<CopyIcon className="size-3.5" />
											</button>
											<button
												aria-label="Use as Reference"
												className="rounded p-1 hover:bg-toolbar-hover disabled:opacity-50"
												disabled={!onAddToInput}
												onClick={() =>
													onAddToInput?.(
														`Use image artifact ${artifact.id} as a reference for the next image generation.`,
													)
												}
												type="button">
												<PaperclipIcon className="size-3.5" />
											</button>
										</div>
										<ImageSurface
											alt={`Generated image ${index + 1}`}
											dataUrl={preview?.dataUrl}
											displayMode={displayMode}
											error={preview?.error}
											height={artifact.height}
											onActivate={() =>
												void UiServiceClient.openImageArtifact(
													ImageArtifactRequest.create({ artifactId: artifact.id }),
												)
											}
											width={artifact.width}
										/>
									</div>
								)
							})}
						</div>
					)}
				</div>
			)}
		</div>
	)
}
