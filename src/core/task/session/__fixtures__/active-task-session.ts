import { vi } from "vitest"
import { createInitialTaskState, type TaskState } from "../../kernel"
import type { ActiveTaskSession } from "../ActiveTaskSession"
import type { InputQueueApplicationPort } from "../InputQueueApplicationPort"

export interface SessionFixtureOptions {
	readonly taskId?: string
	/** The opening this session belongs to; the real session reads it from its incarnation. */
	readonly taskInstanceId?: string
	/** Replaces the whole kernel state; use `patchState` for a partial override. */
	readonly state?: TaskState
	readonly patchState?: (state: TaskState) => TaskState
	/** Partial owners merged over the default stubs. */
	readonly owners?: Record<string, unknown>
	/** Partial facade/session members merged over the defaults. */
	readonly session?: Record<string, unknown>
}

/**
 * Build a canonical `ActiveTaskSession` double for controller tests.
 *
 * Controller handlers read the session through `owners`, `state()` and the
 * six-use-case facade. Tests that hand-roll those shapes drift apart as owners
 * are added, so the default stub lives here and each test overrides only the
 * members its assertion is about.
 */
export function createSessionFixture(options: SessionFixtureOptions = {}) {
	const taskId = options.taskId ?? "task-1"
	const base = options.state ?? createInitialTaskState(taskId)
	const state = options.patchState ? options.patchState(base) : base

	const owners = {
		identity: { taskId, taskIncarnationId: options.taskInstanceId ?? `${taskId}-incarnation` },
		settings: {
			mode: "act" as const,
			taskCapabilityToggles: {},
			getTaskSettingsKey: vi.fn(() => undefined),
		},
		messages: {
			clineMessages: [] as unknown[],
			reloadFromStore: vi.fn(),
			replaceClineMessages: vi.fn(async (_messages: unknown[]) => undefined),
			addToClineMessages: vi.fn(async () => undefined),
			upsertClineMessageInMemory: vi.fn(async () => undefined),
			readStateMetrics: vi.fn(() => undefined),
		},
		activities: {
			list: vi.fn(() => []),
			update: vi.fn(),
			retry: vi.fn(async (activityIds: string[]) => activityIds),
			hasLiveRetryControl: vi.fn(() => false),
			isRetryable: vi.fn(() => false),
		},
		api: { current: vi.fn(() => undefined), rebuild: vi.fn(async () => undefined) },
		prompt: {
			flush: vi.fn(async () => undefined),
			invalidate: vi.fn(),
			requestRefresh: vi.fn(),
			refreshManual: vi.fn(async () => undefined),
			getFreshness: vi.fn(() => undefined),
		},
		promptCache: { record: vi.fn(), getSnapshot: vi.fn(() => undefined) },
		toolState: {
			currentFocusChainChecklist: null,
			focusChainHistory: null,
			contextWindowIndicator: undefined,
			checkpointManagerErrorMessage: undefined,
			didEditFile: false,
		},
		toolExecution: {
			notifySubagentConcurrencyLimitChanged: vi.fn(),
			notifyToolConcurrencyLimitChanged: vi.fn(),
			restoreSubagentActivityRetry: vi.fn(async () => true),
		},
		interactions: {
			open: vi.fn(async () => undefined),
			dispatch: vi.fn(async () => undefined),
			dismissProviderFailure: vi.fn(async () => undefined),
		},
		browser: { dispose: vi.fn() },
		commands: { cancelTaskOwnedCommands: vi.fn(async () => undefined) },
		files: { getAllModifiedFiles: vi.fn(() => [] as string[]) },
		...options.owners,
	}

	const inputQueue = {
		mutate: vi.fn(async () => ({ accepted: true, result: "ok" })),
		project: vi.fn(async () => []),
		onTurnEndAwaiting: vi.fn(),
	} satisfies InputQueueApplicationPort

	const session = {
		taskId,
		taskInstanceId: (owners.identity as { taskIncarnationId: string }).taskIncarnationId,
		/** Owns the task; pass `session: { writable: false }` for a read-only window. */
		writable: true,
		task: {
			start: vi.fn(async () => undefined),
			submitInput: vi.fn(async () => undefined),
			respond: vi.fn(async () => undefined),
			cancel: vi.fn(async () => undefined),
			terminate: vi.fn(async () => undefined),
			open: vi.fn(async () => undefined),
		},
		owners,
		inputs: { materialize: vi.fn(async (input: unknown) => input) },
		inputQueue,
		messages: owners.messages,
		payloads: { put: vi.fn(async () => "payload:1"), read: vi.fn(async () => new Uint8Array()) },
		state: vi.fn(() => state),
		projectView: vi.fn(() => undefined),
		stopForCheckpointRestore: vi.fn(async () => ({})),
		disposeAfterCheckpointRestore: vi.fn(async () => undefined),
		dispose: vi.fn(async () => undefined),
		...options.session,
	}

	return session as typeof session & ActiveTaskSession
}
