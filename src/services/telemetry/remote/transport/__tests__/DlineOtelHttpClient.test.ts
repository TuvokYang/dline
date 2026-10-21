import { mockFetchForTesting } from "@shared/net"
import { describe, expect, it } from "vitest"
import { classifyDeliveryResponse } from "../../contracts/classification"
import { DlineOtelHttpClient, DlineOtelTransportError, loopbackEndpointOverride } from "../DlineOtelHttpClient"

const TOKEN = "tok_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd"
const REQUEST_ID = "0b4f8a52-5d0e-4e55-9a0c-5a1f1e7c0a01"
/** Differs from the running build, so a user agent taken from anywhere but the option shows. */
const VERSION = "0.11.1-contract.7"

interface Captured {
    url: string
    init: RequestInit
}

function respondWith(response: () => Response, captured: Captured[] = []): typeof globalThis.fetch {
    return async (input, init) => {
        captured.push({ url: String(input), init: init ?? {} })
        return response()
    }
}

/** A fetch that only settles when its signal aborts, as a stalled connection would. */
const stalled: typeof globalThis.fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
    })

function failure(promise: Promise<unknown>): Promise<DlineOtelTransportError> {
    return promise.then(
        () => {
            throw new Error("expected the request to fail")
        },
        (error: unknown) => {
            if (!(error instanceof DlineOtelTransportError)) throw error
            return error
        },
    )
}

describe("DlineOtelHttpClient", () => {
    it("posts the exact usage bytes with the version's user agent, bearer, request ID and contract version and refuses to follow redirects", async () => {
        const captured: Captured[] = []
        const body = new TextEncoder().encode('{"schema_version":2}')
        const ok = () =>
            new Response(JSON.stringify({ ok: true, disposition: "duplicate", next_eligible_at: 5 }), {
                status: 200,
                headers: { "retry-after": "3" },
            })

        const response = await mockFetchForTesting(respondWith(ok, captured), () =>
            new DlineOtelHttpClient({ clientVersion: VERSION, endpoint: "https://otel.example.test" }).sendUsage({
                accessToken: TOKEN,
                requestId: REQUEST_ID,
                body,
            }),
        )

        expect(captured).toHaveLength(1)
        expect(captured[0].url).toBe("https://otel.example.test/usage")
        expect(captured[0].init).toMatchObject({ method: "POST", redirect: "error", body })
        expect(captured[0].init.headers).toEqual({
            "User-Agent": `Dline/${VERSION}`,
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
            "x-dline-request-id": REQUEST_ID,
            "x-dline-contract": "3",
        })
        expect(classifyDeliveryResponse(response)).toEqual({ kind: "acknowledged", disposition: "duplicate", nextEligibleAt: 5 })
        expect(response.retryAfter).toBe("3")
    })

    it("posts the device exchange as JSON to its own path", async () => {
        const captured: Captured[] = []
        const request = {
            device_secret: "s".repeat(43),
            requested_profile: "usage" as const,
            client_version: "0.11.0",
            platform: "win32",
        }

        await mockFetchForTesting(
            respondWith(() => new Response("{}", { status: 503 }), captured),
            () => new DlineOtelHttpClient({ clientVersion: VERSION, endpoint: "http://127.0.0.1:8787" }).exchange(request),
        )

        expect(captured[0].url).toBe("http://127.0.0.1:8787/auth/device/exchange")
        expect(new Headers(captured[0].init.headers).get("user-agent")).toBe(`Dline/${VERSION}`)
        expect(JSON.parse(String(captured[0].init.body))).toEqual(request)
    })

    it("reports an edge page that is not JSON so the classifier stops every profile", async () => {
        const blockPage = () => new Response("<html>Access denied</html>", { status: 403 })

        const response = await mockFetchForTesting(respondWith(blockPage), () =>
            new DlineOtelHttpClient({ clientVersion: VERSION }).sendUsage({
                accessToken: TOKEN,
                requestId: REQUEST_ID,
                body: new Uint8Array(),
            }),
        )

        expect(response.json).toBeUndefined()
        expect(classifyDeliveryResponse(response)).toMatchObject({ kind: "stop", scope: "all" })
    })

    it("does not parse a response larger than the service ever sends", async () => {
        const huge = () => new Response(JSON.stringify({ ok: true, disposition: "accepted", pad: "x".repeat(20_000) }))

        const response = await mockFetchForTesting(respondWith(huge), () =>
            new DlineOtelHttpClient({ clientVersion: VERSION }).sendUsage({
                accessToken: TOKEN,
                requestId: REQUEST_ID,
                body: new Uint8Array(),
            }),
        )

        expect(response.json).toBeUndefined()
        expect(classifyDeliveryResponse(response)).toEqual({ kind: "replay" })
    })

    it("turns a stalled request into a timeout and a caller abort into an abort", async () => {
        const client = new DlineOtelHttpClient({ clientVersion: VERSION, timeoutMs: 20 })
        const caller = new AbortController()

        const timedOut = await mockFetchForTesting(stalled, () =>
            failure(client.sendUsage({ accessToken: TOKEN, requestId: REQUEST_ID, body: new Uint8Array() })),
        )
        const aborted = await mockFetchForTesting(stalled, () => {
            const pending = failure(
                new DlineOtelHttpClient({ clientVersion: VERSION, timeoutMs: 60_000 }).sendUsage(
                    { accessToken: TOKEN, requestId: REQUEST_ID, body: new Uint8Array() },
                    caller.signal,
                ),
            )
            caller.abort()
            return pending
        })

        expect(timedOut.failure).toBe("timeout")
        expect(aborted.failure).toBe("aborted")
    })

    it("reports a network failure without the token, URL or cause text", async () => {
        const broken: typeof globalThis.fetch = async () => {
            throw new TypeError(`connect ECONNREFUSED https://otel.dline.cc Bearer ${TOKEN}`)
        }

        const error = await mockFetchForTesting(broken, () =>
            failure(
                new DlineOtelHttpClient({ clientVersion: VERSION }).sendUsage({
                    accessToken: TOKEN,
                    requestId: REQUEST_ID,
                    body: new Uint8Array(),
                }),
            ),
        )

        expect(error.failure).toBe("network")
        expect(error.message).not.toContain(TOKEN)
        expect(error.message).not.toContain("otel.dline.cc")
        expect(error.cause).toBeUndefined()
    })

    it("only accepts an HTTPS origin, or plain HTTP to loopback", () => {
        expect(() => new DlineOtelHttpClient({ clientVersion: VERSION, endpoint: "http://otel.dline.cc" })).toThrow()
        expect(() => new DlineOtelHttpClient({ clientVersion: VERSION, endpoint: "https://user:pw@otel.dline.cc" })).toThrow()
        expect(() => new DlineOtelHttpClient({ clientVersion: VERSION, endpoint: "http://localhost:8787" })).not.toThrow()
    })

    it("honours an environment override only when it names a loopback origin", () => {
        expect(loopbackEndpointOverride("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787")
        expect(loopbackEndpointOverride("https://localhost:8443")).toBe("https://localhost:8443")
        // A remote HTTPS host is a valid client endpoint but must not replace the service from the environment.
        expect(loopbackEndpointOverride("https://otel.example.test")).toBeUndefined()
        expect(loopbackEndpointOverride("http://127.0.0.1:8787/?redirect=x")).toBeUndefined()
        expect(loopbackEndpointOverride("not a url")).toBeUndefined()
        expect(loopbackEndpointOverride("")).toBeUndefined()
        expect(loopbackEndpointOverride(undefined)).toBeUndefined()
    })
})
