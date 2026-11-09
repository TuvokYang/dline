import { afterEach, describe, expect, it, vi } from "vitest"
import { createInitialTaskState, transition } from "../../kernel"
import type { Command, TaskEvent, TaskState } from "../../kernel/types"
import { TaskShell } from "../../shell/TaskShell"
import type { DurableTaskSnapshot } from "../../stores/contracts"
import { TaskRuntime } from "../TaskRuntime"

type EventInput<T = TaskEvent> = T extends TaskEvent ? Omit<T, "generation"> : never
const configuration = { enabled: true, automatic: true, modeRevocation: 0, automaticRevocation: 0 }
function step(state: TaskState, event: EventInput) {
    const result = transition(state, { ...event, generation: state.generation } as TaskEvent)
    if (result.kind === "rejected") throw new Error(result.diagnostic.message)
    return result
}
function awaiting(
    automatic = true,
    timing: { readonly now?: number } = { now: 1000 },
    kind: "followup" | "command_approval" = "followup",
): TaskState {
    let state: TaskState = { ...createInitialTaskState("deadline"), flow: { phase: "running" } }
    state = step(state, { type: "away.configured", configuration: { ...configuration, automatic } }).state
    const requested = step(state, {
        type: "dialog.requested",
        interactionId: "question",
        turnId: "turn",
        kind,
        now: timing.now,
        presentationRef: "question-body",
        actionRules: [{ actionId: kind === "followup" ? "reply" : "approve", payloadPolicy: "draft" }],
    })
    const prepare = requested.commands.find((c) => c.type === "dialog.prepare")!
    const prepared = step(requested.state, {
        type: "dialog.prepared",
        interactionId: "question",
        commandId: prepare.commandId,
        originRevision: prepare.originRevision,
        journalRef: "journal:1",
        receiverGeneration: 0,
    })
    const reveal = prepared.commands.find((c) => c.type === "dialog.reveal")!
    return step(prepared.state, {
        type: "dialog.presented",
        interactionId: "question",
        commandId: reveal.commandId,
        originRevision: reveal.originRevision,
    }).state
}
function runtime(
    state: TaskState,
    options: {
        readonly?: boolean
        hold?: boolean
        outbox?: readonly Command[]
        failSave?: () => boolean
        failDelivery?: () => boolean
    } = {},
) {
    let saved: DurableTaskSnapshot | undefined
    const deliveries: DurableTaskSnapshot[] = []
    const effects: TaskState[] = []
    const published: Command[] = []
    let instance: TaskRuntime
    instance = new TaskRuntime({
        initialState: state,
        deferRestoredCommands: options.readonly,
        holdRestoredCommands: options.hold,
        restoredOutbox: options.outbox,
        vault: {
            load: async () => saved,
            save: async (snapshot) => {
                if (options.failSave?.()) throw new Error("Vault unavailable")
                saved = snapshot
            },
        },
        taskView: { notifyCommitted: async () => {}, notifyTransient: () => {} },
        publications: {
            has: async () => false,
            mark: async (command) => {
                published.push(command)
            },
        },
        executors: [
            { domain: "dialog", execute: async () => {} },
            {
                domain: "provider",
                execute: async () => {
                    effects.push(instance.getState())
                },
            },
            {
                domain: "compose",
                execute: async () => {
                    effects.push(instance.getState())
                },
            },
        ],
        automaticResponses: {
            deliver: async () => {
                if (!saved) throw new Error("Delivery before commit")
                if (options.failDelivery?.()) throw new Error("Delivery storage unavailable")
                deliveries.push(saved)
            },
        },
    })
    return { instance, deliveries, effects, published, saved: () => saved }
}
const runtimes: TaskRuntime[] = []
afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((r) => r.disposeDeadlines()))
    vi.useRealTimers()
})

