import { Task } from "@core/task"
import { InteractionCancellationError } from "@core/task/interaction/InteractionCancellationError"
import { ServerTool } from "@shared/proto/dline/models/metadata"
import { describe, expect, it, vi } from "vitest"

/** Verify Profile admission is request-local and always evaluates the current binding. */
describe("Task Profile admission", () => {
	it("admits a Hosted Web declaration without opening a request-level approval", async () => {
		const beforeApiRequestStarted = vi.fn(async () => undefined)
		const open = vi.fn(async () => ({ actionId: "approve" as const }))
		const releaseApiContinuationForRequestGate = vi.fn(async () => false)
		const prepareAdmission = vi.fn()
		const admitApiRequest = vi.fn(async () => undefined)
		const fakeTask = {
			taskId: "task-1",
			stateManager: {
				getGlobalSettingsKey: vi.fn(() => ({ version: 4, actions: { useWeb: false } })),
			},
			toolExecutor: { prepareAdmission },
			ordinaryRequestInputReplay: { get: vi.fn(() => undefined) },
			compactionRequestReplay: { getProviderInput: vi.fn(() => undefined) },
			interactionCoordinator: { releaseApiContinuationForRequestGate, open },
			admitApiRequest,
		}
		const completeApiRequestGate = Reflect.get(Task.prototype, "completeApiRequestGate") as (
			this: typeof fakeTask,
			requestScope: {
				webSearchRoutingPlan: { route: "hosted"; serverTools: ServerTool[] }
				providerInfo: { providerId: string }
			},
			apiIndex: number,
			beforeApiRequestStarted?: () => Promise<void>,
		) => Promise<boolean>
		const requestScope = {
			webSearchRoutingPlan: { route: "hosted" as const, serverTools: [ServerTool.WEB_SEARCH] },
			providerInfo: { providerId: "openai" },
		}

		await expect(completeApiRequestGate.call(fakeTask, requestScope, 4, beforeApiRequestStarted)).resolves.toBe(true)
		expect(beforeApiRequestStarted).toHaveBeenCalledOnce()
		expect(admitApiRequest).toHaveBeenCalledWith(4)
		expect(prepareAdmission).not.toHaveBeenCalled()
		expect(releaseApiContinuationForRequestGate).not.toHaveBeenCalled()
		expect(open).not.toHaveBeenCalled()
	})

	it("presents the current invalid Profile as one request-local retry interaction", async () => {
		const sequence: string[] = []
		const recoverApiFailure = vi.fn(async () => ({ actionId: "retry" as const }))
		const fakeTask = {
			taskId: "task-1",
			say: vi.fn(async () => {
				sequence.push("api-request-row")
			}),
			messageStateHandler: {
				addToApiConversationHistory: vi.fn(async () => {
					sequence.push("user-message")
				}),
				flushApiConversationHistory: vi.fn(async () => {
					sequence.push("history-flushed")
				}),
			},
			admitApiRequest: vi.fn(async () => {
				sequence.push("runtime-admitted")
			}),
			getRuntimeState: vi.fn(() => ({ revision: 7 })),
			recoverApiFailure,
		}
		const presentFailure = Reflect.get(Task.prototype, "presentApiProfileAdmissionFailure") as (
			this: typeof fakeTask,
			userContent: Array<{ type: "text"; text: string }>,
			apiIndex: number,
			validity: { status: "invalid"; message: string },
			persistedRequest: boolean,
		) => Promise<boolean>

		await expect(
			presentFailure.call(
				fakeTask,
				[{ type: "text", text: "send with current profile" }],
				4,
				{
					status: "invalid",
					message: 'Profile not valid: "gpt-pro" requires an Azure endpoint for Azure Identity authentication.',
				},
				false,
			),
		).resolves.toBe(true)

		expect(sequence).toEqual(["api-request-row", "user-message", "history-flushed", "runtime-admitted"])
		expect(recoverApiFailure).toHaveBeenCalledWith({
			turnId: "profile-admission:task-1:7",
			interactionId: "profile-admission:task-1:7",
			apiIndex: 4,
			presentation: 'Profile not valid: "gpt-pro" requires an Azure endpoint for Azure Identity authentication.',
			persistedRequest: true,
		})
	})

	it("waits for a new request after Profile switch recovery and re-enters admission", async () => {
		const followUp = { type: "text" as const, text: "send with the target profile" }
		const recursivelyMakeClineRequests = vi.fn(async () => false)
		const fakeTask = {
			taskId: "task-1",
			taskState: {
				abort: false,
				userMessageContent: [{ type: "text" as const, text: "stale request" }],
				userMessageContentReady: false,
			},
			say: vi.fn(),
			messageStateHandler: {
				addToApiConversationHistory: vi.fn(),
				flushApiConversationHistory: vi.fn(),
			},
			admitApiRequest: vi.fn(async () => undefined),
			getRuntimeState: vi.fn(() => ({ revision: 7 })),
			recoverApiFailure: vi.fn(async () => {
				setTimeout(() => {
					fakeTask.taskState.userMessageContent.push(followUp)
					fakeTask.taskState.userMessageContentReady = true
				}, 0)
				throw new InteractionCancellationError("profile_recovered")
			}),
			recursivelyMakeClineRequests,
		}
		const presentFailure = Reflect.get(Task.prototype, "presentApiProfileAdmissionFailure") as (
			this: typeof fakeTask,
			userContent: Array<{ type: "text"; text: string }>,
			apiIndex: number,
			validity: { status: "invalid"; message: string },
			persistedRequest: boolean,
		) => Promise<boolean>

		await expect(
			presentFailure.call(
				fakeTask,
				[{ type: "text", text: "invalid request" }],
				4,
				{ status: "invalid", message: "Profile not valid." },
				true,
			),
		).resolves.toBe(false)

		expect(recursivelyMakeClineRequests).toHaveBeenCalledWith([followUp])
		expect(fakeTask.taskState.userMessageContentReady).toBe(false)
	})

	it("rethrows non-Profile interaction cancellation", async () => {
		const fakeTask = {
			taskId: "task-1",
			taskState: { abort: false, userMessageContent: [], userMessageContentReady: false },
			say: vi.fn(),
			messageStateHandler: {
				addToApiConversationHistory: vi.fn(),
				flushApiConversationHistory: vi.fn(),
			},
			admitApiRequest: vi.fn(async () => undefined),
			getRuntimeState: vi.fn(() => ({ revision: 7 })),
			recoverApiFailure: vi.fn(async () => {
				throw new InteractionCancellationError("task_cancelled")
			}),
			recursivelyMakeClineRequests: vi.fn(),
		}
		const presentFailure = Reflect.get(Task.prototype, "presentApiProfileAdmissionFailure") as (
			this: typeof fakeTask,
			userContent: Array<{ type: "text"; text: string }>,
			apiIndex: number,
			validity: { status: "invalid"; message: string },
			persistedRequest: boolean,
		) => Promise<boolean>

		await expect(
			presentFailure.call(
				fakeTask,
				[{ type: "text", text: "invalid request" }],
				4,
				{ status: "invalid", message: "Profile not valid." },
				true,
			),
		).rejects.toMatchObject({ reason: "task_cancelled" })
	})

	it("revalidates a retry without duplicating the persisted user message", async () => {
		const fakeTask = {
			taskId: "task-1",
			say: vi.fn(),
			messageStateHandler: {
				addToApiConversationHistory: vi.fn(),
				flushApiConversationHistory: vi.fn(),
			},
			admitApiRequest: vi.fn(async () => undefined),
			getRuntimeState: vi.fn(() => ({ revision: 9 })),
			recoverApiFailure: vi.fn(async () => ({ actionId: "retry" as const })),
		}
		const presentFailure = Reflect.get(Task.prototype, "presentApiProfileAdmissionFailure") as (
			this: typeof fakeTask,
			userContent: Array<{ type: "text"; text: string }>,
			apiIndex: number,
			validity: { status: "invalid"; message: string },
			persistedRequest: boolean,
		) => Promise<boolean>

		await presentFailure.call(
			fakeTask,
			[{ type: "text", text: "already persisted" }],
			4,
			{ status: "invalid", message: "Profile not valid: current Profile is invalid." },
			true,
		)

		expect(fakeTask.say).not.toHaveBeenCalled()
		expect(fakeTask.messageStateHandler.addToApiConversationHistory).not.toHaveBeenCalled()
		expect(fakeTask.messageStateHandler.flushApiConversationHistory).not.toHaveBeenCalled()
		expect(fakeTask.admitApiRequest).toHaveBeenCalledWith(4)
	})
})
