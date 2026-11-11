import { describe, expect, it, vi } from "vitest"
import type { AtomicIssueGrant } from "../../contracts/issueGrant"
import { DlineOtelTransportError } from "../../transport/DlineOtelHttpClient"
import { IssueDiagnosticDeliveryWorker } from "../IssueDiagnosticDeliveryWorker"

const GRANT: AtomicIssueGrant = {
    accessToken: "a".repeat(43),
    profile: "issue_diagnostic",
    scopes: ["debug"],
    authorizationId: "authorization-1",
    authorizationRevision: 2,
    expiresAt: Date.now() + 60_000,
    captureExpiresAt: Date.now() + 60_000,
    rateLimits: { maxBytes: 1024, maxRequests: 10, maxRecords: 10 },
}
const BATCH = { requestId: "request-1", stream: "logs" as const, body: "queued-body" }

function setup(activeGrant: () => AtomicIssueGrant | undefined = () => GRANT) {
    const outbox = { claim: vi.fn(async () => BATCH), settle: vi.fn(), clear: vi.fn() }
    const transport = { sendIssueDiagnostics: vi.fn(async () => ({ status: 200, json: { ok: true }, retryAfter: null })) }
    const worker = new IssueDiagnosticDeliveryWorker({
        outbox,
        transport,
        activeGrant,
        owner: "owner",
        seal: vi.fn(),
    })
    return { worker, outbox, transport }
}

describe("issue diagnostics cancellation boundaries", () => {
    it("does no disk or network work for an already cancelled delivery", async () => {
        const { worker, outbox, transport } = setup()
        await worker.deliverOnce(AbortSignal.abort())
        expect(outbox.claim).not.toHaveBeenCalled()
        expect(transport.sendIssueDiagnostics).not.toHaveBeenCalled()
        expect(outbox.settle).not.toHaveBeenCalled()
    })

    it("does not send or write a replay when cancellation arrives during claim", async () => {
        const { worker, outbox, transport } = setup()
        const abort = new AbortController()
        outbox.claim.mockImplementationOnce(async () => {
            abort.abort()
            return BATCH
        })
        await worker.deliverOnce(abort.signal)
        expect(transport.sendIssueDiagnostics).not.toHaveBeenCalled()
        expect(outbox.settle).not.toHaveBeenCalled()
    })

    it("does not rebuild a purged partition after transport cancellation", async () => {
        const { worker, outbox, transport } = setup()
        transport.sendIssueDiagnostics.mockRejectedValueOnce(new DlineOtelTransportError("aborted"))
        await worker.deliverOnce()
        expect(outbox.settle).not.toHaveBeenCalled()
    })

    it("acknowledges a delivery when refreshing rehydrates the same grant", async () => {
        const { worker, outbox, transport } = setup(() => ({ ...GRANT }))
        await worker.deliverOnce()
        expect(transport.sendIssueDiagnostics).toHaveBeenCalledTimes(1)
        expect(outbox.settle).toHaveBeenCalledWith("owner", BATCH.requestId, { kind: "acknowledged" }, expect.any(Number), GRANT)
    })

    it("does not send a claim belonging to a replaced grant", async () => {
        let active = GRANT
        const { worker, outbox, transport } = setup(() => active)
        outbox.claim.mockImplementationOnce(async () => {
            active = { ...GRANT, authorizationRevision: 3 }
            return BATCH
        })
        await worker.deliverOnce()
        expect(transport.sendIssueDiagnostics).not.toHaveBeenCalled()
        expect(outbox.settle).not.toHaveBeenCalled()
    })

    it("does not settle a delivery after its grant is removed", async () => {
        let active: AtomicIssueGrant | undefined = GRANT
        const { worker, outbox, transport } = setup(() => active)
        transport.sendIssueDiagnostics.mockImplementationOnce(async () => {
            active = undefined
            return { status: 200, json: { ok: true }, retryAfter: null }
        })
        await worker.deliverOnce()
        expect(transport.sendIssueDiagnostics).toHaveBeenCalledTimes(1)
        expect(outbox.settle).not.toHaveBeenCalled()
    })

    it("still retains the exact claimed request for an ordinary network failure", async () => {
        const { worker, outbox, transport } = setup()
        transport.sendIssueDiagnostics.mockRejectedValueOnce(new Error("connection reset"))
        await worker.deliverOnce()
        expect(outbox.settle).toHaveBeenCalledWith("owner", BATCH.requestId, { kind: "replay" }, expect.any(Number), GRANT)
    })
})
