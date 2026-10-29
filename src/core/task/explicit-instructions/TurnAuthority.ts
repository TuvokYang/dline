import { randomUUID } from "node:crypto"
import type { DlineDefaultTool } from "@shared/tools"
import { ExplicitInstructionRegistry } from "./ExplicitInstructionRegistry"
import { ExplicitInstructionRequestScope } from "./ExplicitInstructionRequestScope"
import { getExplicitInstructionPolicy } from "./policy"
import type { ExplicitInstructionConsumePort, ExplicitInstructionDeclaration } from "./types"

/** One-shot authority a single turn's admitted input granted. */
export interface ExplicitTurnAuthority {
    /** The turn the user named the command in; authority never crosses it. */
    readonly turnId: string
    readonly port: ExplicitInstructionConsumePort
    /** Withdraw unconsumed authority when the turn it belongs to is abandoned. */
    cancel(): void
}

/**
 * Task-scoped owner of turn authority.
 *
 * The provider request path grants authority for the turn it is about to send,
 * and the tool gate reads it back with the same turn identity. Keeping one
 * owner per task is what makes the grant and the gate agree: a command named in
 * one turn cannot authorize an explicit-only tool in a later turn, because
 * opening the next turn retires whatever the previous turn left unconsumed.
 */
interface GrantedTurn {
    readonly turnId: string
    readonly scope: ExplicitInstructionRequestScope
    readonly port: ExplicitInstructionConsumePort
}

export class TaskTurnAuthority {
    private readonly registry = new ExplicitInstructionRegistry()
    private granted?: GrantedTurn

    /**
     * Grant the declarations one turn's admitted input carried.
     *
     * Returns undefined when the input granted nothing, so an ordinary message
     * leaves the explicit-only tools closed instead of inheriting old authority.
     */
    grant(turnId: string, declarations: readonly ExplicitInstructionDeclaration[]): ExplicitTurnAuthority | undefined {
        this.retire()
        const grantable = grantableDeclarations(declarations)
        if (grantable.length === 0) return undefined
        const scope = new ExplicitInstructionRequestScope(this.registry, { requestId: turnId, attemptId: randomUUID() })
        for (const declaration of grantable) scope.register(declaration)
        const port = scope.createConsumePort()
        this.granted = { turnId, scope, port }
        return Object.freeze({
            turnId,
            port,
            cancel: () => this.cancel(turnId),
        })
    }

    /** Authority the tool gate may use for a block that belongs to the named turn. */
    read(turnId: string | undefined): ExplicitInstructionConsumePort | undefined {
        if (turnId === undefined) return undefined
        return this.granted?.turnId === turnId ? this.granted.port : undefined
    }

    /** Withdraw the named turn's unconsumed authority; a stale turn is ignored. */
    cancel(turnId: string): void {
        if (this.granted?.turnId !== turnId) return
        this.granted.scope.cancel()
        this.granted = undefined
    }

    /** Expire whatever the previous turn left unconsumed. */
    private retire(): void {
        this.granted?.scope.close()
        this.granted = undefined
    }
}

/**
 * Keep only declarations the registry can accept.
 *
 * Declarations are replayed from durable payloads, so a stale or malformed one
 * must cost its own authority instead of failing the turn that replayed it. A
 * dropped declaration leaves the explicit-only tool denied, which is the safe
 * outcome and is visible to the user as a denial rather than a lost turn.
 */
function grantableDeclarations(
    declarations: readonly ExplicitInstructionDeclaration[],
): readonly ExplicitInstructionDeclaration[] {
    const grantable: ExplicitInstructionDeclaration[] = []
    const claimed = new Set<DlineDefaultTool>()
    for (const declaration of declarations) {
        const policy = getExplicitInstructionPolicy(declaration.type)
        if (!policy) continue
        if (policy.authorizesTool) {
            if (declaration.targetTool !== policy.targetTool) continue
            if (declaration.targetTool !== undefined && claimed.has(declaration.targetTool)) continue
            if (declaration.targetTool !== undefined) claimed.add(declaration.targetTool)
        } else if (declaration.targetTool !== undefined) {
            continue
        }
        grantable.push(declaration)
    }
    return grantable
}
