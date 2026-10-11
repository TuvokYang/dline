import { semanticInputDiagnostic } from "@shared/input-semantics/diagnostics"
import { isResourceNode, isSlashCommandNode, type SemanticInputDocument } from "@shared/input-semantics/document"
import { Logger } from "@shared/services/Logger"
import type { TaskInputAdmissionPort, TaskInputAdmissionResult } from "@/core/task/session/TaskInputAdmission"
import type { LegacyInputAdapter } from "./LegacyInputAdapter"
import type { SemanticInputAdmissionService } from "./SemanticInputAdmissionService"

/**
 * Binds the two input paths to one admission.
 *
 * A structured submission is admitted as it stands. A legacy submission is
 * upgraded by the single adapter first. Either way exactly one parse happened,
 * and admission sees the same document shape.
 */
export class TaskSemanticInputAdmission implements TaskInputAdmissionPort {
    constructor(
        private readonly legacy: LegacyInputAdapter,
        private readonly admission: SemanticInputAdmissionService,
    ) {}

    async admit(input: {
        readonly text?: string
        readonly images?: readonly string[]
        readonly files?: readonly string[]
        readonly semanticInput?: SemanticInputDocument
    }): Promise<TaskInputAdmissionResult> {
        // A legacy submission carries the catalog it was just lexed against, so
        // admission reviews it against that snapshot instead of a revision that
        // discovery may have published in between.
        const adapted = input.semanticInput
            ? { document: input.semanticInput, catalog: undefined }
            : await this.legacy.adapt(input)
        const document = adapted.document
        if (input.semanticInput && input.text !== undefined && input.text !== document.rawText) {
            return { ok: false, diagnostics: [textMirrorMismatch(document)] }
        }
        if (input.semanticInput && carriesFlatAttachments(input) && document.nodes.some(isResourceNode)) {
            return { ok: false, diagnostics: [mixedAttachmentAuthority(document)] }
        }
        reportUnresolvedCommands(document)
        const result = await this.admission.admit(document, adapted.catalog)
        if (!result.ok) return result
        return {
            ok: true,
            admitted: {
                document,
                admittedText: result.admitted.text,
                parts: result.admitted.parts,
                authorizedTools: result.admitted.authorizedTools,
                explicitInstructions: result.admitted.explicitInstructions,
                ...(result.admitted.barrier === undefined ? {} : { barrier: result.admitted.barrier }),
            },
        }
    }
}

function carriesFlatAttachments(input: { readonly images?: readonly string[]; readonly files?: readonly string[] }): boolean {
    return (input.images?.length ?? 0) > 0 || (input.files?.length ?? 0) > 0
}

/**
 * The submission's text is what the chat shows and the history keeps; the
 * document is what acts. Both must be the same input, or a command could run
 * that the visible text never contained.
 */
function textMirrorMismatch(document: SemanticInputDocument) {
    return semanticInputDiagnostic("semantic_input_source_mismatch", "submission text does not match its document", {
        documentId: document.documentId,
    })
}

/**
 * A structured submission whose resources are nodes must not also carry flat
 * attachments: the two would be two authorities for what the user attached,
 * and the flat list has neither a verified identity nor a place in the order.
 */
function mixedAttachmentAuthority(document: SemanticInputDocument) {
    return semanticInputDiagnostic(
        "semantic_input_resource_invalid",
        "attachments must be sent either as resource nodes or as a flat list, not both",
        { documentId: document.documentId },
    )
}

/**
 * Report a command shape the catalog did not recognize.
 *
 * Such a node stays literal text, so the user sees their command silently do
 * nothing. Naming the catalog revision makes a discovery gap distinguishable
 * from a genuinely unknown command.
 */
function reportUnresolvedCommands(document: SemanticInputDocument): void {
    const unresolved = document.nodes
        .filter(isSlashCommandNode)
        .filter((node) => node.state !== "recognized" && node.state !== "literal")
    if (unresolved.length === 0) return
    Logger.warn(
        `[SemanticInput] catalog revision ${document.catalogRevision} did not resolve ${unresolved
            .map((node) => node.sourceText)
            .join(", ")}; it will be sent as plain text`,
    )
}
