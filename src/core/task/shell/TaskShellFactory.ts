import { type Command, type HydrateForm, type HydrateInput, hydrate, requiredPayloadRefs, type TaskState } from "../kernel"
import type { RuntimeDiagnosticSink, TaskRuntime } from "../runtime"
import { commandEffectKey } from "../runtime/DurableCommandOutbox"
import type { DurableTaskSnapshot, TaskPayloadStore, TaskViewPort } from "../stores"
import {
	createTaskExecutorAssembly,
	type TaskExecutionPorts,
	type TaskExecutorAssembly,
	type TaskPersistencePorts,
} from "./TaskExecutorAssembly"
import { openTaskPersistence, type TaskPersistenceAssembly } from "./TaskPersistenceAssembly"
import { type TaskInputPresentationPort, TaskShell } from "./TaskShell"

/**
 * Rebuild causes that describe a normal open rather than a fault.
 *
 * A task written by an older build, or seeded without runtime state, has no
 * snapshot yet; rebuilding it from its journal is the designed path, so it is
 * reported as an observation. Every other rebuild cause means durable state
 * was damaged and stays a failure.
 */
const EXPECTED_REBUILD_CAUSES: ReadonlySet<string> = new Set(["snapshot_missing"])

export interface TaskExecutionFactoryContext {
	readonly initialState: TaskState
	readonly persistence: TaskPersistenceAssembly
}

export interface OpenTaskShellOptions {
	readonly taskId: string
	readonly openReason: HydrateInput["openReason"]
	readonly execution: TaskExecutionPorts | ((context: TaskExecutionFactoryContext) => TaskExecutionPorts)
	readonly taskView: TaskViewPort
	readonly diagnostics?: RuntimeDiagnosticSink
	readonly persistence?: TaskPersistenceAssembly
	/** Shows accepted submissions in chat; absent in headless assemblies. */
	readonly inputPresentation?: TaskInputPresentationPort
	/**
	 * Hold recovered commands until `TaskShell.open()`. Set when the opening window does not
	 * own the task lock, so recovery cannot write the databases another window is writing.
	 */
	readonly deferRestoredCommands?: boolean
}

/** An opened task; opening an existing task always succeeds, see `hydrate`. */
export interface OpenTaskShellResult {
	readonly kind: "ready"
	readonly form: HydrateForm
	readonly shell: TaskShell
	readonly runtime: TaskRuntime
	readonly assembly: TaskExecutorAssembly
	readonly payloads: TaskPayloadStore
	readonly diagnostics: readonly { readonly code: string; readonly message: string }[]
}

function mergeRestoredCommands(commands: readonly Command[]): readonly Command[] {
	const merged = new Map<string, Command>()
	for (const command of commands) merged.set(commandEffectKey(command), command)
	return [...merged.values()]
}

/**
 * Describe what recovery decided, so a task that reopens without offering a way
 * back in can be told apart from one that had nothing to replay.
 *
 * Every later symptom of a failed reopen — no dialog, a disabled composer, a
 * silent backend — looks identical from the outside. Only the hydrate outcome
 * distinguishes them, and it is otherwise never recorded.
 */
function describeHydrate(form: HydrateForm, state: TaskState, commands: readonly Command[]): string {
	const types = commands.map((command) => command.type)
	return [
		`form=${form}`,
		`flow=${state.flow.phase}`,
		`revision=${state.revision}`,
		`generation=${state.generation}`,
		`primary=${state.dialog.primary ? `${state.dialog.primary.kind}:${state.dialog.primary.status}` : "none"}`,
		// The anchor row is matched by this id, so a restored dialog that no row
		// carries is indistinguishable from a missing dialog without it.
		`primaryInteraction=${state.dialog.primary?.interactionId ?? "none"}`,
		`commands=${types.length === 0 ? "none" : types.join(",")}`,
	].join(" ")
}

/**
 * The stored snapshot, or undefined when there is none or it cannot be read.
 *
 * An unreadable vault costs the in-flight state, not the task: hydrate rebuilds
 * it from the journal, so the failure is recorded instead of thrown.
 */
async function loadSnapshot(
	persistence: TaskPersistenceAssembly,
	taskId: string,
	diagnostics: RuntimeDiagnosticSink | undefined,
): Promise<DurableTaskSnapshot | undefined> {
	try {
		return await persistence.ports.vault.load(taskId)
	} catch (error) {
		diagnostics?.record({
			source: "hydrate",
			code: "snapshot_unreadable",
			message: error instanceof Error ? error.message : String(error),
			// A snapshot that exists but cannot be read is a fault, unlike one that
			// was never written; the rebuild that follows is the recovery from it.
			severity: "failure",
		})
		return undefined
	}
}

/** Payloads `state` needs that the store cannot provide; see `requiredPayloadRefs`. */
async function unavailablePayloads(payloads: TaskPayloadStore, state: TaskState | undefined): Promise<ReadonlySet<string>> {
	const unavailable = new Set<string>()
	if (!state) return unavailable
	for (const payloadRef of requiredPayloadRefs(state)) {
		try {
			await payloads.read(payloadRef)
		} catch {
			unavailable.add(payloadRef)
		}
	}
	return unavailable
}

export async function openTaskShell(options: OpenTaskShellOptions): Promise<OpenTaskShellResult> {
	const persistence = options.persistence ?? (await openTaskPersistence(options.taskId))
	const durable = await loadSnapshot(persistence, options.taskId, options.diagnostics)
	const restored = hydrate({
		taskId: options.taskId,
		snapshot: durable?.state,
		journalTail: persistence.ports.journal.watermark(),
		openReason: options.openReason,
		unavailablePayloads: await unavailablePayloads(persistence.payloads, durable?.state),
	})

	const ports: TaskPersistencePorts = { ...persistence.ports, taskView: options.taskView }
	const execution =
		typeof options.execution === "function"
			? options.execution({ initialState: restored.state, persistence })
			: options.execution
	// Commands stored with a discarded snapshot act on a state that no longer exists.
	const storedOutbox = restored.rebuilt ? [] : (durable?.outbox ?? [])
	const restoredOutbox = mergeRestoredCommands([...storedOutbox, ...restored.initialCommands])
	for (const diagnostic of restored.diagnostics) {
		options.diagnostics?.record({
			source: "hydrate",
			code: diagnostic.code,
			message: diagnostic.message,
			severity: restored.rebuilt && !EXPECTED_REBUILD_CAUSES.has(diagnostic.code) ? "failure" : "observation",
			revision: restored.state.revision,
		})
	}
	options.diagnostics?.record({
		source: "hydrate",
		code: "hydrated",
		severity: "observation",
		message: describeHydrate(restored.form, restored.state, restoredOutbox),
		revision: restored.state.revision,
	})
	const assembly = createTaskExecutorAssembly({
		taskId: options.taskId,
		initialState: restored.state,
		persistence: ports,
		execution,
		diagnostics: options.diagnostics,
		restoredOutbox,
		deferRestoredCommands: options.deferRestoredCommands,
	})
	return {
		kind: "ready",
		form: restored.form,
		shell: new TaskShell(assembly.runtime, assembly.halt, options.inputPresentation),
		runtime: assembly.runtime,
		assembly,
		payloads: persistence.payloads,
		diagnostics: restored.diagnostics,
	}
}
