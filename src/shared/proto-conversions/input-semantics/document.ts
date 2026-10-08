import type {
	FileNodeOrigin,
	MentionCapturePolicy,
	MentionKind,
	SemanticEntityState,
	SemanticInputDocument,
	SemanticInputNode,
	SlashCommandComposition,
	SlashCommandNamespace,
} from "@shared/input-semantics/document"
import { SEMANTIC_INPUT_SCHEMA_VERSION } from "@shared/input-semantics/document"
import type { SemanticInputDiagnostic } from "@shared/input-semantics/validation"
import {
	MentionCapturePolicy as WireCapturePolicy,
	SlashCommandComposition as WireComposition,
	SemanticInputDocument as WireDocument,
	FileNodeOrigin as WireFileOrigin,
	MentionKind as WireMentionKind,
	SlashCommandNamespace as WireNamespace,
	SemanticInputNode as WireNode,
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

function invert<Domain extends string, Wire extends number>(map: Record<Domain, Wire>): ReadonlyMap<Wire, Domain> {
	return new Map((Object.entries(map) as [Domain, Wire][]).map(([domain, wire]) => [wire, domain]))
}

const WIRE_TO_STATE = invert(STATE_TO_WIRE)
const WIRE_TO_NAMESPACE = invert(NAMESPACE_TO_WIRE)
const WIRE_TO_COMPOSITION = invert(COMPOSITION_TO_WIRE)
const WIRE_TO_MENTION_KIND = invert(MENTION_KIND_TO_WIRE)
const WIRE_TO_CAPTURE_POLICY = invert(CAPTURE_POLICY_TO_WIRE)
const WIRE_TO_FILE_ORIGIN = invert(FILE_ORIGIN_TO_WIRE)

function toProtoNode(node: SemanticInputNode): WireNode {
	switch (node.kind) {
		case "text":
			return WireNode.create({ text: { text: node.text } })
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

export function toProtoSemanticInputDocument(document: SemanticInputDocument): WireDocument {
	return WireDocument.create({
		schemaVersion: document.schemaVersion,
		parserVersion: document.parserVersion,
		catalogRevision: document.catalogRevision,
		documentId: document.documentId,
		rawText: document.rawText,
		nodes: document.nodes.map(toProtoNode),
		resources: document.resources.map((resource) => ({
			resourceId: resource.resourceId,
			expectedContentHash: resource.expectedContentHash,
		})),
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
		({ ok: false, diagnostic: { code: "semantic_input_node_invalid", message, documentId, entityId } }) as const

	const payloads = [node.text, node.slashCommand, node.mention, node.image, node.file].filter(
		(payload) => payload !== undefined,
	)
	if (payloads.length === 0) return invalid("node carries no payload")
	if (payloads.length > 1) return invalid("node carries more than one payload")

	if (node.text) return { ok: true, node: { kind: "text", text: node.text.text } }

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
 * Decode a wire document.
 *
 * Decoding is fail-closed: an undecodable node aborts the whole document instead
 * of being dropped, because silently losing a node would change what the user
 * submitted.
 */
export function fromProtoSemanticInputDocument(wire: WireDocument): SemanticInputDecodeResult {
	if (wire.schemaVersion !== SEMANTIC_INPUT_SCHEMA_VERSION) {
		return {
			ok: false,
			diagnostic: {
				code: "semantic_input_schema_unsupported",
				message: `unsupported semantic input schema version ${wire.schemaVersion}`,
				documentId: wire.documentId,
			},
		}
	}

	const nodes: SemanticInputNode[] = []
	for (const node of wire.nodes) {
		const decoded = decodeNode(node, wire.documentId)
		if (!decoded.ok) return decoded
		nodes.push(decoded.node)
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
			resources: wire.resources.map((resource) => ({
				resourceId: resource.resourceId,
				expectedContentHash: resource.expectedContentHash,
			})),
		},
	}
}
