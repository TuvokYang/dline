import { type SemanticInputDiagnostic, semanticInputDiagnostic } from "@shared/input-semantics/diagnostics"
import type {
    FileNodeOrigin,
    InputResourceOwner,
    InputSource,
    MentionCapturePolicy,
    MentionKind,
    SemanticEntityState,
    SemanticInputDocument,
    SemanticInputNode,
    SemanticResourceRef,
    SlashCommandComposition,
    SlashCommandNamespace,
} from "@shared/input-semantics/document"
import { SEMANTIC_INPUT_SCHEMA_VERSION } from "@shared/input-semantics/document"
import { validateSemanticInputDocument } from "@shared/input-semantics/validation"
import {
    MentionCapturePolicy as WireCapturePolicy,
    SlashCommandComposition as WireComposition,
    SemanticInputDocument as WireDocument,
    FileNodeOrigin as WireFileOrigin,
    MentionKind as WireMentionKind,
    SlashCommandNamespace as WireNamespace,
    SemanticInputNode as WireNode,
    InputResourceOwner as WireOwner,
    SemanticResourceRef as WireResourceRef,
    InputSource as WireSource,
    SemanticEntityState as WireState,
} from "@shared/proto/dline/input"

const STATE_TO_WIRE: Record<SemanticEntityState, WireState> = {
    recognized: WireState.SEMANTIC_ENTITY_STATE_RECOGNIZED,
    partial: WireState.SEMANTIC_ENTITY_STATE_PARTIAL,
    unresolved: WireState.SEMANTIC_ENTITY_STATE_UNRESOLVED,
    invalid: WireState.SEMANTIC_ENTITY_STATE_INVALID,
    disabled: WireState.SEMANTIC_ENTITY_STATE_DISABLED,
    stale: WireState.SEMANTIC_ENTITY_STATE_STALE,
    literal: WireState.SEMANTIC_ENTITY_STATE_LITERAL,
}

const NAMESPACE_TO_WIRE: Record<SlashCommandNamespace, WireNamespace> = {
    cmd: WireNamespace.SLASH_COMMAND_NAMESPACE_CMD,
    workflow: WireNamespace.SLASH_COMMAND_NAMESPACE_WORKFLOW,
    skill: WireNamespace.SLASH_COMMAND_NAMESPACE_SKILL,
    mcp: WireNamespace.SLASH_COMMAND_NAMESPACE_MCP,
}

const COMPOSITION_TO_WIRE: Record<SlashCommandComposition, WireComposition> = {
    composable: WireComposition.SLASH_COMMAND_COMPOSITION_COMPOSABLE,
    lifecycle_barrier: WireComposition.SLASH_COMMAND_COMPOSITION_LIFECYCLE_BARRIER,
}

const MENTION_KIND_TO_WIRE: Record<MentionKind, WireMentionKind> = {
    file: WireMentionKind.MENTION_KIND_FILE,
    folder: WireMentionKind.MENTION_KIND_FOLDER,
    url: WireMentionKind.MENTION_KIND_URL,
    problems: WireMentionKind.MENTION_KIND_PROBLEMS,
    terminal: WireMentionKind.MENTION_KIND_TERMINAL,
    git_changes: WireMentionKind.MENTION_KIND_GIT_CHANGES,
    git_commit: WireMentionKind.MENTION_KIND_GIT_COMMIT,
}

const CAPTURE_POLICY_TO_WIRE: Record<MentionCapturePolicy, WireCapturePolicy> = {
    snapshot_at_submit: WireCapturePolicy.MENTION_CAPTURE_POLICY_SNAPSHOT_AT_SUBMIT,
    resolve_at_execute: WireCapturePolicy.MENTION_CAPTURE_POLICY_RESOLVE_AT_EXECUTE,
}

const FILE_ORIGIN_TO_WIRE: Record<FileNodeOrigin, WireFileOrigin> = {
    pasted_text: WireFileOrigin.FILE_NODE_ORIGIN_PASTED_TEXT,
    pasted_file: WireFileOrigin.FILE_NODE_ORIGIN_PASTED_FILE,
    uploaded_file: WireFileOrigin.FILE_NODE_ORIGIN_UPLOADED_FILE,
}

