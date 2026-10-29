import { randomUUID } from "node:crypto"
import { getExplicitInstructionPolicy } from "./policy"
import type {
    ConsumeExplicitInstructionInput,
    ConsumeExplicitInstructionResult,
    ConsumeExplicitToolInput,
    ExplicitInstructionAuthorization,
    ExplicitInstructionRequestIdentity,
    ExplicitInstructionState,
    RegisterExplicitInstructionInput,
} from "./types"

interface MutableAuthorization extends Omit<ExplicitInstructionAuthorization, "state"> {
    state: ExplicitInstructionState
}

export class ExplicitInstructionRegistry {
    private readonly authorizations = new Map<string, MutableAuthorization>()

    register(input: RegisterExplicitInstructionInput): ExplicitInstructionAuthorization {
        const policy = getExplicitInstructionPolicy(input.type)
        if (policy.authorizesTool && input.targetTool !== policy.targetTool) {
            throw new Error(`Explicit instruction '${input.type}' must target '${policy.targetTool}'.`)
        }
        if (!policy.authorizesTool && input.targetTool !== undefined) {
            throw new Error(`Explicit instruction '${input.type}' cannot authorize a tool.`)
        }
        if (
            input.targetTool !== undefined &&
            Array.from(this.authorizations.values()).some(
                (authorization) =>
                    authorization.requestId === input.requestId &&
                    authorization.attemptId === input.attemptId &&
                    authorization.targetTool === input.targetTool &&
                    authorization.state === "pending",
            )
        ) {
            throw new Error(`Explicit tool '${input.targetTool}' already has a pending authorization for this request attempt.`)
        }

        const authorization: MutableAuthorization = {
            instructionId: randomUUID(),
            requestId: input.requestId,
            attemptId: input.attemptId,
            ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
            type: input.type,
            source: input.source,
            ...(input.targetTool === undefined ? {} : { targetTool: input.targetTool }),
            ...(input.metadata === undefined ? {} : { metadata: Object.freeze({ ...input.metadata }) }),
            state: "pending",
        }
        this.authorizations.set(authorization.instructionId, authorization)
        return this.snapshot(authorization)
    }

    consumeTool(input: ConsumeExplicitToolInput): ConsumeExplicitInstructionResult {
        const candidates = Array.from(this.authorizations.values()).filter(
            (authorization) => authorization.targetTool === input.targetTool,
        )
        const requestCandidate = candidates.find((authorization) => authorization.requestId === input.requestId)
        if (!requestCandidate) {
            return candidates.length > 0
                ? { ok: false, code: "explicit_instruction_request_mismatch" }
                : { ok: false, code: "explicit_instruction_missing" }
        }
        const attemptCandidate = candidates.find(
            (authorization) => authorization.requestId === input.requestId && authorization.attemptId === input.attemptId,
        )
        if (!attemptCandidate) {
            return { ok: false, code: "explicit_instruction_attempt_mismatch" }
        }
        if (attemptCandidate.state === "consumed") {
            return { ok: false, code: "explicit_instruction_already_consumed" }
        }
        if (attemptCandidate.state === "expired") return { ok: false, code: "explicit_instruction_expired" }
        if (attemptCandidate.state === "cancelled") return { ok: false, code: "explicit_instruction_cancelled" }
        attemptCandidate.state = "consumed"
        return { ok: true, authorization: this.snapshot(attemptCandidate) }
    }

    consumeBehaviorInstructions(identity: ExplicitInstructionRequestIdentity): readonly ExplicitInstructionAuthorization[] {
        const consumed: ExplicitInstructionAuthorization[] = []
        for (const authorization of this.authorizations.values()) {
            if (
                authorization.requestId === identity.requestId &&
                authorization.attemptId === identity.attemptId &&
                authorization.targetTool === undefined &&
                authorization.state === "pending"
            ) {
                authorization.state = "consumed"
                consumed.push(this.snapshot(authorization))
            }
        }
        return consumed
    }

