import { resolveHostedImageGenerationPlan, resolveWebSearchRoutingPlan } from "@core/api/server-tools"
import type { CanonicalMessageRange } from "@core/context/context-management/compaction-context-projection"
import { ToolPromptGenerator } from "@core/prompts/generators/ToolPromptGenerator"
import type { RequestApiScope } from "@core/task/RequestApiScope"
import type { ClineStorageMessage } from "@shared/messages"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ErrorService } from "@/services/error"
import { Task } from "../index"
import { OrdinaryRequestInputReplay } from "../OrdinaryRequestInputReplay"

vi.mock("@core/storage/disk", async (importOriginal) => {
	const original = await importOriginal<typeof import("@core/storage/disk")>()
	return {
		...original,
		appendApiConversationEvent: vi.fn(async () => undefined),
		ensureTaskDirectoryExists: vi.fn(async () => "test-task-directory"),
	}
})

/** Hosted image generation stays out of the main conversation request for every fixture below. */
const disabledHostedImageGenerationPlan = resolveHostedImageGenerationPlan({
	enabled: false,
	source: undefined,
	modelInfo: undefined,
	selectedApiFormat: undefined,
	remoteAdapterAvailable: false,
})

describe("Task.attemptApiRequest first chunk state", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("keeps frozen request state and preserves manual retry takeover for outer recovery", async () => {
		const connectionError = new Error("connection dropped before first chunk")
		let liveWebToolsEnabled = true
		const api = {
			createMessage: vi.fn(() => ({
				[Symbol.asyncIterator]() {
					return this
				},
				next: vi.fn(async () => {
					throw connectionError
				}),
			})),
		}
		const requestScope = {
			api,
			providerInfo: {
				providerId: "deepseek",
				model: { id: "deepseek-v4-pro", info: {} },
				mode: "act",
			},
			webToolsEnabled: true,
			webSearchRoutingPlan: resolveWebSearchRoutingPlan({
				enabled: true,
				modelInfo: undefined,
				selectedApiFormat: undefined,
				localAvailable: true,
				remoteAdapterAvailable: false,
			}),
			hostedImageGenerationPlan: disabledHostedImageGenerationPlan,
			explicitInstructions: {
				beginProviderAttempt: vi.fn(),
				createConsumePort: vi.fn(() => ({})),
			},
		} as unknown as RequestApiScope
		const taskState = {
			abort: false,
			apiRequestCount: 1,
			autoRetryAttempts: 3,
			conversationHistoryDeletedRange: undefined,
			didAutomaticallyRetryFailedApiRequest: false,
			isWaitingForFirstChunk: false,
		}
		const conversationHistory = [{ role: "user" as const, content: "hello" }]
		const clineError = {
			message: "Connection error.",
			isErrorType: vi.fn(() => false),
			serialize: vi.fn(() => '{"message":"Connection error."}'),
		}
		vi.spyOn(ErrorService, "get").mockReturnValue({
			logMessage: vi.fn(),
			toClineError: vi.fn(() => clineError),
		} as unknown as ErrorService)
		vi.spyOn(ToolPromptGenerator.prototype, "generateToolsForRequest").mockReturnValue(undefined)

		const buildPromptContext = vi.fn(async (_providerInfo, webToolsEnabled, webSearchRoutingPlan) => {
			await Promise.resolve()
			liveWebToolsEnabled = false
			return { promptProfile: {}, clineWebToolsEnabled: webToolsEnabled, webSearchRoutingPlan }
		})
		const toolExecutor = {
			setAllowedNativeToolNames: vi.fn(),
			setExplicitInstructionConsumePort: vi.fn(),
			setHostedImageGenerationContext: vi.fn(),
			setPromptRuntime: vi.fn(),
			setWebSearchRoutingPlan: vi.fn(),
		}
		const beginIndicator = vi.fn(async () => ({
			kind: "ordinary" as const,
			requestId: "ordinary:task-first-chunk-failure:0",
			requestSequence: 1,
			attemptId: "attempt-0",
		}))
		const receiveIndicator = vi.fn(async () => undefined)
		const rollbackIndicator = vi.fn(async () => undefined)
		const ordinaryRequestInputReplay = { get: vi.fn(() => undefined), acknowledge: vi.fn() }
		const fakeTask = Object.assign(Object.create(Task.prototype), {
			taskId: "task-first-chunk-failure",
			manualRetryTakeoverActive: true,
			ordinaryRequestInputReplay,
			taskState,
			pendingSystemPromptRefreshReason: undefined,
			buildPromptContext,
			beginOrdinaryContextWindowIndicator: beginIndicator,
			receiveOrdinaryContextWindowIndicator: receiveIndicator,
			rollbackOrdinaryContextWindowIndicator: rollbackIndicator,
			apiRateMetricsService: {
				recordRequestStarted: vi.fn(),
				trackProviderStream: <T>(stream: T) => stream,
			},
			admitOrdinaryProviderRequestRound: vi.fn(() => ({
				bindAttempt: <T>(stream: T) => stream,
				attachExactUsage: vi.fn(),
			})),
			buildThinkingSummary: vi.fn(() => undefined),
			compactionRequestReplay: { getProviderInput: vi.fn(() => undefined), getHistoryIndex: vi.fn(() => undefined) },
			contextManager: {
				getNewContextMessagesAndMetadata: vi.fn(async () => ({
					truncatedConversationHistory: conversationHistory,
				})),
				applyContextHistoryUpdatesToCanonical: (messages: ClineStorageMessage[]) => messages,
				repairProviderMessagesWithRanges: (
					messages: ClineStorageMessage[],
					canonicalRanges: Array<CanonicalMessageRange | undefined>,
				) => ({ messages, canonicalRanges }),
			},
			endAutoRetrySequence: vi.fn(),
			messageStateHandler: {
				apiConversationHistory: conversationHistory,
				clineMessages: [],
			},
			modeSwitchCompaction: { shouldForce: vi.fn(() => false) },
			stateManager: {
				getApiConfiguration: vi.fn(() => ({ actModeProfile: "deepseek:deepseek-v4-pro" })),
				getGlobalSettingsKey: vi.fn((key: string) => (key === "clineWebToolsEnabled" ? liveWebToolsEnabled : false)),
			},
			systemPromptCacheService: {
				getLastTools: vi.fn(() => undefined),
				getOrCreate: vi.fn(async () => ({ text: "system prompt" })),
			},
			toolExecutor,
			writePromptMetadataArtifacts: vi.fn(async () => undefined),
		}) as Task

		const request = fakeTask.attemptApiRequest(-1, requestScope)

		await expect(request.next()).rejects.toBe(connectionError)
		expect(taskState.isWaitingForFirstChunk).toBe(false)
		expect(liveWebToolsEnabled).toBe(false)
		expect(beginIndicator).toHaveBeenCalledOnce()
		expect(beginIndicator.mock.invocationCallOrder[0]).toBeLessThan(api.createMessage.mock.invocationCallOrder[0])
		expect(receiveIndicator).not.toHaveBeenCalled()
		expect(rollbackIndicator).toHaveBeenCalledOnce()
		expect((fakeTask as unknown as { manualRetryTakeoverActive: boolean }).manualRetryTakeoverActive).toBe(true)
		expect(ordinaryRequestInputReplay.acknowledge).not.toHaveBeenCalled()
		expect(buildPromptContext).toHaveBeenCalledWith(
			requestScope.providerInfo,
			requestScope.webToolsEnabled,
			requestScope.webSearchRoutingPlan,
		)
		await expect(buildPromptContext.mock.results[0]?.value).resolves.toMatchObject({
			clineWebToolsEnabled: true,
		})
		expect(toolExecutor.setPromptRuntime).toHaveBeenCalledWith(
			expect.objectContaining({
				webToolsEnabled: requestScope.webToolsEnabled,
				webSearchRoutingPlan: expect.objectContaining({
					mode: requestScope.webSearchRoutingPlan.mode,
					route: requestScope.webSearchRoutingPlan.route,
					serverTools: requestScope.webSearchRoutingPlan.serverTools,
				}),
			}),
		)
		expect(toolExecutor.setWebSearchRoutingPlan).not.toHaveBeenCalled()
	})

	it("replays the same frozen Provider input after a first-chunk failure and releases it only on success", async () => {
		const connectionError = new Error("connection dropped before first chunk")
		const frozenInput = {
			systemPrompt: "frozen system prompt",
			messages: [{ role: "user" as const, content: "frozen user message" }],
			tools: [
				{
					name: "frozen_tool",
					description: "Frozen tool definition",
					input_schema: { type: "object" as const, properties: {} },
				},
			],
			serverTools: [],
		}
		const ordinaryRequestInputReplay = new OrdinaryRequestInputReplay()
		ordinaryRequestInputReplay.freeze(0, frozenInput)
		const api = {
			createMessage: vi
				.fn()
				.mockImplementationOnce(() => ({
					[Symbol.asyncIterator]() {
						return this
					},
					next: vi.fn(async () => {
						throw connectionError
					}),
				}))
				.mockImplementationOnce(() =>
					(async function* () {
						yield { type: "text" as const, text: "retry succeeded" }
					})(),
				),
		}
		const requestScope = {
			api,
			providerInfo: {
				providerId: "deepseek",
				model: { id: "deepseek-v4-pro", info: {} },
				mode: "act",
			},
			webToolsEnabled: false,
			webSearchRoutingPlan: resolveWebSearchRoutingPlan({
				enabled: false,
				modelInfo: undefined,
				selectedApiFormat: undefined,
				localAvailable: true,
				remoteAdapterAvailable: false,
			}),
			hostedImageGenerationPlan: disabledHostedImageGenerationPlan,
			explicitInstructions: {
				beginProviderAttempt: vi.fn(),
				createConsumePort: vi.fn(() => ({})),
			},
		} as unknown as RequestApiScope
		const taskState = {
			abort: false,
			apiRequestCount: 1,
			autoRetryAttempts: 3,
			conversationHistoryDeletedRange: undefined,
			didAutomaticallyRetryFailedApiRequest: false,
			isWaitingForFirstChunk: false,
			isInternalContextCompactionRequest: false,
			isManualContextCompactionRequest: false,
		}
		const clineError = {
			message: "Connection error.",
			isErrorType: vi.fn(() => false),
			serialize: vi.fn(() => '{"message":"Connection error."}'),
		}
		vi.spyOn(ErrorService, "get").mockReturnValue({
			logMessage: vi.fn(),
			toClineError: vi.fn(() => clineError),
		} as unknown as ErrorService)
		const buildProviderInput = vi.fn()
		const fakeTask = Object.assign(Object.create(Task.prototype), {
			taskId: "task-frozen-ordinary-retry",
			ordinaryRequestInputReplay,
			taskState,
			buildProviderInput,
			beginOrdinaryContextWindowIndicator: vi.fn(async () => ({
				kind: "ordinary" as const,
				requestId: "ordinary:task-frozen-ordinary-retry:0",
				requestSequence: 1,
				attemptId: "attempt-0",
			})),
			receiveOrdinaryContextWindowIndicator: vi.fn(async () => undefined),
			rollbackOrdinaryContextWindowIndicator: vi.fn(async () => undefined),
			apiRateMetricsService: {
				recordRequestStarted: vi.fn(),
				trackProviderStream: <T>(stream: T) => stream,
			},
			admitOrdinaryProviderRequestRound: vi.fn(() => ({
				bindAttempt: <T>(stream: T) => stream,
				attachExactUsage: vi.fn(),
			})),
			buildThinkingSummary: vi.fn(() => undefined),
			compactionRequestReplay: { getProviderInput: vi.fn(() => undefined), getHistoryIndex: vi.fn(() => undefined) },
			messageStateHandler: { apiConversationHistory: frozenInput.messages, clineMessages: [] },
			stateManager: {
				getApiConfiguration: vi.fn(() => ({ actModeProfile: "deepseek:deepseek-v4-pro" })),
				getGlobalSettingsKey: vi.fn(() => false),
			},
			toolExecutor: {
				setAllowedNativeToolNames: vi.fn(),
				setExplicitInstructionConsumePort: vi.fn(),
				setHostedImageGenerationContext: vi.fn(),
				setPromptRuntime: vi.fn(),
				setWebSearchRoutingPlan: vi.fn(),
			},
			writePromptMetadataArtifacts: vi.fn(async () => undefined),
			endAutoRetrySequence: vi.fn(),
			clearAutoRetryMessages: vi.fn(async () => undefined),
			postStateToWebview: vi.fn(async () => undefined),
		}) as Task

		await expect(fakeTask.attemptApiRequest(-1, requestScope, 0, 0).next()).rejects.toBe(connectionError)
		expect(ordinaryRequestInputReplay.get(0)).toEqual(frozenInput)

		const retry = await fakeTask.attemptApiRequest(-1, requestScope, 0, 1).next()
		expect(retry).toMatchObject({ done: false, value: { type: "text", text: "retry succeeded" } })
		expect(buildProviderInput).not.toHaveBeenCalled()
		expect(api.createMessage).toHaveBeenCalledTimes(2)
		expect(api.createMessage.mock.calls[1]).toEqual(api.createMessage.mock.calls[0])
		expect(ordinaryRequestInputReplay.get(0)).toBeUndefined()
	})

	it("rebuilds tool pairing from canonical history exactly once after a deterministic 400", async () => {
		const pairingError = new Error("OpenAI API Error 400: No tool output found for function call call_1.")
		const frozenInput = {
			systemPrompt: "frozen system prompt",
			messages: [{ role: "user" as const, content: "stale provider projection" }],
			tools: [{ name: "frozen_tool", description: "Frozen tool definition", input_schema: { type: "object" as const } }],
			serverTools: [],
		}
		const repairedMessages = [
			{
				role: "assistant" as const,
				content: [{ type: "tool_use" as const, function_id: "call_1", dline_tid: "tid_1", name: "read_file", input: {} }],
			},
			{
				role: "user" as const,
				content: [{ type: "tool_result" as const, function_id: "call_1", dline_tid: "tid_1", content: "repaired" }],
			},
		]
		const ordinaryRequestInputReplay = new OrdinaryRequestInputReplay()
		ordinaryRequestInputReplay.freeze(0, frozenInput)
		const api = {
			createMessage: vi
				.fn()
				.mockImplementationOnce(() => ({
					[Symbol.asyncIterator]() {
						return this
					},
					next: vi.fn(async () => {
						throw pairingError
					}),
				}))
				.mockImplementationOnce(() =>
					(async function* () {
						yield { type: "text" as const, text: "rebuild succeeded" }
					})(),
				),
		}
		const requestScope = {
			api,
			providerInfo: {
				providerId: "openai",
				model: { id: "gpt-5.6-sol", info: {} },
				mode: "act",
			},
			webToolsEnabled: false,
			webSearchRoutingPlan: resolveWebSearchRoutingPlan({
				enabled: false,
				modelInfo: undefined,
				selectedApiFormat: undefined,
				localAvailable: true,
				remoteAdapterAvailable: false,
			}),
			hostedImageGenerationPlan: disabledHostedImageGenerationPlan,
			explicitInstructions: {
				beginProviderAttempt: vi.fn(),
				createConsumePort: vi.fn(() => ({})),
			},
		} as unknown as RequestApiScope
		const projectCanonicalContext = vi.fn(() => repairedMessages)
		const fakeTask = Object.assign(Object.create(Task.prototype), {
			taskId: "task-canonical-rebuild",
			ordinaryRequestInputReplay,
			taskState: {
				abort: false,
				apiRequestCount: 1,
				autoRetryAttempts: 0,
				conversationHistoryDeletedRange: undefined,
				didAutomaticallyRetryFailedApiRequest: false,
				isWaitingForFirstChunk: false,
				isInternalContextCompactionRequest: false,
				isManualContextCompactionRequest: false,
			},
			projectCanonicalContext,
			buildProviderInput: vi.fn(),
			beginOrdinaryContextWindowIndicator: vi.fn(async (_apiIndex, providerAttempt) => ({
				kind: "ordinary" as const,
				requestId: "ordinary:task-canonical-rebuild:0",
				requestSequence: 1,
				attemptId: `attempt-${providerAttempt}`,
			})),
			receiveOrdinaryContextWindowIndicator: vi.fn(async () => undefined),
			rollbackOrdinaryContextWindowIndicator: vi.fn(async () => undefined),
			apiRateMetricsService: {
				recordRequestStarted: vi.fn(),
				trackProviderStream: <T>(stream: T) => stream,
			},
			admitOrdinaryProviderRequestRound: vi.fn(() => ({
				bindAttempt: <T>(stream: T) => stream,
				attachExactUsage: vi.fn(),
			})),
			buildThinkingSummary: vi.fn(() => undefined),
			compactionRequestReplay: { getProviderInput: vi.fn(() => undefined), getHistoryIndex: vi.fn(() => undefined) },
			messageStateHandler: { apiConversationHistory: repairedMessages, clineMessages: [] },
			stateManager: {
				getApiConfiguration: vi.fn(() => ({ actModeProfile: "openai:gpt-5.6-sol" })),
				getGlobalSettingsKey: vi.fn(() => false),
			},
			toolExecutor: {
				setAllowedNativeToolNames: vi.fn(),
				setExplicitInstructionConsumePort: vi.fn(),
				setHostedImageGenerationContext: vi.fn(),
				setPromptRuntime: vi.fn(),
				setWebSearchRoutingPlan: vi.fn(),
			},
			writePromptMetadataArtifacts: vi.fn(async () => undefined),
			endAutoRetrySequence: vi.fn(),
			clearAutoRetryMessages: vi.fn(async () => undefined),
			postStateToWebview: vi.fn(async () => undefined),
		}) as Task

		const result = await fakeTask.attemptApiRequest(-1, requestScope, 0, 0).next()

		expect(result).toMatchObject({ done: false, value: { type: "text", text: "rebuild succeeded" } })
		expect(projectCanonicalContext).toHaveBeenCalledOnce()
		expect(api.createMessage).toHaveBeenCalledTimes(2)
		expect(api.createMessage.mock.calls[0]?.[0]).toBe(frozenInput.systemPrompt)
		expect(api.createMessage.mock.calls[1]?.[0]).toBe(frozenInput.systemPrompt)
		expect(api.createMessage.mock.calls[0]?.[2]).toEqual(frozenInput.tools)
		expect(api.createMessage.mock.calls[1]?.[2]).toEqual(frozenInput.tools)
		expect(api.createMessage.mock.calls[1]?.[1]).toEqual(repairedMessages)
		expect(ordinaryRequestInputReplay.get(0)).toBeUndefined()
	})

	it("does not retry the same deterministic tool-pairing 400 after canonical rebuild is exhausted", async () => {
		const pairingError = new Error("HTTP 400: No tool output found for function call call_1.")
		const ordinaryRequestInputReplay = new OrdinaryRequestInputReplay()
		ordinaryRequestInputReplay.freeze(0, {
			systemPrompt: "frozen",
			messages: [{ role: "user", content: "stale" }],
			serverTools: [],
		})
		const api = {
			createMessage: vi.fn(() => ({
				[Symbol.asyncIterator]() {
					return this
				},
				next: vi.fn(async () => {
					throw pairingError
				}),
			})),
		}
		const requestScope = {
			api,
			providerInfo: { providerId: "openai", model: { id: "gpt-5.6-sol", info: {} }, mode: "act" },
			webToolsEnabled: false,
			webSearchRoutingPlan: resolveWebSearchRoutingPlan({
				enabled: false,
				modelInfo: undefined,
				selectedApiFormat: undefined,
				localAvailable: true,
				remoteAdapterAvailable: false,
			}),
			hostedImageGenerationPlan: disabledHostedImageGenerationPlan,
			explicitInstructions: { beginProviderAttempt: vi.fn(), createConsumePort: vi.fn(() => ({})) },
		} as unknown as RequestApiScope
		const projectCanonicalContext = vi.fn(() => [{ role: "user" as const, content: "repaired" }])
		const fakeTask = Object.assign(Object.create(Task.prototype), {
			taskId: "task-canonical-rebuild-exhausted",
			ordinaryRequestInputReplay,
			taskState: {
				abort: false,
				apiRequestCount: 1,
				autoRetryAttempts: 0,
				conversationHistoryDeletedRange: undefined,
				didAutomaticallyRetryFailedApiRequest: false,
				isWaitingForFirstChunk: false,
				isInternalContextCompactionRequest: false,
				isManualContextCompactionRequest: false,
			},
			projectCanonicalContext,
			beginOrdinaryContextWindowIndicator: vi.fn(async (_apiIndex, providerAttempt) => ({
				kind: "ordinary" as const,
				requestId: "ordinary:task-canonical-rebuild-exhausted:0",
				requestSequence: 1,
				attemptId: `attempt-${providerAttempt}`,
			})),
			receiveOrdinaryContextWindowIndicator: vi.fn(async () => undefined),
			rollbackOrdinaryContextWindowIndicator: vi.fn(async () => undefined),
			apiRateMetricsService: { recordRequestStarted: vi.fn(), trackProviderStream: <T>(stream: T) => stream },
			admitOrdinaryProviderRequestRound: vi.fn(() => ({
				bindAttempt: <T>(stream: T) => stream,
				attachExactUsage: vi.fn(),
			})),
			buildThinkingSummary: vi.fn(() => undefined),
			compactionRequestReplay: { getProviderInput: vi.fn(() => undefined), getHistoryIndex: vi.fn(() => undefined) },
			messageStateHandler: { apiConversationHistory: [{ role: "user" as const, content: "canonical" }], clineMessages: [] },
			stateManager: {
				getApiConfiguration: vi.fn(() => ({ actModeProfile: "openai:gpt-5.6-sol" })),
				getGlobalSettingsKey: vi.fn(() => false),
			},
			toolExecutor: {
				setAllowedNativeToolNames: vi.fn(),
				setExplicitInstructionConsumePort: vi.fn(),
				setHostedImageGenerationContext: vi.fn(),
				setPromptRuntime: vi.fn(),
				setWebSearchRoutingPlan: vi.fn(),
			},
			writePromptMetadataArtifacts: vi.fn(async () => undefined),
		}) as Task

		await expect(fakeTask.attemptApiRequest(-1, requestScope, 0, 0).next()).rejects.toBe(pairingError)
		expect(api.createMessage).toHaveBeenCalledTimes(2)
		expect(projectCanonicalContext).toHaveBeenCalledOnce()
	})

	it("fails explicitly when the provider stream ends without yielding any chunk", async () => {
		// A Responses stream that only emits codex.rate_limits / metadata /
		// response.failed events produces no chunks. Previously the empty
		// generator was treated as a successful first chunk and yielded
		// undefined, crashing downstream on
		// "Cannot read properties of undefined (reading 'type')".
		const api = {
			createMessage: vi.fn(() => (async function* () {})()),
		}
		const requestScope = {
			api,
			providerInfo: {
				providerId: "openai",
				model: { id: "gpt-5.6-sol", info: {} },
				mode: "act",
			},
			webToolsEnabled: true,
			webSearchRoutingPlan: resolveWebSearchRoutingPlan({
				enabled: false,
				modelInfo: undefined,
				selectedApiFormat: undefined,
				localAvailable: true,
				remoteAdapterAvailable: false,
			}),
			hostedImageGenerationPlan: disabledHostedImageGenerationPlan,
			explicitInstructions: {
				beginProviderAttempt: vi.fn(),
				createConsumePort: vi.fn(() => ({})),
			},
		} as unknown as RequestApiScope
		const taskState = {
			abort: false,
			apiRequestCount: 1,
			autoRetryAttempts: 3,
			conversationHistoryDeletedRange: undefined,
			didAutomaticallyRetryFailedApiRequest: false,
			isWaitingForFirstChunk: false,
		}
		const conversationHistory = [{ role: "user" as const, content: "hello" }]
		const clineError = {
			message: "API stream ended without producing any content.",
			isErrorType: vi.fn(() => false),
			serialize: vi.fn(() => '{"message":"API stream ended without producing any content."}'),
		}
		vi.spyOn(ErrorService, "get").mockReturnValue({
			logMessage: vi.fn(),
			toClineError: vi.fn(() => clineError),
		} as unknown as ErrorService)
		vi.spyOn(ToolPromptGenerator.prototype, "generateToolsForRequest").mockReturnValue(undefined)

		const beginIndicator = vi.fn(async () => ({
			kind: "ordinary" as const,
			requestId: "ordinary:task-first-chunk-empty-stream:0",
			requestSequence: 1,
			attemptId: "attempt-0",
		}))
		const receiveIndicator = vi.fn(async () => undefined)
		const rollbackIndicator = vi.fn(async () => undefined)
		const ordinaryRequestInputReplay = { get: vi.fn(() => undefined), acknowledge: vi.fn() }
		const fakeTask = Object.assign(Object.create(Task.prototype), {
			taskId: "task-first-chunk-empty-stream",
			ordinaryRequestInputReplay,
			taskState,
			beginOrdinaryContextWindowIndicator: beginIndicator,
			receiveOrdinaryContextWindowIndicator: receiveIndicator,
			rollbackOrdinaryContextWindowIndicator: rollbackIndicator,
			pendingSystemPromptRefreshReason: undefined,
			buildPromptContext: vi.fn(async () => ({
				promptProfile: {},
				clineWebToolsEnabled: true,
				webSearchRoutingPlan: requestScope.webSearchRoutingPlan,
			})),
			apiRateMetricsService: {
				recordRequestStarted: vi.fn(),
				trackProviderStream: <T>(stream: T) => stream,
			},
			admitOrdinaryProviderRequestRound: vi.fn(() => ({
				bindAttempt: <T>(stream: T) => stream,
				attachExactUsage: vi.fn(),
			})),
			buildThinkingSummary: vi.fn(() => undefined),
			compactionRequestReplay: { getProviderInput: vi.fn(() => undefined), getHistoryIndex: vi.fn(() => undefined) },
			contextManager: {
				getNewContextMessagesAndMetadata: vi.fn(async () => ({
					truncatedConversationHistory: conversationHistory,
				})),
				applyContextHistoryUpdatesToCanonical: (messages: ClineStorageMessage[]) => messages,
				repairProviderMessagesWithRanges: (
					messages: ClineStorageMessage[],
					canonicalRanges: Array<CanonicalMessageRange | undefined>,
				) => ({ messages, canonicalRanges }),
			},
			endAutoRetrySequence: vi.fn(),
			messageStateHandler: {
				apiConversationHistory: conversationHistory,
				clineMessages: [],
			},
			modeSwitchCompaction: { shouldForce: vi.fn(() => false) },
			stateManager: {
				getApiConfiguration: vi.fn(() => ({ actModeProfile: "openai:gpt-5.6-sol" })),
				getGlobalSettingsKey: vi.fn(() => false),
			},
			systemPromptCacheService: {
				getLastTools: vi.fn(() => undefined),
				getOrCreate: vi.fn(async () => ({ text: "system prompt" })),
			},
			toolExecutor: {
				setAllowedNativeToolNames: vi.fn(),
				setExplicitInstructionConsumePort: vi.fn(),
				setHostedImageGenerationContext: vi.fn(),
				setPromptRuntime: vi.fn(),
				setWebSearchRoutingPlan: vi.fn(),
			},
			writePromptMetadataArtifacts: vi.fn(async () => undefined),
		}) as Task

		const request = fakeTask.attemptApiRequest(-1, requestScope)

		await expect(request.next()).rejects.toThrow("API stream ended without producing any content")
		expect(taskState.isWaitingForFirstChunk).toBe(false)
		expect(beginIndicator).toHaveBeenCalledOnce()
		expect(receiveIndicator).not.toHaveBeenCalled()
		expect(rollbackIndicator).toHaveBeenCalledOnce()
		expect(ordinaryRequestInputReplay.acknowledge).not.toHaveBeenCalled()
	})
})
