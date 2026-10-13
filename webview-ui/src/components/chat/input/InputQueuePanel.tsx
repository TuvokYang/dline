import {
    isResourceNode,
    type ResourceInputNode,
    resourceRefOf,
    type SemanticInputDocument,
} from "@shared/input-semantics/document"
import { ChevronDownIcon, ChevronRightIcon, GripVerticalIcon, PencilIcon, RotateCcwIcon, SendIcon, XIcon } from "lucide-react"
import { useMemo, useState } from "react"
import { openTaskResource } from "@/components/chat/input/semantic-composer/resource-staging"
import { UserInputMarkdownBody } from "@/components/chat/UserInputMarkdownBody"
import { type ResourceChipResolver, ResourceChipResolverContext } from "@/components/common/ResourceChip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { markDocumentResources } from "@/services/input-semantics/highlight"

function classes(...values: Array<string | false | undefined>): string {
    return values.filter(Boolean).join(" ")
}

/** Delivery state of a retained entry, mirrored from the backend queue. */
export type InputQueuePanelMode = "queued" | "steering"

/** Presentation-only projection of one retained input. */
export interface InputQueuePanelEntry {
    readonly id: string
    readonly text: string
    readonly images: readonly string[]
    readonly files: readonly string[]
    readonly activeQuote?: string
    /** The entry's composed structure; recalled with it when the entry is edited. */
    readonly semanticInput?: SemanticInputDocument
    readonly mode: InputQueuePanelMode
    readonly editing?: boolean
}

export interface InputQueuePanelProps {
    entries: readonly InputQueuePanelEntry[]
    /** Promote to steering or demote back to queued. Never delivers. */
    onToggleMode: (id: string) => void
    /** Pull the entry back into the composer for editing. */
    onEdit: (id: string) => void
    /** Release an edit without changing the entry, making it deliverable again. */
    onCancelEdit: (id: string) => void
    onRemove: (id: string) => void
    onReorder: (id: string, targetIndex: number) => void
}

/** Display names of an entry's attachments, split by kind. */
export interface QueuedAttachments {
    readonly images: readonly string[]
    readonly files: readonly string[]
}

const LEGACY_IMAGE_LABEL = "image"

function baseNameOf(path: string): string {
    return path.split(/[\\/]/).pop() || path
}

/**
 * The attachments an entry will deliver.
 *
 * An entry whose document holds resource nodes carries its attachments there,
 * and its flat `images`/`files` lists are only the delivery bridge Core
 * derives from those nodes, so they are never read beside them. A document
 * without resource nodes - an older text-only document, or no document at
 * all - leaves the flat lists as the only record of the attachments.
 */
export function queuedAttachmentsOf(entry: Pick<InputQueuePanelEntry, "images" | "files" | "semanticInput">): QueuedAttachments {
    const resources = entry.semanticInput?.nodes.filter(isResourceNode) ?? []
    if (resources.length > 0) {
        return {
            images: resources.filter((node) => node.kind === "image").map((node) => node.displayName),
            files: resources.filter((node) => node.kind === "file").map((node) => node.displayName),
        }
    }
    return { images: entry.images.map(() => LEGACY_IMAGE_LABEL), files: entry.files.map(baseNameOf) }
}

function countLabel(count: number, noun: string): string | undefined {
    if (count === 0) return undefined
    return `${count} ${noun}${count > 1 ? "s" : ""}`
}

function attachmentSummary(attachments: QueuedAttachments): string | undefined {
    const parts = [countLabel(attachments.images.length, "image"), countLabel(attachments.files.length, "file")].filter(
        (part): part is string => part !== undefined,
    )
    return parts.length > 0 ? parts.join(", ") : undefined
}

/** Resolve a queued entry's resource links to the resources its document still holds. */
function resourceChipResolverOf(document: SemanticInputDocument): ResourceChipResolver {
    return (entityId) => {
        const node = document.nodes.find(
            (candidate): candidate is ResourceInputNode => isResourceNode(candidate) && candidate.entityId === entityId,
        )
        if (!node) return undefined
        const resource = resourceRefOf(document, node)
        const openable = resource?.owner.kind === "task"
        return { node, resource, onOpen: openable ? () => void openTaskResource(resource) : undefined }
    }
}

