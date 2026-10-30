import { readFileSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { mockFetchForTesting } from "@shared/net"
import { createReportBugDraft } from "@shared/report-bug"
import { Logger } from "@shared/services/Logger"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IssueCredentialRepository } from "@/core/storage/telemetry-remote/IssueCredentialRepository"
import { IssueGrantRepository } from "@/core/storage/telemetry-remote/IssueGrantRepository"
import { resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import { SupportAuthorizationError, SupportTelemetryService } from "./SupportTelemetryService"

const issue = vi.hoisted(() => ({ open: vi.fn(async (..._args: unknown[]) => undefined) }))
vi.mock("@core/reporting/ReportBugIssue", async () => {
    const actual = await vi.importActual<typeof import("@core/reporting/ReportBugIssue")>("@core/reporting/ReportBugIssue")
    return { ...actual, openReportBugIssue: issue.open }
})

const FIXTURES = path.join(__dirname, "..", "telemetry", "remote", "contracts", "__tests__", "fixtures")
const USAGE_FIXTURE = JSON.parse(readFileSync(path.join(FIXTURES, "usage-schema4-reference.json"), "utf8"))
const NOW = 1_900_000_000_000
const DEVICE_ID = "dev_0123456789abcdef0123456789abcdef"
const DEVICE_TOKEN = "t".repeat(43)
const AUTHORIZATION_CODE = "s".repeat(43)
// The fixture vector of telemetry-exchange-flow §5.1 for this authorization code.
const PUBLIC_CODE = "DLN-BNKP-5RJG-NE6R-Y290"

const draft = (consent = true) => ({
    ...createReportBugDraft(
        {
            title: "Provider failed",
            whatHappened: "The request failed.",
            stepsToReproduce: "Send the request.",
            apiRequestOutput: "safe output",
            additionalContext: "context",
        },
        { providerAndModel: "test / model", operatingSystem: "test", systemInfo: "test", dlineVersion: "1.2.3" },
        PUBLIC_CODE,
    ),
    temporaryTelemetryConsent: consent,
})

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function status(fields: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        ok: true,
        state: "approved",
        authorization_revision: 1,
        authorization_expires_at: NOW + 86_400_000,
        capture_expires_at: NOW + 60_000,
        ticket_expires_at: NOW + 90 * 86_400_000,
        issue_state: "open",
        resolution: { state: "investigating" },
        poll_after_ms: 300_000,
        ...fields,
    }
}

interface Call {
    readonly path: string
    readonly body: Record<string, unknown>
    readonly headers: Headers
}

/** In-memory OTel answering the four routes the client uses; each route's answer is replaceable per test. */
class FakeOtel {
    readonly calls: Call[] = []
    authorize: (body: Record<string, unknown>) => Response | Promise<Response> = (body) =>
        json(200, {
            ok: true,
            request_id: body.request_id,
            authorization_code: AUTHORIZATION_CODE,
            state: "awaiting_issue",
            authorization_expires_at: NOW + 86_400_000,
            ticket_expires_at: NOW + 90 * 86_400_000,
            poll_after_ms: 60_000,
        })
    status: () => Response = () =>
        json(200, status({ state: "awaiting_issue", authorization_revision: 0, capture_expires_at: undefined }))
    exchange: (body: Record<string, unknown>) => Response = (body) =>
        json(200, {
            ok: true,
            request_id: body.request_id,
            access_token: "i".repeat(43),
            profile: "issue_diagnostic",
            scopes: ["error", "runtime", "debug", "high_density_metrics", "high_density_traces"],
            authorization_id: "grant-1",
            authorization_revision: body.authorization_revision,
            expires_at: NOW + 60_000,
            capture_expires_at: NOW + 60_000,
            rate_limits: { authorization_requests: 120, authorization_bytes: 8_388_608, authorization_records: 20_000 },
        })

    readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input))
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
        this.calls.push({ path: url.pathname, body, headers: new Headers(init?.headers) })
        if (url.pathname === "/auth/device/grant") {
            return json(200, {
                ok: true,
                request_id: body.request_id,
                access_token: DEVICE_TOKEN,
                device_id: DEVICE_ID,
                profile: body.requested_profile,
                scopes: [body.requested_profile],
                expires_at: NOW + 3_600_000,
                usage_contract: USAGE_FIXTURE.device_grant.response.usage_contract,
            })
        }
        if (url.pathname === "/auth/report-authorizations") return this.authorize(body)
        if (url.pathname === "/auth/report-authorizations/status") return this.status()
        if (url.pathname === "/auth/exchange") return this.exchange(body)
        return json(404, {})
    }

    paths(): string[] {
        return this.calls.map((call) => call.path)
    }
}

