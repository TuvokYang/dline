import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import {
    ALERT_DIALOG_BACKDROP_STYLE,
    ALERT_DIALOG_PANEL_STYLE,
    AlertDialog,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogTitle,
} from "./AlertDialog"

describe("AlertDialog", () => {
    it("uses a body-level gray translucent backdrop", () => {
        const onOpenChange = vi.fn()
        const { container } = render(
            <div data-testid="local-root">
                <AlertDialog onOpenChange={onOpenChange} open={true}>
                    <AlertDialogContent>Dialog content</AlertDialogContent>
                </AlertDialog>
            </div>,
        )

        const backdrop = screen.getByText("Dialog content").parentElement

        expect(ALERT_DIALOG_BACKDROP_STYLE).toMatchObject({
            backgroundColor: "rgba(96, 96, 96, 0.42)",
        })
        expect(ALERT_DIALOG_BACKDROP_STYLE).not.toHaveProperty("backdropFilter")
        expect(ALERT_DIALOG_BACKDROP_STYLE).not.toHaveProperty("WebkitBackdropFilter")
        expect(backdrop).toHaveStyle({ backgroundColor: "rgba(96, 96, 96, 0.42)" })
        expect(backdrop?.className).not.toContain("bg-black")
        expect(container.querySelector('[role="dialog"]')).toBeNull()
        expect(document.body.contains(backdrop)).toBe(true)
    })

    it("uses a translucent blurred panel with high contrast text", () => {
        const onOpenChange = vi.fn()

        render(
            <AlertDialog onOpenChange={onOpenChange} open={true}>
                <AlertDialogContent>
                    <AlertDialogTitle>Readable title</AlertDialogTitle>
                    <AlertDialogDescription>Readable description</AlertDialogDescription>
                </AlertDialogContent>
            </AlertDialog>,
        )

        const dialog = screen.getByRole("dialog")
        expect(ALERT_DIALOG_PANEL_STYLE).toMatchObject({
            backdropFilter: "blur(22px) saturate(140%)",
            backgroundColor: "rgba(24, 24, 27, 0.88)",
            WebkitBackdropFilter: "blur(22px) saturate(140%)",
        })
        expect(dialog).toHaveStyle({ backgroundColor: "rgba(24, 24, 27, 0.88)" })
        expect(screen.getByText("Readable title").className).toContain("text-[#f8fafc]")
        expect(screen.getByText("Readable description").className).toContain("text-[#e4e4e7]")
    })

    it("closes when clicking the backdrop", () => {
        const onOpenChange = vi.fn()

        render(
            <AlertDialog onOpenChange={onOpenChange} open={true}>
                <AlertDialogContent>Dialog content</AlertDialogContent>
            </AlertDialog>,
        )

        const backdrop = screen.getByText("Dialog content").parentElement
        if (!backdrop) throw new Error("backdrop missing")
        fireEvent.click(backdrop)

        expect(onOpenChange).toHaveBeenCalledWith(false)
    })
})
