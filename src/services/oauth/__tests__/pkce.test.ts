import { describe, expect, it } from "vitest"
import { createOAuthState, createPkceChallenge, createPkceVerifier } from "../pkce"

describe("OAuth PKCE helpers", () => {
    it("creates URL-safe verifier, challenge, and state values", () => {
        const verifier = createPkceVerifier()
        const challenge = createPkceChallenge(verifier)
        const state = createOAuthState()

        expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/)
        expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    })

    it("creates a deterministic S256 challenge", () => {
        expect(createPkceChallenge("dline-oauth-verifier")).toBe("S0ZzATvmRLdf0c-L4RliySwRERPI38p3sV2b0hCux1o")
    })
})
