import { mockFetchForTesting } from "@shared/net"
import { describe, expect, it } from "vitest"
import {
    FeatureFlagsFetchError,
    FeatureFlagsHttpSource,
    loopbackFeaturesEndpointOverride,
} from "../remote/FeatureFlagsHttpSource"
import { MAX_FEATURE_FLAGS_TTL_SECONDS, MIN_FEATURE_FLAGS_TTL_SECONDS, parseFeatureFlagsDocument } from "../remote/flagsDocument"
import { featureFlagsBucket } from "../remote/remoteFeatureFlagsRuntime"

const QUERY = { bucket: "b".repeat(64), version: "0.11.0", platform: "win32", flags: ["account"] }

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
    it("posts the query in the body so the bucket never appears in a URL", async () => {
        const captured: CapturedRequest[] = []
        const source = new FeatureFlagsHttpSource({ query: QUERY })

        const document = await mockFetchForTesting(
            respondWith(200, { schema_version: 1, flags: { account: true }, ttl_seconds: 600 }, captured),
            () => source.fetchFlags(),
        )

        expect(document).toEqual({ flags: { account: true }, ttlSeconds: 600 })
        expect(captured).toHaveLength(1)
        expect(captured[0].url).toBe("https://dev.dline.cc/v1/features")
        expect(captured[0].init).toMatchObject({ method: "POST", redirect: "error" })
        expect(JSON.parse(String(captured[0].init?.body))).toEqual({
            schema_version: 1,
            bucket: QUERY.bucket,
            version: "0.11.0",
            platform: "win32",
            flags: ["account"],
        })
    })

    it("reports a non-2xx answer by status without parsing it", async () => {
        const source = new FeatureFlagsHttpSource({ query: QUERY })

        const failure = await mockFetchForTesting(respondWith(503, { schema_version: 1, flags: { account: true } }), () =>
            source.fetchFlags().catch((error: unknown) => error),
        )

        expect(failure).toBeInstanceOf(FeatureFlagsFetchError)
        expect(failure).toMatchObject({ failure: "status", status: 503 })
    })

    it("rejects a body that is not a flags document", async () => {
        const source = new FeatureFlagsHttpSource({ query: QUERY })

        const failure = await mockFetchForTesting(respondWith(200, "<html>captive portal</html>"), () =>
            source.fetchFlags().catch((error: unknown) => error),
        )

        expect(failure).toMatchObject({ failure: "invalid_document" })
    })

    it("refuses an endpoint that is neither HTTPS nor loopback", () => {
        expect(() => new FeatureFlagsHttpSource({ query: QUERY, endpoint: "http://dev.dline.cc" })).toThrow()
        expect(() => new FeatureFlagsHttpSource({ query: QUERY, endpoint: "https://dev.dline.cc/path" })).toThrow()
        expect(() => new FeatureFlagsHttpSource({ query: QUERY, endpoint: "http://127.0.0.1:8788" })).not.toThrow()
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

describe("featureFlagsBucket", () => {
    it("is stable for one installation and does not reveal the identity", () => {
        const bucket = featureFlagsBucket("machine-1")

        expect(featureFlagsBucket("machine-1")).toBe(bucket)
        expect(featureFlagsBucket("machine-2")).not.toBe(bucket)
        expect(bucket).toMatch(/^[0-9a-f]{64}$/)
        expect(bucket.includes("machine-1")).toBe(false)
    })
})