    consume(input: ConsumeExplicitInstructionInput): ConsumeExplicitInstructionResult {
        const authorization = this.authorizations.get(input.instructionId)
        if (!authorization) return { ok: false, code: "explicit_instruction_missing" }
        if (authorization.state === "consumed") return { ok: false, code: "explicit_instruction_already_consumed" }
        if (authorization.state === "expired") return { ok: false, code: "explicit_instruction_expired" }
        if (authorization.state === "cancelled") return { ok: false, code: "explicit_instruction_cancelled" }
        if (authorization.requestId !== input.requestId) {
            return { ok: false, code: "explicit_instruction_request_mismatch" }
        }
        if (authorization.attemptId !== input.attemptId) {
            return { ok: false, code: "explicit_instruction_attempt_mismatch" }
        }
        if (authorization.type !== input.type) return { ok: false, code: "explicit_instruction_type_mismatch" }
        if (authorization.source !== input.source) return { ok: false, code: "explicit_instruction_source_mismatch" }
        if (authorization.targetTool !== input.targetTool) return { ok: false, code: "explicit_instruction_tool_mismatch" }

        authorization.state = "consumed"
        return { ok: true, authorization: this.snapshot(authorization) }
    }

    registerRetry(instructionId: string, attemptId: string): ExplicitInstructionAuthorization {
        const previous = this.authorizations.get(instructionId)
        if (!previous) throw new Error("Cannot retry a missing explicit instruction authorization.")
        if (!getExplicitInstructionPolicy(previous.type).allowRetry) {
            throw new Error(`Explicit instruction '${previous.type}' does not permit retry authorization.`)
        }
        if (previous.state === "cancelled") {
            throw new Error("Cannot retry a cancelled explicit instruction authorization.")
        }
        previous.state = "expired"
        return this.register({
            requestId: previous.requestId,
            attemptId,
            ...(previous.operationId === undefined ? {} : { operationId: previous.operationId }),
            type: previous.type,
            source: previous.source,
            ...(previous.targetTool === undefined ? {} : { targetTool: previous.targetTool }),
            ...(previous.metadata === undefined ? {} : { metadata: previous.metadata }),
        })
    }

    expireAttempt(identity: ExplicitInstructionRequestIdentity): void {
        for (const authorization of this.authorizations.values()) {
            if (
                authorization.requestId === identity.requestId &&
                authorization.attemptId === identity.attemptId &&
                authorization.state === "pending"
            ) {
                authorization.state = "expired"
            }
        }
    }

    closeRequest(requestId: string): void {
        this.transitionPending(requestId, "expired")
    }

    cancelRequest(requestId: string): void {
        this.transitionPending(requestId, "cancelled")
    }

    get(instructionId: string): ExplicitInstructionAuthorization | undefined {
        const authorization = this.authorizations.get(instructionId)
        return authorization ? this.snapshot(authorization) : undefined
    }

    findPendingTool(
        identity: ExplicitInstructionRequestIdentity,
        targetTool: ExplicitInstructionAuthorization["targetTool"],
    ): ExplicitInstructionAuthorization | undefined {
        const authorization = Array.from(this.authorizations.values()).find(
            (candidate) =>
                candidate.requestId === identity.requestId &&
                candidate.attemptId === identity.attemptId &&
                candidate.targetTool === targetTool &&
                candidate.state === "pending",
        )
        return authorization ? this.snapshot(authorization) : undefined
    }

    private transitionPending(requestId: string, state: "expired" | "cancelled"): void {
        for (const authorization of this.authorizations.values()) {
            if (authorization.requestId === requestId && authorization.state === "pending") authorization.state = state
        }
    }

    private snapshot(authorization: MutableAuthorization): ExplicitInstructionAuthorization {
        return Object.freeze({
            ...authorization,
            ...(authorization.metadata === undefined ? {} : { metadata: Object.freeze({ ...authorization.metadata }) }),
        })
    }
}
