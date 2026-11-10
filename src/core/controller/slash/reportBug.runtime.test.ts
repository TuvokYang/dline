import { DialogCommandExecutor } from "@core/task/executors/dialog/DialogCommandExecutor"
import { ProductionDialogAdapter } from "@core/task/executors/dialog/ProductionDialogAdapter"
import { type Command, createInitialTaskState, hydrate, type TaskState } from "@core/task/kernel"
import type { MessageStateHandler } from "@core/task/message-state"
import type { RuntimeDiagnostic } from "@core/task/runtime"
import { TaskRuntime } from "@core/task/runtime/TaskRuntime"
import type { ActiveTaskSession } from "@core/task/session/ActiveTaskSession"
import { LocalReportBugContinuation } from "@core/task/session/LocalReportBugContinuation"
import { RestoredToolDialogContinuation } from "@core/task/session/RestoredToolDialogContinuation"
import { TaskInteractionOwner } from "@core/task/session/TaskInteractionOwner"
import { ResumeDialogContinuation } from "@core/task/session/UnownedDialogContinuation"
import { TaskShell } from "@core/task/shell/TaskShell"
import {
    InMemoryCommandPublicationStore,
    InMemoryConversationJournal,
    InMemoryStateVault,
    InMemoryTaskPayloadStore,
    InMemoryTaskViewPort,
} from "@core/task/stores/InMemoryRuntimeStores"
import type { UiMessage } from "@shared/ExtensionMessage"
import { StringRequest } from "@shared/proto/dline/common"
import { DispatchInteractionRequest } from "@shared/proto/dline/task"
import { createReportBugDraft, parseReportBugDraft, reportBugDraftSelection } from "@shared/report-bug"
import { afterEach, describe, expect, it, vi } from "vitest"
import { dispatchInteraction } from "../task/dispatchInteraction"
import { reportBug } from "./reportBug"

const effects = vi.hoisted(() => ({
    open: vi.fn(async () => {}),
    authorized: vi.fn(async () => {}),
    discard: vi.fn(async () => {}),
    issue: vi.fn(async () => "SUP-ABCD-1234"),
}))
vi.mock("@core/reporting/ReportBugIssue", async () => ({
    ...(await vi.importActual<typeof import("@core/reporting/ReportBugIssue")>("@core/reporting/ReportBugIssue")),
    collectReportBugEnvironment: async () => ({
        providerAndModel: "unavailable / unavailable",
        operatingSystem: "test",
        systemInfo: "test",
        dlineVersion: "test",
    }),
    openReportBugIssue: effects.open,
}))
vi.mock("@/services/support/SupportTelemetryService", () => ({
    getSupportTelemetryService: () => ({
        issueAuthorization: effects.issue,
        openAuthorizedIssue: effects.authorized,
        discardAuthorization: effects.discard,
    }),
}))

const runtimes: TaskRuntime[] = []
const owners: TaskInteractionOwner[] = []
afterEach(async () => {
    for (const owner of owners.splice(0)) owner.dispose()
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.disposeDeadlines()))
    vi.useRealTimers()
    vi.clearAllMocks()
})

