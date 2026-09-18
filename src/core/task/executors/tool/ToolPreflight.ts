import type { AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import type { ClineAsk } from "@shared/ExtensionMessage"
import {
	type ApprovalDecision,
	type ConfigurableCeilings,
	type PermissionScopeContext,
	resolveApprovalKind,
} from "../../kernel/turn/approval-kind"
import { resolveToolLanes, type ToolLane, type ToolLaneContext } from "../../kernel/turn/tool-lanes"

/**
 * Two-phase tool admission.
 *
 * Admission is split from execution because the two answer different questions.
 * Preflight decides whether a call is well-formed and how it must be approved;
 * it reaches nothing outside itself. Only once that decision has been satisfied
 * does the returned closure run, and only that closure touches the world.
 *
 * The split is what lets approval and execution be owned separately: a block
 * waiting for the user is in preflight and holds no execution slot, and a block
 * that has been admitted holds a slot but no longer holds the approval slot.
 * It also makes the approval decision testable without a host, since the
 * presentation is returned as data rather than shown.
 */

/** Why a call cannot proceed, decided before anything is shown or run. */
export interface ToolPreflightRejection {
	reason: "invalid_parameters" | "unsupported_tool"
	/** Message shown to the model, already safe to surface. */
	message: string
}

/**
 * What the user must be shown in order to decide.
 *
 * This is deliberately data rather than a call. A handler that showed its own
 * prompt would own a second approval route, which could not be serialized
 * against the single approval slot and could not be produced in a test without
 * a host. Returning the payload lets the admission stage decide when, whether,
 * and in which slot it is presented.
 */
export interface ToolApprovalPresentation {
	/** Interaction kind the Webview uses to render the request. */
	ask: ClineAsk
	/** Serialized payload for that interaction. */
	body: string
	/** Whether a desktop notification should accompany the request. */
	notify: boolean
}

/** The side effect a tool performs once it has been admitted. */
export type ToolSideEffect<T> = () => Promise<T>

/** A call that passed validation and may proceed once approved. */
export interface ToolPreflightAdmission<T> {
	outcome: "admitted"
	decision: ApprovalDecision
	/**
	 * Absent when the decision needs no user-facing request, which is the case
	 * for policy-approved calls and for tools that present their own
	 * interaction.
	 */
	presentation?: ToolApprovalPresentation
	/** Shared resources this call serializes against. */
	lanes: ToolLane[]
	/**
	 * The side effect, deliberately not started.
	 *
	 * Returning it unstarted lets the caller resolve approval again immediately
	 * before this runs, so tightening a setting still affects work that has not
	 * begun without depending on a shared version counter.
	 */
	run: ToolSideEffect<T>
	/** Optional input-only preparation that must finish before a manual approval is presented. */
	prepareApproval?: () => Promise<ToolPreflightResult<T>>
	/**
	 * Optional pre-scheduling scope confirmation.
	 *
	 * Admission itself stays target-I/O free. Filesystem-backed calls may attach
	 * this unstarted closure so aliases and final lanes are canonicalized before
	 * the execution pool reserves a lane or permit. The returned Admission is the
	 * one that must execute.
	 */
	confirm?: () => Promise<ToolPreflightResult<T>>
	/** True when a human already approved this exact call before target confirmation. */
	manualApprovalSatisfied?: boolean
	/** Recompute only the live approval decision while preserving run and lanes. */
	refreshDecision?: () => ToolPreflightAdmission<T>
}

/** A call that cannot proceed. */
export interface ToolPreflightRejected {
	outcome: "rejected"
	rejection: ToolPreflightRejection
}

/** Result of preflighting one tool call. */
export type ToolPreflightResult<T> = ToolPreflightAdmission<T> | ToolPreflightRejected

/** Inputs needed to decide admission for one call. */
export interface ToolPreflightInput {
	toolName: string
	settings: AutoApprovalSettings
	ceilings?: ConfigurableCeilings
	scope?: PermissionScopeContext
	lanes?: ToolLaneContext
	blanket?: { yoloMode?: boolean; approveAll?: boolean }
	/**
	 * Subagent execution inherits the approval its parent already obtained, so
	 * a nested call does not raise a second prompt the user never asked for.
	 */
	inheritsApproval?: boolean
}

/** Build a rejected preflight result. */
export function rejectToolCall<T>(rejection: ToolPreflightRejection): ToolPreflightResult<T> {
	return { outcome: "rejected", rejection }
}

/**
 * Decide how a validated call must be admitted.
 *
 * @param input Tool identity, permission state and runtime classification facts.
 * @param run The side effect to perform after admission, not started here.
 * @param presentation Approval payload, used only when the user must decide.
 * @returns The admission, carrying the decision, lanes and unstarted effect.
 */
export function admitToolCall<T>(
	input: ToolPreflightInput,
	run: ToolSideEffect<T>,
	presentation?: ToolApprovalPresentation,
	confirm?: () => Promise<ToolPreflightResult<T>>,
	refreshDecision?: () => ToolPreflightAdmission<T>,
): ToolPreflightAdmission<T> {
	// The runtime facts that classify a call are named `scope` here and
	// `context` on the resolver, so they must be mapped rather than spread.
	// An inherited call still needs the correct scope for diagnostics, and
	// spreading would leave `context` undefined and silently report an
	// external path as an in-workspace one.
	const resolverInput = {
		toolName: input.toolName,
		settings: input.settings,
		ceilings: input.ceilings,
		context: input.scope,
		inheritsApproval: input.inheritsApproval,
		blanket: input.blanket,
	}

	const decision = resolveApprovalKind(resolverInput)

	return {
		outcome: "admitted",
		decision,
		// A decision that needs no user request carries no payload, so a caller
		// cannot accidentally present one.
		presentation: decision.kind === "manual" || decision.kind === "ai_approver" ? presentation : undefined,
		lanes: resolveToolLanes(input.toolName, input.lanes ?? {}),
		run,
		confirm,
		refreshDecision,
	}
}
