import * as assert from "assert"
import { afterEach, beforeEach, describe, it, vi } from "vitest"
// sinon import removed: using vitest globals
import { ClineAccountService } from "@/services/account/ClineAccountService"
import { AuthService } from "@/services/auth/AuthService"

describe("ClineAccountService.fetchUserRemoteConfig", () => {
    let service: ClineAccountService
    let sandbox: any /* sinon.SinonSandbox → vitest */
    let authStub: { getAuthToken: any /* sinon.SinonStub → vitest */ }

    beforeEach(() => {
        sandbox = { mockRestore: () => {} }
        authStub = { getAuthToken: vi.fn().mockResolvedValue("token") }
        vi.spyOn(AuthService, "getInstance").mockReturnValue(authStub as unknown as AuthService)
        service = new ClineAccountService()
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("returns discovery response on a successful authenticated request", async () => {
        const mockResponse = {
            organizationId: "org-123",
            value: '{"version":"v1"}',
            organizations: [
                { organizationId: "org-123", name: "Test Org" },
                { organizationId: "org-456", name: "Another Org" },
            ],
        }
        vi.spyOn(service as unknown as { authenticatedRequest: () => unknown }, "authenticatedRequest").mockResolvedValue(
            mockResponse,
        )

        const result = await service.fetchUserRemoteConfig()

        assert.ok(result !== undefined, "result should not be undefined")
        assert.strictEqual(result?.organizationId, "org-123")
        assert.strictEqual(result?.organizations?.length, 2)
        assert.strictEqual(result?.organizations?.[0].name, "Test Org")
    })

    it("re-throws when the request throws a network error", async () => {
        vi.spyOn(service as unknown as { authenticatedRequest: () => unknown }, "authenticatedRequest").mockRejectedValue(
            new Error("Network error"),
        )

        await assert.rejects(() => service.fetchUserRemoteConfig(), { message: "Network error" })
    })

    it("returns undefined when there is no auth token", async () => {
        authStub.getAuthToken.mockResolvedValue(null)

        const result = await service.fetchUserRemoteConfig()

        assert.strictEqual(result, undefined)
    })

    it("returns undefined when backend returns data: null (no org has remote config)", async () => {
        // When allowNullData is true and backend returns { success: true, data: null },
        // authenticatedRequest returns null. fetchUserRemoteConfig should coalesce to undefined.
        vi.spyOn(service as unknown as { authenticatedRequest: () => unknown }, "authenticatedRequest").mockResolvedValue(null)

        const result = await service.fetchUserRemoteConfig()

        assert.strictEqual(result, undefined)
    })

    it("returns response when backend selects fallback org", async () => {
        const mockResponse = {
            organizationId: "org-fallback",
            value: '{"version":"v1"}',
            organizations: [{ organizationId: "org-fallback", name: "Fallback Org" }],
        }
        vi.spyOn(service as unknown as { authenticatedRequest: () => unknown }, "authenticatedRequest").mockResolvedValue(
            mockResponse,
        )

        const result = await service.fetchUserRemoteConfig()

        assert.ok(result !== undefined)
        assert.strictEqual(result?.organizationId, "org-fallback")
        assert.strictEqual(result?.organizations?.length, 1)
    })
})

describe("ClineAccountService.fetchFeaturebaseToken", () => {
    let service: ClineAccountService
    let sandbox: any /* sinon.SinonSandbox → vitest */

    beforeEach(() => {
        sandbox = { mockRestore: () => {} }
        vi.spyOn(AuthService, "getInstance").mockReturnValue({} as AuthService)
        service = new ClineAccountService()
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("returns featurebaseJwt on a successful authenticated request", async () => {
        vi.spyOn(service as unknown as { authenticatedRequest: () => unknown }, "authenticatedRequest").mockResolvedValue({
            featurebaseJwt: "test-jwt-token-123",
        })

        const result = await service.fetchFeaturebaseToken()

        assert.ok(result !== undefined, "result should not be undefined")
        assert.strictEqual(result?.featurebaseJwt, "test-jwt-token-123")
    })

    it("returns undefined when the request throws a network error", async () => {
        vi.spyOn(service as unknown as { authenticatedRequest: () => unknown }, "authenticatedRequest").mockRejectedValue(
            new Error("Network error"),
        )

        const result = await service.fetchFeaturebaseToken()

        assert.strictEqual(result, undefined)
    })

    it("returns undefined when the request throws due to missing auth token", async () => {
        vi.spyOn(service as unknown as { authenticatedRequest: () => unknown }, "authenticatedRequest").mockRejectedValue(
            new Error("No Cline account auth token found"),
        )

        const result = await service.fetchFeaturebaseToken()

        assert.strictEqual(result, undefined)
    })
})
