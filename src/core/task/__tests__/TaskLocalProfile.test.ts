import { Task } from "@core/task"
import { BlockPhase } from "@core/task/BlockPhaseMachine"
import type { ClineContent } from "@shared/messages/content"
import type { Mode } from "@shared/storage/types"
import { describe, expect, it, vi } from "vitest"

interface ProfileBinding {
	profileId?: string
	profileName?: string
}

type FakeProfileStateSnapshot = Partial<Record<Mode, ProfileBinding | undefined>>

interface FakeTaskStateManager {
	mode: Mode
	planModeProfileId?: string
	planModeProfile?: string
	actModeProfileId?: string
	actModeProfile?: string
	setProfileIdentityBindings: (
		bindings: Partial<Record<Mode, ProfileBinding | undefined>>,
		options?: { clearRuntimeOverrides?: boolean },
	) => FakeProfileStateSnapshot
	restoreProfileState: (snapshot: FakeProfileStateSnapshot) => void
	setProfileBindings: (bindings: Partial<Record<Mode, string | undefined>>) => void
	setMode: (mode: Mode) => void
}

function createTaskStateManager(mode: Mode): FakeTaskStateManager {
	const state: FakeTaskStateManager = {
		mode,
		planModeProfileId: "plan-source-id",
		planModeProfile: "plan-source",
		actModeProfileId: "act-source-id",
		actModeProfile: "act-source",
		setProfileIdentityBindings: vi.fn((bindings: Partial<Record<Mode, ProfileBinding | undefined>>) => {
			const snapshot: FakeProfileStateSnapshot = {}
			if (Object.hasOwn(bindings, "plan")) {
				snapshot.plan = { profileId: state.planModeProfileId, profileName: state.planModeProfile }
				state.planModeProfileId = bindings.plan?.profileId
				state.planModeProfile = bindings.plan?.profileName
			}
			if (Object.hasOwn(bindings, "act")) {
				snapshot.act = { profileId: state.actModeProfileId, profileName: state.actModeProfile }
				state.actModeProfileId = bindings.act?.profileId
				state.actModeProfile = bindings.act?.profileName
			}
			return snapshot
		}),
		restoreProfileState: vi.fn((snapshot: FakeProfileStateSnapshot) => {
			if (Object.hasOwn(snapshot, "plan")) {
				state.planModeProfileId = snapshot.plan?.profileId
				state.planModeProfile = snapshot.plan?.profileName
			}
			if (Object.hasOwn(snapshot, "act")) {
				state.actModeProfileId = snapshot.act?.profileId
				state.actModeProfile = snapshot.act?.profileName
			}
		}),
		setProfileBindings: vi.fn((bindings: Partial<Record<Mode, string | undefined>>) => {
			if (Object.hasOwn(bindings, "plan")) state.planModeProfile = bindings.plan
			if (Object.hasOwn(bindings, "act")) state.actModeProfile = bindings.act
		}),
		setMode: vi.fn((nextMode: Mode) => {
			state.mode = nextMode
		}),
	}
	return state
}

