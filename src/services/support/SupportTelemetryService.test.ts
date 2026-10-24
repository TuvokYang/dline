import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { mockFetchForTesting } from "@shared/net"
import { createReportBugDraft } from "@shared/report-bug"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import { SupportOperationRepository } from "@/core/storage/telemetry-remote/SupportOperationRepository"
import { SupportTelemetryService } from "./SupportTelemetryService"

const issue = vi.hoisted(() => ({ open: vi.fn(async () => undefined) }))
vi.mock("@core/reporting/ReportBugIssue", async () => {
    const actual = await vi.importActual<typeof import("@core/reporting/ReportBugIssue")>("@core/reporting/ReportBugIssue")
    return { ...actual, openReportBugIssue: issue.open }
})

const NOW = 1_900_000_000_000
const draft = (consent = true) =>
    createReportBugDraft(
        {
            title: "Provider failed",
            whatHappened: "The request failed.",
            stepsToReproduce: "Send the request.",
            apiRequestOutput: "safe output",
            additionalContext: "context",
        },
        { providerAndModel: "test / model", operatingSystem: "test", systemInfo: "test", dlineVersion: "1.2.3" },
        consent,
    )

function authorization(requestId: string, state = "pending_approval") {
    return {
        request_id: requestId,
        authorization_id: "authorization-1",
        public_code: "SUP-ABCD-1234",
        resume_credential: "private-resume-credential",
        state,
        revision: 2,
        authorization_expires_at: NOW + 60_000,
        poll_after_ms: 60_000,
        issue: { owner: "TuvokYang", repo: "Dline", number: 115 },
    }
}

function requestId(init?: RequestInit): string {
    return new Headers(init?.headers).get("x-dline-request-id") ?? ""
}

