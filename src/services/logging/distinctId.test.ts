import { expect } from "chai"
import * as nodeMachineId from "node-machine-id"
import { afterEach, beforeEach, describe, it, vi, expect as vitestExpect } from "vitest"
// sinon import removed
import { HostProvider } from "@/hosts/host-provider"
import {
    _GENERATED_MACHINE_ID_KEY,
    getDistinctId,
    initializeDistinctId,
    setDistinctIdForTesting,
} from "@/services/logging/distinctId"
import { StorageContext } from "@/shared/storage"

describe("distinctId", () => {
    let sandbox: any /* sinon.SinonSandbox → vitest */
    let mockStorage: StorageContext
    let mockGlobalState: any
    let hostProviderInitialized = false

    const MOCK_GLOBAL_STATE_ID = "existing-distinct-id-123"
    const MOCK_MACHINE_ID = "machine-id-456"
    const MOCK_UUID = "mock-uuid-12345678-1234-1234-1234-123456789012"
    const GENERATED_MACHINE_ID = `cl-${MOCK_UUID}`

    const mockUuidGenerator = () => MOCK_UUID

    beforeEach(() => {
        sandbox = { mockRestore: () => {} }

        // Initialize HostProvider if not already done
        if (!HostProvider.isInitialized()) {
            const mockHostBridge: any = {
                workspaceClient: {},
                envClient: {
                    getHostVersion: vi.fn().mockResolvedValue({
                        clineVersion: "1.0.0",
                        platform: "darwin",
                        clineType: "vscode",
                    }),
                },
                windowClient: {},
                diffClient: {},
            }

            HostProvider.initialize(
                () => null as any, // createWebviewProvider
                () => null as any, // createDiffViewProvider
                () => null as any, // createCommentReviewController
                () => null as any, // createTerminalManager
                mockHostBridge,
                () => {}, // logToChannel
                async () => "http://localhost", // getCallbackUrl
                async () => "", // getBinaryLocation
                "/test/extension", // extensionFsPath
                "/test/storage", // globalStorageFsPath
            )
            hostProviderInitialized = true
        }

        // Mock global state
        mockGlobalState = { get: vi.fn(), update: vi.fn() }

        // Mock extension storage
        mockStorage = { globalState: mockGlobalState } as unknown as StorageContext

        // Reset the distinctId module state
        setDistinctIdForTesting("")
    })

    afterEach(() => {
        vi.restoreAllMocks()

        // Reset HostProvider if we initialized it
        if (hostProviderInitialized) {
            HostProvider.reset()
            hostProviderInitialized = false
        }
    })

    it("should use id from extension globalstate if it exists", async () => {
        mockGlobalState.get.mockReturnValue(MOCK_GLOBAL_STATE_ID)
        const machineIdStub = vi.spyOn(nodeMachineId, "machineId")

        await initializeDistinctId(mockStorage, mockUuidGenerator)

        expect(getDistinctId()).to.equal(MOCK_GLOBAL_STATE_ID)
        vitestExpect(machineIdStub).not.toHaveBeenCalled()
        vitestExpect(mockGlobalState.update).not.toHaveBeenCalled()
    })

    it("should use the machine ID from node-machine-id", async () => {
        // Mock node-machine-id to return a machine ID
        const machineIdStub = vi.spyOn(nodeMachineId, "machineId").mockResolvedValue(MOCK_MACHINE_ID)

        await initializeDistinctId(mockStorage, mockUuidGenerator)

        expect(getDistinctId()).to.equal(MOCK_MACHINE_ID)
        expect(machineIdStub.mock.calls.length === 1).to.be.true
        expect(mockGlobalState.update.mock.calls.length === 0).to.be.true
    })

    it("distinct ID should be stable", async () => {
        mockGlobalState.get.mockReturnValue(undefined)
        // Mock node-machine-id to return a machine ID
        vi.spyOn(nodeMachineId, "machineId").mockResolvedValue(MOCK_MACHINE_ID)

        await initializeDistinctId(mockStorage, mockUuidGenerator)
        expect(getDistinctId()).to.equal(MOCK_MACHINE_ID)

        await initializeDistinctId(mockStorage, mockUuidGenerator)
        expect(getDistinctId()).to.equal(MOCK_MACHINE_ID)

        expect(mockGlobalState.update.mock.calls.length === 0).to.be.true
    })

    it("should generate and store UUID if node-machine-id returns empty string", async () => {
        mockGlobalState.get.mockReturnValue(undefined)
        // Mock node-machine-id to return empty string
        const machineIdStub = vi.spyOn(nodeMachineId, "machineId").mockResolvedValue("")

        await initializeDistinctId(mockStorage, mockUuidGenerator)

        expect(getDistinctId()).to.equal(GENERATED_MACHINE_ID)
        expect(machineIdStub.mock.calls.length === 1).to.be.true
        vitestExpect(mockGlobalState.update).toHaveBeenCalledWith(_GENERATED_MACHINE_ID_KEY, GENERATED_MACHINE_ID)
    })

    it("should handle node-machine-id errors gracefully", async () => {
        mockGlobalState.get.mockReturnValue(undefined)
        // Mock node-machine-id to throw an error
        const machineIdStub = vi.spyOn(nodeMachineId, "machineId").mockRejectedValue(new Error("Failed to get machine ID"))

        await initializeDistinctId(mockStorage, mockUuidGenerator)

        expect(getDistinctId()).to.equal(GENERATED_MACHINE_ID)
        expect(machineIdStub.mock.calls.length === 1).to.be.true
        vitestExpect(mockGlobalState.update).toHaveBeenCalledWith(_GENERATED_MACHINE_ID_KEY, GENERATED_MACHINE_ID)
    })
})