const SOURCE_TO_WIRE: Record<InputSource, WireSource> = {
    typed: WireSource.INPUT_SOURCE_TYPED,
    pasted: WireSource.INPUT_SOURCE_PASTED,
    app_action: WireSource.INPUT_SOURCE_APP_ACTION,
    editor_selection: WireSource.INPUT_SOURCE_EDITOR_SELECTION,
    model_prefill: WireSource.INPUT_SOURCE_MODEL_PREFILL,
    restored: WireSource.INPUT_SOURCE_RESTORED,
}

function invert<Domain extends string, Wire extends number>(map: Record<Domain, Wire>): ReadonlyMap<Wire, Domain> {
    return new Map((Object.entries(map) as [Domain, Wire][]).map(([domain, wire]) => [wire, domain]))
}

const WIRE_TO_STATE = invert(STATE_TO_WIRE)
const WIRE_TO_NAMESPACE = invert(NAMESPACE_TO_WIRE)
const WIRE_TO_COMPOSITION = invert(COMPOSITION_TO_WIRE)
const WIRE_TO_MENTION_KIND = invert(MENTION_KIND_TO_WIRE)
const WIRE_TO_CAPTURE_POLICY = invert(CAPTURE_POLICY_TO_WIRE)
const WIRE_TO_FILE_ORIGIN = invert(FILE_ORIGIN_TO_WIRE)
const WIRE_TO_SOURCE = invert(SOURCE_TO_WIRE)

function toProtoNode(node: SemanticInputNode): WireNode {
    switch (node.kind) {
        case "text":
            return WireNode.create({ text: { text: node.text } })
        case "literal":
            return WireNode.create({ literal: { text: node.text, source: SOURCE_TO_WIRE[node.source] } })
        case "slash_command":
            return WireNode.create({
                slashCommand: {
                    entityId: node.entityId,
                    commandId: node.commandId,
                    sourceText: node.sourceText,
                    canonicalName: node.canonicalName,
                    namespace: NAMESPACE_TO_WIRE[node.namespace],
                    compositionMode: COMPOSITION_TO_WIRE[node.compositionMode],
                    state: STATE_TO_WIRE[node.state],
                },
            })
        case "mention":
            return WireNode.create({
                mention: {
                    entityId: node.entityId,
                    mentionKind: MENTION_KIND_TO_WIRE[node.mentionKind],
                    sourceText: node.sourceText,
                    canonicalRef: node.canonicalRef,
                    workspaceHint: node.workspaceHint,
                    capturePolicy: node.capturePolicy ? CAPTURE_POLICY_TO_WIRE[node.capturePolicy] : undefined,
                    state: STATE_TO_WIRE[node.state],
                },
            })
        case "image":
            return WireNode.create({
                image: {
                    entityId: node.entityId,
                    resourceId: node.resourceId,
                    displayName: node.displayName,
                    altText: node.altText,
                },
            })
        case "file":
            return WireNode.create({
                file: {
                    entityId: node.entityId,
                    resourceId: node.resourceId,
                    fileOrigin: FILE_ORIGIN_TO_WIRE[node.fileOrigin],
                    displayName: node.displayName,
                    lineCount: node.lineCount,
                },
            })
    }
}

function toProtoOwner(owner: InputResourceOwner): WireOwner {
    return owner.kind === "draft" ? WireOwner.create({ draftId: owner.draftId }) : WireOwner.create({ taskId: owner.taskId })
}

/** Encode one resource reference; typed resource RPCs reuse the document's own encoding. */
export function toProtoSemanticResourceRef(resource: SemanticResourceRef): WireResourceRef {
    return WireResourceRef.create({
        resourceId: resource.resourceId,
        expectedContentHash: resource.expectedContentHash,
        mediaType: resource.mediaType,
        byteLength: resource.byteLength,
        owner: toProtoOwner(resource.owner),
        generation: resource.generation,
    })
}

