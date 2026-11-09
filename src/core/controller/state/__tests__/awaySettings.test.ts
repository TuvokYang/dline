import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SettingsRepository } from "@core/storage/settings/SettingsRepository"
import { createInitialTaskState, type TaskState } from "@core/task/kernel"
import { TaskRuntime } from "@core/task/runtime/TaskRuntime"
import { TaskAwayConfigurationBinding } from "@core/task/session/TaskAwayConfigurationBinding"
import { awayConfigurationEnabled } from "@shared/away"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FeatureFlagsService } from "@/services/feature-flags/FeatureFlagsService"
import { AwaySettings } from "../awaySettings"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function setup(enabled = true, beforeHost?: (repository: SettingsRepository) => void) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dline-away-host-"))
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }))
    const filePath = path.join(dir, "settings.json")
    const repository = new SettingsRepository({ filePath, watch: false })
    await repository.initialize()
    cleanups.push(() => repository.dispose())
    let gate = enabled
    const flags = new FeatureFlagsService({
        resolveFlags: () => ({ "away-mode": gate }),
        isEnabled: () => true,
        getSettings: () => ({ enabled: true }),
        dispose: async () => {},
    })
    cleanups.push(() => flags.dispose())
    const authority = {
        readAwaySettingsSnapshot: () => repository.readSnapshot(),
        subscribeAwaySettings: (
            listener: Parameters<ConstructorParameters<typeof AwaySettings>[0]["subscribeAwaySettings"]>[0],
            unavailable: () => void,
        ) => {
            const a = repository.subscribe((commit) => listener(commit.snapshot))
            const b = repository.subscribeUnavailable(unavailable)
            return () => {
                a()
                b()
            }
        },
        mutateAwayPreferences: async (patch: Parameters<AwaySettings["mutate"]>[0]) => (await repository.mutate(patch)).snapshot,
        revokeAwayMode: async () => (await repository.revokeAwayMode()).snapshot,
    }
    beforeHost?.(repository)
    const host = new AwaySettings(authority, flags)
    cleanups.push(() => host.dispose())
    return {
        host,
        repository,
        filePath,
        gate: (value: boolean) => {
            gate = value
            flags.refresh()
        },
    }
}

describe("Away host configuration binding", () => {
    it("reconciles a real gate close/reopen before a read-only task takes ownership and releases work", async () => {
        const { host, gate } = await setup()
        await host.mutate({ awayModeEnabled: true, autoAwayModeEnabled: true })
        const initial: TaskState = {
            ...createInitialTaskState("reopen"),
            flow: { phase: "running" },
            away: {
                configuration: { enabled: true, automatic: true, modeRevocation: 0, automaticRevocation: 0 },
                mode: { source: "command", modeRevocation: 0, enteredRevision: 0 },
            },
        }
        const save = vi.fn(async () => {})
        const effects: TaskState[] = []
        const runtime = new TaskRuntime({
            initialState: initial,
            deferRestoredCommands: true,
            holdRestoredCommands: true,
            restoredOutbox: [
                { type: "provider.start", commandId: "restored", originRevision: 0, generation: 0, draftRef: "draft" },
            ],
            vault: { load: async () => undefined, save },
            taskView: { notifyCommitted: async () => {}, notifyTransient: () => {} },
            publications: { has: async () => false, mark: async () => {} },
            executors: [
                {
                    domain: "provider",
                    execute: async () => {
                        effects.push(runtime.getState())
                    },
                },
            ],
        })
        const binding = new TaskAwayConfigurationBinding(host, (error) => {
            throw error
        })
        binding.bind(runtime)
        cleanups.push(() => binding.release())
        expect(binding.isActive()).toBe(true)
        gate(false)
        expect(binding.isActive()).toBe(false)
        gate(true)
        await host.reconcile()
        await binding.reconcile()
        expect(save).not.toHaveBeenCalled()
        expect(effects).toEqual([])
        runtime.grantWriteOwnership()
        await binding.activate()
        runtime.releaseRestoredCommands()
        await runtime.waitForQuiescence()
        expect(effects).toHaveLength(1)
        expect(effects[0].away?.mode).toBeUndefined()
        expect(effects[0].away?.configuration.modeRevocation).toBe(1)
        expect(effects[0].roundMaterial?.notices).toMatchObject([{ reason: "configuration_revoked" }])
        expect(binding.isActive()).toBe(false)
    })

    it("does not let the gate enable user preferences and persists revocation through a quick gate reopen", async () => {
        const { host, repository, gate } = await setup()
        expect(awayConfigurationEnabled(host.read())).toBe(false)
        expect(repository.readSnapshot().values).toEqual({})
        await host.mutate({ awayModeEnabled: true, autoAwayModeEnabled: true })
        expect(awayConfigurationEnabled(host.read())).toBe(true)
        gate(false)
        expect(awayConfigurationEnabled(host.read())).toBe(false)
        gate(true)
        expect(awayConfigurationEnabled(host.read())).toBe(false)
        await host.reconcile()
        expect(host.read().revocations).toEqual({ mode: 1, automatic: 1 })
        expect(awayConfigurationEnabled(host.read())).toBe(true)
        expect(repository.readSnapshot().values).toEqual({ awayModeEnabled: true, autoAwayModeEnabled: true })
    })

    it("reaches synchronous permission listeners before a slow presentation listener finishes", async () => {
        let release!: () => void
        let slowWrites = false
        const slow = new Promise<void>((resolve) => {
            release = resolve
        })
        const { host, repository } = await setup(true, (r) => r.subscribe(() => (slowWrites ? slow : undefined)))
        await host.mutate({ awayModeEnabled: true })
        slowWrites = true
        const observed = vi.fn()
        repository.subscribe(() => observed(host.read()))
        const write = repository.mutate({ awayModeEnabled: false })
        await vi.waitFor(() => expect(observed).toHaveBeenCalledTimes(1))
        expect(awayConfigurationEnabled(observed.mock.calls[0][0])).toBe(false)
        release()
        await write
    })

    it("keeps permission withdrawn after a failed close until a durable revocation is reconciled", async () => {
        const { host, repository, filePath } = await setup()
        await host.mutate({ awayModeEnabled: true })
        await fs.writeFile(filePath, "{")
        await expect(host.mutate({ awayModeEnabled: false })).rejects.toThrow()
        expect(awayConfigurationEnabled(host.read())).toBe(false)
        await fs.writeFile(filePath, JSON.stringify({ awayModeEnabled: true }))
        await host.mutate({ awayModeEnabled: true })
        expect(host.read().revocations).toEqual({ mode: 1, automatic: 1 })
        expect(repository.readSnapshot().awayRevocations).toEqual({ mode: 1, automatic: 1 })
        expect(awayConfigurationEnabled(host.read())).toBe(true)
    })
})
