import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { StateManager } from "@core/storage/StateManager"
import { SettingsRepository } from "@core/storage/settings/SettingsRepository"
import { UpdateSettingsRequest } from "@shared/proto/dline/state"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FeatureFlagsService } from "@/services/feature-flags/FeatureFlagsService"
import type { Controller } from "../.."
import { getAwaySettings } from "../awaySettings"
import { updateSettings } from "../updateSettings"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dline-away-rpc-"))
    cleanup.push(() => fs.rm(dir, { recursive: true, force: true }))
    const filePath = path.join(dir, "settings.json")
    const repository = new SettingsRepository({ filePath, watch: false })
    await repository.initialize()
    cleanup.push(() => repository.dispose())
    const flags = new FeatureFlagsService({
        resolveFlags: () => ({ "away-mode": true }),
        isEnabled: () => true,
        getSettings: () => ({ enabled: true }),
        dispose: async () => {},
    })
    cleanup.push(() => flags.dispose())
    const stateManager = {
        readAwaySettingsSnapshot: () => repository.readSnapshot(),
        subscribeAwaySettings: (
            listener: (snapshot: ReturnType<SettingsRepository["readSnapshot"]>) => void,
            unavailable: () => void,
        ) => {
            const a = repository.subscribe((commit) => listener(commit.snapshot))
            const b = repository.subscribeUnavailable(unavailable)
            return () => {
                a()
                b()
            }
        },
        mutateAwayPreferences: async (patch: Parameters<SettingsRepository["mutate"]>[0]) =>
            (await repository.mutate(patch)).snapshot,
        revokeAwayMode: async () => (await repository.revokeAwayMode()).snapshot,
        flushPendingState: async () => {},
    } as unknown as StateManager
    const host = getAwaySettings(stateManager, flags)
    cleanup.push(() => host.dispose())
    const publish = vi.fn(async () => {})
    const controller = {
        stateManager,
        postStateToWebview: publish,
        configureGlobalComponents: async () => ({ components: [], durationMs: 0 }),
    } as unknown as Controller
    return { controller, repository, filePath, publish }
}

// Exercise the real RPC, codec and repository transaction; a coalesced false/true
// or an acknowledgement before the canonical write would lose the revocation here.
describe("Away Settings RPC", () => {
    it("preserves adjacent off/on transactions and both private revocation generations", async () => {
        const h = await fixture()
        await updateSettings(h.controller, UpdateSettingsRequest.create({ awayModeEnabled: true, autoAwayModeEnabled: true }))
        const observed: boolean[] = []
        h.repository.subscribe((commit) => {
            observed.push(commit.snapshot.values.awayModeEnabled === true)
        })
        const close = UpdateSettingsRequest.decode(
            UpdateSettingsRequest.encode(UpdateSettingsRequest.create({ awayModeEnabled: false })).finish(),
        )
        expect(close.awayModeEnabled).toBe(false)
        await Promise.all([
            updateSettings(h.controller, close),
            updateSettings(h.controller, UpdateSettingsRequest.create({ awayModeEnabled: true })),
        ])
        expect(observed).toEqual([false, true])
        expect(h.repository.readSnapshot()).toMatchObject({
            values: { awayModeEnabled: true, autoAwayModeEnabled: true },
            awayRevocations: { mode: 1, automatic: 1 },
        })
        expect(h.publish).toHaveBeenCalledTimes(3)
    })

    it("reports persistence failure without publishing a successful state", async () => {
        const h = await fixture()
        await fs.writeFile(h.filePath, "{")
        await expect(updateSettings(h.controller, UpdateSettingsRequest.create({ awayModeEnabled: true }))).rejects.toThrow()
        expect(h.publish).not.toHaveBeenCalled()
    })

    it.each([
        { awayModeEnabled: "true" },
        { autoAwayModeEnabled: 1 },
        { __awayRevocations: { mode: 0, automatic: 0 } },
    ])("rejects invalid public payloads before any canonical write: %j", async (patch) => {
        const h = await fixture()
        const before = h.repository.readSnapshot()
        await expect(
            updateSettings(h.controller, { ...UpdateSettingsRequest.create(), ...patch } as unknown as UpdateSettingsRequest),
        ).rejects.toThrow()
        expect(h.repository.readSnapshot()).toEqual(before)
        expect(h.publish).not.toHaveBeenCalled()
    })
})
