import type { Controller } from "@core/controller"
import { dispatchInteraction } from "@core/controller/task/dispatchInteraction"
import type { MessageStateHandler } from "@core/task/message-state"
import { DispatchInteractionRequest } from "@shared/proto/dline/task"
import { expect, it, vi } from "vitest"
import { ProductionComposeAdapter } from "../executors/compose/ProductionComposeAdapter"
import { JournalConversationView } from "../executors/provider/service/JournalConversationView"
import { ProviderJournalMessageMaterializer } from "../executors/provider/service/ProviderJournalMessageMaterializer"
import { createDeniedSurface } from "../executors/tool/ToolDomainSurface"
import { TurnToolScheduler } from "../executors/tool/TurnToolScheduler"
import type { TaskRuntime } from "../runtime"
import type { ActiveTaskSession } from "../session/ActiveTaskSession"
import { TaskInteractionOwner } from "../session/TaskInteractionOwner"
import {
    InMemoryCommandPublicationStore,
    InMemoryConversationJournal,
    InMemoryStateVault,
    InMemoryTaskPayloadStore,
    InMemoryTaskViewPort,
} from "../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { ProviderDraftEnvelope } from "../stores/payload/TaskPayloadEnvelopes"
import { openTaskShell } from "./TaskShellFactory"

// A real failed compose must not let a live empty Retry duplicate its committed
// materials merely because the derived draft was unavailable until the click.
it("recovers the original prepared round on live dispatcher Retry after persistent draft writes recover", async () => {
    const payloads = new InMemoryTaskPayloadStore()
    const journal = new InMemoryConversationJournal()
    const vault = new InMemoryStateVault()
    const view = new JournalConversationView(journal, new ProviderJournalMessageMaterializer(payloads))
    let fail = true
    const put = payloads.put.bind(payloads)
    vi.spyOn(payloads, "put").mockImplementation(async (bytes) => {
        if (fail && decodeTaskPayload<{ kind: string }>(bytes).kind === "provider_draft")
            throw new Error("Draft disk unavailable")
        return put(bytes)
    })
    let runtime!: TaskRuntime
    const adapter = new ProductionComposeAdapter({ payloads, journal, readState: () => runtime.getState() })
    const compose = vi.spyOn(adapter, "compose")
    const sent: ProviderDraftEnvelope[] = []
    const opened = await openTaskShell({
        taskId: "retry",
        openReason: "new",
        taskView: new InMemoryTaskViewPort(),
        persistence: { payloads, ports: { vault, journal, publications: new InMemoryCommandPublicationStore() } },
        execution: {
            compose: adapter,
            provider: {
                execution: {
                    start: async function* (input) {
                        sent.push(decodeTaskPayload<ProviderDraftEnvelope>(await payloads.read(input.draftRef)))
                    },
                },
            },
            compaction: { run: async () => ({ resultRef: "compacted" }) },
            policy: { evaluate: async () => ({ approved: true }) },
            dialog: {
                execution: {
                    prepare: async () => ({
                        journalRef: "journal:0",
                        journalWatermark: { seq: 0 },
                        receiverGeneration: 0,
                        disposition: "existing",
                    }),
                    reveal: async () => ({ disposition: "revealed" }),
                },
            },
            tool: {
                runner: { runBlock: async () => undefined, release: async () => undefined },
                surface: createDeniedSurface("detached_domain"),
                scheduler: new TurnToolScheduler({ readConfiguredLimit: () => undefined }),
            },
        },
    })
    runtime = opened.runtime
    await opened.shell.open()
    await runtime.submit({
        type: "away.configured",
        generation: runtime.getState().generation,
        configuration: { enabled: true, automatic: false, modeRevocation: 0, automaticRevocation: 0 },
    })
    const inputRef = await payloads.put(encodeTaskPayload({ kind: "user_input", text: "repair" }))
    await runtime.submit({
        type: "user.submit",
        generation: runtime.getState().generation,
        entryId: "input",
        payloadRef: inputRef,
        userControl: { kind: "enter_away" },
    })
    await runtime.waitForQuiescence()
    expect(sent).toEqual([])
    const before = runtime.getState()
    const checkpoint = await journal.findByOperation(`compose.prepared:${before.flow.compose!.commandId}`)
    expect(checkpoint).toBeDefined()
    expect(before.dialog.primary).toMatchObject({ kind: "error_retry", status: "awaiting" })
    const rows = { clineMessages: [], addToClineMessages: vi.fn(), flushUiMessages: vi.fn() } as unknown as MessageStateHandler
    const owner = new TaskInteractionOwner(rows, payloads, { accepts: () => false, continue: async () => "declined" })
    const session = {
        taskId: "retry",
        taskInstanceId: "opening",
        writable: true,
        state: () => runtime.getState(),
        task: opened.shell,
        assembly: opened.assembly,
        payloads,
        messages: rows,
        inputs: { reviewReply: async () => undefined },
        owners: { interactions: owner },
    } as unknown as ActiveTaskSession
    owner.bind(session)
    fail = false
    const interaction = before.dialog.primary!
    const response = await dispatchInteraction(
        { task: session, postStateToWebview: async () => {} } as unknown as Controller,
        DispatchInteractionRequest.create({
            taskId: "retry",
            taskInstanceId: "opening",
            turnId: interaction.turnId,
            interactionId: interaction.interactionId,
            stateRevision: before.revision,
            actionId: "retry",
            draft: { text: "", images: [], files: [] },
        }),
    )
    expect(response.accepted).toBe(true)
    await runtime.waitForQuiescence()
    expect(sent).toHaveLength(1)
    expect(sent[0].materialPlan?.id).toBe(before.flow.compose!.materialPlan!.id)
    expect(sent[0].journalThrough).toEqual(checkpoint!.watermark)
    expect(compose).toHaveBeenCalledTimes(1)
    expect((await view.entries()).filter((entry) => entry.kind === "round_active_away")).toHaveLength(1)
    expect((await view.entries()).filter((entry) => entry.kind === "round_material_input")).toHaveLength(1)
    await runtime.disposeDeadlines()
})