/** In-memory I/O, but the actual canonical owner, Runtime commit pipeline and dialog executor. */
function harness(
    options: {
        state?: TaskState
        commands?: readonly Command[]
        payloads?: InMemoryTaskPayloadStore
        journal?: InMemoryConversationJournal
    } = {},
) {
    const payloads = options.payloads ?? new InMemoryTaskPayloadStore()
    const vault = new InMemoryStateVault()
    const journal = options.journal ?? new InMemoryConversationJournal()
    const view = new InMemoryTaskViewPort()
    const rows: UiMessage[] = []
    const messages = {
        clineMessages: rows,
        addToClineMessages: async (row: UiMessage) => {
            rows.push(row)
        },
        flushUiMessages: async () => {},
    } as unknown as MessageStateHandler
    let runtime!: TaskRuntime
    const diagnostics: RuntimeDiagnostic[] = []
    const provider = vi.fn(async () => {})
    const resumption = {
        materialize: vi.fn(async () => ({ entryId: "provider-input", payloadRef: "unused" })),
        materializeAnswer: vi.fn(async () => ({ entryId: "provider-answer", payloadRef: "unused" })),
        submit: vi.fn(async () => {
            await provider()
            throw new Error("A local report must not invoke a Provider")
        }),
    }
    const fallback = new RestoredToolDialogContinuation(
        {
            state: () => runtime.getState(),
            payloads,
            journal,
            messages,
            nextPresentationId: () => rows.length + 1,
            admitReply: async () => undefined,
        },
        resumption,
        new ResumeDialogContinuation(resumption),
    )
    const continuation = new LocalReportBugContinuation(
        {
            state: () => runtime.getState(),
            writable: () => runtime.isWritable(),
            payloads,
        },
        fallback,
    )
    const owner = new TaskInteractionOwner(messages, payloads, continuation, { record: (entry) => diagnostics.push(entry) })
    owners.push(owner)
    const dialog = new DialogCommandExecutor(
        new ProductionDialogAdapter({
            taskId: "local-report",
            journal,
            payloads,
            taskView: view,
            readState: () => runtime.getState(),
        }),
        {
            submit: async (event) => {
                const result = await runtime.submit(event)
                return result.kind === "accepted" ? { kind: "accepted" as const, durable: result.receipt.durable } : result
            },
        },
        owner,
    )
    runtime = new TaskRuntime({
        initialState: options.state ?? { ...createInitialTaskState("local-report"), flow: { phase: "running" } },
        restoredOutbox: options.commands,
        vault,
        taskView: view,
        publications: new InMemoryCommandPublicationStore(),
        executors: [dialog, { domain: "provider", execute: provider }, { domain: "compose", execute: provider }],
    })
    runtimes.push(runtime)
    const shell = new TaskShell(runtime, { rearm: async () => {}, forceClose: () => {} })
    const session = {
        taskId: "local-report",
        taskInstanceId: "test-incarnation",
        get writable() {
            return runtime.isWritable()
        },
        state: () => runtime.getState(),
        assembly: { runtime },
        owners: { interactions: owner },
        payloads,
        messages,
        task: shell,
        inputs: { reviewReply: vi.fn(async () => undefined) },
    }
    owner.bind(session as unknown as ActiveTaskSession)
    const controller = {
        task: undefined as unknown,
        stateManager: { getGlobalSettingsKey: () => "act", getApiConfiguration: () => ({}) },
        initTask: vi.fn(async function (this: { task: unknown }) {
            this.task = session
        }),
    }
    const request = (actionId: string, selection?: readonly string[]) => {
        const state = runtime.getState()
        const interaction = state.dialog.primary!
        return DispatchInteractionRequest.create({
            taskId: "local-report",
            taskInstanceId: "test-incarnation",
            turnId: interaction.turnId,
            interactionId: interaction.interactionId,
            stateRevision: state.revision,
            actionId,
            ...(selection ? { selection: { values: [...selection] } } : {}),
        })
    }
    return { controller, session, owner, runtime, vault, rows, payloads, journal, provider, resumption, diagnostics, request }
}

async function flushMicrotasks() {
    for (let index = 0; index < 500; index++) await Promise.resolve()
}

function gate() {
    let release!: () => void
    const promise = new Promise<void>((resolve) => {
        release = resolve
    })
    return { promise, release }
}

async function openLocal(h = harness()) {
    await reportBug(h.controller as never, StringRequest.create({ value: "no profile" }))
    await flushMicrotasks()
    expect(h.runtime.getState().dialog.primary).toMatchObject({ kind: "report_bug", status: "awaiting" })
    return h
}

function editedSelection(h: ReturnType<typeof harness>) {
    const draft = parseReportBugDraft(h.rows.at(-1)?.text)!
    return reportBugDraftSelection(
        createReportBugDraft({ ...draft.content, title: "Edited locally", whatHappened: "Edited details" }, draft.environment),
    )
}

