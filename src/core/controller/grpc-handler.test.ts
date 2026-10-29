import { Controller } from "@core/controller"
import { serviceHandlers } from "@generated/hosts/vscode/protobus-services"
import { GrpcCancel, GrpcRequest } from "@shared/WebviewMessage"
import { expect } from "chai"
import { afterEach, beforeEach, describe, it, vi } from "vitest"
// sinon import removed
import { getRequestRegistry, handleGrpcRequest, handleGrpcRequestCancel } from "./grpc-handler"

describe("grpc-handler", () => {
    let sandbox: any /* sinon.SinonSandbox → vitest */
    let mockController: Controller
    let mockPostMessageToWebview: any /* sinon.SinonStub → vitest */

    let mockUnaryHandler: any /* sinon.SinonStub → vitest */
    let mockUnaryFailingHandler: any /* sinon.SinonStub → vitest */
    let mockStreamingHandler: any /* sinon.SinonStub → vitest */
    let mockStreamingFailingHandler: any /* sinon.SinonStub → vitest */

    const serviceName = "dline.TestService"
    const mockResponse = { result: "result-1234" }

    beforeEach(() => {
        sandbox = { mockRestore: () => {} }

        // Create a mock controller
        mockController = {} as any
        mockPostMessageToWebview = vi.fn().mockResolvedValue(undefined)

        // Create mock service handlers
        mockUnaryHandler = vi.fn().mockResolvedValue(mockResponse)
        mockStreamingHandler = vi.fn().mockResolvedValue(undefined)
        mockUnaryFailingHandler = vi.fn().mockRejectedValue(new Error("Test error unary"))
        mockStreamingFailingHandler = vi.fn().mockRejectedValue(new Error("Stream error"))
        serviceHandlers[serviceName] = {
            testUnary: mockUnaryHandler,
            testUnaryFailing: mockUnaryFailingHandler,
            testStreaming: mockStreamingHandler,
            testStreamingFailing: mockStreamingFailingHandler,
        }
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    describe("handleGrpcRequest", () => {
        describe("Unary requests", () => {
            it("should handle successful unary requests", async () => {
                const request: GrpcRequest = {
                    service: serviceName,
                    method: "testUnary",
                    message: { input: "test" },
                    request_id: "test-123",
                    is_streaming: false,
                }

                await handleGrpcRequest(mockController, mockPostMessageToWebview, request)

                // Verify the handler was called
                expect(mockUnaryHandler.mock.calls.length === 1).to.be.true
                expect(mockUnaryHandler.mock.calls[0][0]).to.equal(mockController)
                expect(mockUnaryHandler.mock.calls[0][1]).to.deep.equal({ input: "test" })

                // Verify the response was sent
                expect(mockPostMessageToWebview.mock.calls.length === 1).to.be.true
                const sentMessage = mockPostMessageToWebview.mock.calls[0][0]
                expect(sentMessage).to.deep.equal({
                    type: "grpc_response",
                    grpc_response: {
                        message: mockResponse,
                        request_id: "test-123",
                    },
                })
            })

            it("should handle errors in unary requests", async () => {
                const request: GrpcRequest = {
                    service: serviceName,
                    method: "testUnaryFailing",
                    message: { input: "test" },
                    request_id: "test-456",
                    is_streaming: false,
                }

                await handleGrpcRequest(mockController, mockPostMessageToWebview, request)

                // Verify the error response was sent
                expect(mockPostMessageToWebview.mock.calls.length === 1).to.be.true
                const sentMessage = mockPostMessageToWebview.mock.calls[0][0]
                expect(sentMessage).to.deep.equal({
                    type: "grpc_response",
                    grpc_response: {
                        error: "Test error unary",
                        request_id: "test-456",
                        is_streaming: false,
                    },
                })
            })

            it("should handle unknown service errors", async () => {
                const request: GrpcRequest = {
                    service: "UnknownService",
                    method: "someMethod",
                    message: {},
                    request_id: "test-789",
                    is_streaming: false,
                }

                await handleGrpcRequest(mockController, mockPostMessageToWebview, request)

                // Verify the error response was sent
                expect(mockPostMessageToWebview.mock.calls.length === 1).to.be.true
                const sentMessage = mockPostMessageToWebview.mock.calls[0][0]
                expect(sentMessage.type).to.equal("grpc_response")
                expect(sentMessage.grpc_response?.error).to.include("Unknown service: UnknownService")
                expect(sentMessage.grpc_response?.request_id).to.equal("test-789")
            })

            it("should handle unknown method errors", async () => {
                const request: GrpcRequest = {
                    service: serviceName,
                    method: "unknownMethod",
                    message: {},
                    request_id: "test-999",
                    is_streaming: false,
                }

                await handleGrpcRequest(mockController, mockPostMessageToWebview, request)

                // Verify the error response was sent
                expect(mockPostMessageToWebview.mock.calls.length === 1).to.be.true
                const sentMessage = mockPostMessageToWebview.mock.calls[0][0]
                expect(sentMessage.type).to.equal("grpc_response")
                expect(sentMessage.grpc_response?.error).to.include("Unknown rpc: dline.TestService.unknownMethod")
                expect(sentMessage.grpc_response?.request_id).to.equal("test-999")
            })
        })
        describe("Streaming requests", () => {
            it("should handle successful streaming requests", async () => {
                // Set up a streaming handler that sends multiple responses
                const request: GrpcRequest = {
                    service: serviceName,
                    method: "testStreaming",
                    message: { input: "stream" },
                    request_id: "stream-123",
                    is_streaming: true,
                }

                // Reset the mock and set up the handler using callsFake
                mockStreamingHandler.mockClear()
                mockStreamingHandler.mockImplementation(
                    async (_controller: any, _message: any, responseStream: any, _requestId: string) => {
                        // Simulate streaming multiple messages
                        await responseStream({ value: 1 }, false, 0)
                        await responseStream({ value: 2 }, false, 1)
                        await responseStream({ value: 3 }, true, 2) // Last message
                    },
                )

                await handleGrpcRequest(mockController, mockPostMessageToWebview, request)

                // Verify the handler was called
                expect(mockStreamingHandler.mock.calls.length === 1).to.be.true
                expect(mockStreamingHandler.mock.calls[0][0]).to.equal(mockController)
                expect(mockStreamingHandler.mock.calls[0][1]).to.deep.equal({ input: "stream" })
                expect(mockStreamingHandler.mock.calls[0][3]).to.equal("stream-123")

                // Verify all streaming responses were sent
                expect(mockPostMessageToWebview.mock.calls.length).to.equal(3)

                // Check all responses
                expect(mockPostMessageToWebview.mock.calls[0][0]).to.deep.equal({
                    type: "grpc_response",
                    grpc_response: {
                        message: { value: 1 },
                        request_id: "stream-123",
                        is_streaming: true,
                        sequence_number: 0,
                    },
                })
                expect(mockPostMessageToWebview.mock.calls[1][0]).to.deep.equal({
                    type: "grpc_response",
                    grpc_response: {
                        message: { value: 2 },
                        request_id: "stream-123",
                        is_streaming: true,
                        sequence_number: 1,
                    },
                })
                expect(mockPostMessageToWebview.mock.calls[2][0]).to.deep.equal({
                    type: "grpc_response",
                    grpc_response: {
                        message: { value: 3 },
                        request_id: "stream-123",
                        is_streaming: false, // Last message has is_streaming: false
                        sequence_number: 2,
                    },
                })
            })

            it("should handle errors in streaming requests", async () => {
                const request: GrpcRequest = {
                    service: serviceName,
                    method: "testStreamingFailing",
                    message: { input: "stream" },
                    request_id: "stream-456",
                    is_streaming: true,
                }

                await handleGrpcRequest(mockController, mockPostMessageToWebview, request)

                // Verify the error response was sent
                expect(mockPostMessageToWebview.mock.calls.length === 1).to.be.true
                const sentMessage = mockPostMessageToWebview.mock.calls[0][0]
                expect(sentMessage).to.deep.equal({
                    type: "grpc_response",
                    grpc_response: {
                        error: "Stream error",
                        request_id: "stream-456",
                        is_streaming: false,
                    },
                })
            })

            it("should handle streaming with message, error, then another message", async () => {
                // This test simulates a scenario where:
                // 1. First message is sent successfully
                // 2. An error occurs
                // 3. Another message is attempted (which should not be sent after error)

                const request: GrpcRequest = {
                    service: serviceName,
                    method: "testStreaming",
                    message: { input: "stream-with-error" },
                    request_id: "stream-error-mid",
                    is_streaming: true,
                }

                // Reset the mock and set up the handler to throw an error after being called
                mockStreamingHandler.mockClear()
                mockStreamingHandler.mockImplementation(
                    async (_controller: any, _message: any, responseStream: any, _requestId: string) => {
                        // Send first message successfully
                        await responseStream({ value: "first" }, false, 0)
                        // Throw an error
                        throw new Error("Mid-stream error")
                    },
                )

                await handleGrpcRequest(mockController, mockPostMessageToWebview, request)

                // Verify the handler was called
                expect(mockStreamingHandler.mock.calls.length === 1).to.be.true

                // Verify that we got the first message and then the error
                expect(mockPostMessageToWebview.mock.calls.length).to.equal(2)

                // Check first message was sent successfully
                expect(mockPostMessageToWebview.mock.calls[0][0]).to.deep.equal({
                    type: "grpc_response",
                    grpc_response: {
                        message: { value: "first" },
                        request_id: "stream-error-mid",
                        is_streaming: true,
                        sequence_number: 0,
                    },
                })

                // Check error response was sent
                expect(mockPostMessageToWebview.mock.calls[1][0]).to.deep.equal({
                    type: "grpc_response",
                    grpc_response: {
                        error: "Mid-stream error",
                        request_id: "stream-error-mid",
                        is_streaming: false,
                    },
                })

                // Try to send another message after the error (simulating what might happen
                // if the handler tried to continue after an error)
                const responseStream = mockStreamingHandler.mock.calls[0][2]

                // This should still work as the responseStream function is still valid
                await responseStream({ value: "after-error" }, false, 1)

                // Verify we now have 3 total calls (first message, error, after-error message)
                expect(mockPostMessageToWebview.mock.calls.length).to.equal(3)

                // Verify the message after error was still sent
                // (In a real scenario, the handler would have stopped due to the error,
                // but this tests that the responseStream function itself still works)
                expect(mockPostMessageToWebview.mock.calls[2][0]).to.deep.equal({
                    type: "grpc_response",
                    grpc_response: {
                        message: { value: "after-error" },
                        request_id: "stream-error-mid",
                        is_streaming: true,
                        sequence_number: 1,
                    },
                })
            })
        })

        describe("handleGrpcRequestCancel", () => {
            it("should cancel an active request", async () => {
                // Register a request in the registry
                const registry = getRequestRegistry()
                const cleanupStub = vi.fn()
                registry.registerRequest("cancel-123", cleanupStub)

                const cancelRequest: GrpcCancel = {
                    request_id: "cancel-123",
                }

                await handleGrpcRequestCancel(mockPostMessageToWebview, cancelRequest)

                // Verify the cleanup was called
                expect(cleanupStub.mock.calls.length === 1).to.be.true

                // Verify the cancellation confirmation was sent
                expect(mockPostMessageToWebview.mock.calls.length === 1).to.be.true
                const sentMessage = mockPostMessageToWebview.mock.calls[0][0]
                expect(sentMessage).to.deep.equal({
                    type: "grpc_response",
                    grpc_response: {
                        message: { cancelled: true },
                        request_id: "cancel-123",
                        is_streaming: false,
                    },
                })

                // Verify the request was removed from the registry
                expect(registry.hasRequest("cancel-123")).to.be.false
            })

            it("should handle cancellation of non-existent request", async () => {
                const cancelRequest: GrpcCancel = {
                    request_id: "non-existent",
                }

                await handleGrpcRequestCancel(mockPostMessageToWebview, cancelRequest)

                // Verify no message was sent (request not found)
                expect(mockPostMessageToWebview.mock.calls.length > 0).to.be.false
            })

            it("should handle cleanup errors gracefully", async () => {
                // Register a request with a failing cleanup
                const registry = getRequestRegistry()
                const cleanupStub = vi.fn().mockImplementation(() => {
                    throw new Error("Cleanup failed")
                })
                registry.registerRequest("cancel-error", cleanupStub)

                const cancelRequest: GrpcCancel = {
                    request_id: "cancel-error",
                }

                // Should not throw
                await handleGrpcRequestCancel(mockPostMessageToWebview, cancelRequest)

                // Verify the cleanup was attempted
                expect(cleanupStub.mock.calls.length === 1).to.be.true

                // Verify the cancellation confirmation was still sent
                expect(mockPostMessageToWebview.mock.calls.length === 1).to.be.true

                // Verify the request was removed despite the error
                expect(registry.hasRequest("cancel-error")).to.be.false
            })
        })

        describe("Concurrent requests", () => {
            it("should handle concurrent requests", async () => {
                // Set up handlers
                mockUnaryHandler.mockResolvedValue({ result: "unary" })
                mockStreamingHandler.mockImplementation(async (_controller: any, _message: any, responseStream: any) => {
                    await responseStream({ value: "stream1" }, false, 0)
                    await responseStream({ value: "stream2" }, true, 1)
                })

                // Send multiple requests concurrently
                const requests = [
                    handleGrpcRequest(mockController, mockPostMessageToWebview, {
                        service: serviceName,
                        method: "testUnary",
                        message: { id: 1 },
                        request_id: "concurrent-1",
                        is_streaming: false,
                    }),
                    handleGrpcRequest(mockController, mockPostMessageToWebview, {
                        service: serviceName,
                        method: "testStreaming",
                        message: { id: 2 },
                        request_id: "concurrent-2",
                        is_streaming: true,
                    }),
                    handleGrpcRequest(mockController, mockPostMessageToWebview, {
                        service: serviceName,
                        method: "testUnary",
                        message: { id: 3 },
                        request_id: "concurrent-3",
                        is_streaming: false,
                    }),
                ]

                await Promise.all(requests)

                // Verify all handlers were called
                expect(mockUnaryHandler.mock.calls.length).to.equal(2)
                expect(mockStreamingHandler.mock.calls.length).to.equal(1)

                // Verify all responses were sent (2 unary + 2 streaming)
                expect(mockPostMessageToWebview.mock.calls.length).to.equal(4)
            })
        })
    })
})
