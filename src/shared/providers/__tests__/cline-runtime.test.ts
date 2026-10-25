import { describe, expect, it } from "vitest"
import { CLINE_PROVIDER_DEFAULT_API_BASE_URL, resolveClineProviderApiBaseUrl } from "../cline-runtime"

describe("resolveClineProviderApiBaseUrl", () => {
    it("uses the Cline Provider API when the Profile has no override", () => {
        expect(resolveClineProviderApiBaseUrl()).toBe(CLINE_PROVIDER_DEFAULT_API_BASE_URL)
        expect(resolveClineProviderApiBaseUrl("   ")).toBe(CLINE_PROVIDER_DEFAULT_API_BASE_URL)
    })

    it("normalizes a Profile-scoped endpoint without changing its path", () => {
        expect(resolveClineProviderApiBaseUrl("  https://proxy.example.test/cline///  ")).toBe("https://proxy.example.test/cline")
    })
})
