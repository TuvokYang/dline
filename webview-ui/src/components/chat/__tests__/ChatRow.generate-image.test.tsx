import type { TaskViewState } from "@shared/ExtensionMessage"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import React, { type ComponentType } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ChatRowContent } from "../ChatRow"

void React

const activeView = vi.hoisted(() => ({ current: undefined as TaskViewState | undefined }))
const { getImageArtifact, getImagePreview, openImageArtifact, copyToClipboard } = vi.hoisted(() => ({
	getImageArtifact: vi.fn(async () => ({
		data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
		mimeType: "image/png",
	})),
	getImagePreview: vi.fn(async () => ({
		data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
		mimeType: "image/png",
	})),
	openImageArtifact: vi.fn(async () => undefined),
	copyToClipboard: vi.fn(async () => undefined),
}))

vi.mock("@/services/grpc-client", async (importOriginal) => {
	const original = await importOriginal<typeof import("@/services/grpc-client")>()
	return {
		...original,
		FileServiceClient: { ...original.FileServiceClient, copyToClipboard },
		UiServiceClient: { ...original.UiServiceClient, getImageArtifact, getImagePreview, openImageArtifact },
	}
})

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		backgroundEditEnabled: true,
		mcpServers: [],
		mcpMarketplaceCatalog: [],
		onRelinquishControl: () => () => undefined,
		vscodeTerminalExecutionMode: "backgroundExec",
		clineMessages: [],
		showFeatureTips: false,
		taskViewState: activeView.current,
		currentTaskItem: { id: "task-1" },
	}),
}))

const artifactId = `image:sha256:${"a".repeat(64)}`
const previewPresentations = [2, 0, 1].map((sequence) => ({
	id: `image-preview:sha256:${"c".repeat(63)}${sequence}`,
	mimeType: "image/png" as const,
	width: 512,
	height: 288,
	sequence,
}))
const message = {
	ts: 1,
	type: "say" as const,
	say: "tool" as const,
	partial: false,
	text: JSON.stringify({
		tool: "generateImage",
		imageGeneration: {
			schemaVersion: 1,
			status: "completed",
			requestId: "request-1",
			prompt: "A blue owl",
			profileId: "profile-1",
			providerId: "openai",
			modelId: "gpt-image-2",
			count: 1,
			previews: previewPresentations,
			artifacts: [
				{
					id: artifactId,
					mimeType: "image/png",
					format: "png",
					byteLength: 64,
					width: 1024,
					height: 1024,
				},
			],
		},
	}),
}

const partialMessage = {
	ts: 2,
	type: "say" as const,
	say: "tool" as const,
	partial: true,
	text: JSON.stringify({
		tool: "generateImage",
		imageGeneration: {
			schemaVersion: 1,
			status: "preview",
			requestId: "request-2",
			prompt: "A blue owl in flight",
			providerId: "openai",
			modelId: "gpt-image-2",
			count: 1,
			previews: previewPresentations,
		},
	}),
}

const baseProps = {
	isExpanded: true,
	isLast: true,
	onSetQuote: vi.fn(),
	onToggleExpand: vi.fn(),
}

const TestableChatRowContent = ChatRowContent as ComponentType<Record<string, unknown>>

