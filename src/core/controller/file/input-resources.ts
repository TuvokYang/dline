import { openDraftInputResources } from "@core/input-semantics/DraftInputResourceStore"
import type { InputResourceKind } from "@core/input-semantics/InputResourceClassifier"
import {
    type InputResourceFailure,
    type InputResourceResult,
    resourceFailed,
    resourceSucceeded,
} from "@core/input-semantics/InputResourceFailure"
import {
    type InputResourceRecord,
    type InputResourceStore,
    inputResourceDisplayName,
    referenceOf,
} from "@core/input-semantics/InputResourceStore"
import { openTaskInputResources } from "@core/input-semantics/TaskInputResourceStore"
import { sanitizeDiagnosticText } from "@shared/input-semantics/diagnostics"
import type { SemanticResourceRef } from "@shared/input-semantics/document"
import {
    InputResourceError,
    InputResourceOperationResult,
    InputResourceStageResult,
    InputResourceStageResults,
    StagedInputResource,
    InputResourceKind as WireInputResourceKind,
} from "@shared/proto/dline/file"
import type { SemanticResourceRef as WireSemanticResourceRef } from "@shared/proto/dline/input"
import { fromProtoSemanticResourceRef, toProtoSemanticResourceRef } from "@shared/proto-conversions/input-semantics/document"
import type { Controller } from ".."

/*
 * Host side of the typed input resource RPCs.
 *
 * The Host, not the Webview, decides who owns a resource: the active task when
 * one exists, otherwise the composer draft the request names. Only the window
 * that holds the task lock stages into the task, because another window shows
 * the task read-only. A reference is honored only when its owner is one the
 * Host currently recognizes, so a Webview cannot address another task's or
 * another draft's resources. Draft identities are random UUIDs the Webview
 * generates, so one draft cannot guess another's identity.
 */

const DRAFT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const WIRE_KIND: Readonly<Record<InputResourceKind, WireInputResourceKind>> = {
    image: WireInputResourceKind.INPUT_RESOURCE_KIND_IMAGE,
    file: WireInputResourceKind.INPUT_RESOURCE_KIND_FILE,
    pasted_text: WireInputResourceKind.INPUT_RESOURCE_KIND_PASTED_TEXT,
}

/** One staging outcome and the name the request supplied for it. */
export interface StageOutcome {
    readonly result: InputResourceResult<InputResourceRecord>
    readonly requestedName?: string
}

/** Who receives newly staged resources; a task target names the exact opening it was resolved for. */
export type StagingTarget =
    | { readonly kind: "task"; readonly taskId: string; readonly taskInstanceId: string }
    | { readonly kind: "draft"; readonly draftId: string }

/** The active task when this window may write it, else nothing. */
export function writableTaskIdOf(controller: Controller): string | undefined {
    const task = controller.task
    return task?.writable ? task.taskId : undefined
}

/** Resolve who owns newly staged resources: the active task, else the request's composer draft. */
export function stagingTargetOf(controller: Controller, draftId: string): InputResourceResult<StagingTarget> {
    const task = controller.task
    if (task) {
        if (!task.writable) {
            return resourceFailed("semantic_input_resource_invalid", "the active task is open read-only in this window")
        }
        return resourceSucceeded({ kind: "task", taskId: task.taskId, taskInstanceId: task.taskInstanceId })
    }
    if (!isDraftId(draftId)) {
        return resourceFailed("semantic_input_resource_invalid", "staging needs an active task or a composer draft")
    }
    return resourceSucceeded({ kind: "draft", draftId })
}

export function sameStagingTarget(left: StagingTarget, right: StagingTarget): boolean {
    if (left.kind === "task" && right.kind === "task") {
        return left.taskId === right.taskId && left.taskInstanceId === right.taskInstanceId
    }
    return left.kind === "draft" && right.kind === "draft" && left.draftId === right.draftId
}

export function openStagingStore(target: StagingTarget): InputResourceResult<InputResourceStore> {
    return target.kind === "task"
        ? openOwnerStore(() => openTaskInputResources(target.taskId))
        : openOwnerStore(() => openDraftInputResources(target.draftId))
}

/** The store that owns newly staged resources, resolved for this request. */
export function stagingStoreFor(controller: Controller, draftId: string): InputResourceResult<InputResourceStore> {
    const target = stagingTargetOf(controller, draftId)
    return target.ok ? openStagingStore(target.value) : target
}

/** Decode a wire reference and select the store its owner names, if the Host recognizes that owner. */
export function referencedStoreFor(
    controller: Controller,
    draftId: string,
    wire: WireSemanticResourceRef | undefined,
): InputResourceResult<{ readonly ref: SemanticResourceRef; readonly store: InputResourceStore }> {
    const ref = fromProtoSemanticResourceRef(wire)
    if (!ref) return resourceFailed("semantic_input_resource_invalid", "resource reference needs exactly one owner")

    const owner = ref.owner
    if (owner.kind === "task") {
        if (owner.taskId !== controller.task?.taskId) {
            return resourceFailed(
                "semantic_input_resource_invalid",
                `resource ${ref.resourceId} does not belong to the active task`,
                ref.resourceId,
            )
        }
        return withReference(
            ref,
            openOwnerStore(() => openTaskInputResources(owner.taskId)),
        )
    }
    if (!isDraftId(draftId) || owner.draftId !== draftId) {
        return resourceFailed(
            "semantic_input_resource_invalid",
            `resource ${ref.resourceId} does not belong to this composer draft`,
            ref.resourceId,
        )
    }
    return withReference(
        ref,
        openOwnerStore(() => openDraftInputResources(owner.draftId)),
    )
}

export function toStageResults(outcomes: readonly StageOutcome[]): InputResourceStageResults {
    return InputResourceStageResults.create({ results: outcomes.map(toStageResult) })
}

export function toOperationResult(result: InputResourceResult<unknown>): InputResourceOperationResult {
    return InputResourceOperationResult.create(result.ok ? {} : { error: toInputResourceError(result.failure) })
}

function toStageResult({ result, requestedName }: StageOutcome): InputResourceStageResult {
    if (!result.ok) return InputResourceStageResult.create({ error: toInputResourceError(result.failure, requestedName) })
    const record = result.value
    return InputResourceStageResult.create({
        staged: StagedInputResource.create({
            ref: toProtoSemanticResourceRef(referenceOf(record)),
            displayName: record.displayName,
            kind: WIRE_KIND[record.kind],
            lineCount: record.lineCount,
        }),
    })
}

/** The requested name is user input from the Webview or a picker, so only its sanitized leaf travels back. */
function toInputResourceError(failure: InputResourceFailure, requestedName?: string): InputResourceError {
    return InputResourceError.create({
        code: failure.code,
        message: failure.message,
        resourceId: failure.resourceId,
        displayName: requestedName === undefined ? undefined : sanitizeDiagnosticText(inputResourceDisplayName(requestedName)),
    })
}

function isDraftId(draftId: string): boolean {
    return DRAFT_ID_PATTERN.test(draftId)
}

function withReference(
    ref: SemanticResourceRef,
    store: InputResourceResult<InputResourceStore>,
): InputResourceResult<{ readonly ref: SemanticResourceRef; readonly store: InputResourceStore }> {
    return store.ok ? resourceSucceeded({ ref, store: store.value }) : store
}

/** Opening a store validates the owner identity; a malformed identity is a rejected request, not a crash. */
function openOwnerStore(open: () => InputResourceStore): InputResourceResult<InputResourceStore> {
    try {
        return resourceSucceeded(open())
    } catch {
        return resourceFailed("semantic_input_resource_invalid", "the resource owner identity is not valid")
    }
}
