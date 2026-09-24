import { ChevronDownIcon, ChevronRightIcon, GripVerticalIcon, PencilIcon, RotateCcwIcon, SendIcon, XIcon } from "lucide-react"
import { useState } from "react"
import { UserInputMarkdownBody } from "@/components/chat/UserInputMarkdownBody"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

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
	readonly semanticInput?: import("@shared/input-semantics/document").SemanticInputDocument
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

function attachmentSummary(entry: InputQueuePanelEntry): string | undefined {
	const parts: string[] = []
	if (entry.images.length > 0) parts.push(`${entry.images.length} image${entry.images.length > 1 ? "s" : ""}`)
	if (entry.files.length > 0) parts.push(`${entry.files.length} file${entry.files.length > 1 ? "s" : ""}`)
	return parts.length > 0 ? parts.join(", ") : undefined
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
						const attachments = attachmentSummary(entry)
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
									{attachments ? <span className="ml-auto shrink-0 normal-case">{attachments}</span> : null}
								</header>
								<UserInputMarkdownBody
									markdown={entry.text}
									testId={`input-queue-markdown-${entry.id}`}
									variant="queued-pending"
								/>
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
