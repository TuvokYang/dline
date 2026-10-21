/**
 * Turn-taking for the machine-wide usage sender lease.
 *
 * Every extension host that reports usage asks for the lease once per cycle.
 * A holder keeps it for one turn and then gives it up for a cycle, whether or
 * not it sees anyone waiting: a build that predates turns writes nothing while
 * it waits, so a holder that only yielded to visible waiters would keep such a
 * build out forever. Windows of this build queue in `waiting`, and the one that
 * has waited longest takes a free or expired lease first. A holder that keeps
 * renewing past its turn, such as a build that predates turns, is taken over
 * under a new generation once a grace period after its turn has passed; its
 * acknowledgements are fenced off and its inflight is replayed from the same
 * bytes, which the service deduplicates by request ID.
 *
 * This module only decides; the outbox repository reads and writes the
 * document under its lock.
 */

/** How long one window sends before it hands the lease on. */
export const USAGE_SENDER_TURN_MS = 10 * 60_000
/**
 * How long past the end of a turn a waiter leaves the holder to hand over by
 * itself. Longer than a cycle plus one HTTP attempt, so a holder of this build
 * always yields before it is taken over.
 */
export const USAGE_SENDER_TAKEOVER_GRACE_MS = 90_000
/** Renew once less than this share of the lease is left; a cycle then always starts with over half a lease. */
const LEASE_RENEW_FRACTION = 2 / 3
/** A waiter that has not asked for this many lease lengths has stopped waiting. */
const WAITER_TTL_LEASES = 2
/** A waiter refreshes its entry at most once per this share of a lease, so waiting does not rewrite the outbox every cycle. */
const WAITER_REFRESH_FRACTION = 1 / 2

export interface UsageSenderGrant {
    readonly ownerId: string
    readonly generation: number
}

export interface SenderLease extends UsageSenderGrant {
    readonly expiresAt: number
    /** Start of the holder's turn; absent when a build that predates turns wrote the lease. */
    readonly grantedAt?: number
}

export interface SenderWaiter {
    /** When this window started waiting; the oldest live waiter goes first. */
    readonly since: number
    /** When this window last asked; an entry not refreshed within the TTL is dropped. */
    readonly seenAt: number
}

export type SenderWaiting = Readonly<Record<string, SenderWaiter>>

/** The lease part of the outbox document. */
export interface SenderTurns {
    /** Highest lease generation ever granted; it only rises, so an old owner can never match again. */
    readonly generation: number
    readonly lease?: SenderLease
    readonly waiting: SenderWaiting
}

/**
 * What one window remembers between its claims. A build that predates turns
 * rewrites the document without `waiting` and without `grantedAt`, so a waiter
 * keeps its own start and the moment it first saw the current lease.
 */
export interface SenderClaimMemory {
    readonly since: number
    readonly seenAt: number
    readonly observed?: { readonly ownerId: string; readonly generation: number; readonly at: number }
}

export type UsageSenderTurnEvent =
    /** This window's turn ended and it gave the lease up for the next window. */
    | { readonly kind: "yielded"; readonly generation: number }
    /** This window took the lease from a holder that kept it past its turn. */
    | { readonly kind: "took_over"; readonly generation: number }

export type SenderClaimDecision =
    /** The holder keeps a lease with most of its time left; nothing is written. */
    | { readonly kind: "kept"; readonly grant: UsageSenderGrant }
    | {
          readonly kind: "granted"
          readonly turns: SenderTurns
          readonly grant: UsageSenderGrant
          readonly event?: UsageSenderTurnEvent
      }
    | {
          readonly kind: "waiting"
          readonly turns: SenderTurns
          readonly memory: SenderClaimMemory
          readonly event?: UsageSenderTurnEvent
      }

export interface SenderClaimInput {
    readonly turns: SenderTurns
    readonly ownerId: string
    readonly now: number
    readonly leaseMs: number
    /** What this window remembered from its previous claim, if any. */
    readonly memory: SenderClaimMemory | undefined
}

/** Decide one claim of the sender lease. */
export function decideSenderClaim(input: SenderClaimInput): SenderClaimDecision {
    const { turns, ownerId, now } = input
    const lease = turns.lease
    const live = lease !== undefined && lease.expiresAt > now
    if (live && lease.ownerId === ownerId) return holderClaim(input, lease)
    return contenderClaim(input, live ? lease : undefined)
}