describe("Runtime-owned Away deadlines", () => {
    it.each([
        "command",
        "ask_timeout",
    ] as const)("durably stops %s Away without changing execution or answering the dialog", async (source) => {
        const original = awaiting()
        const state: TaskState = {
            ...original,
            away: { configuration, mode: { source, enteredRevision: original.revision, modeRevocation: 0 } },
        }
        const r = runtime(state)
        runtimes.push(r.instance)
        const halt = { rearm: vi.fn(), forceClose: vi.fn() }
        const presentation = { prepare: vi.fn() }
        const shell = new TaskShell(r.instance, halt, presentation)
        await shell.stopAway()
        expect(r.saved()?.state.away?.mode).toBeUndefined()
        expect(r.saved()?.state.flow).toEqual(state.flow)
        expect(r.saved()?.state.dialog.primary).toEqual(state.dialog.primary)
        expect(r.saved()?.state.roundMaterial?.notices).toMatchObject([{ reason: "stopped" }])
        expect(r.effects).toEqual([])
        expect(halt.rearm).not.toHaveBeenCalled()
        expect(presentation.prepare).not.toHaveBeenCalled()
        await shell.stopAway()
        expect(r.saved()?.state.roundMaterial?.notices).toHaveLength(1)
    })

    it("rejects a read-only stop and allows retry after a failed durable stop", async () => {
        const state: TaskState = {
            ...awaiting(),
            away: { configuration, mode: { source: "command", enteredRevision: 1, modeRevocation: 0 } },
        }
        let fail = true
        const r = runtime(state, { readonly: true, failSave: () => fail })
        runtimes.push(r.instance)
        const shell = new TaskShell(r.instance, { rearm: vi.fn(), forceClose: vi.fn() })
        expect(await shell.stopAway()).toMatchObject({ kind: "rejected", reason: "read_only" })
        expect(r.saved()).toBeUndefined()
        r.instance.grantWriteOwnership()
        await expect(shell.stopAway()).rejects.toThrow("Vault unavailable")
        expect(r.saved()).toBeUndefined()
        fail = false
        await shell.stopAway()
        expect(r.saved()?.state.away?.mode).toBeUndefined()
        expect(r.saved()?.state.roundMaterial?.notices).toHaveLength(1)
    })

    it.each([
        "followup",
        "command_approval",
    ] as const)("commits the absolute ten-minute %s timeout before delivery without repeating", async (kind) => {
        vi.useFakeTimers()
        vi.setSystemTime(1000)
        const state = awaiting(true, { now: 1000 }, kind)
        expect(state.dialog.primary?.deadline?.deadlineAt).toBe(601000)
        const r = runtime(state)
        runtimes.push(r.instance)
        r.instance.allowRestoredCommands()
        expect(vi.getTimerCount()).toBe(1)
        await vi.advanceTimersByTimeAsync(599999)
        expect(r.deliveries).toEqual([])
        await vi.advanceTimersByTimeAsync(1)
        await r.instance.waitForQuiescence()
        expect(r.deliveries).toHaveLength(1)
        expect(r.deliveries[0].state.away?.mode?.source).toBe("ask_timeout")
        expect(r.deliveries[0].state.dialog.primary).toMatchObject({
            status: "resolving",
            acceptedResponse: { origin: "timeout", actionId: kind === "followup" ? "reply" : "reject" },
        })
        expect(r.instance.getState().dialog.primary?.deadline).toBeUndefined()
        await vi.advanceTimersByTimeAsync(600000)
        expect(r.deliveries).toHaveLength(1)
        expect(vi.getTimerCount()).toBe(0)
    })

    it.each([
        "persistent",
        "closed",
        "ownership_lost",
    ] as const)("bounds automatic delivery recovery and retains the accepted identity on %s failure", async (failure) => {
        vi.useFakeTimers()
        vi.setSystemTime(1000)
        let attempts = 0
        const state = awaiting()
        const r = runtime(state, {
            failDelivery: () => {
                attempts++
                if (failure === "closed") r.instance.beginClose()
                if (failure === "ownership_lost") r.instance.ownershipLost()
                return true
            },
        })
        runtimes.push(r.instance)
        r.instance.allowRestoredCommands()
        await vi.advanceTimersByTimeAsync(600000)
        await r.instance.waitForQuiescence()
        expect(attempts).toBe(failure === "persistent" ? 3 : 1)
        expect(r.deliveries).toEqual([])
        expect(r.published).toEqual([])
        expect(r.instance.getState().dialog.primary).toMatchObject({
            interactionId: "question",
            status: "resolving",
            acceptedResponse: { origin: "timeout" },
        })
        expect(r.instance.getState().dialog.primary?.deadline).toBeUndefined()
        if (failure === "persistent") {
            const configured = await r.instance.submit({ type: "away.configured", generation: 0, configuration })
            if (configured.kind !== "accepted") throw new Error("Configuration refused")
            await configured.receipt.durable
            expect(r.saved()?.outbox).toMatchObject([
                { type: "dialog.deliver_automatic", interactionId: "question", turnId: "turn", generation: 0 },
            ])
        }
        await vi.advanceTimersByTimeAsync(600000)
        expect(attempts).toBe(failure === "persistent" ? 3 : 1)
    })

    it.each([
        undefined,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
    ])("does not arm an ask without a finite event clock (%s)", async (now) => {
        vi.useFakeTimers()
        vi.setSystemTime(1000)
        const state = awaiting(true, { now })
        expect(state.dialog.primary?.deadline).toBeUndefined()
        const r = runtime(state)
        runtimes.push(r.instance)
        r.instance.allowRestoredCommands()
        expect(vi.getTimerCount()).toBe(0)
        await vi.advanceTimersByTimeAsync(700000)
        expect(r.deliveries).toEqual([])
        expect(r.instance.getState()).toBe(state)
    })

    it.each(["deadline", "receiverGeneration"] as const)("does not schedule an interaction missing %s", async (missing) => {
        vi.useFakeTimers()
        vi.setSystemTime(1000)
        const original = awaiting()
        const primary = original.dialog.primary
        if (!primary) throw new Error("Missing prepared question")
        const state: TaskState = {
            ...original,
            dialog: { ...original.dialog, primary: { ...primary, [missing]: undefined } },
        }
        const r = runtime(state)
        runtimes.push(r.instance)
        r.instance.allowRestoredCommands()
        expect(vi.getTimerCount()).toBe(0)
        await vi.advanceTimersByTimeAsync(700000)
        expect(r.deliveries).toEqual([])
        expect(r.instance.getState()).toBe(state)
    })

    it.each([
        "followup",
        "command_approval",
    ] as const)("lets only one of a human response and the due event settle %s", (kind) => {
        const state = awaiting(true, { now: 1000 }, kind)
        const due: TaskEvent = {
            type: "away.deadline_due",
            generation: 0,
            interactionId: "question",
            turnId: "turn",
            receiverGeneration: 0,
            deadlineAt: 601000,
            now: 601000,
        }
        const human: TaskEvent = {
            type: "dialog.responded",
            generation: 0,
            taskId: state.taskId,
            interactionId: "question",
            turnId: "turn",
            stateRevision: state.revision,
            receiverGeneration: 0,
            actionId: kind === "followup" ? "reply" : "approve",
            draftRef: "answer",
        }
        const firstHuman = transition(state, human)
        const firstDue = transition(state, due)
        expect(firstHuman.kind).toBe("accepted")
        expect(firstDue.kind).toBe("accepted")
        if (firstHuman.kind !== "accepted" || firstDue.kind !== "accepted") return
        expect(transition(firstHuman.state, due).kind).toBe("rejected")
        expect(transition(firstDue.state, human).kind).toBe("rejected")
        expect(firstHuman.state.away?.mode).toBeUndefined()
        expect(firstDue.state.away?.mode?.source).toBe("ask_timeout")
    })

    it.each(["followup", "command_approval"] as const)("does not retroactively arm %s after enabling automatic Away", (kind) => {
        const state = awaiting(false, { now: 1000 }, kind)
        const enabled = step(state, { type: "away.configured", configuration }).state
        expect(enabled.dialog.primary?.deadline).toBeUndefined()
    })

    it.each(["followup", "command_approval"] as const)("revokes the %s deadline without restoring it on reopen", (kind) => {
        const state = awaiting(true, { now: 1000 }, kind)
        const closed = step(state, {
            type: "away.configured",
            configuration: { ...configuration, automatic: false, automaticRevocation: 1 },
        }).state
        const reopened = step(closed, {
            type: "away.configured",
            configuration: { ...configuration, automaticRevocation: 1 },
        }).state
        expect(closed.dialog.primary?.status).toBe("awaiting")
        expect(reopened.dialog.primary?.deadline).toBeUndefined()
    })

    it.each(["paused", "readonly", "closed"] as const)("does not fire in a %s session", async (kind) => {
        vi.useFakeTimers()
        vi.setSystemTime(1000)
        const original = awaiting()
        const state: TaskState = kind === "paused" ? { ...original, flow: { phase: "paused" } } : original
        const r = runtime(state, { readonly: kind === "readonly" })
        runtimes.push(r.instance)
        r.instance.allowRestoredCommands()
        if (kind === "closed") r.instance.beginClose()
        await vi.advanceTimersByTimeAsync(700000)
        expect(r.instance.getState().revision).toBe(state.revision)
        expect(r.deliveries).toEqual([])
        expect(r.saved()).toBeUndefined()
        expect(vi.getTimerCount()).toBe(0)
    })

    it.each([
        "closed",
        "readonly",
        "revoked",
    ] as const)("rechecks %s permission after an in-flight submission awaits durability recovery", async (kind) => {
        const state = awaiting()
        const r = runtime(state)
        runtimes.push(r.instance)
        const pending = r.instance.submit({
            type: "away.deadline_due",
            generation: 0,
            interactionId: "question",
            turnId: "turn",
            receiverGeneration: 0,
            deadlineAt: 601000,
            now: 601000,
        })
        if (kind === "closed") r.instance.beginClose()
        else if (kind === "readonly") r.instance.ownershipLost()
        else r.instance.setAutomationPermissionFence(() => false)
        expect((await pending).kind).toBe("rejected")
        await r.instance.waitForQuiescence()
        expect(r.instance.getState()).toBe(state)
        expect(r.saved()).toBeUndefined()
        expect(r.deliveries).toEqual([])
    })

    it("keeps held restored commands in every configuration snapshot until the bootstrap barrier opens", async () => {
        const state = awaiting()
        const command: Command = {
            type: "provider.start",
            commandId: "held-provider",
            originRevision: state.revision,
            generation: 0,
            draftRef: "draft",
        }
        const r = runtime(state, { hold: true, outbox: [command] })
        runtimes.push(r.instance)
        const result = await r.instance.submit({ type: "away.configured", generation: 0, configuration })
        if (result.kind !== "accepted") throw new Error("Configuration refused")
        await result.receipt.durable
        expect(r.saved()?.outbox).toEqual([command])
        expect(r.effects).toEqual([])
        r.instance.allowRestoredCommands()
        await r.instance.waitForQuiescence()
        expect(r.effects).toHaveLength(1)
    })

    it("does not let a failed commit retry release recovered effects before bootstrap reconciliation", async () => {
        let fail = true
        const r = runtime(createInitialTaskState("bootstrap-retry"), { hold: true, failSave: () => fail })
        runtimes.push(r.instance)
        const submitted = await r.instance.submit({ type: "user.submit", generation: 0, entryId: "input", payloadRef: "input" })
        if (submitted.kind !== "accepted") throw new Error("Input refused")
        await expect(submitted.receipt.durable).rejects.toThrow("Vault unavailable")
        fail = false
        const configured = await r.instance.submit({ type: "away.configured", generation: 0, configuration })
        if (configured.kind !== "accepted") throw new Error("Configuration refused")
        await configured.receipt.durable
        await r.instance.waitForQuiescence()
        expect(r.effects).toEqual([])
        r.instance.allowRestoredCommands()
        await r.instance.waitForQuiescence()
        expect(r.effects).toHaveLength(1)
    })

    it("holds restored effects through the separate bootstrap barrier even after writer ownership is granted", async () => {
        const base = awaiting()
        const state = step(base, {
            type: "user.submit",
            entryId: "away",
            payloadRef: "away-input",
            userControl: { kind: "enter_away" },
        }).state
        const r = runtime(state, {
            readonly: true,
            hold: true,
            outbox: [
                {
                    type: "provider.start",
                    commandId: "restored",
                    originRevision: state.revision,
                    generation: 0,
                    draftRef: "old-draft",
                },
            ],
        })
        runtimes.push(r.instance)
        r.instance.grantWriteOwnership()
        r.instance.releaseRestoredCommands()
        await r.instance.waitForQuiescence()
        expect(r.effects).toEqual([])
        const configured = await r.instance.submit({
            type: "away.configured",
            generation: 0,
            configuration: { ...configuration, modeRevocation: 1, automaticRevocation: 1 },
        })
        if (configured.kind !== "accepted") throw new Error("Configuration rejected")
        await configured.receipt.durable
        r.instance.allowRestoredCommands()
        await r.instance.waitForQuiescence()
        expect(r.effects).toHaveLength(1)
        expect(r.effects[0].away?.mode).toBeUndefined()
        expect(r.effects[0].roundMaterial?.notices).toMatchObject([{ reason: "configuration_revoked" }])
    })
})
