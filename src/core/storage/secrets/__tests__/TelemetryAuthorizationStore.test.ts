import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { TelemetryAuthorizationStore } from "../TelemetryAuthorizationStore"

/**
 * RTD-002 / AC-002 / AC-003.
 *
 * The pairing credential is a 256-bit one-time client pairing code that must:
 * - live in a dedicated 0o600 file store, never in general secrets or settings,
 * - be reused across reloads while consent stays enabled,
 * - be revoked when the user disables telemetry,
 * - never leak the raw code through the public status projection.
 */
describe("TelemetryAuthorizationStore", () => {
    let dataDir: string
    let store: TelemetryAuthorizationStore

    const credentialPath = () => path.join(dataDir, "secrets", "telemetry-authorization.json")

    beforeEach(() => {
        dataDir = mkdtempSync(path.join(tmpdir(), "dline-telemetry-auth-"))
        store = new TelemetryAuthorizationStore({ dataDir })
    })

    afterEach(() => {
        rmSync(dataDir, { recursive: true, force: true })
    })

    it("issues a 256-bit base64url pairing code on first enable", () => {
        const credential = store.ensurePairingCode()

        expect(credential.schemaVersion).toBe(1)
        expect(credential.state).toBe("unclaimed")
        expect(credential.createdAtMs).toBeGreaterThan(0)
        // base64url of 32 random bytes is 43 chars with no padding and no +/ characters.
        expect(credential.code).toMatch(/^[A-Za-z0-9_-]{43}$/)
    })

    it("reuses the existing unclaimed code across store instances", () => {
        const first = store.ensurePairingCode()

        const reopened = new TelemetryAuthorizationStore({ dataDir })
        const second = reopened.ensurePairingCode()

        expect(second.code).toBe(first.code)
        expect(second.createdAtMs).toBe(first.createdAtMs)
    })

    it("writes the credential file with owner-only permissions", () => {
        store.ensurePairingCode()

        expect(existsSync(credentialPath())).toBe(true)
        if (process.platform !== "win32") {
            expect(statSync(credentialPath()).mode & 0o777).toBe(0o600)
        }
    })

    it("revokes the unclaimed code and rotates on the next enable", () => {
        const first = store.ensurePairingCode()
        store.revokePairingCode()

        expect(store.peekPairingCode()).toBeUndefined()

        const second = store.ensurePairingCode()
        expect(second.code).not.toBe(first.code)
    })

    it("consumes the code exactly once", () => {
        const issued = store.ensurePairingCode()

        expect(store.consumePairingCode()).toBe(issued.code)
        expect(store.consumePairingCode()).toBeUndefined()
        expect(store.peekPairingCode()).toBeUndefined()
    })

    it("never exposes the raw code through the public status projection", () => {
        const issued = store.ensurePairingCode()

        const status = store.getStatus()

        expect(status.authorizationCodeConfigured).toBe(true)
        expect(status.createdAtMs).toBe(issued.createdAtMs)
        expect(status.fingerprint).toMatch(/^[0-9a-f]{12}$/)
        expect(JSON.stringify(status)).not.toContain(issued.code)
    })

    it("reports an unconfigured status when no code exists", () => {
        const status = store.getStatus()

        expect(status.authorizationCodeConfigured).toBe(false)
        expect(status.createdAtMs).toBeUndefined()
        expect(status.fingerprint).toBeUndefined()
    })

    it("produces a stable irreversible fingerprint for the same code", () => {
        store.ensurePairingCode()
        const first = store.getStatus().fingerprint

        const reopened = new TelemetryAuthorizationStore({ dataDir })
        expect(reopened.getStatus().fingerprint).toBe(first)
    })

    it("recovers from a corrupted credential file by issuing a fresh code", () => {
        store.ensurePairingCode()

        // Simulate a truncated / hand-edited file.
        const file = credentialPath()
        expect(readFileSync(file, "utf8").length).toBeGreaterThan(0)
        writeFileSync(file, "{not json", { mode: 0o600 })

        const recovered = new TelemetryAuthorizationStore({ dataDir })
        expect(recovered.peekPairingCode()).toBeUndefined()
        expect(recovered.ensurePairingCode().code).toMatch(/^[A-Za-z0-9_-]{43}$/)
    })
})