describe("SupportTelemetryService", () => {
    let root: string

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-support-service-"))
        issue.open.mockClear()
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    function service(clock: () => number = () => NOW) {
        return new SupportTelemetryService({
            dataDir: path.join(root, "data"),
            clientVersion: "1.2.3",
            platform: "test",
            clock,
        })
    }

    it("creates authorization before opening the public-code issue and projects no private material", async () => {
        const order: string[] = []
        issue.open.mockImplementationOnce(async () => {
            order.push("issue")
        })
        const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            order.push("authorization")
            expect(new URL(String(input)).pathname).toBe("/support/authorizations")
            return new Response(JSON.stringify(authorization(requestId(init))), { status: 201 })
        })
        const support = service()

        const projected = await mockFetchForTesting(transport, () => support.createAuthorizationAndOpenIssue(draft()))

        expect(order).toEqual(["authorization", "issue"])
        expect(projected).toEqual({
            publicCode: "SUP-ABCD-1234",
            state: "pending_approval",
            authorizationExpiresAt: NOW + 60_000,
            issue: { owner: "TuvokYang", repo: "Dline", number: 115 },
        })
        expect(JSON.stringify(projected)).not.toContain("private-resume-credential")
        expect(issue.open).toHaveBeenCalledWith(
            expect.objectContaining({ additionalContext: expect.stringContaining("Public support code: SUP-ABCD-1234") }),
            draft().environment,
        )
        await mockFetchForTesting(
            async (_input, init) => new Response(JSON.stringify({ request_id: requestId(init) }), { status: 200 }),
            () => support.deleteAndRevoke(),
        )
    })

    it("checks status with owner-only resume material but returns only the safe projection", async () => {
        const support = service()
        await mockFetchForTesting(
            async (_input, init) => new Response(JSON.stringify(authorization(requestId(init))), { status: 201 }),
            () => support.createAuthorizationAndOpenIssue(draft()),
        )
        const captured: Array<Record<string, unknown>> = []
        const projected = await mockFetchForTesting(
            async (_input, init) => {
                captured.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
                return new Response(
                    JSON.stringify({ ...authorization(requestId(init)), state: "pending_approval", revision: 3 }),
                    { status: 200 },
                )
            },
            () => support.checkNow(),
        )

        expect(captured[0]).toMatchObject({
            authorization_id: "authorization-1",
            resume_credential: "private-resume-credential",
        })
        expect(JSON.stringify(projected)).not.toContain("private-resume-credential")
        await mockFetchForTesting(
            async (_input, init) => new Response(JSON.stringify({ request_id: requestId(init) }), { status: 200 }),
            () => support.deleteAndRevoke(),
        )
    })

    it("keeps the owner-only revoke tombstone when offline", async () => {
        const support = service()
        await mockFetchForTesting(
            async (_input, init) => new Response(JSON.stringify(authorization(requestId(init))), { status: 201 }),
            () => support.createAuthorizationAndOpenIssue(draft()),
        )

        await mockFetchForTesting(
            async () => Promise.reject(new Error("offline")),
            () => support.deleteAndRevoke(),
        )

        const layout = resolveOtelStorageLayout(path.join(root, "data"))
        const raw = await fs.readFile(layout.issueCredentialPath, "utf8")
        expect(raw).toContain('"revoke_tombstone"')
        expect(raw).toContain("private-resume-credential")
        expect(raw).not.toContain('"record"')
        await expect(
            mockFetchForTesting(
                async () => Promise.reject(new Error("still offline")),
                () => support.status(),
            ),
        ).resolves.toBeUndefined()
        await mockFetchForTesting(
            async (_input, init) => new Response(JSON.stringify({ request_id: requestId(init) }), { status: 200 }),
            () => support.resumePendingRevoke(),
        )
        await expect(fs.access(layout.issueCredentialPath)).rejects.toMatchObject({ code: "ENOENT" })
        await expect(fs.access(layout.supportOperationPath)).rejects.toMatchObject({ code: "ENOENT" })
    })

    it("clears an offline revoke operation at natural expiry without another request", async () => {
        let now = NOW
        const support = service(() => now)
        await mockFetchForTesting(
            async (_input, init) => new Response(JSON.stringify(authorization(requestId(init))), { status: 201 }),
            () => support.createAuthorizationAndOpenIssue(draft()),
        )
        await mockFetchForTesting(
            async () => Promise.reject(new Error("offline")),
            () => support.deleteAndRevoke(),
        )
        now = NOW + 60_000
        const transport = vi.fn(async () => Promise.reject(new Error("expired revoke must not use network")))

        await mockFetchForTesting(transport, () => service(() => now).resumePendingRevoke())

        expect(transport).not.toHaveBeenCalled()
        const layout = resolveOtelStorageLayout(path.join(root, "data"))
        await expect(fs.access(layout.issueCredentialPath)).rejects.toMatchObject({ code: "ENOENT" })
        await expect(fs.access(layout.supportOperationPath)).rejects.toMatchObject({ code: "ENOENT" })
    })

    it("replays an unknown create outcome with the exact request id and body", async () => {
        const attempts: Array<{ requestId: string; body: string }> = []
        const capture = (init?: RequestInit) => {
            attempts.push({ requestId: requestId(init), body: String(init?.body) })
        }

        await expect(
            mockFetchForTesting(
                async (_input, init) => {
                    capture(init)
                    throw new Error("response lost")
                },
                () => service().createAuthorizationAndOpenIssue(draft()),
            ),
        ).rejects.toThrow("response lost")

        const recovered = await mockFetchForTesting(
            async (_input, init) => {
                capture(init)
                return new Response(JSON.stringify(authorization(requestId(init))), { status: 201 })
            },
            () => service().createAuthorizationAndOpenIssue(draft()),
        )

        expect(attempts).toHaveLength(2)
        expect(attempts[1]).toEqual(attempts[0])
        expect(recovered.publicCode).toBe("SUP-ABCD-1234")
        expect(issue.open).toHaveBeenCalledTimes(1)
    })

    it("finishes a stored create response without issuing another network request", async () => {
        const support = service()
        await expect(
            mockFetchForTesting(
                async () => Promise.reject(new Error("response lost")),
                () => support.createAuthorizationAndOpenIssue(draft()),
            ),
        ).rejects.toThrow("response lost")

        const layout = resolveOtelStorageLayout(path.join(root, "data"))
        const operations = new SupportOperationRepository(layout)
        const pending = await operations.read()
        expect(pending?.kind).toBe("create")
        await operations.storeResponse(pending!.requestId, {
            status: 201,
            json: authorization(pending!.requestId),
        })
        const transport = vi.fn(async () => Promise.reject(new Error("network must not be used")))

        const recovered = await mockFetchForTesting(transport, () => service().createAuthorizationAndOpenIssue(draft()))

        expect(recovered.publicCode).toBe("SUP-ABCD-1234")
        expect(transport).not.toHaveBeenCalled()
        await expect(operations.read()).resolves.toBeUndefined()
    })

    it("replays unknown status and revoke outcomes with their original request identities", async () => {
        const support = service()
        await mockFetchForTesting(
            async (_input, init) => new Response(JSON.stringify(authorization(requestId(init))), { status: 201 }),
            () => support.createAuthorizationAndOpenIssue(draft()),
        )

        const statusAttempts: Array<{ requestId: string; body: string }> = []
        await expect(
            mockFetchForTesting(
                async (_input, init) => {
                    statusAttempts.push({ requestId: requestId(init), body: String(init?.body) })
                    throw new Error("status response lost")
                },
                () => support.checkNow(),
            ),
        ).rejects.toThrow("status response lost")
        await mockFetchForTesting(
            async (_input, init) => {
                statusAttempts.push({ requestId: requestId(init), body: String(init?.body) })
                return new Response(JSON.stringify({ ...authorization(requestId(init)), revision: 3 }), { status: 200 })
            },
            () => service().checkNow(),
        )
        expect(statusAttempts[1]).toEqual(statusAttempts[0])

        const revokeAttempts: Array<{ requestId: string; body: string }> = []
        await mockFetchForTesting(
            async (_input, init) => {
                revokeAttempts.push({ requestId: requestId(init), body: String(init?.body) })
                throw new Error("revoke response lost")
            },
            () => support.deleteAndRevoke(),
        )
        await mockFetchForTesting(
            async (_input, init) => {
                revokeAttempts.push({ requestId: requestId(init), body: String(init?.body) })
                return new Response(JSON.stringify({ request_id: requestId(init) }), { status: 200 })
            },
            () => service().resumePendingRevoke(),
        )
        expect(revokeAttempts[1]).toEqual(revokeAttempts[0])
    })
})