describe("ChatRow image generation rendering", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		activeView.current = undefined
	})

	it("loads a completed task artifact without persisting base64 in the message", async () => {
		render(<TestableChatRowContent {...baseProps} message={message} />)

		expect(screen.getByText("A blue owl")).toBeInTheDocument()
		expect(screen.getByText((_, element) => element?.textContent === "openai · gpt-image-2")).toBeInTheDocument()
		expect(message.text).not.toContain("base64")
		expect(screen.queryByText(artifactId)).not.toBeInTheDocument()
		await waitFor(() => expect(getImageArtifact).toHaveBeenCalledWith(expect.objectContaining({ artifactId })))
		expect(getImagePreview).not.toHaveBeenCalled()
		expect(screen.queryByTestId("image-generation-partial-preview")).not.toBeInTheDocument()
		const preview = await screen.findByRole("img", { name: "Generated image 1" })
		expect(preview).toHaveAttribute("src", expect.stringMatching(/^data:image\/png;base64,/))
	})

	it.each([
		["awaiting_approval", "Dline wants to generate an image", "ask"],
		["rejected", "Image generation rejected", "say"],
	] as const)("keeps the typed card for %s state", (status, title, type) => {
		const approvalMessage = {
			...partialMessage,
			type,
			...(type === "ask" ? { ask: "tool" as const, say: undefined } : { say: "tool" as const }),
			partial: false,
			text: JSON.stringify({
				tool: "generateImage",
				imageGeneration: {
					schemaVersion: 1,
					status,
					requestId: `request-${status}`,
					prompt: "A blue owl awaiting a decision",
					count: 1,
				},
			}),
		}

		render(<TestableChatRowContent {...baseProps} message={approvalMessage} />)

		expect(screen.getByText(title)).toBeInTheDocument()
		expect(screen.getByText("A blue owl awaiting a decision")).toBeInTheDocument()
	})

	it("delegates only the exact active approval card to the footer and restores timeline history afterward", () => {
		const approvalMessage = {
			...partialMessage,
			ts: 100,
			type: "ask" as const,
			ask: "tool" as const,
			say: undefined,
			interactionId: "image-approval",
			partial: false,
			text: JSON.stringify({
				tool: "generateImage",
				imageGeneration: {
					schemaVersion: 1,
					status: "awaiting_approval",
					requestId: "image-approval",
					prompt: "A blue owl awaiting a decision",
					count: 1,
				},
			}),
		}
		activeView.current = {
			taskId: "task-1",
			phase: "awaiting_approval",
			stateRevision: 8,
			activeInteraction: {
				taskId: "task-1",
				turnId: "turn:image-approval",
				interactionId: "image-approval",
				kind: "tool_approval",
				status: "awaiting",
				stateRevision: 8,
				taskAsk: "tool",
				presentationKind: "tool_approval",
				askMessageTs: 100,
			},
			input: { enabled: true, acceptsText: true, acceptsImages: true, acceptsFiles: true },
			footer: { actions: [] },
		}
		const { rerender } = render(<TestableChatRowContent {...baseProps} message={approvalMessage} />)
		expect(screen.queryByText("Dline wants to generate an image")).not.toBeInTheDocument()

		rerender(<TestableChatRowContent {...baseProps} message={{ ...approvalMessage, interactionId: "older-approval" }} />)
		expect(screen.getByText("Dline wants to generate an image")).toBeInTheDocument()

		activeView.current = undefined
		rerender(<TestableChatRowContent {...baseProps} message={approvalMessage} />)
		expect(screen.getByText("Dline wants to generate an image")).toBeInTheDocument()

		rerender(
			<TestableChatRowContent {...baseProps} message={{ ...approvalMessage, type: "say", say: "tool", ask: undefined }} />,
		)
		expect(screen.getByText("Dline wants to generate an image")).toBeInTheDocument()
	})

	it("shows the prompt before any image is available", () => {
		const startedMessage = {
			...partialMessage,
			text: JSON.stringify({
				tool: "generateImage",
				imageGeneration: {
					schemaVersion: 1,
					status: "started",
					requestId: "request-started",
					prompt: "A blue owl before pixels arrive",
					providerId: "openai",
					modelId: "gpt-image-2",
					count: 1,
				},
			}),
		}

		render(<TestableChatRowContent {...baseProps} message={startedMessage} />)

		expect(screen.getByText("A blue owl before pixels arrive")).toBeInTheDocument()
		expect(screen.queryAllByTestId("image-generation-partial-preview")).toHaveLength(0)
	})

	it("updates one stable image surface as ordered partials progress from 0 to 1 to 2", async () => {
		const orderedPreviews = [...previewPresentations].sort((left, right) => left.sequence - right.sequence)
		const payload = JSON.parse(partialMessage.text)
		const messageWithPreviews = (previews: typeof orderedPreviews) => ({
			...partialMessage,
			text: JSON.stringify({
				...payload,
				imageGeneration: { ...payload.imageGeneration, previews },
			}),
		})
		const { rerender } = render(
			<TestableChatRowContent {...baseProps} message={messageWithPreviews(orderedPreviews.slice(0, 1))} />,
		)
		const surface = screen.getByTestId("image-generation-partial-preview")
		expect(surface).toHaveAttribute("data-preview-sequence", "0")

		rerender(<TestableChatRowContent {...baseProps} message={messageWithPreviews(orderedPreviews.slice(0, 2))} />)
		expect(screen.getByTestId("image-generation-partial-preview")).toBe(surface)
		expect(surface).toHaveAttribute("data-preview-sequence", "1")

		rerender(<TestableChatRowContent {...baseProps} message={messageWithPreviews(orderedPreviews)} />)
		expect(screen.getByTestId("image-generation-partial-preview")).toBe(surface)
		expect(surface).toHaveAttribute("data-preview-sequence", "2")
		expect(screen.getAllByTestId("image-generation-partial-preview")).toHaveLength(1)
		expect(partialMessage.text).not.toContain("base64")
		await waitFor(() =>
			expect(getImagePreview).toHaveBeenLastCalledWith(expect.objectContaining({ previewId: orderedPreviews[2].id })),
		)
		expect(await screen.findByRole("img", { name: "Generated image partial 3" })).toHaveAttribute(
			"src",
			expect.stringMatching(/^data:image\/png;base64,/),
		)
	})

	it("keeps partial and final image surfaces full-width with a 60vh height ceiling", async () => {
		const portraitPartialPayload = JSON.parse(partialMessage.text)
		portraitPartialPayload.imageGeneration.previews = [{ ...previewPresentations[0], width: 941, height: 1672, sequence: 0 }]
		const { unmount } = render(
			<TestableChatRowContent
				{...baseProps}
				message={{ ...partialMessage, text: JSON.stringify(portraitPartialPayload) }}
			/>,
		)
		const partialImage = await screen.findByRole("img", { name: "Generated image partial 1" })
		expect(screen.getByTestId("image-generation-scroll")).toHaveClass(
			"max-h-[60vh]",
			"overflow-y-auto",
			"overscroll-x-contain",
		)
		expect(partialImage.parentElement).toHaveClass("w-full")
		expect(partialImage.parentElement?.style.maxHeight).toBe("60vh")
		unmount()

		render(<TestableChatRowContent {...baseProps} message={message} />)
		const finalImage = await screen.findByRole("img", { name: "Generated image 1" })
		expect(finalImage.closest("[data-testid='image-generation-artifacts']")).toHaveClass("grid-cols-1")
		expect(finalImage.closest("[data-testid='image-generation-artifacts']")).not.toHaveClass("sm:grid-cols-2")
		expect(finalImage.parentElement?.style.maxHeight).toBe("60vh")
	})

	it("opens from the image, toggles fit mode, copies, references, and collapses", async () => {
		const onAddToInput = vi.fn()
		const onToggleExpand = vi.fn()
		render(
			<TestableChatRowContent
				{...baseProps}
				isExpanded={true}
				message={message}
				onAddToInput={onAddToInput}
				onToggleExpand={onToggleExpand}
			/>,
		)

		const image = await screen.findByRole("img", { name: "Generated image 1" })
		fireEvent.click(image)
		expect(screen.queryByRole("button", { name: "Open generated image" })).not.toBeInTheDocument()
		const fillButtons = screen.getAllByRole("button", { name: "Fill image preview" })
		fireEvent.click(fillButtons[fillButtons.length - 1])
		expect(image).toHaveAttribute("data-display-mode", "fill")
		expect(image).toHaveClass("object-cover")
		fireEvent.click(screen.getByRole("button", { name: "Copy Artifact ID" }))
		fireEvent.click(screen.getByRole("button", { name: "Use as Reference" }))
		fireEvent.click(screen.getByRole("button", { name: "Collapse image generation" }))

		await waitFor(() => expect(openImageArtifact).toHaveBeenCalledWith(expect.objectContaining({ artifactId })))
		expect(copyToClipboard).toHaveBeenCalledWith(expect.objectContaining({ value: artifactId }))
		expect(onAddToInput).toHaveBeenCalledWith(
			`Use image artifact ${artifactId} as a reference for the next image generation.`,
		)
		expect(onToggleExpand).toHaveBeenCalled()
	})
})