/** Verify Profile binding adoption is atomic at the Task runtime boundary. */
describe("Task task-local Profile adoption", () => {
	it("updates unified bindings and rebuilds the active handler exactly once", async () => {
		const taskSm = createTaskStateManager("act")
		const order: string[] = []
		const originalSet = taskSm.setProfileIdentityBindings
		taskSm.setProfileIdentityBindings = vi.fn((bindings, options) => {
			order.push("bindings")
			return originalSet(bindings, options)
		})
		const fakeTask = {
			taskSm,
			ordinaryRequestInputReplay: { clear: vi.fn(() => order.push("replay")) },
			getProfileRecoveryInteractionId: vi.fn(() => undefined),
			resolveProfileBinding: vi.fn(() => ({ profileId: "target-id", profileName: "target-profile" })),
			rebuildApiHandler: vi.fn(async () => order.push("rebuild")),
			syncContextWindowIndicatorScope: vi.fn(() => order.push("scope")),
			stateManager: {
				flushPendingState: vi.fn(async () => {
					order.push("flush")
				}),
			},
		}

		await Task.prototype.commitProfileBindings.call(fakeTask, "target-profile", ["plan", "act"])

		expect(taskSm.setProfileIdentityBindings).toHaveBeenCalledWith(
			{
				plan: { profileId: "target-id", profileName: "target-profile" },
				act: { profileId: "target-id", profileName: "target-profile" },
			},
			{ clearRuntimeOverrides: true },
		)
		expect(fakeTask.rebuildApiHandler).toHaveBeenCalledOnce()
		expect(fakeTask.syncContextWindowIndicatorScope).toHaveBeenCalledOnce()
		expect(order).toEqual(["bindings", "replay", "rebuild", "flush", "scope"])
	})

	it("invalidates frozen ordinary Provider input before rebuilding the active Profile", async () => {
		const taskSm = createTaskStateManager("act")
		const order: string[] = []
		const originalSet = taskSm.setProfileIdentityBindings
		taskSm.setProfileIdentityBindings = vi.fn((bindings, options) => {
			order.push("bindings")
			return originalSet(bindings, options)
		})
		const ordinaryRequestInputReplay = {
			clear: vi.fn(() => order.push("replay")),
		}
		const fakeTask = {
			taskSm,
			ordinaryRequestInputReplay,
			getProfileRecoveryInteractionId: vi.fn(() => undefined),
			resolveProfileBinding: vi.fn(() => ({ profileId: "target-id", profileName: "target-profile" })),
			rebuildApiHandler: vi.fn(async () => order.push("rebuild")),
			syncContextWindowIndicatorScope: vi.fn(() => order.push("scope")),
			stateManager: {
				flushPendingState: vi.fn(async () => {
					order.push("flush")
				}),
			},
		}

		await Task.prototype.commitProfileBindings.call(fakeTask, "target-profile", ["act"])

		expect(ordinaryRequestInputReplay.clear).toHaveBeenCalledOnce()
		expect(order).toEqual(["bindings", "replay", "rebuild", "flush", "scope"])
	})

	it("durably removes both stale Profile error carriers before publishing recovery", async () => {
		const taskSm = createTaskStateManager("act")
		const messages = [
			{
				ts: 90,
				type: "say" as const,
				say: "api_req_started" as const,
				text: JSON.stringify({
					request: "request",
					streamingFailedMessage: JSON.stringify({ message: 'Profile not valid: "source" is unavailable.' }),
				}),
			},
			{
				ts: 100,
				type: "ask" as const,
				ask: "api_req_failed" as const,
				text: 'Profile not valid: "source" is unavailable.',
				interactionId: "retry-1",
			},
		]
		const updateClineMessage = vi.fn(async (index: number, updates: { text?: string }) => {
			messages[index] = { ...messages[index], ...updates }
		})
		const flushMessageUpdate = vi.fn(async () => undefined)
		const removeMessagesByTs = vi.fn(async () => undefined)
		const dispatchRuntime = vi.fn(async () => ({ accepted: true }))
		const fakeTask = {
			taskSm,
			ordinaryRequestInputReplay: { clear: vi.fn() },
			clearProfileRecoveryMessages: Reflect.get(Task.prototype, "clearProfileRecoveryMessages") as (
				interactionId: string,
			) => Promise<void>,
			getProfileRecoveryInteractionId: vi.fn(() => "retry-1"),
			resolveProfileBinding: vi.fn(() => ({ profileId: "target-id", profileName: "target-profile" })),
			rebuildApiHandler: vi.fn(async () => undefined),
			syncContextWindowIndicatorScope: vi.fn(),
			stateManager: { flushPendingState: vi.fn(async () => undefined) },
			interactionCoordinator: {
				cancelPendingInteraction: vi.fn(() => false),
				waitForPendingInteraction: vi.fn(async () => undefined),
			},
			dispatchRuntime,
			getRuntimeState: vi.fn(() => ({})),
			messageStateHandler: {
				clineMessages: messages,
				updateClineMessage,
				flushMessageUpdate,
				removeMessagesByTs,
			},
		}

		await Task.prototype.commitProfileBindings.call(fakeTask, "target-profile", ["act"])

		expect(updateClineMessage).toHaveBeenCalledOnce()
		const persistedApiRequest = JSON.parse(updateClineMessage.mock.calls[0]?.[1].text ?? "{}")
		expect(persistedApiRequest.streamingFailedMessage).toBeUndefined()
		expect(flushMessageUpdate).toHaveBeenCalledWith(0)
		expect(removeMessagesByTs).toHaveBeenCalledWith([100])
		expect(dispatchRuntime).toHaveBeenCalledWith({
			type: "PROFILE_RECOVERY_COMMITTED",
			interactionId: "retry-1",
		})
		expect(removeMessagesByTs.mock.invocationCallOrder[0]).toBeLessThan(dispatchRuntime.mock.invocationCallOrder[0])
	})

	it("persists an inactive binding without rebuilding the active handler", async () => {
		const taskSm = createTaskStateManager("act")
		const fakeTask = {
			taskSm,
			getProfileRecoveryInteractionId: vi.fn(() => undefined),
			resolveProfileBinding: vi.fn(() => ({ profileId: "target-id", profileName: "target-profile" })),
			rebuildApiHandler: vi.fn(async () => undefined),
			syncContextWindowIndicatorScope: vi.fn(),
			stateManager: { flushPendingState: vi.fn(async () => undefined) },
		}

		await Task.prototype.commitProfileBindings.call(fakeTask, "target-profile", ["plan"])

		expect(taskSm.planModeProfileId).toBe("target-id")
		expect(taskSm.planModeProfile).toBe("target-profile")
		expect(taskSm.actModeProfileId).toBe("act-source-id")
		expect(taskSm.actModeProfile).toBe("act-source")
		expect(fakeTask.rebuildApiHandler).not.toHaveBeenCalled()
		expect(fakeTask.syncContextWindowIndicatorScope).not.toHaveBeenCalled()
	})

	it("restores source bindings and handler when persistence fails", async () => {
		const taskSm = createTaskStateManager("act")
		const fakeTask = {
			taskSm,
			ordinaryRequestInputReplay: { clear: vi.fn() },
			getProfileRecoveryInteractionId: vi.fn(() => undefined),
			resolveProfileBinding: vi.fn(() => ({ profileId: "target-id", profileName: "target-profile" })),
			rebuildApiHandler: vi.fn(async () => undefined),
			syncContextWindowIndicatorScope: vi.fn(),
			stateManager: { flushPendingState: vi.fn(async () => Promise.reject(new Error("persist failed"))) },
		}

		await expect(Task.prototype.commitProfileBindings.call(fakeTask, "target-profile", ["plan", "act"])).rejects.toThrow(
			"persist failed",
		)

		expect(taskSm.planModeProfileId).toBe("plan-source-id")
		expect(taskSm.planModeProfile).toBe("plan-source")
		expect(taskSm.actModeProfileId).toBe("act-source-id")
		expect(taskSm.actModeProfile).toBe("act-source")
		expect(taskSm.restoreProfileState).toHaveBeenCalledOnce()
		expect(fakeTask.rebuildApiHandler).toHaveBeenCalledTimes(2)
		expect(fakeTask.syncContextWindowIndicatorScope).not.toHaveBeenCalled()
	})
})

