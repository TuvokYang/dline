import { describe, expect, it, vi } from "vitest"
import { saveSettingsAndClose } from "./settingsSaveCoordinator"

describe("saveSettingsAndClose", () => {
    it("completes every persistence boundary before closing the Settings view", async () => {
        const order: string[] = []
        const flushInputs = vi.fn(async () => {
            order.push("inputs")
        })
        const flushRequests = vi.fn(async () => {
            order.push("requests")
        })
        const flushProfileCatalog = vi.fn(async () => {
            order.push("profiles")
        })
        const flushBackend = vi.fn(async () => {
            order.push("backend")
        })
        const close = vi.fn(async () => {
            order.push("close")
        })

        await saveSettingsAndClose({ flushInputs, flushRequests, flushProfileCatalog, flushBackend, close })

        expect(order).toEqual(["inputs", "requests", "profiles", "backend", "close"])
    })

    it("does not close or cross later persistence boundaries after a save failure", async () => {
        const flushInputs = vi.fn().mockResolvedValue(undefined)
        const flushRequests = vi.fn().mockRejectedValue(new Error("Settings request failed"))
        const flushProfileCatalog = vi.fn().mockResolvedValue(undefined)
        const flushBackend = vi.fn().mockResolvedValue(undefined)
        const close = vi.fn().mockResolvedValue(undefined)

        await expect(
            saveSettingsAndClose({ flushInputs, flushRequests, flushProfileCatalog, flushBackend, close }),
        ).rejects.toThrow("Settings request failed")

        expect(flushInputs).toHaveBeenCalledOnce()
        expect(flushRequests).toHaveBeenCalledOnce()
        expect(flushProfileCatalog).not.toHaveBeenCalled()
        expect(flushBackend).not.toHaveBeenCalled()
        expect(close).not.toHaveBeenCalled()
    })
})
