import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import {
	DEFAULT_AUTO_CONDENSE_MAX_CONTEXT_TOKENS,
	DEFAULT_AUTO_CONDENSE_MAX_RESERVE_TOKENS,
	DEFAULT_AUTO_CONDENSE_MIN_RESERVE_TOKENS,
	DEFAULT_AUTO_CONDENSE_TRIGGER_PERCENT,
} from "@shared/auto-condense"
import { DEFAULT_BROWSER_SETTINGS } from "@shared/BrowserSettings"
import { DEFAULT_CHAT_INPUT_SEND_SHORTCUT } from "@shared/ChatInputSendShortcut"
import { DEFAULT_MAX_PARALLEL_SUBAGENTS, DEFAULT_MAX_PARALLEL_TOOL_CALLS } from "@shared/concurrency-limits"
import { type ActiveInteractionView, type ClineMessage, DEFAULT_PLATFORM, type ExtensionState } from "@shared/ExtensionMessage"
import { DEFAULT_FOCUS_CHAIN_SETTINGS } from "@shared/FocusChainSettings"
import { DEFAULT_MCP_DISPLAY_MODE } from "@shared/McpDisplayMode"
import type { UserInfo } from "@shared/proto/dline/account"
import { EmptyRequest } from "@shared/proto/dline/common"
import type { OpenRouterCompatibleModelInfo } from "@shared/proto/dline/models"
import { OnboardingModelGroup, type TerminalProfile } from "@shared/proto/dline/state"
import { FetchMessageRequest } from "@shared/proto/dline/task"
import { protoToAccountUsage } from "@shared/proto-conversions/account-usage-conversion"
import { convertProtoToClineMessage } from "@shared/proto-conversions/cline-message"
import { convertProtoMcpServersToMcpServers } from "@shared/proto-conversions/mcp/mcp-server-conversion"
import { fromProtobufModels } from "@shared/proto-conversions/models/typeConversion"
import type React from "react"
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import {
	basetenDefaultModelId,
	basetenModels,
	groqDefaultModelId,
	groqModels,
	type ModelInfo,
	openRouterDefaultModelId,
	openRouterDefaultModelInfo,
	requestyDefaultModelId,
	requestyDefaultModelInfo,
} from "../../../src/shared/api"
import { Environment } from "../../../src/shared/config-types"
import type { McpMarketplaceCatalog, McpServer, McpViewTab } from "../../../src/shared/mcp"
import type { TaskCapabilityToggles } from "../../../src/shared/TaskCapabilityToggles"
import {
	McpServiceClient,
	ModelsServiceClient,
	StateServiceClient,
	TaskServiceClient,
	UiServiceClient,
} from "../services/grpc-client"
import { canAppendRealtimeMessage, isMessageWindowOverfull, reconcileMessageWindow } from "./messageWindowSync"

const getTaskViewKey = (taskId?: string, taskTitleMessageTs?: number) =>
	taskId ?? (taskTitleMessageTs != null ? `task-title:${taskTitleMessageTs}` : undefined)

/** Decide whether an incoming full state snapshot may replace current Webview state. */
export function shouldAcceptState(currentRevision: number, incomingRevision?: number): boolean {
	if (incomingRevision === undefined) return currentRevision === 0
	return incomingRevision > currentRevision
}

const mergeClineMessagesByTs = (existing: ClineMessage[], incoming: ClineMessage[]): ClineMessage[] => {
	const merged: ClineMessage[] = []
	const indexByTs = new Map<number, number>()
	const appendOrReplace = (message: ClineMessage) => {
		const existingIndex = indexByTs.get(message.ts)
		if (existingIndex === undefined) {
			indexByTs.set(message.ts, merged.length)
			merged.push(message)
			return
		}
		const current = merged[existingIndex]
		if (current.partial !== true && message.partial === true) {
			return
		}
		merged[existingIndex] = message
	}

	for (const message of existing) {
		appendOrReplace(message)
	}
	for (const message of incoming) {
		appendOrReplace(message)
	}
	return merged.sort((left, right) => left.ts - right.ts)
}

/**
 * Merge a fetched window into the local one without losing backend deletions.
 *
 * A plain timestamp union can only add or replace, so a message the backend
 * removed stayed on screen forever. Reconciliation treats the fetched span as
 * authoritative and leaves everything outside it untouched.
 *
 * @param existing Currently rendered window.
 * @param existingStartIndex Absolute index of the first rendered message.
 * @param fetched Window returned by the backend.
 * @param fetchedStartIndex Absolute index of the first fetched message.
 * @param total Total messages the backend reports, when known.
 * @returns Reconciled window and its absolute start index.
 */
const applyFetchedMessageWindow = (
	existing: ClineMessage[],
	existingStartIndex: number,
	fetched: ClineMessage[],
	fetchedStartIndex: number,
	total?: number,
): { messages: ClineMessage[]; startIndex: number } => {
	const reconciled = reconcileMessageWindow(
		{ messages: existing, startIndex: existingStartIndex },
		{ messages: fetched, startIndex: fetchedStartIndex, total },
	)
	return { messages: reconciled.messages, startIndex: reconciled.startIndex }
}

const hasExactInteractionAnchor = (messages: readonly ClineMessage[], interaction: ActiveInteractionView): boolean =>
	messages.some(
		(message) =>
			message.type === "ask" &&
			message.ts === interaction.askMessageTs &&
			message.interactionId === interaction.interactionId &&
			message.ask === interaction.taskAsk,
	)

const interactionFetchKey = (taskViewKey: string | undefined, interaction: ActiveInteractionView): string =>
	`${taskViewKey ?? ""}:${interaction.stateRevision}:${interaction.interactionId}:${interaction.askMessageTs}`

/**
 * Turns whatever a failed subscription produced into a message a user can act
 * on. gRPC errors, thrown values and plain strings all reach this path, and a
 * rendered `[object Object]` would be no more useful than the blank panel it
 * replaces.
 */
function describeHydrationFailure(error: unknown): string {
	if (error instanceof Error) {
		return error.message
	}
	if (typeof error === "string") {
		return error
	}
	return "Unknown state subscription failure"
}

/**
 * How far the webview has got towards having state to render.
 *
 * Hydration used to be a single boolean that only ever moved forward on
 * success. A parse failure or a subscription error left it false with no way
 * to tell the two apart, and the view rendered nothing at all — the blank
 * panel. Naming the failure separately is what makes it reportable.
 */
export type HydrationStatus = { status: "pending" } | { status: "failed"; reason: string } | { status: "ready" }

export interface ExtensionStateContextType extends ExtensionState {
	clineMessages: ClineMessage[]
	setClineMessages: React.Dispatch<React.SetStateAction<ClineMessage[]>>
	didHydrateState: boolean
	/** Hydration progress, including why it failed when it did. */
	hydration: HydrationStatus
	/** Re-establishes the state subscription after a failure. */
	retryHydration: () => void
	showWelcome: boolean
	onboardingModels: OnboardingModelGroup | undefined
	clineModels: Record<string, ModelInfo> | null
	openRouterModels: Record<string, ModelInfo>
	vercelAiGatewayModels: Record<string, ModelInfo>
	hicapModels: Record<string, ModelInfo>
	liteLlmModels: Record<string, ModelInfo>
	openAiModels: string[]
	requestyModels: Record<string, ModelInfo>
	groqModels: Record<string, ModelInfo>
	basetenModels: Record<string, ModelInfo>
	huggingFaceModels: Record<string, ModelInfo>
	mcpServers: McpServer[]
	mcpMarketplaceCatalog: McpMarketplaceCatalog
	totalTasksSize: number | null

	availableTerminalProfiles: TerminalProfile[]

