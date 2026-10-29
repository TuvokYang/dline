import {
    closestCenter,
    DndContext,
    type DragEndEvent,
    DragOverlay,
    type DragStartEvent,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
} from "@dnd-kit/core"
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import type { ImageGenerationProfile } from "@shared/proto/dline/profile"
import type { Mode } from "@shared/storage/types"
import { CheckIcon, GripVerticalIcon, ListFilterIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { useState } from "react"
import type { ApiProfile } from "./ProviderProfile"
import ApiProfileCard from "./ProviderProfileCard"

interface ApiProfileListProps {
    profiles: ApiProfile[]
    imageProfiles: ImageGenerationProfile[]
    imageGenerationEnabled: boolean
    expandedId: string | null
    editMode: boolean
    currentMode: Mode
    providerOptions: readonly { value: string; label: string }[]
    onToggleExpand: (id: string) => void
    onToggleEditMode: () => void
    onAddProfile: () => void
    onDeleteProfile: (id: string) => void
    onReorderProfiles: (activeId: string, overId: string) => void
    onUpdateProfile: (id: string, updates: Partial<ApiProfile>) => void
}

const btnClass =
    "inline-flex min-h-7 cursor-pointer items-center justify-center gap-1 rounded-xs border border-editor-widget-border/40 bg-(--vscode-editor-background) px-2 text-xs text-description transition-colors hover:bg-(--vscode-list-hoverBackground) hover:text-foreground"

interface SortableProfileCardProps
    extends Omit<ApiProfileListProps, "profiles" | "onReorderProfiles" | "onToggleEditMode" | "onAddProfile"> {
    profile: ApiProfile
    selected: boolean
    onToggleSelect: () => void
}

function SortableProfileCard({
    profile,
    imageProfiles,
    imageGenerationEnabled,
    expandedId,
    editMode,
    currentMode,
    providerOptions,
    onToggleExpand,
    onDeleteProfile,
    onUpdateProfile,
    selected,
    onToggleSelect,
}: SortableProfileCardProps) {
    const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging } = useSortable({
        id: profile.id,
    })
    const name = profile.name || `${profile.provider}:${profile.modelId}` || "Unnamed profile"
    return (
        <div
            className={isDragging ? "opacity-40" : undefined}
            ref={setNodeRef}
            style={{ transform: CSS.Transform.toString(transform), transition }}>
            <ApiProfileCard
                currentMode={currentMode}
                dragHandle={
                    <button
                        aria-label={`Reorder ${name}`}
                        className="inline-flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-xs border-0 bg-transparent text-description hover:bg-toolbar-hover hover:text-foreground active:cursor-grabbing"
                        ref={setActivatorNodeRef}
                        type="button"
                        {...attributes}
                        {...listeners}>
                        <GripVerticalIcon size={13} />
                    </button>
                }
                editMode={editMode}
                imageGenerationEnabled={imageGenerationEnabled}
                imageProfiles={imageProfiles}
                isExpanded={expandedId === profile.id}
                onDelete={() => onDeleteProfile(profile.id)}
                onToggleExpand={() => onToggleExpand(profile.id)}
                onToggleSelect={onToggleSelect}
                onUpdate={(updates) => onUpdateProfile(profile.id, updates)}
                profile={profile}
                providerOptions={providerOptions}
                selected={selected}
            />
        </div>
    )
}

/**
 * List of configured provider profiles with edit mode, multi-select, and add/delete.
 */
