import { expect } from "chai"
import "should"
import { afterEach, beforeEach, describe, it, vi, expect as vitestExpect } from "vitest"
import { handleGrpcRequest } from "@/core/controller/grpc-handler"
import { GrpcRecorderBuilder } from "@/core/controller/grpc-recorder/grpc-recorder.builder"
import { serviceHandlers } from "@/generated/hosts/vscode/protobus-services"
import type { ExtensionMessage } from "@/shared/ExtensionMessage"
import type { GrpcRequest } from "@/shared/WebviewMessage"

describe("GrpcHandler Recording Middleware", () => {
    let recorderStub: any /* sinon.SinonStub → vitest */
    let _consoleWarnStub: any /* sinon.SinonStub → vitest */
    let mockController: any /* sinon.SinonStub → vitest */
    let mockPostMessage: any /* sinon.SinonStub → vitest */

    beforeEach(() => {
        recorderStub = {
            recordRequest: vi.fn(),
            recordResponse: vi.fn(),
            recordError: vi.fn(),
            getSessionLog: vi.fn(),
        }

        vi.spyOn(GrpcRecorderBuilder, "getRecorder").mockReturnValue(recorderStub)
        _consoleWarnStub = vi.spyOn(console, "warn")
        mockController = {} as any
        mockPostMessage = vi.fn().mockResolvedValue(true)

        serviceHandlers.TestService = {
            testMethod: vi.fn().mockResolvedValue({ success: true }),
            errorMethod: vi.fn().mockRejectedValue(new Error("Simulated failure")),
        }
    })

    afterEach(() => {
        delete serviceHandlers.TestService
        vi.restoreAllMocks()
    })

    describe("Recording Middleware Integration", () => {
        it("should record requests and responses for unary gRPC calls", async () => {
            const grpcRequest: GrpcRequest = {
                request_id: "the-request-id",
                service: "TestService",
                method: "testMethod",
                message: { test: "request" },
                is_streaming: false,
            }

            await handleGrpcRequest(mockController, mockPostMessage, grpcRequest)

            vitestExpect(recorderStub.recordRequest).toHaveBeenCalledTimes(1)
            vitestExpect(recorderStub.recordRequest).toHaveBeenCalledWith(grpcRequest)
            expect(recorderStub.recordError.mock.calls.length === 0).to.be.true

            expect(mockPostMessage.mock.calls.length === 1).to.be.true
            const sentMessage = mockPostMessage.mock.calls[0][0] as ExtensionMessage
            expect(sentMessage.type).to.equal("grpc_response")
            expect(sentMessage.grpc_response?.request_id).to.equal("the-request-id")
            expect(sentMessage.grpc_response?.message).to.deep.equal({ success: true })

            vitestExpect(recorderStub.recordResponse).toHaveBeenCalledTimes(1)
            vitestExpect(recorderStub.recordResponse).toHaveBeenCalledWith("the-request-id", sentMessage.grpc_response)
        })
    })
})
