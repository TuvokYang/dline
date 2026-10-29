import { DlineDefaultTool } from "@shared/tools"
import { isExplicitOnlyTool } from "./policy"
import type { ExplicitInstructionAuthorization, ExplicitInstructionConsumePort, ExplicitInstructionFailureCode } from "./types"

export type ExplicitToolGateResult =
    | { readonly ok: true; readonly authorization?: ExplicitInstructionAuthorization }
    | { readonly ok: false; readonly code: ExplicitInstructionFailureCode }

/** Consume one request-scoped authorization before an explicit-only handler can execute. */
export function authorizeExplicitToolExecution(
    tool: DlineDefaultTool,
    port: ExplicitInstructionConsumePort | undefined,
): ExplicitToolGateResult {
    if (tool === DlineDefaultTool.CONDENSE) return { ok: false, code: "explicit_instruction_retired" }
    if (!isExplicitOnlyTool(tool)) return { ok: true }
    if (!port) return { ok: false, code: "explicit_instruction_missing" }
    return port.consumeTool(tool)
}

/** Model-visible refusal shared by every path that applies the explicit gate. */
export function explicitToolRefusalMessage(tool: string, code: ExplicitInstructionFailureCode): string {
    return `Explicit-only tool '${tool}' was rejected: ${code}.`
}

/**
 * Name the gate's refusal for an explicit-only or retired tool that has no handler.
 *
 * summarize_task text is owned by ContextCompactionSession, so the tool intentionally has no handler. A call
 * without pending authority must still surface the gate's code; a "no handler" failure would hide the policy
 * reason the model has to act on. Pending authority belongs to its owner and is never consumed here.
 */
export function findHandlerlessExplicitRefusal(
    tool: string,
    port: ExplicitInstructionConsumePort | undefined,
): ExplicitInstructionFailureCode | undefined {
    const gated = tool as DlineDefaultTool
    // Ordinary tools never reach the explicit gate, so a missing handler stays an ordinary failure for them.
    if (gated !== DlineDefaultTool.CONDENSE && !isExplicitOnlyTool(gated)) return undefined
    if (port?.getPendingToolAuthorization(gated) !== undefined) return undefined
    // Nothing is pending, so the gate cannot consume authority here; it only names the refusal.
    const refusal = authorizeExplicitToolExecution(gated, port)
    return refusal.ok ? undefined : refusal.code
}
