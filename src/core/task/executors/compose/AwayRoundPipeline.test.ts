import { LegacyInputAdapter } from "@core/input-semantics/LegacyInputAdapter"
import { SemanticInputAdmissionService } from "@core/input-semantics/SemanticInputAdmissionService"
import { TaskCommandExpander } from "@core/input-semantics/TaskEntityResolvers"
import { TaskSemanticInputAdmission } from "@core/input-semantics/TaskSemanticInputAdmission"
import { BUILTIN_INPUT_SEMANTICS } from "@shared/input-semantics/catalog"
import type { SemanticResourceRef } from "@shared/input-semantics/document"
import { InputSemanticCatalog as WireCatalog } from "@shared/proto/dline/slash"
import { fromProtoInputSemanticCatalog, toProtoInputSemanticCatalog } from "@shared/proto-conversions/input-semantics/catalog"
import { describe, expect, it, vi } from "vitest"
import { createCommandAtom, createMentionAtom } from "../../../../../webview-ui/src/components/chat/input/semantic-composer/atoms"
import type { ComposerSegment } from "../../../../../webview-ui/src/components/chat/input/semantic-composer/model"
import { composeComposerSubmission } from "../../../../../webview-ui/src/components/chat/input/semantic-composer/projection"
import { serializeDurableToolResult } from "../../DurableToolResult"
import { createInitialTaskState, type TaskState } from "../../kernel"
import { TaskRuntime } from "../../runtime"
import { TaskInputMaterializer } from "../../session/TaskInputMaterializer"
import { TaskShell } from "../../shell/TaskShell"
import {
    InMemoryCommandPublicationStore,
    InMemoryConversationJournal,
    InMemoryStateVault,
    InMemoryTaskPayloadStore,
    InMemoryTaskViewPort,
} from "../../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type {
    DialogDraftEnvelope,
    ProviderDraftEnvelope,
    ToolInvocationEnvelope,
} from "../../stores/payload/TaskPayloadEnvelopes"
import type { TaskEventSink } from "../contracts"
import { JournalConversationView } from "../provider/service/JournalConversationView"
import { ProviderJournalMessageMaterializer } from "../provider/service/ProviderJournalMessageMaterializer"
import { ComposeCommandExecutor } from "./ComposeCommandExecutor"
import { ProductionComposeAdapter } from "./ProductionComposeAdapter"

vi.mock("@/services/telemetry", () => ({ telemetryService: { captureSlashCommandUsed: vi.fn() } }))
// The mention I/O port is injected below; do not boot unused editor diagnostics.
vi.mock("@core/mentions", () => ({ resolveMention: vi.fn() }))
// Other slash commands use this host; Away uses only its typed expansion.
vi.mock("@core/storage/StateManager", () => ({ StateManager: class {} }))
// Extraction is an external format boundary; ordering and resource projection stay real.
vi.mock("@integrations/misc/extract-resource-text", () => ({
    extractResourceText: async () => ({ text: "PDF attachment body", pageCount: 1 }),
    UnsupportedResourceMediaTypeError: class extends Error {},
}))

const imageId = "4f9c2b2e-8d3a-4c1e-9b6a-2f1e3d4c5b6a"
const pdfId = "4f9c2b2e-8d3a-4c1e-9b6a-2f1e3d4c5b6b"
const bytes = new Map([
    [imageId, Buffer.from("pixels")],
    [pdfId, Buffer.from("%PDF-1.4 fixture")],
])
const configuration = { enabled: true, automatic: false, modeRevocation: 0, automaticRevocation: 0 }

