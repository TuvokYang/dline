import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "should"
import { Controller } from "@core/controller"
import { IRecorder } from "@core/controller/grpc-recorder/grpc-recorder"
import { GrpcRecorderBuilder } from "@core/controller/grpc-recorder/grpc-recorder.builder"
import { testHooks } from "@core/controller/grpc-recorder/test-hooks"
import { GrpcLogEntry } from "@core/controller/grpc-recorder/types"

// sinon import removed

describe("test-hooks", () => {
    let cleanupSyntheticEntriesStub: any /* sinon.SinonStub → vitest */
    let recordRequestStub: any /* sinon.SinonStub → vitest */
    let recordResponseStub: any /* sinon.SinonStub → vitest */
    let getRecorderStub: any /* sinon.SinonStub → vitest */

    beforeEach(() => {
        cleanupSyntheticEntriesStub = vi.fn()
        recordRequestStub = vi.fn()
        recordResponseStub = vi.fn()

        const mockRecorder: IRecorder = {
            cleanupSyntheticEntries: cleanupSyntheticEntriesStub,
            recordRequest: recordRequestStub,
            recordResponse: recordResponseStub,
            recordError: vi.fn(),
            getSessionLog: vi.fn().mockReturnValue({ startTime: "", entries: [] }),
        }

        getRecorderStub = vi.spyOn(GrpcRecorderBuilder, "getRecorder").mockReturnValue(mockRecorder)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("should return an array of post-record hooks", () => {
        const mockController = {} as Controller
        const hooks = testHooks(mockController)

        hooks.should.be.an.Array()
        hooks.should.have.length(1)
        hooks[0].should.be.a.Function()
    })

    it("should execute hook and call recorder methods", async () => {
        const mockController = {
            getStateToPostToWebview: vi.fn().mockReturnValue({}),
            getAccountUsage: vi.fn().mockReturnValue(undefined),
        } as any as Controller

        const hooks = testHooks(mockController)

        const mockEntry: GrpcLogEntry = {
            requestId: "test-request-id",
            service: "TestService",
            method: "testMethod",
            isStreaming: false,
            request: { message: {} },
            status: "pending",
        }

        await hooks[0](mockEntry)

        // Validate stub calls
        expect(getRecorderStub).toHaveBeenCalledWith(mockController)
        cleanupSyntheticEntriesStub.mock.calls.length.should.equal(1)
        expect(recordRequestStub).toHaveBeenCalled()
        expect(recordResponseStub).toHaveBeenCalled()
    })
})