describe("SupportTelemetryService", () => {
    let root: string
    let otel: FakeOtel
    const services: SupportTelemetryService[] = []

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-support-service-"))
        otel = new FakeOtel()
        issue.open.mockReset().mockResolvedValue(undefined)
    })

    afterEach(async () => {
        for (const service of services.splice(0)) service.dispose()
        vi.restoreAllMocks()
        await fs.rm(root, { recursive: true, force: true })
    })

    function service(clock = () => NOW): SupportTelemetryService {
        const created = new SupportTelemetryService({
            dataDir: path.join(root, "data"),
            clientVersion: "1.2.3",
            platform: "test",
            otelEndpoint: "http://127.0.0.1:8787",
            clock,
        })
        services.push(created)
        return created
    }

    const layout = () => resolveOtelStorageLayout(path.join(root, "data"))
    const run = <T>(operation: () => Promise<T>) => mockFetchForTesting(otel.fetch, operation)

    it("issues a ticket and returns only the derived public code without opening an Issue", async () => {
        const support = service()
        const publicCode = await run(() => support.issueAuthorization())

        expect(otel.paths()).toEqual(["/auth/device/grant", "/auth/report-authorizations"])
        const issuance = otel.calls[1]
        expect(issuance.headers.get("authorization")).toBe(`Bearer ${DEVICE_TOKEN}`)
        expect(issuance.headers.get("x-dline-request-id")).toBe(issuance.body.request_id)
        expect(issuance.body).toEqual({
            operation: "report.authorize",
            request_id: issuance.body.request_id,
            temporary_telemetry_consent: true,
            client_version: "1.2.3",
            platform: "test",
        })
        expect(issue.open).not.toHaveBeenCalled()
        expect(publicCode).toBe(PUBLIC_CODE)
        await expect(support.status()).resolves.toEqual({
            publicCode: PUBLIC_CODE,
            state: "awaiting_issue",
            authorizationExpiresAt: NOW + 86_400_000,
            issueState: "unlinked",
            resolution: { state: "none" },
        })
    })

    it("opens no Issue when OTel refuses to issue a ticket", async () => {
        otel.authorize = () => json(429, { ok: false, error: { code: "report_authorization_rate_limited" } })
        const support = service()

        await expect(run(() => support.issueAuthorization())).rejects.toMatchObject({
            code: "report_authorization_rate_limited",
        })
        expect(issue.open).not.toHaveBeenCalled()
        await expect(support.status()).resolves.toBeUndefined()
    })

    it("replays the same issuance identity after the response was lost", async () => {
        otel.authorize = () => Promise.reject(new Error("connection reset"))
        const support = service()
        await expect(run(() => support.issueAuthorization())).rejects.toBeInstanceOf(SupportAuthorizationError)
        const lost = otel.calls.find((call) => call.path === "/auth/report-authorizations")

        otel.authorize = new FakeOtel().authorize
        await expect(run(() => support.issueAuthorization())).resolves.toBe(PUBLIC_CODE)

        const issuances = otel.calls.filter((call) => call.path === "/auth/report-authorizations")
        expect(issuances).toHaveLength(2)
        expect(issuances[1].body.request_id).toBe(lost?.body.request_id)
        expect(issue.open).not.toHaveBeenCalled()
    })

    it("exchanges the approved revision once and keeps the ticket", async () => {
        const support = service()
        await run(() => support.issueAuthorization())
        otel.status = () => json(200, status())

        const approved = await run(() => support.checkNow())
        await run(() => support.checkNow())

        const exchanges = otel.calls.filter((call) => call.path === "/auth/exchange")
        expect(exchanges).toHaveLength(1)
        expect(exchanges[0].body).toMatchObject({ authorization_code: AUTHORIZATION_CODE, authorization_revision: 1 })
        expect(approved).toMatchObject({ state: "approved", issueState: "open", captureExpiresAt: NOW + 60_000 })
        await expect(new IssueGrantRepository(layout(), { clock: () => NOW }).readActive(NOW, 1)).resolves.not.toBeNull()
    })

    it("seals capture on a revoked status but keeps the ticket for its resolution", async () => {
        const support = service()
        await run(() => support.issueAuthorization())
        otel.status = () => json(200, status())
        await run(() => support.checkNow())
        otel.status = () =>
            json(
                200,
                status({
                    state: "revoked",
                    authorization_revision: 2,
                    capture_expires_at: undefined,
                    issue_state: "closed",
                    resolution: { state: "fixed", fixed_in_version: "0.12.1" },
                }),
            )

        await run(() => support.checkNow())

        await expect(new IssueGrantRepository(layout(), { clock: () => NOW }).readActive(NOW, 1)).resolves.toBeNull()
        await expect(support.status()).resolves.toMatchObject({
            state: "revoked",
            issueState: "closed",
            resolution: { state: "fixed", fixedInVersion: "0.12.1" },
        })
    })

    it("deletes the ticket locally when OTel no longer knows the authorization code", async () => {
        const support = service()
        await run(() => support.issueAuthorization())
        otel.status = () => json(404, { ok: false, error: { code: "report_authorization_not_found" } })

        await expect(run(() => support.checkNow())).resolves.toBeUndefined()
        await expect(fs.access(layout().issueCredentialPath)).rejects.toMatchObject({ code: "ENOENT" })
    })

    it("keeps the ticket on a 404 that does not carry the contract code", async () => {
        const support = service()
        await run(() => support.issueAuthorization())
        otel.status = () => json(404, {})

        await expect(run(() => support.checkNow())).rejects.toThrow("unavailable")
        await expect(support.status()).resolves.toMatchObject({ publicCode: PUBLIC_CODE })
    })

    it("never projects an Issue identity even when the response carries one", async () => {
        const support = service()
        await run(() => support.issueAuthorization())
        otel.status = () => json(200, status({ issue: { owner: "TuvokYang", repo: "dline", number: 123 }, issue_url: "x" }))

        const projected = await run(() => support.checkNow())

        expect(Object.keys(projected ?? {}).sort()).toEqual(
            ["authorizationExpiresAt", "captureExpiresAt", "issueState", "publicCode", "resolution", "state"].sort(),
        )
    })

    it("deletes and revokes locally without any request leaving the machine", async () => {
        const support = service()
        await run(() => support.issueAuthorization())
        otel.status = () => json(200, status())
        await run(() => support.checkNow())
        const before = otel.calls.length

        await run(() => support.deleteAndRevoke())

        expect(otel.calls).toHaveLength(before)
        await expect(support.status()).resolves.toBeUndefined()
        await expect(new IssueGrantRepository(layout(), { clock: () => NOW }).readActive(NOW, 1)).resolves.toBeNull()
    })

    it("opens the already issued public code without issuing another ticket", async () => {
        const support = service()
        await run(() => support.issueAuthorization())
        const before = otel.paths()

        await run(() => support.openAuthorizedIssue(draft()))

        expect(otel.paths()).toEqual(before)
        expect(issue.open.mock.calls).toEqual([[draft().content, draft().environment, { supportCode: PUBLIC_CODE }]])
    })

    it("opens the ordinary form without consent and without contacting OTel", async () => {
        const support = service()

        await run(() => support.openAuthorizedIssue(draft(false)))

        expect(otel.calls).toEqual([])
        expect(issue.open.mock.calls).toEqual([[draft().content, draft().environment]])
    })

    it("opens the ordinary form when the preview ticket is no longer stored", async () => {
        const support = service()
        const error = vi.spyOn(Logger, "error").mockImplementation(() => undefined)

        await run(() => support.openAuthorizedIssue(draft()))

        expect(otel.calls).toEqual([])
        expect(issue.open.mock.calls).toEqual([[draft().content, draft().environment]])
        expect(error).toHaveBeenCalledOnce()
    })

    it("opens the ordinary form and deletes an expired ticket without reissuing", async () => {
        let now = NOW
        const support = service(() => now)
        const error = vi.spyOn(Logger, "error").mockImplementation(() => undefined)
        await run(() => support.issueAuthorization())
        const before = otel.paths()
        now += 91 * 86_400_000

        await run(() => support.openAuthorizedIssue(draft()))

        expect(otel.paths()).toEqual(before)
        expect(issue.open.mock.calls).toEqual([[draft().content, draft().environment]])
        expect(error).toHaveBeenCalledOnce()
        await expect(support.status()).resolves.toBeUndefined()
    })

    it.each([
        86_400_000, 86_400_001,
    ])("does not reuse an expired authorization at offset %s but retains its ticket", async (offset) => {
        let now = NOW
        const support = service(() => now)
        const error = vi.spyOn(Logger, "error").mockImplementation(() => undefined)
        await run(() => support.issueAuthorization())
        const before = otel.paths()
        now += offset

        await run(() => support.openAuthorizedIssue(draft()))

        expect(otel.paths()).toEqual(before)
        expect(issue.open.mock.calls).toEqual([[draft().content, draft().environment]])
        expect(error).toHaveBeenCalledOnce()
        await expect(support.status()).resolves.toMatchObject({ publicCode: PUBLIC_CODE })
    })

    it.each([
        "pending_approval",
        "approved",
        "revoked",
        "expired",
    ])("does not reuse a %s ticket for a new Issue", async (state) => {
        const support = service()
        const error = vi.spyOn(Logger, "error").mockImplementation(() => undefined)
        await run(() => support.issueAuthorization())
        otel.status = () => json(200, status({ state }))
        await run(() => support.checkNow())
        const before = otel.paths()

        await run(() => support.openAuthorizedIssue(draft()))

        expect(otel.paths()).toEqual(before)
        expect(issue.open.mock.calls).toEqual([[draft().content, draft().environment]])
        expect(error).toHaveBeenCalledOnce()
        await expect(support.status()).resolves.toMatchObject({ state, publicCode: PUBLIC_CODE })
    })

    it("opens an ordinary Issue if local credential reading fails", async () => {
        const support = service()
        await run(() => support.issueAuthorization())
        const error = new Error("credential read failed")
        const log = vi.spyOn(Logger, "error").mockImplementation(() => undefined)
        vi.spyOn(IssueCredentialRepository.prototype, "read").mockRejectedValueOnce(error)
        const before = otel.paths()

        await run(() => support.openAuthorizedIssue(draft()))

        expect(otel.paths()).toEqual(before)
        expect(issue.open.mock.calls).toEqual([[draft().content, draft().environment]])
        expect(log).toHaveBeenCalledWith(expect.any(String), error)
    })

    it("opens an ordinary Issue if expired-ticket cleanup fails", async () => {
        let now = NOW
        const support = service(() => now)
        await run(() => support.issueAuthorization())
        const error = new Error("credential cleanup failed")
        const log = vi.spyOn(Logger, "error").mockImplementation(() => undefined)
        vi.spyOn(IssueCredentialRepository.prototype, "clear").mockRejectedValueOnce(error)
        const before = otel.paths()
        now += 91 * 86_400_000

        await run(() => support.openAuthorizedIssue(draft()))

        expect(otel.paths()).toEqual(before)
        expect(issue.open.mock.calls).toEqual([[draft().content, draft().environment]])
        expect(log).toHaveBeenCalledWith(expect.any(String), error)
    })

    it("does not retry a browser-opening failure as an ordinary Issue", async () => {
        const support = service()
        await run(() => support.issueAuthorization())
        const error = new Error("browser unavailable")
        issue.open.mockRejectedValueOnce(error)
        const before = otel.paths()

        await expect(run(() => support.openAuthorizedIssue(draft()))).rejects.toBe(error)

        expect(issue.open).toHaveBeenCalledOnce()
        expect(otel.paths()).toEqual(before)
    })

    it("discards a matching ticket after restart without any server revoke request", async () => {
        const support = service()
        await run(() => support.issueAuthorization())
        const before = otel.paths()

        const restarted = service()
        await run(() => restarted.discardAuthorization(PUBLIC_CODE))

        expect(otel.paths()).toEqual(before)
        await expect(support.status()).resolves.toBeUndefined()
        expect(issue.open).not.toHaveBeenCalled()
    })

    it("does not submit or discard a newer ticket from an older preview", async () => {
        const support = service()
        const error = vi.spyOn(Logger, "error").mockImplementation(() => undefined)
        await run(() => support.issueAuthorization())
        otel.authorize = (body) =>
            json(200, {
                ok: true,
                request_id: body.request_id,
                authorization_code: "n".repeat(43),
                state: "awaiting_issue",
                authorization_expires_at: NOW + 86_400_000,
                ticket_expires_at: NOW + 90 * 86_400_000,
                poll_after_ms: 60_000,
            })
        const newerCode = await run(() => support.issueAuthorization())
        const before = otel.paths()

        await run(() => support.openAuthorizedIssue(draft()))
        await run(() => support.discardAuthorization(PUBLIC_CODE))

        expect(otel.paths()).toEqual(before)
        expect(issue.open.mock.calls).toEqual([[draft().content, draft().environment]])
        expect(error).toHaveBeenCalledOnce()
        expect(newerCode).not.toBe(PUBLIC_CODE)
        await expect(support.status()).resolves.toMatchObject({ publicCode: newerCode })
    })
})
