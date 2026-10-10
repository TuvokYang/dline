import { expect } from "chai"
import { afterEach, beforeEach, describe, it, vi, expect as vitestExpect } from "vitest"
// sinon import removed
import { WebviewProvider } from "@/core/webview"
import { Logger } from "@/shared/services/Logger"
import { ErrorService } from "../error"
import { SharedUriHandler } from "./SharedUriHandler"

describe("SharedUriHandler", () => {
    let sandbox: any /* sinon.SinonSandbox → vitest */
    let handleOpenRouterCallbackStub: any /* sinon.SinonStub → vitest */
    let handleAuthCallbackStub: any /* sinon.SinonStub → vitest */

    beforeEach(async () => {
        sandbox = { mockRestore: () => {} }

        // Mock Logger methods to avoid HostProvider dependency
        vi.spyOn(Logger, "info").mockReturnValue(undefined)
        vi.spyOn(Logger, "error").mockReturnValue(undefined)
        // Mock ErrorService to avoid telemetry dependency
        const mockErrorService = {
            logMessage: vi.fn(),
            logException: vi.fn(),
            toClineError: vi.fn(),
            isEnabled: vi.fn().mockReturnValue(false),
            getSettings: vi.fn().mockReturnValue({ enabled: false, hostEnabled: false }),
            getProvider: vi.fn(),
            dispose: vi.fn().mockResolvedValue(undefined),
        }
        vi.spyOn(ErrorService, "initialize").mockResolvedValue(mockErrorService as any)
        vi.spyOn(ErrorService, "get").mockReturnValue(mockErrorService as any)

        await ErrorService.initialize()

        handleOpenRouterCallbackStub = vi.fn().mockResolvedValue(undefined)
        handleAuthCallbackStub = vi.fn().mockResolvedValue(undefined)
        const mockWebviewProvider = {
            controller: {
                handleOpenRouterCallback: handleOpenRouterCallbackStub,
                handleAuthCallback: handleAuthCallbackStub,
            },
        } as any
        vi.spyOn(WebviewProvider, "getVisibleInstance").mockReturnValue(mockWebviewProvider)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    describe("handleUri", () => {
        describe("OpenRouter callback handling", () => {
            it("should successfully handle OpenRouter callback with code", async () => {
                const result = await SharedUriHandler.handleUri("vscode://cline.cline/openrouter?code=test123")

                expect(result).to.be.true
                vitestExpect(handleOpenRouterCallbackStub).toHaveBeenCalledTimes(1)
                vitestExpect(handleOpenRouterCallbackStub).toHaveBeenCalledWith("test123")
            })

            it("should return false when OpenRouter code is missing", async () => {
                const result = await SharedUriHandler.handleUri("vscode://cline.cline/openrouter")

                expect(result).to.be.false
                expect(handleOpenRouterCallbackStub.mock.calls.length > 0).to.be.false
            })

            it("should handle URL with plus signs in code parameter", async () => {
                const result = await SharedUriHandler.handleUri("vscode://cline.cline/openrouter?code=test+123+abc")

                expect(result).to.be.true
                // Plus signs in query params are preserved
                vitestExpect(handleOpenRouterCallbackStub).toHaveBeenCalledTimes(1)
                vitestExpect(handleOpenRouterCallbackStub).toHaveBeenCalledWith("test+123+abc")
            })
        })

        describe("Auth callback handling", () => {
            it("should successfully handle auth callback with idToken", async () => {
                const result = await SharedUriHandler.handleUri("vscode://cline.cline/auth?idToken=jwt123&provider=google")

                expect(result).to.be.true
                vitestExpect(handleAuthCallbackStub).toHaveBeenCalledTimes(1)
                vitestExpect(handleAuthCallbackStub).toHaveBeenCalledWith("jwt123", "google")
            })

            it("should successfully handle auth callback without provider", async () => {
                const result = await SharedUriHandler.handleUri("vscode://cline.cline/auth?idToken=jwt123")

                expect(result).to.be.true
                vitestExpect(handleAuthCallbackStub).toHaveBeenCalledTimes(1)
                vitestExpect(handleAuthCallbackStub).toHaveBeenCalledWith("jwt123", null)
            })

            it("should return false when idToken is missing", async () => {
                const result = await SharedUriHandler.handleUri("vscode://cline.cline/auth?provider=google")

                expect(result).to.be.false
                expect(handleAuthCallbackStub.mock.calls.length > 0).to.be.false
            })
        })

        describe("Unknown path handling", () => {
            it("should return false for unknown paths", async () => {
                const result = await SharedUriHandler.handleUri("vscode://cline.cline/unknown?param=value")

                expect(result).to.be.false
                expect(handleAuthCallbackStub.mock.calls.length > 0).to.be.false
                expect(handleOpenRouterCallbackStub.mock.calls.length > 0).to.be.false
            })
        })

        describe("Error handling", () => {
            it("should catch and log errors from controller methods", async () => {
                handleOpenRouterCallbackStub.mockRejectedValue(new Error("Controller error"))

                const result = await SharedUriHandler.handleUri("vscode://cline.cline/openrouter?code=test123")

                expect(result).to.be.false
            })

            it("should handle malformed URIs gracefully", async () => {
                const result = await SharedUriHandler.handleUri("invalid://uri")

                expect(result).to.be.false
                expect(handleAuthCallbackStub.mock.calls.length > 0).to.be.false
                expect(handleOpenRouterCallbackStub.mock.calls.length > 0).to.be.false
            })
        })

        describe("Query parameter parsing", () => {
            it("should correctly parse multiple query parameters", async () => {
                const result = await SharedUriHandler.handleUri(
                    "vscode://cline.cline/auth?idToken=jwt123&provider=github&extra=param",
                )

                expect(result).to.be.true
                vitestExpect(handleAuthCallbackStub).toHaveBeenCalledTimes(1)
                vitestExpect(handleAuthCallbackStub).toHaveBeenCalledWith("jwt123", "github")
            })

            it("should handle URL-encoded parameters", async () => {
                const result = await SharedUriHandler.handleUri(
                    "vscode://cline.cline/auth?idToken=jwt%20with%20spaces&provider=google",
                )

                expect(result).to.be.true
                // URLSearchParams should decode %20 to spaces
                vitestExpect(handleAuthCallbackStub).toHaveBeenCalledTimes(1)
                vitestExpect(handleAuthCallbackStub).toHaveBeenCalledWith("jwt with spaces", "google")
            })

            it("should handle empty query string", async () => {
                const result = await SharedUriHandler.handleUri("vscode://cline.cline/openrouter")

                expect(result).to.be.false
                expect(handleAuthCallbackStub.mock.calls.length > 0).to.be.false
                expect(handleOpenRouterCallbackStub.mock.calls.length > 0).to.be.false
            })
        })

        describe("Different URI schemes", () => {
            it("should handle HTTP scheme URIs", async () => {
                const result = await SharedUriHandler.handleUri("http://localhost:3000/openrouter?code=test123")

                expect(result).to.be.true
                vitestExpect(handleOpenRouterCallbackStub).toHaveBeenCalledTimes(1)
                vitestExpect(handleOpenRouterCallbackStub).toHaveBeenCalledWith("test123")
            })

            it("should handle HTTPS scheme URIs", async () => {
                const result = await SharedUriHandler.handleUri("https://example.com/auth?idToken=jwt123&provider=github")

                expect(result).to.be.true
                vitestExpect(handleAuthCallbackStub).toHaveBeenCalledWith("jwt123", "github")
            })
        })
    })
})