export function toProtoSemanticInputDocument(document: SemanticInputDocument): WireDocument {
    return WireDocument.create({
        schemaVersion: document.schemaVersion,
        parserVersion: document.parserVersion,
        catalogRevision: document.catalogRevision,
        documentId: document.documentId,
        rawText: document.rawText,
        nodes: document.nodes.map(toProtoNode),
        resources: document.resources.map(toProtoSemanticResourceRef),
    })
}

export type SemanticInputDecodeResult =
    | { readonly ok: true; readonly document: SemanticInputDocument }
    | { readonly ok: false; readonly diagnostic: SemanticInputDiagnostic }

function decodeNode(
    node: WireNode,
    documentId: string,
):
    | { readonly ok: true; readonly node: SemanticInputNode }
    | { readonly ok: false; readonly diagnostic: SemanticInputDiagnostic } {
    const invalid = (message: string, entityId?: string) =>
        ({
            ok: false,
            diagnostic: semanticInputDiagnostic("semantic_input_node_invalid", message, { documentId, entityId }),
        }) as const

    const payloads = [node.text, node.literal, node.slashCommand, node.mention, node.image, node.file].filter(
        (payload) => payload !== undefined,
    )
    if (payloads.length === 0) return invalid("node carries no payload")
    if (payloads.length > 1) return invalid("node carries more than one payload")

    if (node.text) return { ok: true, node: { kind: "text", text: node.text.text } }

    if (node.literal) {
        // UNSPECIFIED is the wire default and maps to nothing, so a missing source is rejected.
        const source = WIRE_TO_SOURCE.get(node.literal.source)
        if (!source) return invalid("literal node carries no supported source")
        return { ok: true, node: { kind: "literal", text: node.literal.text, source } }
    }

    if (node.slashCommand) {
        const wire = node.slashCommand
        const namespace = WIRE_TO_NAMESPACE.get(wire.namespace)
        const compositionMode = WIRE_TO_COMPOSITION.get(wire.compositionMode)
        const state = WIRE_TO_STATE.get(wire.state)
        if (!namespace || !compositionMode || !state) {
            return invalid("slash command node carries an unsupported enum value", wire.entityId)
        }
        return {
            ok: true,
            node: {
                kind: "slash_command",
                entityId: wire.entityId,
                commandId: wire.commandId,
                sourceText: wire.sourceText,
                canonicalName: wire.canonicalName,
                namespace,
                compositionMode,
                state,
            },
        }
    }

    if (node.mention) {
        const wire = node.mention
        const mentionKind = WIRE_TO_MENTION_KIND.get(wire.mentionKind)
        const state = WIRE_TO_STATE.get(wire.state)
        const capturePolicy = wire.capturePolicy === undefined ? undefined : WIRE_TO_CAPTURE_POLICY.get(wire.capturePolicy)
        if (!mentionKind || !state || (wire.capturePolicy !== undefined && !capturePolicy)) {
            return invalid("mention node carries an unsupported enum value", wire.entityId)
        }
        return {
            ok: true,
            node: {
                kind: "mention",
                entityId: wire.entityId,
                mentionKind,
                sourceText: wire.sourceText,
                canonicalRef: wire.canonicalRef,
                state,
                ...(wire.workspaceHint ? { workspaceHint: wire.workspaceHint } : {}),
                ...(capturePolicy ? { capturePolicy } : {}),
            },
        }
    }

    if (node.image) {
        const wire = node.image
        return {
            ok: true,
            node: {
                kind: "image",
                entityId: wire.entityId,
                resourceId: wire.resourceId,
                displayName: wire.displayName,
                ...(wire.altText ? { altText: wire.altText } : {}),
            },
        }
    }

    const wire = node.file
    if (!wire) return invalid("node carries no payload")
    const fileOrigin = WIRE_TO_FILE_ORIGIN.get(wire.fileOrigin)
    if (!fileOrigin) return invalid("file node carries an unsupported origin", wire.entityId)
    return {
        ok: true,
        node: {
            kind: "file",
            entityId: wire.entityId,
            resourceId: wire.resourceId,
            fileOrigin,
            displayName: wire.displayName,
            ...(wire.lineCount === undefined ? {} : { lineCount: wire.lineCount }),
        },
    }
}

