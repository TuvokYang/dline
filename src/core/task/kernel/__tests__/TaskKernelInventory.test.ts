import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const REPO = path.resolve(__dirname, "../../../../..")
const TASK_INDEX = path.join(REPO, "src/core/task/index.ts")

const EXPECTED_TASK_FIELDS = [
	"taskId",
	"ulid",
	"taskTelemetry",
	"initialTaskTitle",
	"taskIsFavorited",
	"cwd",
	"taskInitializationStartTime",
	"taskState",
	"taskController",
	"taskRuntime",
	"completionProjector",
	"interactionCoordinator",
	"resumeCoordinator",
	"historyResumeMaintenance",
	"historyPreparationPending",
	"controllerDetached",
	"restoredFromHistory",
	"latestOrdinaryCompactionDiagnostic",
	"stateMutex",
	"controller",
	"mcpHub",
	"_mcpNotificationCb",
	"api",
	"terminalManager",
	"urlContentFetcher",
	"browserSession",
	"contextManager",
	"modeSwitchCompaction",
	"contextCompactionSession",
	"taskHeaderCompactionSettlement",
	"contextCompactionPresentation",
	"taskLegacyStorageCleaner",
	"contextWindowIndicator",
	"contextWindowEnvironmentRefreshTimer",
	"contextWindowEnvironmentRefreshInFlight",
	"contextCompactionFailureReasons",
	"contextCompactionRetryProgress",
	"diffViewProvider",
	"checkpointManager",
	"initialCheckpointCommitPromise",
	"checkpointHashPersistenceChain",
	"ignoreController",
	"commandPermissionController",
	"toolExecutor",
	"activityStore",
	"useNativeToolCalls",
	"streamHandler",
	"identityFactory",
	"explicitInstructionRegistry",
	"compactionRequestReplay",
	"compactionRetryPolicy",
	"terminalExecutionMode",
	"fileContextTracker",
	"taskFileTracker",
	"modelContextTracker",
	"environmentContextTracker",
	"FocusChainManager",
	"updateTaskHistory",
	"postStateToWebview",
	"reinitExistingTaskFromId",
	"cancelTask",
	"stateManager",
	"taskSm",
	"messageStateHandler",
	"workspaceManager",
	"commandExecutor",
	"isRemoteWorkspaceEnvironment",
	"remoteWorkspaceDetectionSettled",
	"remoteWorkspaceDetectionPromise",
	"presentationScheduler",
	"pendingReasoningText",
	"snapshotPersistence",
	"projectionScheduler",
	"toolDomainLedger",
	"toolDomain",
	"turnToolScheduler",
	"turnDriver",
	"systemPromptCacheService",
	"promptFreshnessInvalidationCoordinator",
	"promptInputWatcherSubscription",
	"promptInputFileWatcherInitialization",
	"promptFreshnessDisposed",
	"latestTaskSnapshot",
	"inputQueueCoordinator",
	"awaitingQueuedInputInteraction",
	"pendingSystemPromptRefreshReason",
	"activeProviderInputRuntime",
	"promptCacheHealth",
	"apiRateMetricsService",
	"apiRequestRoundLifecycle",
	"taskRateMetricsQueryService",
	"ordinaryProviderRequestRounds",
	"activeProviderExecutionTurns",
	"turnEndProviderExecutions",
	"nextAuxiliaryProviderRoundApiIndex",
	"apiRateMetricsInitialization",
	"pendingBackgroundResultIds",
	"pendingBackgroundCommandLineCounts",
	"pendingRecentlyModifiedFilesSnapshot",
	"ordinaryRequestInputReplay",
	"ordinaryContextIndicatorLineageByApiIndex",
	"ordinaryContextIndicatorReceivingByApiIndex",
	"contextCompactionIndicatorReceivingByAttemptId",
	"pendingAutoRetry",
	"autoRetrySequenceActive",
	"manualRetryTakeoverActive",
	"presentationSchedulingDisabled",
	"restoreHandler",
	"lastGeneratedMessageTs",
] as const

const EXPECTED_TASK_INDEX_CONSUMERS = [
	"src/core/controller/index.ts",
	"src/core/task/interaction/TurnEndContinuationRegistry.ts",
	"src/core/task/tools/ToolExecutionResult.ts",
	"src/core/task/tools/handlers/AccessMcpResourceHandler.ts",
	"src/core/task/tools/handlers/ActModeRespondHandler.ts",
	"src/core/task/tools/handlers/ApplyPatchHandler.ts",
	"src/core/task/tools/handlers/AskFollowupQuestionToolHandler.ts",
	"src/core/task/tools/handlers/AttemptCompletionHandler.ts",
	"src/core/task/tools/handlers/BrowserToolHandler.ts",
	"src/core/task/tools/handlers/ExecuteCommandToolHandler.ts",
	"src/core/task/tools/handlers/FindReferencesHandler.ts",
	"src/core/task/tools/handlers/FocusChainHandler.ts",
	"src/core/task/tools/handlers/GenerateExplanationToolHandler.ts",
	"src/core/task/tools/handlers/GenerateImageToolHandler.ts",
	"src/core/task/tools/handlers/GenerateReportHandler.ts",
	"src/core/task/tools/handlers/ListCodeDefinitionNamesToolHandler.ts",
	"src/core/task/tools/handlers/ListFilesToolHandler.ts",
	"src/core/task/tools/handlers/LoadMcpDocumentationHandler.ts",
	"src/core/task/tools/handlers/MakePlanHandler.ts",
	"src/core/task/tools/handlers/QnaRespondHandler.ts",
	"src/core/task/tools/handlers/ReadFileToolHandler.ts",
	"src/core/task/tools/handlers/RenameSymbolHandler.ts",
	"src/core/task/tools/handlers/ReplaceTextHandler.ts",
	"src/core/task/tools/handlers/ReportBugHandler.ts",
	"src/core/task/tools/handlers/SearchFilesToolHandler.ts",
	"src/core/task/tools/handlers/SpawnTaskHandler.ts",
	"src/core/task/tools/handlers/StatusUpdateHandler.ts",
	"src/core/task/tools/handlers/SubagentToolHandler.ts",
	"src/core/task/tools/handlers/SummarizeTaskHandler.ts",
	"src/core/task/tools/handlers/UseMcpToolHandler.ts",
	"src/core/task/tools/handlers/WebFetchToolHandler.ts",
	"src/core/task/tools/handlers/WebSearchToolHandler.ts",
	"src/core/task/tools/handlers/WriteToFileToolHandler.ts",
	"src/core/task/tools/utils/ToolResultUtils.ts",
] as const