	// View state
	showMcp: boolean
	mcpTab?: McpViewTab
	showSettings: boolean
	settingsTargetSection?: string
	showHistory: boolean
	showAccount: boolean
	showWorktrees: boolean
	showAnnouncement: boolean
	expandTaskHeader: boolean

	// Setters
	setShowAnnouncement: (value: boolean) => void
	setShouldShowAnnouncement: (value: boolean) => void
	setMcpServers: (value: McpServer[]) => void
	setRequestyModels: (value: Record<string, ModelInfo>) => void
	setGroqModels: (value: Record<string, ModelInfo>) => void
	setBasetenModels: (value: Record<string, ModelInfo>) => void
	setHuggingFaceModels: (value: Record<string, ModelInfo>) => void
	setGlobalClineRulesToggles: (toggles: Record<string, boolean>) => void
	setLocalClineRulesToggles: (toggles: Record<string, boolean>) => void
	setLocalCursorRulesToggles: (toggles: Record<string, boolean>) => void
	setLocalWindsurfRulesToggles: (toggles: Record<string, boolean>) => void
	setLocalAgentsRulesToggles: (toggles: Record<string, boolean>) => void
	setLocalWorkflowToggles: (toggles: Record<string, boolean>) => void
	setGlobalWorkflowToggles: (toggles: Record<string, boolean>) => void
	setGlobalSkillsToggles: (toggles: Record<string, boolean>) => void
	setLocalSkillsToggles: (toggles: Record<string, boolean>) => void
	setRemoteSkillsToggles: (toggles: Record<string, boolean>) => void
	setTaskCapabilityToggles: (toggles: TaskCapabilityToggles | undefined) => void
	setRemoteRulesToggles: (toggles: Record<string, boolean>) => void
	setRemoteWorkflowToggles: (toggles: Record<string, boolean>) => void
	setMcpMarketplaceCatalog: (value: McpMarketplaceCatalog) => void
	setTotalTasksSize: (value: number | null) => void
	setExpandTaskHeader: (value: boolean) => void
	setShowWelcome: (value: boolean) => void
	setOnboardingModels: (value: OnboardingModelGroup | undefined) => void

	// Sliding window
	firstItemIndex: number
	setFirstItemIndex: React.Dispatch<React.SetStateAction<number>>

	// Refresh functions
	refreshClineModels: () => void
	refreshOpenRouterModels: () => void
	refreshVercelAiGatewayModels: () => void
	refreshHicapModels: () => void
	refreshLiteLlmModels: () => Promise<void>
	setUserInfo: (userInfo?: UserInfo) => void

	// Navigation state setters
	setShowMcp: (value: boolean) => void
	setMcpTab: (tab?: McpViewTab) => void

	// Navigation functions
	navigateToMcp: (tab?: McpViewTab) => void
	navigateToSettings: (targetSection?: string) => void
	navigateToHistory: () => void
	navigateToAccount: () => void
	navigateToWorktrees: () => void
	navigateToChat: () => void

	// Hide functions
	hideSettings: () => void
	hideHistory: () => void
	hideAccount: () => void
	hideWorktrees: () => void
	hideAnnouncement: () => void
	closeMcpView: () => void

	// Event callbacks
	onRelinquishControl: (callback: () => void) => () => void
}

export const ExtensionStateContext = createContext<ExtensionStateContextType | undefined>(undefined)