/**
 * An entry's text, with each resource drawn as the chip the composer showed.
 *
 * The stored text names resources by stable id, which means nothing to a
 * reader, so an entry with a document is rendered from the document. A legacy
 * entry has only its text and shows it as written.
 */
function QueuedEntryBody({ entry }: { entry: InputQueuePanelEntry }) {
    const document = entry.semanticInput
    const markdown = useMemo(() => (document ? markDocumentResources(document) : entry.text), [document, entry.text])
    const resolver = useMemo(() => (document ? resourceChipResolverOf(document) : undefined), [document])
    return (
        <ResourceChipResolverContext.Provider value={resolver}>
            <UserInputMarkdownBody
                markdown={markdown}
                submittedEntities={document !== undefined}
                testId={`input-queue-markdown-${entry.id}`}
                variant="queued-pending"
            />
        </ResourceChipResolverContext.Provider>
    )
}

/** Collapsed summary plus a portalled, collision-aware list of retained input. */
export function InputQueuePanel({ entries, onToggleMode, onEdit, onCancelEdit, onRemove, onReorder }: InputQueuePanelProps) {
    const [expanded, setExpanded] = useState(false)
    const [draggingId, setDraggingId] = useState<string>()

    if (entries.length === 0) {
        return null
    }

    const steeringCount = entries.filter((entry) => entry.mode === "steering").length

    return (
        <div className="mx-3.5" data-testid="input-queue-root">
            <Popover onOpenChange={setExpanded} open={expanded}>
                <PopoverTrigger asChild>
                    <button
                        aria-expanded={expanded}
                        className="flex w-full items-center gap-1 appearance-none border-0 bg-transparent px-0 py-0.5 text-left text-xs text-(--vscode-foreground)"
                        data-testid="input-queue-toggle"
                        type="button">
                        {expanded ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
                        <span>Queue {entries.length}</span>
                        {steeringCount > 0 ? (
                            <span className="text-(--vscode-charts-orange,var(--vscode-foreground))">
                                {" "}
                                {steeringCount} steering
                            </span>
                        ) : null}
                    </button>
                </PopoverTrigger>

                <PopoverContent
                    align="start"
                    aria-label="Queued input"
                    className="max-h-[min(60vh,480px)] w-(--radix-popover-trigger-width) overflow-y-auto overscroll-contain rounded p-1 text-xs shadow-lg"
                    collisionPadding={8}
                    data-testid="input-queue-overlay"
                    // The surface is portalled out of ChatLayout's overflow-hidden tree.
                    // An explicit fallback chain guarantees an opaque paint even when a
                    // host theme omits one of the more specific widget tokens.
                    role="listbox"
                    side="top"
                    sideOffset={4}
                    style={{
                        backgroundColor:
                            "var(--vscode-editorWidget-background, var(--vscode-menu-background, var(--vscode-sideBar-background, rgb(30, 30, 30))))",
                        borderColor:
                            "var(--vscode-editorWidget-border, var(--vscode-panel-border, var(--vscode-contrastBorder, transparent)))",
                        color: "var(--vscode-foreground)",
                        maxHeight: "min(60vh, 480px, var(--radix-popover-content-available-height))",
                    }}>
                    {entries.map((entry, index) => {
                        const attachments = queuedAttachmentsOf(entry)
                        const summary = attachmentSummary(attachments)
                        return (
                            <div
                                aria-selected={entry.mode === "steering"}
                                className={classes(
                                    // The body carries the user's own text, so it stays on the
                                    // primary foreground token. Mode is signalled by the header
                                    // and the border instead of dimming the whole entry.
                                    "group rounded border bg-(--vscode-editorWidget-background,var(--vscode-sideBar-background)) px-2 py-1.5 text-xs text-(--vscode-foreground)",
                                    entry.mode === "steering"
                                        ? "border-(--vscode-charts-orange,var(--vscode-focusBorder))"
                                        : "border-(--vscode-editorWidget-border,var(--vscode-panel-border))",
                                    entry.editing && "italic",
                                    draggingId === entry.id && "opacity-40",
                                )}
                                data-editing={entry.editing ? "true" : "false"}
                                data-mode={entry.mode}
                                data-testid={`input-queue-entry-${entry.id}`}
                                draggable={true}
                                key={entry.id}
                                onDragEnd={() => setDraggingId(undefined)}
                                onDragOver={(event) => event.preventDefault()}
                                onDragStart={() => setDraggingId(entry.id)}
                                onDrop={() => {
                                    if (draggingId && draggingId !== entry.id) {
                                        onReorder(draggingId, index)
                                    }
                                    setDraggingId(undefined)
                                }}
                                role="option"
                                style={{
                                    backgroundColor:
                                        "var(--vscode-editorWidget-background, var(--vscode-menu-background, var(--vscode-sideBar-background, rgb(30, 30, 30))))",
                                }}
                                // Roving tabindex: the row is programmatically focusable for
                                // assistive tech without adding a tab stop per queue entry.
                                tabIndex={-1}>
                                <header
                                    className={classes(
                                        "mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide",
                                        entry.mode === "steering"
                                            ? "text-(--vscode-charts-orange,var(--vscode-foreground))"
                                            : "text-(--vscode-descriptionForeground)",
                                    )}>
                                    <GripVerticalIcon className="size-3 shrink-0 cursor-grab" />
                                    <span>{entry.mode === "steering" ? "Steering input" : "Queued input"}</span>
                                    {entry.editing ? <span className="normal-case">· Editing</span> : null}
                                    {summary ? (
                                        <span
                                            className="ml-auto shrink-0 normal-case"
                                            data-testid={`input-queue-attachments-${entry.id}`}
                                            title={[...attachments.images, ...attachments.files].join(", ")}>
                                            {summary}
                                        </span>
                                    ) : null}
                                </header>
                                <QueuedEntryBody entry={entry} />
                                <footer className="mt-1 flex items-center justify-end gap-1">
                                    <button
                                        aria-label={entry.mode === "steering" ? "Return to queue" : "Send with next round"}
                                        className="input-icon-button shrink-0 appearance-none border-0 bg-transparent p-0"
                                        data-testid={`input-queue-send-${entry.id}`}
                                        onClick={() => onToggleMode(entry.id)}
                                        type="button">
                                        <SendIcon className="size-3" />
                                    </button>
                                    {/* An entry under edit is held back from delivery, so it needs a
								    way out that does not require sending or deleting it. */}
                                    {entry.editing ? (
                                        <button
                                            aria-label="Cancel editing"
                                            className="input-icon-button shrink-0 appearance-none border-0 bg-transparent p-0"
                                            data-testid={`input-queue-cancel-edit-${entry.id}`}
                                            onClick={() => onCancelEdit(entry.id)}
                                            type="button">
                                            <RotateCcwIcon className="size-3" />
                                        </button>
                                    ) : (
                                        <button
                                            aria-label="Edit queued input"
                                            className="input-icon-button shrink-0 appearance-none border-0 bg-transparent p-0"
                                            data-testid={`input-queue-edit-${entry.id}`}
                                            onClick={() => onEdit(entry.id)}
                                            type="button">
                                            <PencilIcon className="size-3" />
                                        </button>
                                    )}
                                    <button
                                        aria-label="Remove queued input"
                                        className="input-icon-button shrink-0 appearance-none border-0 bg-transparent p-0"
                                        data-testid={`input-queue-remove-${entry.id}`}
                                        onClick={() => onRemove(entry.id)}
                                        type="button">
                                        <XIcon className="size-3" />
                                    </button>
                                </footer>
                            </div>
                        )
                    })}
                </PopoverContent>
            </Popover>
        </div>
    )
}