describe("local ReportBug unary with the real Runtime", () => {
    it("returns ready before Confirm and stays ready beyond the 30s unary deadline", async () => {
        vi.useFakeTimers()
        const h = harness()
        let ready = false
        const unary = reportBug(h.controller as never, StringRequest.create({ value: "no profile" }))
        void unary.then(
            () => {
                ready = true
            },
            () => {},
        )
        await flushMicrotasks()
        expect(h.controller.initTask).toHaveBeenCalledWith()
        expect(h.runtime.getState().dialog.primary).toMatchObject({ kind: "report_bug", status: "awaiting" })
        expect((await h.vault.load("local-report"))?.state.dialog.primary?.kind).toBe("report_bug")
        expect(ready).toBe(true)
        await vi.advanceTimersByTimeAsync(31_000)
        expect(effects.open).not.toHaveBeenCalled()
        expect(ready).toBe(true)
        await unary
        expect(effects.authorized).not.toHaveBeenCalled()
        expect(h.provider).not.toHaveBeenCalled()
    })

    it("does not equate presented with ready while the admission receipt is not durable", async () => {
        const h = harness()
        const commit = gate()
        const save = h.vault.save.bind(h.vault)
        vi.spyOn(h.vault, "save").mockImplementationOnce(async (snapshot) => {
            await commit.promise
            await save(snapshot)
        })
        let ready = false
        const unary = reportBug(h.controller as never, StringRequest.create({ value: "no profile" })).then(() => {
            ready = true
        })
        await flushMicrotasks()
        expect(h.rows).toHaveLength(1)
        expect(ready).toBe(false)
        commit.release()
        await unary
        expect(ready).toBe(true)
    })

    it("propagates failed admission durability instead of returning unary success", async () => {
        const h = harness()
        vi.spyOn(h.vault, "save").mockRejectedValue(new Error("Vault unavailable"))
        await expect(reportBug(h.controller as never, StringRequest.create({ value: "no profile" }))).rejects.toThrow(
            "Vault unavailable",
        )
        expect(effects.discard).toHaveBeenCalledWith("SUP-ABCD-1234")
        expect(effects.open).not.toHaveBeenCalled()
        expect(effects.authorized).not.toHaveBeenCalled()
    })

    it("strictly refuses read-only admission before payload or row writes", async () => {
        const h = harness()
        h.runtime.ownershipLost()
        h.controller.task = h.session
        const put = vi.spyOn(h.payloads, "put")
        await expect(reportBug(h.controller as never, StringRequest.create({ value: "no profile" }))).rejects.toThrow(
            "write ownership",
        )
        expect(put).not.toHaveBeenCalled()
        expect(h.rows).toHaveLength(0)
    })

    it("refuses a stale admission after asynchronous payload preparation", async () => {
        const h = harness()
        const pending = gate()
        const put = h.payloads.put.bind(h.payloads)
        vi.spyOn(h.payloads, "put").mockImplementationOnce(async (bytes) => {
            await pending.promise
            return put(bytes)
        })
        const unary = reportBug(h.controller as never, StringRequest.create({ value: "no profile" }))
        const refused = expect(unary).rejects.toThrow("task_disposed")
        await flushMicrotasks()
        h.owner.dispose()
        pending.release()
        await refused
        expect(h.rows).toHaveLength(0)
        expect(h.runtime.getState().dialog.primary).toBeUndefined()
    })

    it("dispatches the actual accepted selection once and rejects a repeated Confirm", async () => {
        const h = await openLocal()
        const request = h.request("approve", editedSelection(h))
        expect(await dispatchInteraction(h.controller as never, request)).toMatchObject({ accepted: true })
        expect(effects.open).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ title: "Edited locally", whatHappened: "Edited details" }),
            expect.any(Object),
        )
        expect(await dispatchInteraction(h.controller as never, request)).toMatchObject({
            accepted: false,
            result: "stale_interaction",
        })
        expect(await h.owner.resolve(request.interactionId, { actionId: "approve" })).toBe(false)
        expect(effects.open).toHaveBeenCalledOnce()
        expect(h.runtime.getState().dialog.primary).toBeUndefined()
        expect(h.resumption.materializeAnswer).not.toHaveBeenCalled()
        expect(h.provider).not.toHaveBeenCalled()
    })

    it("dispatches checked telemetry consent without reissuing authorization", async () => {
        const h = await openLocal()
        const draft = parseReportBugDraft(h.rows.at(-1)?.text)!
        expect(
            await dispatchInteraction(h.controller as never, h.request("approve", reportBugDraftSelection(draft))),
        ).toMatchObject({ accepted: true })
        expect(effects.authorized).toHaveBeenCalledExactlyOnceWith(draft)
        expect(effects.issue).toHaveBeenCalledOnce()
        expect(effects.open).not.toHaveBeenCalled()
        expect(h.provider).not.toHaveBeenCalled()
    })

    it("restores the interrupted question after the local effect without answering it as ordinary input", async () => {
        const h = harness()
        void h.owner
            .open({ turnId: "original-turn", interactionId: "question", kind: "followup", presentation: "Original question" })
            .catch(() => {})
        await flushMicrotasks()
        await openLocal(h)
        expect(h.runtime.getState().dialog.interrupted?.interactionId).toBe("question")
        expect(await dispatchInteraction(h.controller as never, h.request("approve", editedSelection(h)))).toMatchObject({
            accepted: true,
        })
        expect(h.runtime.getState().dialog.primary).toMatchObject({ interactionId: "question", status: "awaiting" })
        expect(h.provider).not.toHaveBeenCalled()
    })

    it("does not execute Confirm without selection or with an invalid canonical draft", async () => {
        const h = await openLocal()
        expect(await dispatchInteraction(h.controller as never, h.request("approve"))).toMatchObject({ accepted: false })
        expect(h.runtime.getState().dialog.primary?.status).toBe("awaiting")
        expect(await dispatchInteraction(h.controller as never, h.request("approve", ["not-a-report-draft"]))).toMatchObject({
            accepted: false,
        })
        expect(h.runtime.getState().dialog.primary?.status).toBe("awaiting")
        expect(effects.open).not.toHaveBeenCalled()
        expect(effects.authorized).not.toHaveBeenCalled()
        expect(h.provider).not.toHaveBeenCalled()
    })

    it("cancels without selection using the persisted authorization, never Provider input", async () => {
        const h = await openLocal()
        expect(await dispatchInteraction(h.controller as never, h.request("reject"))).toMatchObject({ accepted: true })
        expect(effects.discard).toHaveBeenCalledExactlyOnceWith("SUP-ABCD-1234")
        expect(effects.open).not.toHaveBeenCalled()
        expect(effects.authorized).not.toHaveBeenCalled()
        expect(h.provider).not.toHaveBeenCalled()
    })

    it.each([
        "approve",
        "reject",
    ])("hydrates a standalone no-tool-block preview and handles %s without a Provider", async (action) => {
        const original = await openLocal()
        const selection = editedSelection(original)
        await original.runtime.waitForQuiescence()
        const snapshot = (await original.vault.load("local-report"))!
        original.owner.dispose()
        const restored = hydrate({
            taskId: "local-report",
            snapshot: snapshot.state,
            journalTail: original.journal.watermark(),
            openReason: "crash_recovery",
        })
        expect(restored.rebuilt).toBe(false)
        expect(restored.state.turn.blocks).toHaveLength(0)
        const h = harness({
            state: restored.state,
            commands: restored.initialCommands,
            payloads: original.payloads,
            journal: original.journal,
        })
        h.controller.task = h.session
        await flushMicrotasks()
        expect(h.runtime.getState().dialog.primary).toMatchObject({ kind: "report_bug", status: "awaiting" })
        expect(
            await dispatchInteraction(h.controller as never, h.request(action, action === "approve" ? selection : undefined)),
        ).toMatchObject({ accepted: true })
        expect(effects.issue).toHaveBeenCalledOnce()
        expect(effects.open).toHaveBeenCalledTimes(action === "approve" ? 1 : 0)
        expect(effects.discard).toHaveBeenCalledTimes(action === "reject" ? 1 : 0)
        expect(h.provider).not.toHaveBeenCalled()
        expect(h.resumption.materializeAnswer).not.toHaveBeenCalled()
    })

    it("does not automatically replay an accepted pre-crash answer before a restored explicit Confirm", async () => {
        const original = await openLocal()
        const selection = editedSelection(original)
        const pending = gate()
        const read = original.payloads.read.bind(original.payloads)
        vi.spyOn(original.payloads, "read").mockImplementationOnce(async (ref) => {
            await pending.promise
            return read(ref)
        })
        const dispatch = dispatchInteraction(original.controller as never, original.request("approve", selection))
        await flushMicrotasks()
        const snapshot = (await original.vault.load("local-report"))!
        expect(snapshot.state.dialog.primary).toMatchObject({ status: "resolving", acceptedResponse: { actionId: "approve" } })
        original.owner.dispose()
        pending.release()
        expect(await dispatch).toMatchObject({ accepted: false })
        const restored = hydrate({
            taskId: "local-report",
            snapshot: snapshot.state,
            journalTail: original.journal.watermark(),
            openReason: "crash_recovery",
        })
        const h = harness({
            state: restored.state,
            commands: restored.initialCommands,
            payloads: original.payloads,
            journal: original.journal,
        })
        h.controller.task = h.session
        await flushMicrotasks()
        expect(effects.open).not.toHaveBeenCalled()
        expect(h.runtime.getState().dialog.primary?.status).toBe("awaiting")
        expect(await dispatchInteraction(h.controller as never, h.request("approve", selection))).toMatchObject({
            accepted: true,
        })
        expect(effects.open).toHaveBeenCalledOnce()
        expect(h.provider).not.toHaveBeenCalled()
    })

    it("reopens an effect failure and reports it; the same task can answer again", async () => {
        const h = await openLocal()
        effects.open.mockRejectedValueOnce(new Error("Browser unavailable"))
        expect(await dispatchInteraction(h.controller as never, h.request("approve", editedSelection(h)))).toMatchObject({
            accepted: false,
        })
        expect(h.runtime.getState().dialog.primary?.status).toBe("awaiting")
        expect(h.diagnostics).toContainEqual(expect.objectContaining({ code: "unowned_dialog_settled", severity: "failure" }))
        expect(await dispatchInteraction(h.controller as never, h.request("approve", editedSelection(h)))).toMatchObject({
            accepted: true,
        })
        expect(effects.open).toHaveBeenCalledTimes(2)
        expect(h.provider).not.toHaveBeenCalled()
    })

    it("does not double-execute a concurrent Confirm while its effect is in flight", async () => {
        const h = await openLocal()
        const pending = gate()
        effects.open.mockImplementationOnce(async () => pending.promise)
        const request = h.request("approve", editedSelection(h))
        const first = dispatchInteraction(h.controller as never, request)
        await flushMicrotasks()
        expect(effects.open).toHaveBeenCalledOnce()
        expect(await dispatchInteraction(h.controller as never, request)).toMatchObject({ accepted: false })
        pending.release()
        expect(await first).toMatchObject({ accepted: true })
        expect(effects.open).toHaveBeenCalledOnce()
    })

    it.each([
        "dispose",
        "ownership",
        "generation",
    ])("does not start a late effect after %s fences an asynchronous continuation", async (fence) => {
        const h = await openLocal()
        const request = h.request("approve", editedSelection(h))
        const pending = gate()
        const read = h.payloads.read.bind(h.payloads)
        vi.spyOn(h.payloads, "read").mockImplementationOnce(async (ref) => {
            await pending.promise
            return read(ref)
        })
        const dispatch = dispatchInteraction(h.controller as never, request)
        await flushMicrotasks()
        if (fence === "dispose") h.owner.dispose()
        else if (fence === "ownership") h.runtime.ownershipLost()
        else await h.runtime.submit({ type: "user.cancel", generation: h.runtime.getState().generation, haltId: "fence-local" })
        pending.release()
        expect(await dispatch).toMatchObject({ accepted: false })
        expect(effects.open).not.toHaveBeenCalled()
        expect(effects.authorized).not.toHaveBeenCalled()
        expect(h.provider).not.toHaveBeenCalled()
    })
})