const EXPECTED_TASK_VIEW_FILES = [
	"src/core/controller/index.ts",
	"src/core/controller/task/history-task-readiness.ts",
	"src/core/task/view/TaskViewProjector.ts",
	"src/core/task/view/TaskViewState.ts",
	"src/shared/ExtensionMessage.ts",
	"webview-ui/src/components/chat/ChatRow.tsx",
	"webview-ui/src/components/chat/ChatView.tsx",
	"webview-ui/src/components/chat/chat-view/utils/messageUtils.ts",
	"webview-ui/src/components/chat/input/TaskRuntimeControls.tsx",
	"webview-ui/src/components/chat/task-header/ModelSwitcher.tsx",
	"webview-ui/src/config/storybook/chatStoryFixtures.ts",
	"webview-ui/src/context/ExtensionStateContext.tsx",
	"webview-ui/src/hooks/useTaskCapabilityToggles.ts",
	"webview-ui/src/task-interaction/FooterActions.tsx",
	"webview-ui/src/task-interaction/InteractionHost.tsx",
	"webview-ui/src/task-interaction/TaskInput.tsx",
	"webview-ui/src/task-interaction/types.ts",
] as const

function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")
}

function productionFiles(directory: string): string[] {
	return readdirSync(directory).flatMap((entry) => {
		const absolute = path.join(directory, entry)
		const relative = path.relative(REPO, absolute).replaceAll("\\", "/")
		if (relative.includes("/__tests__/") || /\.(?:test|spec)\.[jt]sx?$/.test(entry)) return []
		return statSync(absolute).isDirectory() ? productionFiles(absolute) : /\.[jt]sx?$/.test(entry) ? [absolute] : []
	})
}

function taskFields(): string[] {
	const source = readFileSync(TASK_INDEX, "utf8")
	const classStart = source.indexOf("export class Task")
	if (classStart < 0) throw new Error("Task class not found")
	const classSource = stripComments(source.slice(classStart))
	return Array.from(
		classSource.matchAll(
			/^\t(?:(?:public|private|protected)\s+)?(?:(?:static|readonly|declare)\s+)*([A-Za-z_$][\w$]*)[!?]?\s*(?::|=)/gm,
		),
		(match) => match[1],
	).sort()
}

function resolvesTaskIndex(importer: string, specifier: string): boolean {
	if (specifier === "@core/task") return true
	if (!specifier.startsWith(".")) return false
	const resolved = path.resolve(path.dirname(importer), specifier)
	return resolved === path.dirname(TASK_INDEX) || resolved === TASK_INDEX.replace(/\.ts$/, "")
}

function taskIndexConsumers(): string[] {
	return productionFiles(path.join(REPO, "src"))
		.filter((file) => {
			const source = stripComments(readFileSync(file, "utf8"))
			const specifiers = [
				...source.matchAll(/\bfrom\s*["']([^"']+)["']/g),
				...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
			].map((match) => match[1])
			return specifiers.some((specifier) => resolvesTaskIndex(file, specifier))
		})
		.map((file) => path.relative(REPO, file).replaceAll("\\", "/"))
		.sort()
}

function taskViewFiles(): string[] {
	const roots = [path.join(REPO, "src"), path.join(REPO, "webview-ui/src")]
	return roots
		.flatMap(productionFiles)
		.filter((file) => /\b(?:TaskViewState|taskViewState)\b/.test(stripComments(readFileSync(file, "utf8"))))
		.map((file) => path.relative(REPO, file).replaceAll("\\", "/"))
		.sort()
}

describe("TASK-101 machine inventories", () => {
	it("locks the activation-baseline Task instance fields", () => {
		expect(taskFields()).toEqual([...EXPECTED_TASK_FIELDS].sort())
		expect(taskFields()).toHaveLength(109)
	})

	it("locks direct, barrel-resolved and dynamic production consumers of task index", () => {
		expect(taskIndexConsumers()).toEqual([...EXPECTED_TASK_INDEX_CONSUMERS].sort())
	})

	it("locks every production TaskViewState type or field consumer", () => {
		expect(taskViewFiles()).toEqual([...EXPECTED_TASK_VIEW_FILES].sort())
	})

	it("keeps every kernel production file below the 1000-line architecture limit", () => {
		const kernelRoot = path.join(REPO, "src/core/task/kernel")
		const oversized = productionFiles(kernelRoot)
			.map((file) => ({
				file: path.relative(REPO, file).replaceAll("\\", "/"),
				lines: readFileSync(file, "utf8").split(/\r?\n/).length,
			}))
			.filter((entry) => entry.lines >= 1000)
		expect(oversized).toEqual([])
	})
})
