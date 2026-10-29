/**
 * Simulators a reproduction scenario is allowed to reach.
 *
 * A diagnostic bundle describes a failure that already happened. Replaying it
 * must never re-run the original side effects: the maintainer opening a bug
 * report is not the user who chose to run that command, call that MCP tool, or
 * write that file.
 *
 * The guarantee is structural rather than contractual. `resolveReplayPort`
 * returns one of a closed set of module-private simulators, and the runner
 * takes a policy rather than an implementation, so a caller cannot supply an
 * object that performs real work and then reports `simulated: true`. Adding a
 * new capability means adding a simulator here, where it is reviewable,
 * instead of injecting one at a call site.
 */

/** Effect category a step wants to perform. */
export enum ReplayEffect {
    Command = "command",
    McpTool = "mcp_tool",
    Network = "network",
    FileWrite = "file_write",
    /** Reviewed component that only reads or computes; nothing to re-perform. */
    Inert = "inert",
    /** Component the classifier does not recognise; never replayed. */
    Unknown = "unknown",
}

/**
 * A single replay request.
 *
 * The request carries identity and the recorded outcome only. It deliberately
 * has no argv, body, payload, or path: those are the fields that would make a
 * real execution possible, and they are also the fields most likely to hold
 * user content.
 */
export interface ReplayRequest {
    readonly effect: ReplayEffect
    readonly component: string
    readonly operation: string
    /** Outcome recorded when the incident happened. */
    readonly recordedOutcome: string
    readonly recordedDurationMs?: number
}

export interface ReplayResult {
    readonly outcome: string
    readonly durationMs: number
    /**
     * Always `true`.
     *
     * The literal type is the enforcement: a port that performed real work
     * could not honestly return it, so "no side effect" is checked by the
     * compiler at every implementation site rather than asserted in a test
     * that only ever sees a cooperative fake.
     */
    readonly simulated: true
}

/** The single capability a scenario runner is given. */
export interface ReplayPort {
    perform(request: ReplayRequest): ReplayResult
    /** Requests seen so far, in order. */
    readonly requests: readonly ReplayRequest[]
}

/**
 * How a caller wants a scenario handled.
 *
 * A policy, not an implementation: the caller decides whether the scenario is
 * simulated or refused, and cannot decide what "simulated" means.
 */
export enum ReplayPolicy {
    /** Return the recorded outcome without performing anything. */
    Simulate = "simulate",
    /** Refuse every step, so an accidental replay fails loudly. */
    Refuse = "refuse",
}

/**
 * Replay port that performs nothing and returns the recorded outcome.
 *
 * Module-private: exposing the class would let a caller subclass it, override
 * `perform`, and reintroduce the very side effects the port exists to prevent.
 * Callers obtain an instance through `resolveReplayPort`.
 *
 * Requests are kept observable so a test can assert both that the runner routed
 * every step through the port and that no other channel was used.
 */
class SimulatingReplayPort implements ReplayPort {
    private readonly performed: ReplayRequest[] = []

    get requests(): readonly ReplayRequest[] {
        return this.performed
    }

    perform(request: ReplayRequest): ReplayResult {
        this.performed.push(request)
        return {
            outcome: request.recordedOutcome,
            durationMs: request.recordedDurationMs ?? 0,
            simulated: true,
        }
    }
}

/**
 * Seal a port so its behaviour cannot be swapped after construction.
 *
 * Making the classes module-private hides their names but not their
 * prototypes: a caller holding an instance from `resolveReplayPort` could
 * reach `Object.getPrototypeOf(port)` and overwrite `perform`, and every
 * later instance would inherit the replacement. Freezing the prototype and
 * the instance closes that path, so "a replay performs nothing" survives a
 * hostile or careless consumer rather than only an honest one.
 */
function sealPort<T extends ReplayPort>(port: T): T {
    Object.freeze(Object.getPrototypeOf(port))
    return Object.freeze(port)
}

/**
 * Replay port that refuses every request.
 *
 * Used where a caller wants a scenario inspected but never executed, so an
 * accidental run fails loudly instead of quietly reporting simulated success.
 */
class RefusingReplayPort implements ReplayPort {
    get requests(): readonly ReplayRequest[] {
        return []
    }

    perform(request: ReplayRequest): ReplayResult {
        throw new ReplayNotPermitted(request)
    }
}

/**
 * Build the port for a policy.
 *
 * The only way to obtain a port. Every returned instance comes from this
 * module, which is what makes "a replay cannot touch the machine" a property
 * of the code rather than of the caller's good intentions.
 */
export function resolveReplayPort(policy: ReplayPolicy): ReplayPort {
    switch (policy) {
        case ReplayPolicy.Simulate:
            return sealPort(new SimulatingReplayPort())
        case ReplayPolicy.Refuse:
            return sealPort(new RefusingReplayPort())
        default:
            return assertNeverPolicy(policy)
    }
}

/** Count the requests routed to `port` for one effect. */
export function countReplayedEffects(port: ReplayPort, effect: ReplayEffect): number {
    return port.requests.reduce((total, request) => (request.effect === effect ? total + 1 : total), 0)
}

function assertNeverPolicy(policy: never): never {
    throw new Error(`unsupported replay policy: ${String(policy)}`)
}

export class ReplayNotPermitted extends Error {
    constructor(readonly request: ReplayRequest) {
        super(`replay of ${request.component}.${request.operation} is not permitted`)
        this.name = "ReplayNotPermitted"
    }
}