async function harness(native: boolean, approval: boolean) {
    const payloads = new InMemoryTaskPayloadStore()
    const journal = new InMemoryConversationJournal()
    const vault = new InMemoryStateVault()
    const invocation: ToolInvocationEnvelope = {
        kind: "tool_invocation",
        toolName: "read_file",
        input: { path: "a.ts" },
        functionId: "call",
        dlineTid: "block",
        presentationId: 1,
        isNativeToolCall: native,
        ...(native ? {} : { resultReplay: "text" as const }),
    }
    const invocationRef = await payloads.put(encodeTaskPayload(invocation))
    await journal.append({
        operationId: "provider.final:previous",
        source: "provider",
        payloadRef: await payloads.put(
            encodeTaskPayload({
                kind: "provider_final",
                content: native
                    ? [{ type: "tool_use", function_id: "call", dline_tid: "block", name: "read_file", input: { path: "a.ts" } }]
                    : [{ type: "text", text: "<read_file><path>a.ts</path></read_file>" }],
            }),
        ),
        causation: { turnId: "previous" },
    })
    const base = createInitialTaskState("round")
    const initialState: TaskState = {
        ...base,
        flow: { phase: "running" },
        away: { configuration, mode: { source: "command", enteredRevision: 0, modeRevocation: 0 } },
        turn: {
            ...base.turn,
            turnId: "previous",
            blocks: [
                {
                    blockId: "block",
                    index: 0,
                    lanes: [],
                    turnEnding: false,
                    phase: approval ? "awaiting_approval" : "completed",
                    attempt: "attempt",
                    invocationRef,
                },
            ],
            executingBlockIds: [],
            manualApprovalBlockIds: approval ? ["block"] : [],
        },
        dialog: {
            approvalsByBlock: approval
                ? {
                      block: {
                          blockId: "block",
                          interactionId: "approval",
                          turnId: "previous",
                          kind: "tool_approval",
                          status: "awaiting",
                          receiverGeneration: 0,
                          createdRevision: 0,
                          presentationRef: "presentation",
                          actionRules: [
                              { actionId: "approve", payloadPolicy: "draft" },
                              { actionId: "reject", payloadPolicy: "draft" },
                          ],
                      },
                  }
                : {},
        },
    }
    const recordResult = async () => {
        const raw = await payloads.put(
            encodeTaskPayload({
                kind: "tool_result",
                blockId: "block",
                content: serializeDurableToolResult(
                    {
                        type: "tool_result",
                        function_id: "call",
                        dline_tid: "block",
                        content: [{ type: "text", text: "READ_RESULT" }],
                    },
                    native ? undefined : { kind: "text", toolName: "read_file" },
                ),
            }),
        )
        await journal.append({
            operationId: "tool.result:block",
            source: "tool",
            payloadRef: raw,
            causation: { turnId: "previous" },
        })
    }
    if (!approval) await recordResult()
    let runtime!: TaskRuntime
    const failures: string[] = []
    const events: TaskEventSink = {
        submit: async (event) => {
            const result = await runtime.submit(event)
            if (result.kind === "rejected") {
                failures.push(`${event.type}:${result.diagnostic.message}`)
                return { kind: "rejected" }
            }
            return {
                kind: "accepted",
                durable: result.receipt.durable,
                ...(event.type === "compose.freeze_requested" ? { materialPlan: result.state.flow.compose!.materialPlan! } : {}),
            }
        },
    }
    const adapter = new ProductionComposeAdapter({
        payloads,
        journal,
        readState: () => runtime.getState(),
        environment: { render: async () => "environment" },
        subagentsAvailable: async () => false,
    })
    const sent: ProviderDraftEnvelope[] = []
    runtime = new TaskRuntime({
        initialState,
        vault,
        taskView: new InMemoryTaskViewPort(),
        publications: new InMemoryCommandPublicationStore(),
        diagnostics: {
            record: (entry) => {
                if (entry.severity === "failure") failures.push(entry.message)
            },
        },
        executors: [
            new ComposeCommandExecutor(adapter, events),
            { domain: "tool", execute: async () => {} },
            { domain: "dialog", execute: async () => {} },
            {
                domain: "provider",
                execute: async (command) => {
                    if (command.type === "provider.start")
                        sent.push(decodeTaskPayload<ProviderDraftEnvelope>(await payloads.read(command.draftRef)))
                },
            },
        ],
    })
    const catalog = fromProtoInputSemanticCatalog(
        WireCatalog.decode(
            WireCatalog.encode(toProtoInputSemanticCatalog({ revision: 1, descriptors: BUILTIN_INPUT_SEMANTICS })).finish(),
        ),
    )
    let identity = 0
    const legacy = new LegacyInputAdapter(
        async () => catalog,
        () => `document:${++identity}`,
    )
    const admission = new TaskSemanticInputAdmission(
        legacy,
        new SemanticInputAdmissionService({
            catalog: () => catalog,
            commands: new TaskCommandExpander(() => ({
                localWorkflowToggles: {},
                globalWorkflowToggles: {},
                taskIncarnationId: "round",
            })),
            mentions: { resolve: async () => "MENTION_BODY" },
            resources: { verify: async () => [] },
        }),
    )
    const inputs = new TaskInputMaterializer(
        payloads,
        { nextEntryId: () => `input:${++identity}`, nextSequence: () => identity },
        admission,
    )
    const shell = new TaskShell(runtime, { rearm: async () => {}, forceClose: () => {} })
    const resources = {
        readBytes: vi.fn(async (ref: SemanticResourceRef) => ({
            ok: true as const,
            value: { record: { mediaType: ref.mediaType }, bytes: bytes.get(ref.resourceId)! },
        })),
    }
    return {
        payloads,
        journal,
        vault,
        runtime,
        shell,
        inputs,
        legacy,
        catalog,
        failures,
        sent,
        recordResult,
        view: new JournalConversationView(journal, new ProviderJournalMessageMaterializer(payloads, resources)),
        resources,
    }
}