const ApiProfileList: React.FC<ApiProfileListProps> = ({
    profiles,
    imageProfiles,
    imageGenerationEnabled,
    expandedId,
    editMode,
    currentMode,
    providerOptions,
    onToggleExpand,
    onToggleEditMode,
    onAddProfile,
    onDeleteProfile,
    onReorderProfiles,
    onUpdateProfile,
}) => {
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
    const [confirmDelete, setConfirmDelete] = useState(false)
    const [activeId, setActiveId] = useState<string | null>(null)
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    )

    const toggleSelect = (id: string) => {
        setSelectedIds((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    const handleDeleteClick = () => {
        if (!confirmDelete) {
            setConfirmDelete(true)
            setTimeout(() => setConfirmDelete(false), 5000)
            return
        }
        selectedIds.forEach((id) => {
            onDeleteProfile(id)
        })
        setSelectedIds(new Set())
        setConfirmDelete(false)
    }

    const handleDragStart = ({ active }: DragStartEvent) => setActiveId(String(active.id))
    const handleDragEnd = ({ active, over }: DragEndEvent) => {
        setActiveId(null)
        if (over && active.id !== over.id) onReorderProfiles(String(active.id), String(over.id))
    }
    const activeProfile = activeId ? profiles.find((profile) => profile.id === activeId) : undefined
    const profileCountLabel = `${profiles.length} ${profiles.length === 1 ? "profile" : "profiles"}`

    return (
        <div className="mb-4 flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
                <span className="mr-auto text-xs text-description">{profileCountLabel}</span>
                <button aria-label="Add profile" className={btnClass} onClick={onAddProfile} type="button">
                    <PlusIcon size={14} />
                    <span>Add profile</span>
                </button>
                <button
                    aria-label={editMode ? "Done managing profiles" : "Manage profiles"}
                    className={btnClass}
                    onClick={onToggleEditMode}
                    type="button">
                    {editMode ? <CheckIcon size={14} /> : <ListFilterIcon size={14} />}
                    <span>{editMode ? "Done" : "Manage"}</span>
                </button>
            </div>

            <DndContext
                collisionDetection={closestCenter}
                onDragCancel={() => setActiveId(null)}
                onDragEnd={handleDragEnd}
                onDragStart={handleDragStart}
                sensors={sensors}>
                <SortableContext items={profiles.map((profile) => profile.id)} strategy={verticalListSortingStrategy}>
                    {profiles.map((profile) => (
                        <SortableProfileCard
                            currentMode={currentMode}
                            editMode={editMode}
                            expandedId={expandedId}
                            imageGenerationEnabled={imageGenerationEnabled}
                            imageProfiles={imageProfiles}
                            key={profile.id}
                            onDeleteProfile={onDeleteProfile}
                            onToggleExpand={onToggleExpand}
                            onToggleSelect={() => toggleSelect(profile.id)}
                            onUpdateProfile={onUpdateProfile}
                            profile={profile}
                            providerOptions={providerOptions}
                            selected={selectedIds.has(profile.id)}
                        />
                    ))}
                </SortableContext>
                <DragOverlay>
                    {activeProfile ? (
                        <div className="rounded-xs border border-editor-widget-border bg-(--vscode-editor-background) px-3 py-2 shadow-lg">
                            <div className="truncate text-sm font-medium text-foreground">
                                {activeProfile.name || "Unnamed profile"}
                            </div>
                            <div className="truncate text-xs text-description">
                                {[activeProfile.provider, activeProfile.modelId].filter(Boolean).join(" · ")}
                            </div>
                        </div>
                    ) : null}
                </DragOverlay>
            </DndContext>

            {editMode ? (
                <div className="flex justify-end">
                    <button
                        className={`${btnClass} ${
                            confirmDelete ? "text-error" : selectedIds.size > 0 ? "" : "cursor-not-allowed opacity-40"
                        }`}
                        disabled={!confirmDelete && selectedIds.size === 0}
                        onClick={handleDeleteClick}
                        type="button">
                        <Trash2Icon size={14} />
                        <span>
                            {confirmDelete ? `Confirm delete (${selectedIds.size})` : `Delete selected (${selectedIds.size})`}
                        </span>
                    </button>
                </div>
            ) : null}

            {profiles.length === 0 ? (
                <div className="rounded-xs border border-dashed border-editor-widget-border/50 px-3 py-4 text-center text-xs text-description">
                    No profiles configured. Add a profile to connect a provider and model.
                </div>
            ) : null}
        </div>
    )
}

export default ApiProfileList
