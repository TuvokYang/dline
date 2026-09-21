import { vi } from "vitest"
import { createInitialTaskState, type TaskState } from "../../kernel"
import type { ActiveTaskSession } from "../ActiveTaskSession"

export interface SessionFixtureOptions {
	readonly taskId?: string
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
		identity: { taskId, taskIncarnationId: `${taskId}-incarnation` },
		settings: {
			mode: "act" as const,
			taskCapabilityToggles: {},
			getTaskSettingsKey: vi.fn(() => undefined),
		},
		messages: {
			clineMessages: [] as unknown[],
			reloadFromStore: vi.fn(),
			addToClineMessages: vi.fn(async () => undefined),
			upsertClineMessageInMemory: vi.fn(async () => undefined),
		},
		activities: { list: vi.fn(() => []), update: vi.fn(), retry: vi.fn(async () => true) },
		api: { current: vi.fn(() => undefined), rebuild: vi.fn(async () => undefined) },
		prompt: { flush: vi.fn(async () => undefined), refresh: vi.fn(async () => undefined) },
		promptCache: { record: vi.fn() },
		toolState: { currentFocusChainChecklist: null },
		toolExecution: {
			notifySubagentConcurrencyLimitChanged: vi.fn(),
			notifyToolConcurrencyLimitChanged: vi.fn(),
			restoreSubagentActivityRetry: vi.fn(async () => true),
		},
		interactions: { open: vi.fn(async () => undefined), dispatch: vi.fn(async () => undefined) },
		browser: { dispose: vi.fn() },
		commands: { cancelTaskOwnedCommands: vi.fn(async () => undefined) },
		files: { getAllModifiedFiles: vi.fn(() => [] as string[]) },
		...options.owners,
	}

	const session = {
		taskId,
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
		messages: owners.messages,
		payloads: { put: vi.fn(async () => "payload:1"), read: vi.fn(async () => new Uint8Array()) },
		state: vi.fn(() => state),
		projectView: vi.fn(() => undefined),
		dispose: vi.fn(async () => undefined),
		...options.session,
	}

	return session as typeof session & ActiveTaskSession
}
