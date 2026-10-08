import { UpdateApiConfigurationPartialRequest } from "@shared/proto/dline/models"
import { describe, expect, it, vi } from "vitest"
import { useApiConfigurationHandlers } from "./useApiConfigurationHandlers"

const models = vi.hoisted(() => ({ updateApiConfigurationPartial: vi.fn(async () => ({})) }))

vi.mock("@/services/grpc-client", () => ({ ModelsServiceClient: models }))

describe("useApiConfigurationHandlers", () => {
	// Sending only the changed field keeps two quick edits, or an edit made in
	// another window, from overwriting each other with a stale configuration.
	it("sends only the changed field, named in the update mask", async () => {
		const { handleFieldChange } = useApiConfigurationHandlers()

		await handleFieldChange("requestTimeoutMs", 45_000)

		expect(models.updateApiConfigurationPartial).toHaveBeenCalledOnce()
		const [request] = models.updateApiConfigurationPartial.mock.calls[0] as unknown as [UpdateApiConfigurationPartialRequest]
		expect(request.updateMask).toEqual(["requestTimeoutMs"])
		expect(request.apiConfiguration?.requestTimeoutMs).toBe(45_000)
	})
})
