import type { ClineMessage } from "@shared/ExtensionMessage"
import { ClineAsk } from "@shared/proto/dline/ui"
import { describe, expect, it } from "vitest"
import { convertClineMessageToProto, convertProtoToClineMessage } from "./cline-message"

describe("ClineMessage command identity conversion", () => {
	it("preserves command activity state across the proto boundary", () => {
		const applicationMessage = {
			ts: 100,
			type: "say" as const,
			say: "command" as const,
			text: "sleep 10",
			activityId: "command-100-1",
			commandStatus: "cancelled" as const,
			commandExecutionMode: "background" as const,
			commandCanMoveToBackground: true,
		}

		const protoMessage = convertClineMessageToProto(applicationMessage)
		const roundTripMessage = convertProtoToClineMessage(protoMessage)

		expect(protoMessage.activityId).toBe("command-100-1")
		expect((protoMessage as unknown as { commandExecutionMode?: string }).commandExecutionMode).toBe("background")
		expect(roundTripMessage).toMatchObject({
			activityId: "command-100-1",
			commandStatus: "cancelled",
			commandExecutionMode: "background",
			commandCanMoveToBackground: true,
		})
	})

	it("round-trips the canonical TODO-list interaction through proto enum 20", () => {
		const applicationMessage = {
			ts: 101,
			type: "ask" as const,
			ask: "change_todo_list" as const,
			text: JSON.stringify({ plan: "# Plan\n- [ ] First item", reason: "Review" }),
		}

		const protoMessage = convertClineMessageToProto(applicationMessage)
		const roundTripMessage = convertProtoToClineMessage(protoMessage)

		expect(ClineAsk.CHANGE_TODO_LIST).toBe(20)
		expect(protoMessage.ask).toBe(ClineAsk.CHANGE_TODO_LIST)
		expect(roundTripMessage.ask).toBe("change_todo_list")
	})

	it("preserves the compaction conversation range across the Webview proto boundary", () => {
		const applicationMessage = {
			ts: 102,
			type: "say" as const,
			say: "tool" as const,
			compactionConversationRange: {
				logicalTurnRange: [2, 5] as const,
				apiConversationRange: [4, 11] as const,
				preCompactionApiEndIndex: 13,
			},
		}

		const protoMessage = convertClineMessageToProto(applicationMessage)
		const roundTripMessage = convertProtoToClineMessage(protoMessage)

		expect(protoMessage.compactionConversationRange).toEqual({
			logicalTurnStartIndex: 2,
			logicalTurnEndIndex: 5,
			apiConversationStartIndex: 4,
			apiConversationEndIndex: 11,
			preCompactionApiEndIndex: 13,
		})
		expect(roundTripMessage.compactionConversationRange).toEqual(applicationMessage.compactionConversationRange)
	})

	it("preserves queued user input semantics across the Webview proto boundary", () => {
		const applicationMessage = {
			ts: 103,
			type: "say" as const,
			say: "user_feedback" as const,
			text: "你好",
			userInputKind: "queued" as const,
			queuedInputMode: "steering" as const,
		}

		const protoMessage = convertClineMessageToProto(applicationMessage)
		const roundTripMessage = convertProtoToClineMessage(protoMessage)

		expect(protoMessage.userInputKind).toBe("queued")
		expect(protoMessage.queuedInputMode).toBe("steering")
		expect(roundTripMessage).toMatchObject(applicationMessage)
	})

	it("preserves multi-root checkpoint references across the proto boundary", () => {
		const applicationMessage: ClineMessage = {
			ts: 104,
			type: "say",
			say: "checkpoint_created",
			lastCheckpointHash: ["hash-a", "", "hash-c"],
			checkpointWorkspaceRoots: ["C:/workspace-a", "C:/workspace-b", "C:/workspace-c"],
		}

		const protoMessage = convertClineMessageToProto(applicationMessage)
		const roundTripMessage = convertProtoToClineMessage(protoMessage)

		expect(protoMessage.lastCheckpointHash).toEqual(applicationMessage.lastCheckpointHash)
		expect(protoMessage.checkpointWorkspaceRoots).toEqual(applicationMessage.checkpointWorkspaceRoots)
		expect(roundTripMessage).toMatchObject(applicationMessage)
	})
})

describe("ClineMessage image generation conversion", () => {
	it("preserves a structured image presentation across the proto boundary without embedding image bytes", () => {
		const artifactId = `image:sha256:${"a".repeat(64)}`
		const previewId = `image-preview:sha256:${"b".repeat(64)}`
		const previews = [2, 0, 1].map((sequence) => ({
			id: previewId,
			mimeType: "image/png" as const,
			width: 512,
			height: 288,
			sequence,
		}))
		const applicationMessage = {
			ts: 200,
			type: "say",
			say: "tool",
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
					previews,
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
		} satisfies ClineMessage

		const protoMessage = convertClineMessageToProto(applicationMessage)
		const roundTripMessage = convertProtoToClineMessage(protoMessage)
		const protoPresentation = (protoMessage as unknown as { imageGeneration?: unknown }).imageGeneration
		const restoredPresentation = (roundTripMessage as ClineMessage & { imageGeneration?: unknown }).imageGeneration

		expect(protoPresentation).toMatchObject({
			schemaVersion: 1,
			status: expect.anything(),
			requestId: "request-1",
			previews,
			artifacts: [{ id: artifactId, mimeType: "image/png" }],
		})
		expect(restoredPresentation).toMatchObject({
			schemaVersion: 1,
			status: "completed",
			requestId: "request-1",
			previews,
			artifacts: [{ id: artifactId, mimeType: "image/png" }],
		})
		expect(JSON.stringify(protoMessage)).not.toContain("base64")
	})
})
