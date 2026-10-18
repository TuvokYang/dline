import { mockFetchForTesting } from "@shared/net"
import { describe, expect, it } from "vitest"
import { ExtensionRegistryInfo } from "@/registry"
import {
    FeatureFlagsFetchError,
    FeatureFlagsHttpSource,
    type FeatureFlagsHttpSourceOptions,
    loopbackFeaturesEndpointOverride,
} from "../remote/FeatureFlagsHttpSource"
import { MAX_FEATURE_FLAGS_TTL_SECONDS, MIN_FEATURE_FLAGS_TTL_SECONDS, parseFeatureFlagsDocument } from "../remote/flagsDocument"

const QUERY = { version: "0.11.0", platform: "win32", flags: ["account"] }

function createSource(options: Partial<FeatureFlagsHttpSourceOptions> = {}): FeatureFlagsHttpSource {
    return new FeatureFlagsHttpSource({ query: QUERY, deviceId: async () => "dev_device-1", ...options })
}

interface CapturedRequest {
    readonly url: string
    readonly init: RequestInit | undefined
}

function respondWith(status: number, body: unknown, captured: CapturedRequest[] = []): typeof globalThis.fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        captured.push({ url: String(input), init })
        return new Response(typeof body === "string" ? body : JSON.stringify(body), { status })
    }) as typeof globalThis.fetch
}

describe("FeatureFlagsHttpSource", () => {
    it("names the device by its issued id in the body and sends no credential", async () => {
        const captured: CapturedRequest[] = []
        const source = createSource()

        const document = await mockFetchForTesting(
            respondWith(200, { schema_version: 1, flags: { account: true }, ttl_seconds: 600 }, captured),
            () => source.fetchFlags(),
        )

        expect(document).toEqual({ flags: { account: true }, ttlSeconds: 600 })
        expect(captured).toHaveLength(1)
        expect(captured[0].url).toBe("https://dev.dline.cc/v1/features")
        expect(captured[0].init).toMatchObject({ method: "POST", redirect: "error" })
        expect(new Headers(captured[0].init?.headers).has("authorization")).toBe(false)
        expect(new Headers(captured[0].init?.headers).get("user-agent")).toBe(`Dline/${ExtensionRegistryInfo.version}`)
        expect(JSON.parse(String(captured[0].init?.body))).toEqual({
            schema_version: 1,
            device_id: "dev_device-1",
            version: "0.11.0",
            platform: "win32",
            flags: ["account"],
        })
    })

    it("sends nothing while the device has no issued id", async () => {
        const captured: CapturedRequest[] = []
        const source = createSource({ deviceId: async () => undefined })

        const failure = await mockFetchForTesting(respondWith(200, { schema_version: 1, flags: {} }, captured), () =>
            source.fetchFlags().catch((error: unknown) => error),
        )

        expect(failure).toMatchObject({ failure: "no_device" })
        expect(captured).toHaveLength(0)
    })

    it("turns a failed id acquisition into no_device without passing its message on", async () => {
        const captured: CapturedRequest[] = []
        const source = createSource({
            deviceId: async () => {
                throw new Error("exchange failed for secret-material")
            },
        })

        const failure = await mockFetchForTesting(respondWith(200, { schema_version: 1, flags: {} }, captured), () =>
            source.fetchFlags().catch((error: unknown) => error),
        )

        expect(failure).toBeInstanceOf(FeatureFlagsFetchError)
        expect(failure).toMatchObject({ failure: "no_device" })
        expect((failure as Error).message.includes("secret-material")).toBe(false)
        expect(captured).toHaveLength(0)
    })

    it("reports a non-2xx answer by status without parsing it", async () => {
        const source = createSource()

        const failure = await mockFetchForTesting(respondWith(503, { schema_version: 1, flags: { account: true } }), () =>
            source.fetchFlags().catch((error: unknown) => error),
        )

        expect(failure).toBeInstanceOf(FeatureFlagsFetchError)
        expect(failure).toMatchObject({ failure: "status", status: 503 })
    })

    it("rejects a body that is not a flags document", async () => {
        const source = createSource()

        const failure = await mockFetchForTesting(respondWith(200, "<html>captive portal</html>"), () =>
            source.fetchFlags().catch((error: unknown) => error),
        )

        expect(failure).toMatchObject({ failure: "invalid_document" })
    })

    it("refuses an endpoint that is neither HTTPS nor loopback", () => {
        expect(() => createSource({ endpoint: "http://dev.dline.cc" })).toThrow()
        expect(() => createSource({ endpoint: "https://dev.dline.cc/path" })).toThrow()
        expect(() => createSource({ endpoint: "http://127.0.0.1:8788" })).not.toThrow()
    })
})

describe("loopbackFeaturesEndpointOverride", () => {
    it("honours only a loopback origin", () => {
        expect(loopbackFeaturesEndpointOverride("http://localhost:8788")).toBe("http://localhost:8788")
        expect(loopbackFeaturesEndpointOverride("https://features.example.test")).toBeUndefined()
        expect(loopbackFeaturesEndpointOverride(undefined)).toBeUndefined()
    })
})

describe("parseFeatureFlagsDocument", () => {
    it("rejects an unknown schema version", () => {
        expect(parseFeatureFlagsDocument({ schema_version: 2, flags: { account: true } })).toBeUndefined()
    })

    it("drops answers that are not booleans rather than coercing them", () => {
        expect(parseFeatureFlagsDocument({ schema_version: 1, flags: { account: "true", other: false } })?.flags).toEqual({
            other: false,
        })
    })

    it("bounds the refresh interval", () => {
        expect(parseFeatureFlagsDocument({ schema_version: 1, flags: {}, ttl_seconds: 1 })?.ttlSeconds).toBe(
            MIN_FEATURE_FLAGS_TTL_SECONDS,
        )
        expect(parseFeatureFlagsDocument({ schema_version: 1, flags: {}, ttl_seconds: 10_000_000 })?.ttlSeconds).toBe(
            MAX_FEATURE_FLAGS_TTL_SECONDS,
        )
    })
})