/**
 * Decode the owner oneof.
 *
 * The generated type exposes both arms as independent optionals, so a forged
 * message could set both. Exactly one arm must be present; anything else is
 * rejected instead of silently preferring one owner.
 */
function decodeOwner(owner: WireOwner | undefined): InputResourceOwner | undefined {
    const draftId = owner?.draftId
    const taskId = owner?.taskId
    if (draftId && !taskId) return { kind: "draft", draftId }
    if (taskId && !draftId) return { kind: "task", taskId }
    return undefined
}

function decodeResourceRef(
    wire: WireResourceRef,
    documentId: string,
):
    | { readonly ok: true; readonly resource: SemanticResourceRef }
    | { readonly ok: false; readonly diagnostic: SemanticInputDiagnostic } {
    const owner = decodeOwner(wire.owner)
    if (!owner) {
        return {
            ok: false,
            diagnostic: semanticInputDiagnostic("semantic_input_resource_invalid", "resource reference needs exactly one owner", {
                documentId,
                resourceId: wire.resourceId,
            }),
        }
    }
    return {
        ok: true,
        resource: {
            resourceId: wire.resourceId,
            expectedContentHash: wire.expectedContentHash,
            mediaType: wire.mediaType,
            byteLength: wire.byteLength,
            owner,
            generation: wire.generation,
        },
    }
}

/**
 * Decode one reference a typed resource RPC carries.
 *
 * Returns undefined when the reference does not name exactly one owner; every
 * other claim is left for the resource store to verify against its record.
 */
export function fromProtoSemanticResourceRef(wire: WireResourceRef | undefined): SemanticResourceRef | undefined {
    if (!wire) return undefined
    const decoded = decodeResourceRef(wire, "")
    return decoded.ok ? decoded.resource : undefined
}

/**
 * Decode a wire document.
 *
 * Decoding is fail-closed: an undecodable node or resource reference aborts the
 * whole document instead of being dropped, because silently losing either would
 * change what the user submitted.
 */
export function fromProtoSemanticInputDocument(wire: WireDocument): SemanticInputDecodeResult {
    if (wire.schemaVersion !== SEMANTIC_INPUT_SCHEMA_VERSION) {
        return {
            ok: false,
            diagnostic: semanticInputDiagnostic(
                "semantic_input_schema_unsupported",
                `unsupported semantic input schema version ${wire.schemaVersion}`,
                { documentId: wire.documentId },
            ),
        }
    }

    const nodes: SemanticInputNode[] = []
    for (const node of wire.nodes) {
        const decoded = decodeNode(node, wire.documentId)
        if (!decoded.ok) return decoded
        nodes.push(decoded.node)
    }

    const resources: SemanticResourceRef[] = []
    for (const resource of wire.resources) {
        const decoded = decodeResourceRef(resource, wire.documentId)
        if (!decoded.ok) return decoded
        resources.push(decoded.resource)
    }

    return {
        ok: true,
        document: {
            schemaVersion: SEMANTIC_INPUT_SCHEMA_VERSION,
            parserVersion: wire.parserVersion,
            catalogRevision: wire.catalogRevision,
            documentId: wire.documentId,
            rawText: wire.rawText,
            nodes,
            resources,
        },
    }
}

/**
 * Decode a wire document and check its structure.
 *
 * Every wire entry point uses this instead of {@link fromProtoSemanticInputDocument}
 * alone: a document that decodes can still carry duplicate identities, forged
 * resource metadata or more than one lifecycle barrier, and none of that may
 * cross the boundary.
 */
export function decodeAdmissibleSemanticInputDocument(wire: WireDocument): SemanticInputDecodeResult {
    const decoded = fromProtoSemanticInputDocument(wire)
    if (!decoded.ok) return decoded
    const [problem] = validateSemanticInputDocument(decoded.document)
    return problem ? { ok: false, diagnostic: problem } : decoded
}