export const ExtensionStateContextProvider: React.FC<{
	children: React.ReactNode
}> = ({ children }) => {
	// UI view state
	const [showMcp, setShowMcp] = useState(false)
	const [mcpTab, setMcpTab] = useState<McpViewTab | undefined>(undefined)
	const [showSettings, setShowSettings] = useState(false)
	const [settingsTargetSection, setSettingsTargetSection] = useState<string | undefined>(undefined)
	const [showHistory, setShowHistory] = useState(false)
	const [showAccount, setShowAccount] = useState(false)
	const [showWorktrees, setShowWorktrees] = useState(false)
	const [showAnnouncement, setShowAnnouncement] = useState(false)

	// Helper for MCP view
	const closeMcpView = useCallback(() => {
		setShowMcp(false)
		setMcpTab(undefined)
	}, [])

	// Hide functions
	const hideSettings = useCallback(() => {
		setShowSettings(false)
		setSettingsTargetSection(undefined)
	}, [])
	const hideHistory = useCallback(() => setShowHistory(false), [])
	const hideAccount = useCallback(() => setShowAccount(false), [])
	const hideWorktrees = useCallback(() => setShowWorktrees(false), [])
	const hideAnnouncement = useCallback(() => setShowAnnouncement(false), [])

	// Navigation functions
	const navigateToMcp = useCallback((tab?: McpViewTab) => {
		setShowSettings(false)
		setShowHistory(false)
		setShowAccount(false)
		setShowWorktrees(false)
		if (tab) {
			setMcpTab(tab)
		}
		setShowMcp(true)
	}, [])

	const navigateToSettings = useCallback(
		(targetSection?: string) => {
			setShowHistory(false)
			closeMcpView()
			setShowAccount(false)
			setShowWorktrees(false)
			setSettingsTargetSection(targetSection)
			setShowSettings(true)
		},
		[closeMcpView],
	)

	const navigateToHistory = useCallback(() => {
		setShowSettings(false)
		closeMcpView()
		setShowAccount(false)
		setShowWorktrees(false)
		setShowHistory(true)
	}, [closeMcpView])

	const navigateToAccount = useCallback(() => {
		setShowSettings(false)
		closeMcpView()
		setShowHistory(false)
		setShowWorktrees(false)
		setShowAccount(true)
	}, [closeMcpView])

	const navigateToWorktrees = useCallback(() => {
		setShowSettings(false)
		closeMcpView()
		setShowHistory(false)
		setShowAccount(false)
		setShowWorktrees(true)
	}, [closeMcpView])

	const navigateToChat = useCallback(() => {
		setShowSettings(false)
		closeMcpView()
		setShowHistory(false)
		setShowAccount(false)
		setShowWorktrees(false)
	}, [closeMcpView])

	const [state, setState] = useState<ExtensionState>({
		stateRevision: 0,
		version: "",
		taskHistory: [],
		shouldShowAnnouncement: false,
		autoApprovalSettings: DEFAULT_AUTO_APPROVAL_SETTINGS,
		browserSettings: DEFAULT_BROWSER_SETTINGS,
		focusChainSettings: DEFAULT_FOCUS_CHAIN_SETTINGS,
		preferredLanguage: "English",
		chatInputSendShortcut: DEFAULT_CHAT_INPUT_SEND_SHORTCUT,
		mode: "act",
		platform: DEFAULT_PLATFORM,
		environment: Environment.production,
		usageReportingSetting: "unset",
		errorReportingSetting: "unset",
		distinctId: "",
		planActSeparateModelsSetting: true,
		enableCheckpointsSetting: true,
		mcpDisplayMode: DEFAULT_MCP_DISPLAY_MODE,
		globalClineRulesToggles: {},
		localClineRulesToggles: {},
		localCursorRulesToggles: {},
		localWindsurfRulesToggles: {},
		localAgentsRulesToggles: {},
		localWorkflowToggles: {},
		globalWorkflowToggles: {},
		shellIntegrationTimeout: 4000,
		terminalReuseEnabled: true,
		vscodeTerminalExecutionMode: "vscodeTerminal",
		terminalOutputLineLimit: 500,
		terminalCommandTimeoutSeconds: 1800,
		terminalCommandHandoffSeconds: 10,
		maxConsecutiveMistakes: 3,
		defaultTerminalProfile: "default",
		isNewUser: false,
		welcomeViewCompleted: false,
		onboardingModels: undefined,
		mcpResponsesCollapsed: false, // Default value (expanded), will be overwritten by extension state
		strictPlanModeEnabled: false,
		yoloModeToggled: false,
		customPrompt: undefined,
		useAutoCondense: false,
		autoCondenseTriggerPercent: DEFAULT_AUTO_CONDENSE_TRIGGER_PERCENT,
		autoCondenseMinReserveTokens: DEFAULT_AUTO_CONDENSE_MIN_RESERVE_TOKENS,
		autoCondenseMaxReserveTokens: DEFAULT_AUTO_CONDENSE_MAX_RESERVE_TOKENS,
		autoCondenseMaxContextTokens: DEFAULT_AUTO_CONDENSE_MAX_CONTEXT_TOKENS,
		subagentsEnabled: true,
		mcpEnabled: true,
		clineWebToolsEnabled: { user: true, featureFlag: false },
		worktreesEnabled: { user: true, featureFlag: false },
		favoritedModelIds: [],
		optOutOfRemoteConfig: false,
		remoteConfigSettings: {},
		backgroundCommandRunning: false,
		backgroundCommandTaskId: undefined,
		backgroundEditEnabled: false,
		doubleCheckCompletionEnabled: false,
		lazyTeammateModeEnabled: false,
		showFeatureTips: true,
		showActiveTasksInEnvDetails: true,
		globalSkillsToggles: {},
		localSkillsToggles: {},
		remoteSkillsToggles: {},
		taskCapabilityToggles: undefined,

		// NEW: Add workspace information with defaults
		workspaceRoots: [],
		primaryRootIndex: 0,
		isMultiRootWorkspace: false,
		multiRootSetting: { user: false, featureFlag: false },
		hooksEnabled: false,
		nativeToolCallSetting: false,
		enableParallelToolCalling: false,
		// Resolved from the shared policy rather than a literal, so the slider
		// before hydration shows the same ceiling the runtime would apply.
		maxParallelToolCalls: DEFAULT_MAX_PARALLEL_TOOL_CALLS,
		maxParallelSubagents: DEFAULT_MAX_PARALLEL_SUBAGENTS,
		providersVersion: 0,
		profileCatalogRevision: 0,
		taskLockStatus: undefined,
	})
	const [expandTaskHeader, setExpandTaskHeader] = useState(true)
	const [hydration, setHydration] = useState<HydrationStatus>({ status: "pending" })
	const didHydrateState = hydration.status === "ready"
	// Bumping this re-runs the subscription effect, which is what a retry needs:
	// the failed stream is torn down by the effect cleanup and replaced.
	const [hydrationAttempt, setHydrationAttempt] = useState(0)
	const retryHydration = useCallback(() => {
		setHydration({ status: "pending" })
		setHydrationAttempt((attempt) => attempt + 1)
	}, [])

	// Atomic sliding window state via React 18 auto-batching
	const [clineMessages, setClineMessages] = useState<ClineMessage[]>([])
	const [firstItemIndex, setFirstItemIndex] = useState(0)
	const clineMessagesRef = useRef<ClineMessage[]>([])
	// Fetch callbacks resolve after their scheduling render, so reconciliation
	// has to read the window start from a ref rather than the captured value.
	const firstItemIndexRef = useRef(0)
	const totalMessageCountRef = useRef(0)
	const bootstrapResolvedRef = useRef(false)
	clineMessagesRef.current = clineMessages
	firstItemIndexRef.current = firstItemIndex
	totalMessageCountRef.current = state.totalMessageCount ?? 0
	if (clineMessages.length > 0) bootstrapResolvedRef.current = true

	const commitMessageWindow = useCallback((messages: ClineMessage[], startIndex: number) => {
		clineMessagesRef.current = messages
		firstItemIndexRef.current = startIndex
		setClineMessages(messages)
		setFirstItemIndex(startIndex)
	}, [])

	const prevTotalRef = useRef(0)
	const refetchLockRef = useRef(false)
	// Stabilize window after cancel: delay refetch by 200ms so rapid state
	// changes (remove partials, postState, total update) settle before
	// triggering a Virtuoso data swap that causes layout jitter.
	const cancelStabilizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const initialTaskViewKey = getTaskViewKey(state.currentTaskItem?.id, state.taskTitleMessage?.ts)
	const currentTaskViewKeyRef = useRef<string | undefined>(initialTaskViewKey)
	const messageFetchGenerationRef = useRef(0)
	const prevRefetchTaskViewKeyRef = useRef<string | undefined>(initialTaskViewKey)
	const prevHistoryTaskViewKeyRef = useRef<string | undefined>(initialTaskViewKey)
	// Separating these two is the fix for a footer that stayed permanently
	// unusable: one records that an anchor was successfully hydrated, the other
	// only that a recovery is currently running. Collapsing them made a failed
	// attempt look like a completed one.
	const lastInteractionFetchKeyRef = useRef<string | undefined>(undefined)
	const inFlightInteractionFetchRef = useRef<string | undefined>(undefined)
	const projectedInteraction = state.taskViewState?.activeInteraction
	const projectedInteractionAnchorPresent = projectedInteraction
		? hasExactInteractionAnchor(clineMessages, projectedInteraction)
		: true
	const localTailMessage = clineMessages.at(-1)

	// Reset when task is cleared, bootstrap on task switch, and reconcile gaps
	// when a durable tail message arrives without its realtime event.
	useEffect(() => {
		const currentTaskViewKey = getTaskViewKey(state.currentTaskItem?.id, state.taskTitleMessage?.ts)
		const total = state.totalMessageCount ?? 0

		const fetchLatestWindow = (scheduledTaskViewKey: string | undefined, expectedInteraction?: ActiveInteractionView) => {
			const scheduledGeneration = messageFetchGenerationRef.current
			// The key records that this interaction's anchor is now *hydrated*,
			// so it is written only once the committed window actually contains
			// the anchor. Recording it here, before the request, would mark a
			// failed recovery as done and suppress every later attempt, leaving
			// the footer permanently unusable.
			const expectedKey = expectedInteraction ? interactionFetchKey(scheduledTaskViewKey, expectedInteraction) : undefined
			// Guards this fetch chain against re-entry while it is still running,
			// without claiming the anchor was recovered.
			const inFlightKey = expectedKey
			if (inFlightKey) {
				inFlightInteractionFetchRef.current = inFlightKey
			}
			const retryDelaysMs = [100, 300, 750] as const
			const retryLatest = async (attempt: number, retryLatestAtStart: boolean): Promise<void> => {
				if (attempt >= retryDelaysMs.length) return
				await new Promise<void>((resolve) => setTimeout(resolve, retryDelaysMs[attempt]))
				if (
					messageFetchGenerationRef.current !== scheduledGeneration ||
					currentTaskViewKeyRef.current !== scheduledTaskViewKey
				) {
					return
				}
				await fetchAttempt(-1, retryLatestAtStart, attempt + 1)
			}
			const fetchAttempt = async (
				referenceIndex: number,
				retryLatestAtStart: boolean,
				bootstrapRetryAttempt = 0,
			): Promise<void> => {
				try {
					const resp = await TaskServiceClient.fetchMessage(FetchMessageRequest.create({ referenceIndex, count: 200 }))
					if (
						messageFetchGenerationRef.current !== scheduledGeneration ||
						currentTaskViewKeyRef.current !== scheduledTaskViewKey
					) {
						return
					}
					const converted = resp.messages.map((message) => convertProtoToClineMessage(message))
					const responseTotal = Number(resp.totalCount ?? 0)
					if (
						!expectedInteraction &&
						referenceIndex === -1 &&
						converted.length === 0 &&
						!bootstrapResolvedRef.current &&
						clineMessagesRef.current.length === 0 &&
						Math.max(total, responseTotal) > 0 &&
						bootstrapRetryAttempt < retryDelaysMs.length
					) {
						await retryLatest(bootstrapRetryAttempt, retryLatestAtStart)
						return
					}
					if (converted.length > 0) bootstrapResolvedRef.current = true
					const startIndex = Math.max(0, resp.startIndex)
					const reconciled = applyFetchedMessageWindow(
						clineMessagesRef.current,
						firstItemIndexRef.current,
						converted,
						startIndex,
						responseTotal,
					)
					commitMessageWindow(reconciled.messages, reconciled.startIndex)
					if (expectedInteraction) {
						// The response may contain the anchor and still be
						// rejected by the continuous-window contract when it does
						// not touch the local window. Only the committed window
						// makes the anchor consumable, so success is judged there
						// rather than on the raw response.
						if (hasExactInteractionAnchor(reconciled.messages, expectedInteraction)) {
							lastInteractionFetchKeyRef.current = expectedKey
							if (inFlightKey && inFlightInteractionFetchRef.current === inFlightKey) {
								inFlightInteractionFetchRef.current = undefined
							}
						} else if (startIndex > 0) {
							await fetchAttempt(Math.max(0, startIndex - 200), false)
						} else if (retryLatestAtStart) {
							await fetchAttempt(-1, false)
						} else if (inFlightKey && inFlightInteractionFetchRef.current === inFlightKey) {
							// Every page was walked without recovering the anchor.
							// Releasing the in-flight marker lets a later viewport
							// change try again instead of failing permanently.
							inFlightInteractionFetchRef.current = undefined
						}
					}
				} catch {
					if (
						!expectedInteraction &&
						referenceIndex === -1 &&
						total > 0 &&
						!bootstrapResolvedRef.current &&
						clineMessagesRef.current.length === 0
					) {
						await retryLatest(bootstrapRetryAttempt, retryLatestAtStart)
						return
					}
					// A failed request ends this chain, so the in-flight marker
					// has to be released here too. Leaving it set would suppress
					// every later recovery exactly like a successful hydration,
					// which is the failure mode this split was introduced to fix.
					if (inFlightKey && inFlightInteractionFetchRef.current === inFlightKey) {
						inFlightInteractionFetchRef.current = undefined
					}
				}
			}
			void fetchAttempt(-1, Boolean(expectedInteraction))
		}

		if (currentTaskViewKey !== prevRefetchTaskViewKeyRef.current) {
			messageFetchGenerationRef.current++
			currentTaskViewKeyRef.current = currentTaskViewKey
			prevRefetchTaskViewKeyRef.current = currentTaskViewKey
			if (cancelStabilizeTimerRef.current) {
				clearTimeout(cancelStabilizeTimerRef.current)
				cancelStabilizeTimerRef.current = null
			}
			refetchLockRef.current = false
			lastInteractionFetchKeyRef.current = undefined
			inFlightInteractionFetchRef.current = undefined
			bootstrapResolvedRef.current = false
			firstItemIndexRef.current = 0
			setClineMessages([])
			setFirstItemIndex(0)
			prevTotalRef.current = total
			if (total > 0) {
				fetchLatestWindow(currentTaskViewKey, projectedInteraction)
			}
			return
		}
		currentTaskViewKeyRef.current = currentTaskViewKey

		if (total === 0) {
			if (cancelStabilizeTimerRef.current) {
				clearTimeout(cancelStabilizeTimerRef.current)
				cancelStabilizeTimerRef.current = null
			}
			firstItemIndexRef.current = 0
			setClineMessages([])
			setFirstItemIndex(0)
			prevTotalRef.current = 0
			lastInteractionFetchKeyRef.current = undefined
			inFlightInteractionFetchRef.current = undefined
			bootstrapResolvedRef.current = false
			return
		}
		if (prevTotalRef.current === 0 && total > 0 && clineMessages.length === 0) {
			fetchLatestWindow(currentTaskViewKeyRef.current, projectedInteraction)
			prevTotalRef.current = total
			return
		}
		const knownEndIndex = firstItemIndex + clineMessages.length
		const windowCoveredPreviousTail = knownEndIndex >= prevTotalRef.current
		const durableTailMayHaveReplacedPartial =
			total > prevTotalRef.current && knownEndIndex === total && localTailMessage?.partial === true
		if (durableTailMayHaveReplacedPartial && !refetchLockRef.current) {
			const scheduledTaskViewKey = currentTaskViewKeyRef.current
			refetchLockRef.current = true
			TaskServiceClient.fetchMessage(FetchMessageRequest.create({ referenceIndex: -1, count: 200 }))
				.then((resp) => {
					if (currentTaskViewKeyRef.current !== scheduledTaskViewKey) {
						return
					}
					const converted = resp.messages.map((message) => convertProtoToClineMessage(message))
					const startIndex = Math.max(0, resp.startIndex)
					const reconciled = applyFetchedMessageWindow(
						clineMessagesRef.current,
						firstItemIndexRef.current,
						converted,
						startIndex,
						Number(resp.totalCount ?? 0),
					)
					commitMessageWindow(reconciled.messages, reconciled.startIndex)
				})
				.catch(() => {})
				.finally(() => {
					refetchLockRef.current = false
				})
		} else if (knownEndIndex < total && windowCoveredPreviousTail && !refetchLockRef.current) {
			const scheduledTaskViewKey = currentTaskViewKeyRef.current
			refetchLockRef.current = true
			TaskServiceClient.fetchMessage(
				FetchMessageRequest.create({ referenceIndex: knownEndIndex, count: Math.min(200, total - knownEndIndex) }),
			)
				.then((resp) => {
					if (currentTaskViewKeyRef.current !== scheduledTaskViewKey) {
						return
					}
					const converted = resp.messages.map((message) => convertProtoToClineMessage(message))
					const startIndex = Math.max(0, resp.startIndex)
					const reconciled = applyFetchedMessageWindow(
						clineMessagesRef.current,
						firstItemIndexRef.current,
						converted,
						startIndex,
						Number(resp.totalCount ?? 0),
					)
					commitMessageWindow(reconciled.messages, reconciled.startIndex)
				})
				.catch(() => {})
				.finally(() => {
					refetchLockRef.current = false
				})
		}
		// Refetch when the local window can no longer be reconciled from state
		// alone: the total shrank, or it claims more messages than exist because
		// a restore truncated the tail and appended replacements.
		// Delayed by 200ms via cancelStabilizeTimerRef so rapid state changes
		// (remove partials, postState, total update) settle before triggering
		// a Virtuoso data swap that causes layout jitter.
		const windowContradictsTotal =
			total < prevTotalRef.current || isMessageWindowOverfull(clineMessages.length, firstItemIndex, total)
		if (prevTotalRef.current !== 0 && windowContradictsTotal && clineMessages.length > 0 && !refetchLockRef.current) {
			if (cancelStabilizeTimerRef.current) {
				clearTimeout(cancelStabilizeTimerRef.current)
			}
			const scheduledTaskViewKey = currentTaskViewKeyRef.current
			cancelStabilizeTimerRef.current = setTimeout(() => {
				cancelStabilizeTimerRef.current = null
				if (currentTaskViewKeyRef.current !== scheduledTaskViewKey) {
					return
				}
				refetchLockRef.current = true
				TaskServiceClient.fetchMessage(FetchMessageRequest.create({ referenceIndex: -1, count: 200 }))
					.then((resp) => {
						if (currentTaskViewKeyRef.current !== scheduledTaskViewKey) {
							return
						}
						const converted = resp.messages.map((m) => convertProtoToClineMessage(m))
						const startIndex = Math.max(0, resp.startIndex)
						commitMessageWindow(converted, startIndex)
					})
					.catch(() => {})
					.finally(() => {
						refetchLockRef.current = false
					})
			}, 200)
		}

		const activeInteraction = projectedInteraction
		if (activeInteraction && !projectedInteractionAnchorPresent && !refetchLockRef.current) {
			const expectedFetchKey = interactionFetchKey(currentTaskViewKeyRef.current, activeInteraction)
			// Recovery is skipped only when this anchor was already hydrated or a
			// recovery for it is still running. A previously failed attempt no
			// longer counts, so browsing away and back can recover the footer
			// instead of leaving it permanently disabled.
			const alreadyHydrated = lastInteractionFetchKeyRef.current === expectedFetchKey
			const alreadyRunning = inFlightInteractionFetchRef.current === expectedFetchKey
			if (!alreadyHydrated && !alreadyRunning) {
				fetchLatestWindow(currentTaskViewKeyRef.current, activeInteraction)
			}
		}

		prevTotalRef.current = total
	}, [
		state.currentTaskItem?.id,
		state.taskTitleMessage?.ts,
		state.totalMessageCount,
		projectedInteraction,
		projectedInteractionAnchorPresent,
		clineMessages.length,
		localTailMessage,
		firstItemIndex,
		commitMessageWindow,
	])

	useEffect(() => {
		return () => {
			messageFetchGenerationRef.current++
			if (cancelStabilizeTimerRef.current) {
				clearTimeout(cancelStabilizeTimerRef.current)
				cancelStabilizeTimerRef.current = null
			}
		}
	}, [])

	const [showWelcome, setShowWelcome] = useState(false)
	const [onboardingModels, setOnboardingModels] = useState<OnboardingModelGroup | undefined>(undefined)

	const [clineModels, setClineModels] = useState<Record<string, ModelInfo> | null>(null)
	const [openRouterModels, setOpenRouterModels] = useState<Record<string, ModelInfo>>({
		[openRouterDefaultModelId]: openRouterDefaultModelInfo,
	})
	const [vercelAiGatewayModels, setVercelAiGatewayModels] = useState<Record<string, ModelInfo>>({})
	const [hicapModels, setHicapModels] = useState<Record<string, ModelInfo>>({})
	const [liteLlmModels, setLiteLlmModels] = useState<Record<string, ModelInfo>>({})
	const [totalTasksSize, setTotalTasksSize] = useState<number | null>(null)
	const [availableTerminalProfiles, setAvailableTerminalProfiles] = useState<TerminalProfile[]>([])

	const [openAiModels, _setOpenAiModels] = useState<string[]>([])
	const [requestyModels, setRequestyModels] = useState<Record<string, ModelInfo>>({
		[requestyDefaultModelId]: requestyDefaultModelInfo,
	})
	const [groqModelsState, setGroqModels] = useState<Record<string, ModelInfo>>({
		[groqDefaultModelId]: groqModels[groqDefaultModelId],
	})
	const [basetenModelsState, setBasetenModels] = useState<Record<string, ModelInfo>>({
		...basetenModels,
		[basetenDefaultModelId]: basetenModels[basetenDefaultModelId],
	})
	const [huggingFaceModels, setHuggingFaceModels] = useState<Record<string, ModelInfo>>({})
	const [mcpServers, setMcpServers] = useState<McpServer[]>([])
	const [mcpMarketplaceCatalog, setMcpMarketplaceCatalog] = useState<McpMarketplaceCatalog>({ items: [] })

	// References to store subscription cancellation functions
	const stateSubscriptionRef = useRef<(() => void) | null>(null)
	const stateRevisionRef = useRef(0)

	const mcpButtonUnsubscribeRef = useRef<(() => void) | null>(null)
	const historyButtonClickedSubscriptionRef = useRef<(() => void) | null>(null)
	const chatButtonUnsubscribeRef = useRef<(() => void) | null>(null)
	const accountButtonClickedSubscriptionRef = useRef<(() => void) | null>(null)
	const settingsButtonClickedSubscriptionRef = useRef<(() => void) | null>(null)
	const worktreesButtonClickedSubscriptionRef = useRef<(() => void) | null>(null)
	const partialMessageUnsubscribeRef = useRef<(() => void) | null>(null)
	const mcpMarketplaceUnsubscribeRef = useRef<(() => void) | null>(null)
	const openRouterModelsUnsubscribeRef = useRef<(() => void) | null>(null)
	const liteLlmModelsUnsubscribeRef = useRef<(() => void) | null>(null)
	const workspaceUpdatesUnsubscribeRef = useRef<(() => void) | null>(null)
	const relinquishControlUnsubscribeRef = useRef<(() => void) | null>(null)

	// Add ref for callbacks
	const relinquishControlCallbacks = useRef<Set<() => void>>(new Set())

	// Create hook function
	const onRelinquishControl = useCallback((callback: () => void) => {
		relinquishControlCallbacks.current.add(callback)
		return () => {
			relinquishControlCallbacks.current.delete(callback)
		}
	}, [])
	const mcpServersSubscriptionRef = useRef<(() => void) | null>(null)

	// Subscribe to state updates and UI events using the gRPC streaming API
	useEffect(() => {
		void hydrationAttempt
		// Set up state subscription
		stateSubscriptionRef.current = StateServiceClient.subscribeToState(EmptyRequest.create({}), {
			onResponse: (response) => {
				if (!response.stateJson) {
					setState((prevState) => ({
						...prevState,
						accountUsage: protoToAccountUsage(response.accountUsage),
					}))
					return
				}
				if (response.stateJson) {
					try {
						const stateData = JSON.parse(response.stateJson) as ExtensionState
						if (!shouldAcceptState(stateRevisionRef.current, stateData.stateRevision)) {
							return
						}
						stateRevisionRef.current = stateData.stateRevision ?? 0
						setState((prevState) => {
							// Versioning logic for autoApprovalSettings
							const incomingVersion = stateData.autoApprovalSettings?.version ?? 1
							const currentVersion = prevState.autoApprovalSettings?.version ?? 1
							const shouldUpdateAutoApproval = incomingVersion > currentVersion

							const newState = {
								...stateData,
								accountUsage: protoToAccountUsage(response.accountUsage),
								autoApprovalSettings: shouldUpdateAutoApproval
									? stateData.autoApprovalSettings
									: prevState.autoApprovalSettings,
							}

							// Update welcome screen state based on API configuration if welcome view not in progress
							if (!newState.welcomeViewCompleted && !showWelcome) {
								setShowWelcome(true)
								setOnboardingModels(newState.onboardingModels)
							} else if (newState.welcomeViewCompleted) {
								setShowWelcome(false)
								setOnboardingModels(undefined)
							}

							setHydration({ status: "ready" })

							return newState
						})
					} catch (error) {
						console.error("Error parsing state JSON:", error)
						// Only a first payload that cannot be parsed blocks the
						// view. Once state has rendered, a later bad payload is
						// better ignored than allowed to blank a working panel.
						setHydration((current) =>
							current.status === "ready" ? current : { status: "failed", reason: describeHydrationFailure(error) },
						)
					}
				}
			},
			onError: (error) => {
				console.error("Error in state subscription:", error)
				// Without this the stream dies silently and the view waits for a
				// payload that will never arrive, which is the blank panel.
				setHydration((current) =>
					current.status === "ready" ? current : { status: "failed", reason: describeHydrationFailure(error) },
				)
			},
			onComplete: () => {
				console.log("State subscription completed")
				// A stream that ends before delivering state leaves nothing to
				// render, and is as terminal as an error for a panel that never
				// hydrated.
				setHydration((current) =>
					current.status === "ready"
						? current
						: { status: "failed", reason: "State subscription closed before any state arrived" },
				)
			},
		})

		// Subscribe to MCP button clicked events with webview type
		mcpButtonUnsubscribeRef.current = UiServiceClient.subscribeToMcpButtonClicked(
			{},
			{
				onResponse: () => {
					console.debug("Received mcpButtonClicked event from gRPC stream")
					navigateToMcp()
				},
				onError: (error) => {
					console.error("Error in mcpButtonClicked subscription:", error)
				},
				onComplete: () => {
					console.log("mcpButtonClicked subscription completed")
				},
			},
		)

		// Set up history button clicked subscription with webview type
		historyButtonClickedSubscriptionRef.current = UiServiceClient.subscribeToHistoryButtonClicked(
			{},
			{
				onResponse: () => {
					// When history button is clicked, navigate to history view
					console.debug("Received history button clicked event from gRPC stream")
					navigateToHistory()
				},
				onError: (error) => {
					console.error("Error in history button clicked subscription:", error)
				},
				onComplete: () => {
					console.log("History button clicked subscription completed")
				},
			},
		)

		// Subscribe to chat button clicked events with webview type
		chatButtonUnsubscribeRef.current = UiServiceClient.subscribeToChatButtonClicked(
			{},
			{
				onResponse: () => {
					// When chat button is clicked, navigate to chat
					console.debug("Received chat button clicked event from gRPC stream")
					setTimeout(() => navigateToChat(), 0)
				},
				onError: (error) => {
					console.error("Error in chat button subscription:", error)
				},
				onComplete: () => {},
			},
		)

		// Subscribe to MCP servers updates
		mcpServersSubscriptionRef.current = McpServiceClient.subscribeToMcpServers(EmptyRequest.create(), {
			onResponse: (response) => {
				console.debug("Received MCP servers update from gRPC stream")
				if (response.mcpServers) {
					setMcpServers(convertProtoMcpServersToMcpServers(response.mcpServers))
				}
			},
			onError: (error) => {
				console.error("Error in MCP servers subscription:", error)
			},
			onComplete: () => {
				console.log("MCP servers subscription completed")
			},
		})

		// Set up settings button clicked subscription
		settingsButtonClickedSubscriptionRef.current = UiServiceClient.subscribeToSettingsButtonClicked(EmptyRequest.create({}), {
			onResponse: () => {
				// When settings button is clicked, navigate to settings
				navigateToSettings()
			},
			onError: (error) => {
				console.error("Error in settings button clicked subscription:", error)
			},
			onComplete: () => {
				console.log("Settings button clicked subscription completed")
			},
		})

		// Set up worktrees button clicked subscription
		worktreesButtonClickedSubscriptionRef.current = UiServiceClient.subscribeToWorktreesButtonClicked(
			EmptyRequest.create({}),
			{
				onResponse: () => {
					// When worktrees button is clicked, navigate to worktrees
					navigateToWorktrees()
				},
				onError: (error) => {
					console.error("Error in worktrees button clicked subscription:", error)
				},
				onComplete: () => {
					console.log("Worktrees button clicked subscription completed")
				},
			},
		)

		// Subscribe to partial message events
		partialMessageUnsubscribeRef.current = UiServiceClient.subscribeToPartialMessage(EmptyRequest.create({}), {
			onResponse: (protoMessage) => {
				try {
					// Validate critical fields
					if (!protoMessage.ts || protoMessage.ts <= 0) {
						console.error("Invalid timestamp in partial message:", protoMessage)
						return
					}

					const partialMessage = convertProtoToClineMessage(protoMessage)
					setClineMessages((prev) => {
						const existingIndex = prev.findIndex((msg) => msg.ts === partialMessage.ts)
						if (existingIndex >= 0 && prev[existingIndex].partial !== true && partialMessage.partial === true) {
							return prev
						}
						if (
							existingIndex < 0 &&
							!canAppendRealtimeMessage(prev.length, firstItemIndexRef.current, totalMessageCountRef.current)
						) {
							return prev
						}
						return mergeClineMessagesByTs(prev, [partialMessage])
					})
				} catch (error) {
					console.error("Failed to process partial message:", error, protoMessage)
				}
			},
			onError: (error) => {
				console.error("Error in partialMessage subscription:", error)
			},
			onComplete: () => {
				console.debug("partialMessage subscription completed")
			},
		})

		// Subscribe to MCP marketplace catalog updates
		mcpMarketplaceUnsubscribeRef.current = McpServiceClient.subscribeToMcpMarketplaceCatalog(EmptyRequest.create({}), {
			onResponse: (catalog) => {
				console.debug("Received MCP marketplace catalog update from gRPC stream")
				setMcpMarketplaceCatalog(catalog)
			},
			onError: (error) => {
				console.error("Error in MCP marketplace catalog subscription:", error)
			},
			onComplete: () => {
				console.log("MCP marketplace catalog subscription completed")
			},
		})

		// Subscribe to OpenRouter models updates
		openRouterModelsUnsubscribeRef.current = ModelsServiceClient.subscribeToOpenRouterModels(EmptyRequest.create({}), {
			onResponse: (response: OpenRouterCompatibleModelInfo) => {
				const models = fromProtobufModels(response.models)
				setOpenRouterModels({
					[openRouterDefaultModelId]: openRouterDefaultModelInfo, // in case the extension sent a model list without the default model
					...models,
				})
			},
			onError: (error) => {
				console.error("Error in OpenRouter models subscription:", error)
			},
			onComplete: () => {
				console.log("OpenRouter models subscription completed")
			},
		})

		// Subscribe to LiteLLM models updates
		liteLlmModelsUnsubscribeRef.current = ModelsServiceClient.subscribeToLiteLlmModels(EmptyRequest.create({}), {
			onResponse: (response: OpenRouterCompatibleModelInfo) => {
				const models = fromProtobufModels(response.models)
				setLiteLlmModels(models)
			},
			onError: (error) => {
				console.error("Error in LiteLLM models subscription:", error)
			},
			onComplete: () => {
				console.log("LiteLLM models subscription completed")
			},
		})

		// Initialize webview using gRPC
		UiServiceClient.initializeWebview(EmptyRequest.create({}))
			.then(() => {
				console.debug("Webview initialization completed via gRPC")
			})
			.catch((error) => {
				console.error("Failed to initialize webview via gRPC:", error)
			})

		// Set up account button clicked subscription
		accountButtonClickedSubscriptionRef.current = UiServiceClient.subscribeToAccountButtonClicked(EmptyRequest.create(), {
			onResponse: () => {
				// When account button is clicked, navigate to account view
				console.debug("Received account button clicked event from gRPC stream")
				navigateToAccount()
			},
			onError: (error) => {
				console.error("Error in account button clicked subscription:", error)
			},
			onComplete: () => {
				console.log("Account button clicked subscription completed")
			},
		})

		// Fetch available terminal profiles on launch
		StateServiceClient.getAvailableTerminalProfiles(EmptyRequest.create({}))
			.then((response) => {
				setAvailableTerminalProfiles(response.profiles)
			})
			.catch((error) => {
				console.error("Failed to fetch available terminal profiles:", error)
			})

		// Subscribe to relinquish control events
		relinquishControlUnsubscribeRef.current = UiServiceClient.subscribeToRelinquishControl(EmptyRequest.create({}), {
			onResponse: () => {
				// Call all registered callbacks
				relinquishControlCallbacks.current.forEach((callback) => {
					callback()
				})
			},
			onError: (error) => {
				console.error("Error in relinquishControl subscription:", error)
			},
			onComplete: () => {},
		})

		// Clean up subscriptions when component unmounts
		return () => {
			if (stateSubscriptionRef.current) {
				stateSubscriptionRef.current()
				stateSubscriptionRef.current = null
			}
			if (mcpButtonUnsubscribeRef.current) {
				mcpButtonUnsubscribeRef.current()
				mcpButtonUnsubscribeRef.current = null
			}
			if (historyButtonClickedSubscriptionRef.current) {
				historyButtonClickedSubscriptionRef.current()
				historyButtonClickedSubscriptionRef.current = null
			}
			if (chatButtonUnsubscribeRef.current) {
				chatButtonUnsubscribeRef.current()
				chatButtonUnsubscribeRef.current = null
			}
			if (accountButtonClickedSubscriptionRef.current) {
				accountButtonClickedSubscriptionRef.current()
				accountButtonClickedSubscriptionRef.current = null
			}
			if (settingsButtonClickedSubscriptionRef.current) {
				settingsButtonClickedSubscriptionRef.current()
				settingsButtonClickedSubscriptionRef.current = null
			}
			if (worktreesButtonClickedSubscriptionRef.current) {
				worktreesButtonClickedSubscriptionRef.current()
				worktreesButtonClickedSubscriptionRef.current = null
			}
			if (partialMessageUnsubscribeRef.current) {
				partialMessageUnsubscribeRef.current()
				partialMessageUnsubscribeRef.current = null
			}
			if (mcpMarketplaceUnsubscribeRef.current) {
				mcpMarketplaceUnsubscribeRef.current()
				mcpMarketplaceUnsubscribeRef.current = null
			}
			if (openRouterModelsUnsubscribeRef.current) {
				openRouterModelsUnsubscribeRef.current()
				openRouterModelsUnsubscribeRef.current = null
			}
			if (liteLlmModelsUnsubscribeRef.current) {
				liteLlmModelsUnsubscribeRef.current()
				liteLlmModelsUnsubscribeRef.current = null
			}
			if (workspaceUpdatesUnsubscribeRef.current) {
				workspaceUpdatesUnsubscribeRef.current()
				workspaceUpdatesUnsubscribeRef.current = null
			}
			if (relinquishControlUnsubscribeRef.current) {
				relinquishControlUnsubscribeRef.current()
				relinquishControlUnsubscribeRef.current = null
			}
			if (mcpServersSubscriptionRef.current) {
				mcpServersSubscriptionRef.current()
				mcpServersSubscriptionRef.current = null
			}
		}
	}, [
		navigateToChat,
		navigateToHistory,
		navigateToMcp,
		showWelcome, // When worktrees button is clicked, navigate to worktrees
		navigateToWorktrees, // When settings button is clicked, navigate to settings
		navigateToSettings,
		navigateToAccount,
		// A retry re-runs this effect, so the cleanup above tears down the
		// failed stream before a fresh subscription replaces it.
		hydrationAttempt,
	])

	// Safety net for task switches while HistoryView is open. The primary
	// navigation path is the backend history-ready event; this only handles a
	// missed event without closing HistoryView just because a task already exists.
	useEffect(() => {
		const currentTaskViewKey = getTaskViewKey(state.currentTaskItem?.id, state.taskTitleMessage?.ts)
		const prevTaskViewKey = prevHistoryTaskViewKeyRef.current

		if (!showHistory) {
			prevHistoryTaskViewKeyRef.current = currentTaskViewKey
			return
		}

		if (currentTaskViewKey && currentTaskViewKey !== prevTaskViewKey) {
			navigateToChat()
		}

		prevHistoryTaskViewKeyRef.current = currentTaskViewKey
	}, [state.currentTaskItem?.id, state.taskTitleMessage?.ts, showHistory, navigateToChat])

	const refreshOpenRouterModels = useCallback(() => {
		ModelsServiceClient.refreshOpenRouterModelsRpc(EmptyRequest.create({}))
			.then((response: OpenRouterCompatibleModelInfo) => {
				const models = fromProtobufModels(response.models)
				setOpenRouterModels({
					[openRouterDefaultModelId]: openRouterDefaultModelInfo, // in case the extension sent a model list without the default model
					...models,
				})
			})
			.catch((error: Error) => console.error("Failed to refresh OpenRouter models:", error))
	}, [])

	const refreshHicapModels = useCallback(() => {
		ModelsServiceClient.refreshHicapModels(EmptyRequest.create({}))
			.then((response: OpenRouterCompatibleModelInfo) => {
				const models = response.models
				const converted: Record<string, ModelInfo> = {}
				for (const [key, value] of Object.entries(models)) {
					converted[key] = {
						id: key,
						capabilities: {
							supportsImages: value.supportsImages ?? false,
							supportsPromptCache: value.supportsPromptCache,
							supportsReasoning: value.supportsReasoning ?? false,
							contextWindow: value.contextWindow,
							maxTokens: value.maxTokens,
							thinking: value.thinkingConfig,
						},
						pricing: {
							inputPrice: value.inputPrice,
							outputPrice: value.outputPrice,
							cacheWritesPrice: value.cacheWritesPrice,
							cacheReadsPrice: value.cacheReadsPrice,
						},
						name: value.name,
						description: value.description,
					}
				}
				setHicapModels(converted)
			})
			.catch((error: Error) => console.error("Failed to refresh Hicap models:", error))
	}, [])

	const refreshLiteLlmModels = useCallback(() => {
		return ModelsServiceClient.refreshLiteLlmModelsRpc(EmptyRequest.create({}))
			.then((response: OpenRouterCompatibleModelInfo) => {
				const models = fromProtobufModels(response.models)
				setLiteLlmModels(models)
			})
			.catch((error: Error) => console.error("Failed to refresh LiteLLM models:", error))
	}, [])

	const refreshBasetenModels = useCallback(() => {
		ModelsServiceClient.refreshBasetenModelsRpc(EmptyRequest.create({}))
			.then((response) => {
				setBasetenModels({
					[basetenDefaultModelId]: basetenModels[basetenDefaultModelId],
					...fromProtobufModels(response.models),
				})
			})
			.catch((err) => console.error("Failed to refresh Baseten models:", err))
	}, [])

	const refreshVercelAiGatewayModels = useCallback(() => {
		ModelsServiceClient.refreshVercelAiGatewayModelsRpc(EmptyRequest.create({}))
			.then((response: OpenRouterCompatibleModelInfo) => {
				const models = fromProtobufModels(response.models)
				setVercelAiGatewayModels(models)
			})
			.catch((error: Error) => console.error("Failed to refresh Vercel AI Gateway models:", error))
	}, [])

	// Guard to prevent repeated refresh when models are empty
	const modelRefreshAttempted = useRef(false)

	// Auto-refresh model lists on API key availability
	useEffect(() => {
		if (modelRefreshAttempted.current) return
		const needsOpenRouter = !openRouterModels || Object.keys(openRouterModels).length <= 1
		const needsVercel = !vercelAiGatewayModels || Object.keys(vercelAiGatewayModels).length === 0
		if (!needsOpenRouter && !needsVercel) return
		modelRefreshAttempted.current = true
		if (needsOpenRouter) {
			refreshOpenRouterModels()
		}
		if (needsVercel) {
			refreshVercelAiGatewayModels()
		}
		if (state.apiConfiguration?.planModeProfile) {
			refreshBasetenModels()
		}
		if (state.apiConfiguration?.planModeProfile) {
			refreshLiteLlmModels()
		}
	}, [
		refreshOpenRouterModels,
		refreshVercelAiGatewayModels,
		state?.apiConfiguration?.planModeProfile,
		refreshBasetenModels,
		refreshLiteLlmModels,
		openRouterModels,
		vercelAiGatewayModels,
	])

	// Refresh Cline models function
	const refreshClineModels = useCallback(() => {
		ModelsServiceClient.refreshClineModelsRpc(EmptyRequest.create({}))
			.then((response: OpenRouterCompatibleModelInfo) => {
				const models = fromProtobufModels(response.models)
				setClineModels((prev) => (Object.keys(models).length > 0 ? models : (prev ?? null)))
			})
			.catch((error: Error) => console.error("Failed to refresh Cline models:", error))
	}, [])

	// Auto-refresh Cline models when provider is cline
	useEffect(() => {
		const hasClineProvider =
			state.apiConfiguration?.actModeProfile === "cline" || state.apiConfiguration?.planModeProfile === "cline"
		if (hasClineProvider && clineModels === null) {
			refreshClineModels()
		}
	}, [state.apiConfiguration?.actModeProfile, state.apiConfiguration?.planModeProfile, clineModels, refreshClineModels])

	const capabilityStateSetters = useMemo<
		Pick<ExtensionStateContextType, Extract<keyof ExtensionStateContextType, `set${string}Toggles`>>
	>(
		() => ({
			setGlobalClineRulesToggles: (toggles) =>
				setState((prevState) => ({ ...prevState, globalClineRulesToggles: toggles })),
			setLocalClineRulesToggles: (toggles) => setState((prevState) => ({ ...prevState, localClineRulesToggles: toggles })),
			setLocalCursorRulesToggles: (toggles) =>
				setState((prevState) => ({ ...prevState, localCursorRulesToggles: toggles })),
			setLocalWindsurfRulesToggles: (toggles) =>
				setState((prevState) => ({ ...prevState, localWindsurfRulesToggles: toggles })),
			setLocalAgentsRulesToggles: (toggles) =>
				setState((prevState) => ({ ...prevState, localAgentsRulesToggles: toggles })),
			setLocalWorkflowToggles: (toggles) => setState((prevState) => ({ ...prevState, localWorkflowToggles: toggles })),
			setGlobalWorkflowToggles: (toggles) => setState((prevState) => ({ ...prevState, globalWorkflowToggles: toggles })),
			setGlobalSkillsToggles: (toggles) => setState((prevState) => ({ ...prevState, globalSkillsToggles: toggles })),
			setLocalSkillsToggles: (toggles) => setState((prevState) => ({ ...prevState, localSkillsToggles: toggles })),
			setRemoteSkillsToggles: (toggles) => setState((prevState) => ({ ...prevState, remoteSkillsToggles: toggles })),
			setTaskCapabilityToggles: (toggles) => setState((prevState) => ({ ...prevState, taskCapabilityToggles: toggles })),
			setRemoteRulesToggles: (toggles) => setState((prevState) => ({ ...prevState, remoteRulesToggles: toggles })),
			setRemoteWorkflowToggles: (toggles) => setState((prevState) => ({ ...prevState, remoteWorkflowToggles: toggles })),
		}),
		[],
	)

	const setShouldShowAnnouncement = useCallback((value: boolean) => {
		setState((prevState) => ({ ...prevState, shouldShowAnnouncement: value }))
	}, [])

	const setUserInfo = useCallback((userInfo?: UserInfo) => {
		setState((prevState) => ({ ...prevState, userInfo }))
	}, [])

	// The provider sits above the whole webview tree, so an unmemoized value
	// would republish on every render and force each consumer to re-render.
	const contextValue = useMemo<ExtensionStateContextType>(
		() => ({
			...state,
			clineMessages,
			didHydrateState,
			hydration,
			retryHydration,
			showWelcome,
			onboardingModels,
			clineModels,
			openRouterModels,
			vercelAiGatewayModels,
			hicapModels,
			liteLlmModels,
			openAiModels,
			requestyModels,
			groqModels: groqModelsState,
			basetenModels: basetenModelsState,
			huggingFaceModels,
			mcpServers,
			mcpMarketplaceCatalog,
			totalTasksSize,
			availableTerminalProfiles,
			showMcp,
			mcpTab,
			showSettings,
			settingsTargetSection,
			showHistory,
			showAccount,
			showWorktrees,
			showAnnouncement,
			firstItemIndex,
			setFirstItemIndex,
			globalClineRulesToggles: state.globalClineRulesToggles || {},
			localClineRulesToggles: state.localClineRulesToggles || {},
			localCursorRulesToggles: state.localCursorRulesToggles || {},
			localWindsurfRulesToggles: state.localWindsurfRulesToggles || {},
			localAgentsRulesToggles: state.localAgentsRulesToggles || {},
			localWorkflowToggles: state.localWorkflowToggles || {},
			globalWorkflowToggles: state.globalWorkflowToggles || {},
			remoteRulesToggles: state.remoteRulesToggles || {},
			remoteWorkflowToggles: state.remoteWorkflowToggles || {},
			enableCheckpointsSetting: state.enableCheckpointsSetting,
			currentFocusChainChecklist: state.currentFocusChainChecklist,
			focusChainHistory: state.focusChainHistory,

			// Navigation functions
			navigateToMcp,
			navigateToSettings,
			navigateToHistory,
			navigateToAccount,
			navigateToWorktrees,
			navigateToChat,

			// Hide functions
			hideSettings,
			hideHistory,
			hideAccount,
			hideWorktrees,
			hideAnnouncement,
			setShowAnnouncement,
			setShowWelcome,
			setOnboardingModels,
			setShouldShowAnnouncement,
			setMcpServers,
			setRequestyModels,
			setGroqModels,
			setBasetenModels,
			setHuggingFaceModels,
			setMcpMarketplaceCatalog,
			setShowMcp,
			closeMcpView,
			...capabilityStateSetters,
			setMcpTab,
			setTotalTasksSize,
			refreshClineModels,
			refreshOpenRouterModels,
			refreshVercelAiGatewayModels,
			refreshHicapModels,
			refreshLiteLlmModels,
			onRelinquishControl,
			setUserInfo,
			expandTaskHeader,
			setExpandTaskHeader,
			setClineMessages,
		}),
		[
			state,
			clineMessages,
			didHydrateState,
			hydration,
			retryHydration,
			showWelcome,
			onboardingModels,
			clineModels,
			openRouterModels,
			vercelAiGatewayModels,
			hicapModels,
			liteLlmModels,
			openAiModels,
			requestyModels,
			groqModelsState,
			basetenModelsState,
			huggingFaceModels,
			mcpServers,
			mcpMarketplaceCatalog,
			totalTasksSize,
			availableTerminalProfiles,
			showMcp,
			mcpTab,
			showSettings,
			settingsTargetSection,
			showHistory,
			showAccount,
			showWorktrees,
			showAnnouncement,
			firstItemIndex,
			navigateToMcp,
			navigateToSettings,
			navigateToHistory,
			navigateToAccount,
			navigateToWorktrees,
			navigateToChat,
			hideSettings,
			hideHistory,
			hideAccount,
			hideWorktrees,
			hideAnnouncement,
			setShouldShowAnnouncement,
			closeMcpView,
			capabilityStateSetters,
			refreshClineModels,
			refreshOpenRouterModels,
			refreshVercelAiGatewayModels,
			refreshHicapModels,
			refreshLiteLlmModels,
			onRelinquishControl,
			setUserInfo,
			expandTaskHeader,
		],
	)

	return <ExtensionStateContext.Provider value={contextValue}>{children}</ExtensionStateContext.Provider>
}

export const useExtensionState = () => {
	const context = useContext(ExtensionStateContext)
	if (context === undefined) {
		throw new Error("useExtensionState must be used within an ExtensionStateContextProvider")
	}
	return context
}