/** Verify Profile compaction freezes draft content without resolving the live interaction. */
describe("Task Profile transition continuation", () => {
	it("keeps the draft as protected continuation without synthesizing the awaiting result", async () => {
		const interaction = { interactionId: "interaction-1", kind: "qna_response" }
		const runtimeState = {
			interaction,
			turn: {
				assistantApiIndex: 0,
				blocks: [
					{
						dlineTid: "interaction-1",
						functionId: "function-1",
						toolName: "qna_respond",
						phase: BlockPhase.AWAITING_APPROVAL,
						ts: 1,
						requiresApproval: true,
						conversationHistoryIndex: 0,
					},
				],
			},
		}
		const fakeTask = {
			taskRuntime: { getState: () => runtimeState },
			messageStateHandler: { apiConversationHistory: [], clineMessages: [] },
			taskState: { userMessageContent: [] },
			taskSm: { mode: "act" as const },
		}
		const captureContinuation = Reflect.get(Task.prototype, "captureContextTransitionContinuation") as (
			this: typeof fakeTask,
			trigger: "profile_switch" | "mode_switch",
			targetMode: Mode,
			chatContent?: { message?: string; images?: string[]; files?: string[] },
		) => Promise<ClineContent[]>

		const continuation = await captureContinuation.call(fakeTask, "profile_switch", "act", {
			message: "keep this draft",
		})

		expect(continuation).toContainEqual({
			type: "text",
			text: "<user_message>\nkeep this draft\n</user_message>",
		})
		expect(continuation).not.toContainEqual(expect.objectContaining({ type: "tool_result", function_id: "function-1" }))
		expect(runtimeState.interaction).toBe(interaction)
	})
})