/** The live holder renews within its turn and gives the lease up once the turn is over. */
function holderClaim({ turns, ownerId, now, leaseMs }: SenderClaimInput, lease: SenderLease): SenderClaimDecision {
    const grant = { ownerId, generation: lease.generation }
    // A lease without a turn start was rewritten by an older build's reset; the turn restarts now.
    const grantedAt = lease.grantedAt ?? now
    if (now - grantedAt >= USAGE_SENDER_TURN_MS) {
        const { lease: _ended, ...rest } = turns
        const waiter = { since: now, seenAt: now }
        return {
            kind: "waiting",
            turns: { ...rest, waiting: { ...liveWaiting(turns.waiting, now, leaseMs), [ownerId]: waiter } },
            memory: waiter,
            event: { kind: "yielded", generation: lease.generation },
        }
    }
    // A lease with most of its time left is kept as it is, so a quiet machine does not rewrite the outbox every cycle.
    if (lease.grantedAt !== undefined && lease.expiresAt - now > leaseMs * LEASE_RENEW_FRACTION) return { kind: "kept", grant }
    return {
        kind: "granted",
        turns: {
            ...turns,
            lease: { ...lease, grantedAt, expiresAt: now + leaseMs },
            waiting: liveWaiting(turns.waiting, now, leaseMs),
        },
        grant,
    }
}

/**
 * Any other window queues. It takes a free or expired lease when it has waited
 * longest, and a live one only when that holder is past its turn and grace.
 */
function contenderClaim(input: SenderClaimInput, held: SenderLease | undefined): SenderClaimDecision {
    const { turns, ownerId, now, leaseMs } = input
    const ttl = WAITER_TTL_LEASES * leaseMs
    const remembered = input.memory && now - input.memory.seenAt <= ttl ? input.memory : undefined
    const others = liveWaiting(turns.waiting, now, leaseMs)
    const persisted = others[ownerId]
    const since = Math.min(remembered?.since ?? now, persisted?.since ?? now)
    // Refresh the entry only when it is missing, moved or getting old, so an unchanged queue is not rewritten.
    const fresh =
        persisted !== undefined && persisted.since === since && now - persisted.seenAt < leaseMs * WAITER_REFRESH_FRACTION
    const waiting = { ...others, [ownerId]: fresh ? persisted : { since, seenAt: now } }
    const first = oldestWaiter(waiting) === ownerId
    if (!held) return first ? grantTurn(turns, waiting, ownerId, now, leaseMs) : queued(turns, waiting, { since, seenAt: now })

    const observed =
        remembered?.observed?.ownerId === held.ownerId && remembered.observed.generation === held.generation
            ? remembered.observed
            : { ownerId: held.ownerId, generation: held.generation, at: now }
    // Without a recorded turn start, the turn is counted from when this window first saw the lease.
    const turnStart = held.grantedAt ?? observed.at
    const overdue = now >= turnStart + USAGE_SENDER_TURN_MS + USAGE_SENDER_TAKEOVER_GRACE_MS
    if (overdue && first) {
        const granted = grantTurn(turns, waiting, ownerId, now, leaseMs)
        return { ...granted, event: { kind: "took_over", generation: granted.grant.generation } }
    }
    return queued(turns, waiting, { since, seenAt: now, observed })
}

function grantTurn(
    turns: SenderTurns,
    waiting: SenderWaiting,
    ownerId: string,
    now: number,
    leaseMs: number,
): Extract<SenderClaimDecision, { kind: "granted" }> {
    const generation = turns.generation + 1
    const { [ownerId]: _self, ...rest } = waiting
    return {
        kind: "granted",
        turns: { generation, lease: { ownerId, generation, expiresAt: now + leaseMs, grantedAt: now }, waiting: rest },
        grant: { ownerId, generation },
    }
}

function queued(turns: SenderTurns, waiting: SenderWaiting, memory: SenderClaimMemory): SenderClaimDecision {
    return { kind: "waiting", turns: { ...turns, waiting }, memory }
}

/** Waiters that asked within the TTL. */
function liveWaiting(waiting: SenderWaiting, now: number, leaseMs: number): Record<string, SenderWaiter> {
    const ttl = WAITER_TTL_LEASES * leaseMs
    return Object.fromEntries(Object.entries(waiting).filter(([, waiter]) => now - waiter.seenAt <= ttl))
}

/** The waiter that started waiting first; ties go to the smaller owner ID so every window agrees. */
function oldestWaiter(waiting: SenderWaiting): string | undefined {
    let oldest: [string, SenderWaiter] | undefined
    for (const entry of Object.entries(waiting)) {
        if (!oldest || entry[1].since < oldest[1].since || (entry[1].since === oldest[1].since && entry[0] < oldest[0])) {
            oldest = entry
        }
    }
    return oldest?.[0]
}
