import type { ScenarioStep } from "../export/bundle-builder"
import {
    ReplayEffect,
    ReplayNotPermitted,
    type ReplayPolicy,
    type ReplayPort,
    type ReplayRequest,
    type ReplayResult,
    resolveReplayPort,
} from "./replay-ports"

/**
 * Replays a recorded scenario through a simulator selected by policy.
 *
 * The runner is deliberately thin: it classifies each step, hands it to the
 * port, and reports what the port returned. The caller chooses a policy rather
 * than supplying a port, so "a scenario cannot touch the machine" holds even
 * when the caller is careless: there is no seam through which a real terminal,
 * client, socket, or file system can be injected.
 *
 * Timing is reported, never awaited. Sleeping through the original delays
 * would make replaying an incident as slow as the incident itself and would
 * add nothing: the recorded duration is already in the step.
 */

/**
 * Effect classification for a step, derived from its component name.
 *
 * Keys are the component names a bundle actually carries. `buildScenarioSteps`
 * derives an absent component from the event name, and `PerfDomain` spells
 * those in snake_case (`terminal_pool`, `settings_repository`), so a map that
 * only knew camelCase would refuse to replay the scenarios this codebase
 * produces. Both spellings are listed rather than normalised, because
 * normalising would also fold apart names that a reviewer intended to keep
 * distinct. `DiagnosticDomain` contributes a few further names — `storage`,
 * `hook`, `task`, `workspace` — that no performance domain spells.
 */
const COMPONENT_EFFECTS: ReadonlyMap<string, ReplayEffect> = new Map([
    ["terminal", ReplayEffect.Command],
    ["terminalPool", ReplayEffect.Command],
    ["terminal_pool", ReplayEffect.Command],
    ["mcp", ReplayEffect.McpTool],
    ["provider", ReplayEffect.Network],
    ["telemetry", ReplayEffect.Network],
    ["checkpoint", ReplayEffect.FileWrite],
    ["settings", ReplayEffect.FileWrite],
    ["settingsRepository", ReplayEffect.FileWrite],
    ["settings_repository", ReplayEffect.FileWrite],
    ["fileLock", ReplayEffect.FileWrite],
    ["file_lock", ReplayEffect.FileWrite],
    ["storage", ReplayEffect.FileWrite],
    // Domains that only read or compute. They are listed so a scenario built
    // from this codebase's own events replays end to end instead of aborting
    // on the first startup sample; `Inert` still reaches the port, which
    // performs nothing.
    ["activation", ReplayEffect.Inert],
    ["capability", ReplayEffect.Inert],
    ["controller_close", ReplayEffect.Inert],
    ["hook", ReplayEffect.Inert],
    ["hook_discovery", ReplayEffect.Inert],
    ["profile", ReplayEffect.Inert],
    ["prompt_build", ReplayEffect.Inert],
    ["prompt_freshness", ReplayEffect.Inert],
    ["prompt_input_watcher", ReplayEffect.Inert],
    ["runtime", ReplayEffect.Inert],
    ["state", ReplayEffect.Inert],
    ["task", ReplayEffect.Inert],
    ["task_close", ReplayEffect.Inert],
    ["task_init", ReplayEffect.Inert],
    ["task_snapshot", ReplayEffect.Inert],
    ["workspace", ReplayEffect.Inert],
])

/**
 * Steps whose component is unrecognised are classified as unknown.
 *
 * Mapping them onto an existing category would grant a new instrumentation
 * domain — or a component name invented by a hostile bundle — the permissions
 * of a category it was never reviewed for. Unknown is refused instead.
 */
const UNCLASSIFIED_EFFECT = ReplayEffect.Unknown

export interface ReplayedStep {
    readonly index: number
    readonly component: string
    readonly operation: string
    readonly effect: ReplayEffect
    readonly recordedOutcome: string
    readonly replayedOutcome: string
    /**
     * Always `true`, carried through from `ReplayResult`.
     *
     * Widening this to `boolean` would let a future change report a real
     * execution as an ordinary field value; the literal keeps the compiler
     * involved in the guarantee.
     */
    readonly simulated: true
}

export interface ScenarioReplayReport {
    readonly steps: readonly ReplayedStep[]
    /** Steps whose replayed outcome differed from the recorded one. */
    readonly divergences: readonly number[]
    readonly totalRecordedDurationMs: number
    /** The port that handled the run, for assertions about routing. */
    readonly port: ReplayPort
}

/**
 * Map a component name onto the effect it is allowed to replay.
 *
 * A Map rather than an object literal: a scenario file arrives from an
 * untrusted bug report, and `constructor`, `toString` or `__proto__` would
 * resolve through an object's prototype chain and silently escape the
 * fail-closed Unknown branch.
 */
export function classifyStepEffect(component: string): ReplayEffect {
    return COMPONENT_EFFECTS.get(component) ?? UNCLASSIFIED_EFFECT
}

/**
 * Replay every step under `policy`.
 *
 * The caller chooses the policy because the decision to allow any handling at
 * all belongs to the caller, not to the scenario file, which arrives from an
 * untrusted bug report. The caller cannot choose the implementation.
 */
export function replayScenario(steps: readonly ScenarioStep[], policy: ReplayPolicy): ScenarioReplayReport {
    const port = resolveReplayPort(policy)
    const replayed: ReplayedStep[] = []
    const divergences: number[] = []
    let totalRecordedDurationMs = 0

    for (const step of steps) {
        const request: ReplayRequest = {
            effect: classifyStepEffect(step.component),
            component: step.component,
            operation: step.operation,
            recordedOutcome: step.outcome,
            recordedDurationMs: step.durationMs,
        }

        // Fail closed: an unclassified component is refused before it reaches
        // the port, so a port cannot be asked to act on an effect nobody
        // reviewed.
        if (request.effect === ReplayEffect.Unknown) {
            throw new ReplayNotPermitted(request)
        }

        const result: ReplayResult = port.perform(request)
        totalRecordedDurationMs += step.durationMs ?? 0

        if (result.outcome !== step.outcome) divergences.push(step.index)
        replayed.push({
            index: step.index,
            component: step.component,
            operation: step.operation,
            effect: request.effect,
            recordedOutcome: step.outcome,
            replayedOutcome: result.outcome,
            simulated: result.simulated,
        })
    }

    return { steps: replayed, divergences, totalRecordedDurationMs, port }
}
