import type { AwayConfiguration } from "@shared/away"
import { describe, expect, it, vi } from "vitest"
import { createInitialTaskState } from "../../kernel"
import { TaskRuntime } from "../../runtime/TaskRuntime"
import { TaskAwayConfigurationBinding } from "../TaskAwayConfigurationBinding"

// An equal in-memory configuration is not evidence that the preceding vault write succeeded.
describe("Away bootstrap durability", () => {
    it("does not release restored commands after an equal configuration whose original commit failed", async () => {
        let fail = true
        let savedRevision = -1
        const configuration: AwayConfiguration = {
            available: true,
            gateEnabled: true,
            awayModeEnabled: true,
            autoAwayModeEnabled: true,
            revocations: { mode: 0, automatic: 0 },
        }
        const effects: number[] = []
        const runtime = new TaskRuntime({
            initialState: createInitialTaskState("bootstrap"),
            holdRestoredCommands: true,
            restoredOutbox: [
                { type: "provider.start", commandId: "restored", originRevision: 0, generation: 0, draftRef: "draft" },
            ],
            vault: {
                load: async () => undefined,
                save: async (snapshot) => {
                    if (fail) throw new Error("Vault unavailable")
                    savedRevision = snapshot.state.revision
                },
            },
            taskView: { notifyCommitted: async () => {}, notifyTransient: () => {} },
            publications: { has: async () => false, mark: async () => {} },
            executors: [
                {
                    domain: "provider",
                    execute: async () => {
                        effects.push(savedRevision)
                    },
                },
            ],
        })
        const binding = new TaskAwayConfigurationBinding(
            { read: () => configuration, reconcile: async () => configuration, subscribe: () => () => {} },
            vi.fn(),
        )
        binding.bind(runtime)
        try {
            await expect(binding.activate()).rejects.toThrow("Vault unavailable")
            await expect(binding.activate()).rejects.toThrow("Vault unavailable")
            expect(effects).toEqual([])
            expect(savedRevision).toBe(-1)
            fail = false
            await binding.activate()
            await runtime.waitForQuiescence()
            expect(effects).toEqual([runtime.getState().revision])
        } finally {
            await binding.release()
        }
    })
})
