import { UpdateSettingsRequest } from "@shared/proto/dline/state"
import { describe, expect, it, vi } from "vitest"
import type { Controller } from "../.."
import { updateSettings } from "../updateSettings"

interface AutoCondenseRequestFields {
    autoCondenseMinReserveTokens?: number
    autoCondenseMaxReserveTokens?: number
}

function createRequest(fields: AutoCondenseRequestFields): UpdateSettingsRequest {
    return { ...UpdateSettingsRequest.create(), ...fields }
}

function createController(currentSettings: Record<string, unknown> = {}) {
    const setGlobalState = vi.fn()
    const flushPendingState = vi.fn().mockResolvedValue(undefined)
    const controller = {
        configureGlobalComponents: vi.fn().mockResolvedValue({ components: [], durationMs: 0 }),
        stateManager: {
            flushPendingState,
            getGlobalSettingsKey: vi.fn((key: string) => currentSettings[key]),
            setGlobalState,
        },
        postStateToWebview: vi.fn().mockResolvedValue(undefined),
    } as unknown as Controller

    return { controller, setGlobalState }
}

describe("updateSettings auto-compact thresholds", () => {
    it("persists a valid percentage and maximum context", async () => {
        const { controller, setGlobalState } = createController()

        await updateSettings(
            controller,
            UpdateSettingsRequest.create({
                autoCondenseTriggerPercent: 60,
                autoCondenseMaxContextTokens: 500_000,
            }),
        )

        expect(setGlobalState).toHaveBeenCalledWith("autoCondenseTriggerPercent", 60)
        expect(setGlobalState).toHaveBeenCalledWith("autoCondenseMaxContextTokens", 500_000)
    })

    it.each([0, 98, 12.5])("rejects invalid trigger percentage %s", async (triggerPercent) => {
        const { controller, setGlobalState } = createController()

        await expect(
            updateSettings(controller, UpdateSettingsRequest.create({ autoCondenseTriggerPercent: triggerPercent })),
        ).rejects.toThrow(/integer from 1 to 97 percent/i)
        expect(setGlobalState).not.toHaveBeenCalled()
    })

    it.each([-1, 1.5, 2_147_483_648])("rejects invalid maximum context %s", async (maxContextTokens) => {
        const { controller, setGlobalState } = createController()

        await expect(
            updateSettings(controller, UpdateSettingsRequest.create({ autoCondenseMaxContextTokens: maxContextTokens })),
        ).rejects.toThrow(/integer from 0 to 2147483647 tokens/i)
        expect(setGlobalState).not.toHaveBeenCalled()
    })

    it("persists a valid reserve pair atomically", async () => {
        const { controller, setGlobalState } = createController()

        await updateSettings(
            controller,
            createRequest({ autoCondenseMinReserveTokens: 10_000, autoCondenseMaxReserveTokens: 40_000 }),
        )

        expect(setGlobalState).toHaveBeenCalledWith("autoCondenseMinReserveTokens", 10_000)
        expect(setGlobalState).toHaveBeenCalledWith("autoCondenseMaxReserveTokens", 40_000)
    })

    it.each([
        { autoCondenseMinReserveTokens: -1, autoCondenseMaxReserveTokens: 30_000 },
        { autoCondenseMinReserveTokens: 5_000.5, autoCondenseMaxReserveTokens: 30_000 },
        { autoCondenseMinReserveTokens: 5_000, autoCondenseMaxReserveTokens: 2_147_483_648 },
        { autoCondenseMinReserveTokens: 40_000, autoCondenseMaxReserveTokens: 30_000 },
    ])("rejects invalid reserve pair without partial persistence: %o", async (fields) => {
        const { controller, setGlobalState } = createController()

        await expect(updateSettings(controller, createRequest(fields))).rejects.toThrow(/auto-compact reserve/i)
        expect(setGlobalState).not.toHaveBeenCalled()
    })

    it("validates a single reserve update against the persisted opposite bound", async () => {
        const { controller, setGlobalState } = createController({
            autoCondenseMinReserveTokens: 5_000,
            autoCondenseMaxReserveTokens: 30_000,
        })

        await expect(updateSettings(controller, createRequest({ autoCondenseMinReserveTokens: 40_000 }))).rejects.toThrow(
            /minimum.*maximum/i,
        )
        expect(setGlobalState).not.toHaveBeenCalled()
    })
})
