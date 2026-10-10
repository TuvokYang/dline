import { describe, expect, it } from "vitest"
import { PairingAuthorization, PairingRejection } from "../pairing-authorization"

/**
 * The pairing code is what lets an external collector claim this session's
 * telemetry. These tests pin the properties that make it safe to display in a
 * settings panel: it is single-use, it expires, and a rejected attempt says
 * why without revealing the expected value.
 */

function createAuthorization(overrides: Partial<ConstructorParameters<typeof PairingAuthorization>[0]> = {}) {
    let now = 1_700_000_000_000
    const authorization = new PairingAuthorization({
        ttlMs: 60_000,
        now: () => now,
        ...overrides,
    })
    return { authorization, advance: (ms: number) => (now += ms) }
}

describe("PairingAuthorization issuance", () => {
    it("issues a code that can be shown to the user", () => {
        const { authorization } = createAuthorization()

        const issued = authorization.issue()

        expect(issued.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
        expect(issued.expiresAt).toBeGreaterThan(issued.issuedAt)
    })

    it("replaces a previous unredeemed code so only one is ever valid", () => {
        const { authorization } = createAuthorization()

        const first = authorization.issue()
        const second = authorization.issue()

        expect(authorization.redeem(first.code)).toBe(PairingRejection.Unknown)
        expect(authorization.redeem(second.code)).toBeUndefined()
    })

    it("does not expose the active code through its status", () => {
        const { authorization } = createAuthorization()
        const issued = authorization.issue()

        const status = JSON.stringify(authorization.status)

        expect(status).not.toContain(issued.code)
        expect(authorization.status.hasPendingCode).toBe(true)
    })
})

describe("PairingAuthorization redemption", () => {
    it("accepts the issued code exactly once", () => {
        const { authorization } = createAuthorization()
        const issued = authorization.issue()

        expect(authorization.redeem(issued.code)).toBeUndefined()
        expect(authorization.redeem(issued.code)).toBe(PairingRejection.AlreadyRedeemed)
    })

    it("rejects a code after its lifetime elapses", () => {
        const { authorization, advance } = createAuthorization({ ttlMs: 1_000 })
        const issued = authorization.issue()

        advance(1_001)

        expect(authorization.redeem(issued.code)).toBe(PairingRejection.Expired)
    })

    it("rejects an unknown code", () => {
        const { authorization } = createAuthorization()
        authorization.issue()

        expect(authorization.redeem("AAAA-BBBB")).toBe(PairingRejection.Unknown)
    })

    it("rejects every attempt when no code was issued", () => {
        const { authorization } = createAuthorization()

        expect(authorization.redeem("AAAA-BBBB")).toBe(PairingRejection.Unknown)
    })

    it("ignores case and surrounding whitespace when the user retypes the code", () => {
        const { authorization } = createAuthorization()
        const issued = authorization.issue()

        expect(authorization.redeem(`  ${issued.code.toLowerCase()} `)).toBeUndefined()
    })

    it("reports the redeemed state so a collector can be shown as paired", () => {
        const { authorization } = createAuthorization()
        const issued = authorization.issue()

        authorization.redeem(issued.code)

        expect(authorization.status.hasPendingCode).toBe(false)
        expect(authorization.status.pairedAt).toBeDefined()
    })

    it("drops the pairing when revoked", () => {
        const { authorization } = createAuthorization()
        const issued = authorization.issue()
        authorization.redeem(issued.code)

        authorization.revoke()

        expect(authorization.status.pairedAt).toBeUndefined()
        expect(authorization.redeem(issued.code)).toBe(PairingRejection.Unknown)
    })
})