// Reordering the exit after the new body, losing approval ownership, or replaying
// the raw draft inside a result would each fail these independent content oracles.
describe("Away accepted events through compose to the Provider conversation", () => {
    it.each(
        [
            { native: true, approval: true },
            { native: false, approval: true },
            { native: true, approval: false },
            { native: false, approval: false },
        ].flatMap((scenario) => (["typed", "menu"] as const).map((source) => ({ ...scenario, source }))),
    )("keeps Stop -> /away body and resources exactly once (%j)", async ({ native, approval, source }) => {
        const h = await harness(native, approval)
        try {
            await h.shell.stopAway()
            const refs: SemanticResourceRef[] = [imageId, pdfId].map((resourceId) => ({
                resourceId,
                expectedContentHash: "a".repeat(64),
                mediaType: resourceId === imageId ? "image/png" : "application/pdf",
                byteLength: bytes.get(resourceId)!.length,
                owner: { kind: "task", taskId: "round" },
                generation: 1,
            }))
            const text = (value: string): ComposerSegment => ({ kind: "text", text: value, source: "typed" })
            const leading: ComposerSegment[] =
                source === "typed"
                    ? [text("/away repair ")]
                    : [{ kind: "atom", atom: createCommandAtom(h.catalog, "command.away", "/cmd:away")! }, text(" repair ")]
            const submitted = composeComposerSubmission(
                [
                    ...leading,
                    { kind: "atom", atom: createMentionAtom(h.catalog, "/src/a.ts")! },
                    text(" "),
                    {
                        kind: "atom",
                        atom: {
                            kind: "resource",
                            entityId: "image",
                            nodeKind: "image",
                            displayName: "shot.png",
                            fileOrigin: "pasted_file",
                            status: "ready",
                            ref: refs[0],
                        },
                    },
                    text(" then "),
                    {
                        kind: "atom",
                        atom: {
                            kind: "resource",
                            entityId: "pdf",
                            nodeKind: "file",
                            displayName: "notes.pdf",
                            fileOrigin: "uploaded_file",
                            status: "ready",
                            ref: refs[1],
                        },
                    },
                    text(" END_BODY"),
                ],
                { catalog: h.catalog, documentId: `composer:${source}` },
            )
            let feedbackRef: string | undefined
            if (approval) {
                const reviewed = await h.inputs.reviewReply({ text: submitted.text, semanticInput: submitted.semanticInput })
                feedbackRef = await h.payloads.put(
                    encodeTaskPayload<DialogDraftEnvelope>({
                        kind: "dialog_draft",
                        text: reviewed!.modelText!,
                        images: [],
                        files: [],
                        admittedParts: reviewed!.parts,
                        admittedInputRef: reviewed!.admittedInputRef,
                        roundMaterialOwned: true,
                    }),
                )
                const accepted = await h.shell.respond({
                    type: "approval.respond",
                    taskId: "round",
                    turnId: "previous",
                    interactionId: "approval",
                    blockId: "block",
                    stateRevision: h.runtime.getState().revision,
                    receiverGeneration: 0,
                    approved: true,
                    draftRef: feedbackRef,
                    roundFeedbackRef: feedbackRef,
                    userControl: reviewed!.userControl,
                })
                expect(accepted.kind).toBe("accepted")
            } else {
                expect(
                    (
                        await h.shell.submitInput(
                            await h.inputs.materialize({ text: submitted.text, semanticInput: submitted.semanticInput }),
                        )
                    ).kind,
                ).toBe("accepted")
            }
            await h.runtime.waitForQuiescence()
            if (approval) {
                const block = h.runtime.getState().turn.blocks[0]
                expect(
                    (
                        await h.runtime.submit({
                            type: "tool.started",
                            generation: 0,
                            turnId: "previous",
                            blockId: "block",
                            attempt: block.attempt!,
                        })
                    ).kind,
                ).toBe("accepted")
                await h.recordResult()
                expect(
                    (
                        await h.runtime.submit({
                            type: "tool.completed",
                            generation: 0,
                            turnId: "previous",
                            blockId: "block",
                            attempt: block.attempt!,
                        })
                    ).kind,
                ).toBe("accepted")
            }
            await h.runtime.waitForQuiescence()
            expect(h.failures).toEqual([])
            expect(h.sent).toHaveLength(1)
            const draft = h.sent[0]
            expect(draft.materialPlan!.notices.map((notice) => notice.reason)).toEqual(["stopped"])
            expect(draft.materialPlan!.inputs.map((input) => input.source)).toEqual([approval ? "approval" : "intake"])
            expect(draft.materialPlan!.activeAway?.source).toBe("command")
            expect(h.runtime.getState().roundMaterial).toEqual({ notices: [], feedback: [] })
            const entries = (await h.view.entries()).filter((entry) => entry.messages.length > 0)
            expect(entries.map((entry) => entry.kind)).toEqual([
                "provider_final",
                "tool_terminal_manifest",
                "round_notice",
                "round_material_input",
                "environment_details",
                "round_active_away",
            ])
            const results = entries[1].messages.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
            expect(results).toHaveLength(1)
            if (native)
                expect(results[0]).toMatchObject({
                    type: "tool_result",
                    function_id: "call",
                    dline_tid: "block",
                    content: [{ type: "text", text: "READ_RESULT" }],
                })
            else expect(results[0]).toMatchObject({ type: "text", text: "[read_file] Result:\nREAD_RESULT" })
            const body = entries[3].messages.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
            expect(body.filter((part) => part.type === "image")).toEqual([
                {
                    type: "image",
                    source: { type: "base64", media_type: "image/png", data: bytes.get(imageId)!.toString("base64") },
                },
            ])
            expect(body.filter((part) => part.type === "attached_document")).toMatchObject([
                { path: "notes.pdf", data: bytes.get(pdfId)!.toString("base64") },
            ])
            const bodyText = body
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("")
            const [, beforeImage, afterImage] = /^<user_message>\n([\s\S]*)<image_ref [^>]+ \/>([\s\S]*)$/.exec(bodyText)!
            expect(beforeImage).toBe(" repair MENTION_BODY ")
            expect(afterImage.startsWith(" then ")).toBe(true)
            expect(bodyText.match(/END_BODY/g)).toHaveLength(1)
            const all = entries
                .flatMap((entry) => entry.messages)
                .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
            expect(all.filter((part) => part.type === "image")).toHaveLength(1)
            expect(all.filter((part) => part.type === "attached_document")).toHaveLength(1)
            expect(
                all
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("")
                    .match(/MENTION_BODY/g),
            ).toHaveLength(1)
            const saved = await h.vault.load("round")
            expect(saved!.state.away?.mode?.source).toBe("command")
        } finally {
            await h.runtime.disposeDeadlines()
        }
    })
})
