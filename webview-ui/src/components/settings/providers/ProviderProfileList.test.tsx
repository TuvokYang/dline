import { DndContext, type DragEndEvent, KeyboardSensor, PointerSensor } from "@dnd-kit/core"
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable"
import { ApiProfile } from "@shared/proto/dline/profile"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import ProviderProfileList from "./ProviderProfileList"

const dndMockState = vi.hoisted(() => ({
    props: undefined as React.ComponentProps<typeof DndContext> | undefined,
}))

vi.mock("@dnd-kit/core", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@dnd-kit/core")>()
    const React = await import("react")
    return {
        ...actual,
        DndContext: (props: React.ComponentProps<typeof actual.DndContext>) => {
            dndMockState.props = props
            return React.createElement(actual.DndContext, props)
        },
    }
})

vi.mock("./ProviderProfileCard", () => ({
    default: ({ profile, dragHandle }: { profile: ApiProfile; dragHandle?: React.ReactNode }) => (
        <div data-testid={`profile-${profile.id}`}>
            {dragHandle}
            {profile.name}
        </div>
    ),
}))

const providerOptions = [{ value: "openai", label: "OpenAI" }]

/**
 * Build a profile fixture for list rendering tests.
 * @returns Api profile test fixture.
 */
function buildProfile(id = "profile-1", modelId = "model-a"): ApiProfile {
    return ApiProfile.create({
        id,
        name: `openai:${modelId}`,
        provider: "openai",
        modelId,
        usedFor: ["act"],
        enabled: true,
    })
}

describe("ProviderProfileList", () => {
    it("places count, Add profile, and Manage actions in the top toolbar", () => {
        const onAddProfile = vi.fn()
        const onToggleEditMode = vi.fn()
        render(
            <ProviderProfileList
                currentMode="act"
                editMode={false}
                expandedId={null}
                onAddProfile={onAddProfile}
                onDeleteProfile={vi.fn()}
                onReorderProfiles={vi.fn()}
                onToggleEditMode={onToggleEditMode}
                onToggleExpand={vi.fn()}
                onUpdateProfile={vi.fn()}
                profiles={[buildProfile()]}
                providerOptions={providerOptions}
            />,
        )

        expect(screen.getByText("1 profile")).toBeInTheDocument()
        expect(screen.getByRole("button", { name: "Reorder openai:model-a" })).toHaveAttribute("tabindex", "0")
        fireEvent.click(screen.getByRole("button", { name: "Add profile" }))
        fireEvent.click(screen.getByRole("button", { name: "Manage profiles" }))
        expect(onAddProfile).toHaveBeenCalledOnce()
        expect(onToggleEditMode).toHaveBeenCalledOnce()
        expect(screen.queryByRole("button", { name: "Add API" })).not.toBeInTheDocument()
    })

    it("configures pointer and keyboard sensors and persists only a valid drop once", () => {
        const onReorderProfiles = vi.fn()
        render(
            <ProviderProfileList
                currentMode="act"
                editMode={false}
                expandedId={null}
                onAddProfile={vi.fn()}
                onDeleteProfile={vi.fn()}
                onReorderProfiles={onReorderProfiles}
                onToggleEditMode={vi.fn()}
                onToggleExpand={vi.fn()}
                onUpdateProfile={vi.fn()}
                profiles={[buildProfile(), buildProfile("profile-2", "model-b")]}
                providerOptions={providerOptions}
            />,
        )

        expect(dndMockState.props?.sensors).toEqual([
            expect.objectContaining({
                options: { activationConstraint: { distance: 6 } },
                sensor: PointerSensor,
            }),
            expect.objectContaining({
                options: { coordinateGetter: sortableKeyboardCoordinates },
                sensor: KeyboardSensor,
            }),
        ])

        act(() => {
            dndMockState.props?.onDragEnd?.({ active: { id: "profile-1" }, over: null } as DragEndEvent)
            dndMockState.props?.onDragEnd?.({ active: { id: "profile-1" }, over: { id: "profile-1" } } as DragEndEvent)
            dndMockState.props?.onDragEnd?.({ active: { id: "profile-1" }, over: { id: "profile-2" } } as DragEndEvent)
        })

        expect(onReorderProfiles).toHaveBeenCalledOnce()
        expect(onReorderProfiles).toHaveBeenCalledWith("profile-1", "profile-2")
    })

    it("uses muted settings-compatible button surfaces", () => {
        render(
            <ProviderProfileList
                currentMode="act"
                editMode={false}
                expandedId={null}
                onAddProfile={vi.fn()}
                onDeleteProfile={vi.fn()}
                onReorderProfiles={vi.fn()}
                onToggleEditMode={vi.fn()}
                onToggleExpand={vi.fn()}
                onUpdateProfile={vi.fn()}
                profiles={[buildProfile()]}
                providerOptions={providerOptions}
            />,
        )

        expect(screen.getByRole("button", { name: "Manage profiles" })).toHaveClass("border-editor-widget-border/40")
        expect(screen.getByRole("button", { name: "Add profile" })).toHaveClass("bg-(--vscode-editor-background)")
    })

    it("uses a muted destructive style for delete confirmation", () => {
        render(
            <ProviderProfileList
                currentMode="act"
                editMode={true}
                expandedId={null}
                onAddProfile={vi.fn()}
                onDeleteProfile={vi.fn()}
                onReorderProfiles={vi.fn()}
                onToggleEditMode={vi.fn()}
                onToggleExpand={vi.fn()}
                onUpdateProfile={vi.fn()}
                profiles={[buildProfile()]}
                providerOptions={providerOptions}
            />,
        )

        const deleteButton = screen.getByRole("button", { name: "Delete selected (0)" })

        expect(deleteButton).toHaveClass("border-editor-widget-border/40")
        expect(deleteButton).not.toHaveClass("border-red-600")
    })
})
