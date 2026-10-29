import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { AlertTriangle } from "lucide-react"
import React, { ReactNode } from "react"
import { createPortal } from "react-dom"
import { cn } from "@/lib/utils"
import { OPENROUTER_MODEL_PICKER_Z_INDEX } from "../settings/OpenRouterModelPicker"

interface AlertDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    children: ReactNode
}

/**
 * Inline backdrop style shared by all alert dialogs.
 */
export const ALERT_DIALOG_BACKDROP_STYLE: React.CSSProperties = {
    backgroundColor: "rgba(96, 96, 96, 0.42)",
    zIndex: OPENROUTER_MODEL_PICKER_Z_INDEX + 50,
}

/**
 * Semi-transparent blurred panel style shared by all alert dialogs.
 */
export const ALERT_DIALOG_PANEL_STYLE: React.CSSProperties = {
    backdropFilter: "blur(22px) saturate(140%)",
    backgroundColor: "rgba(24, 24, 27, 0.88)",
    WebkitBackdropFilter: "blur(22px) saturate(140%)",
}

/**
 * Render a centered gray alert dialog overlay.
 * @param props Dialog open state and children.
 * @returns Dialog overlay or null when closed.
 */
export function AlertDialog({ open, onOpenChange, children }: AlertDialogProps) {
    if (!open) {
        return null
    }

    /**
     * Close the dialog when clicking on the backdrop.
     * @param e Mouse event from the overlay.
     */
    const handleBackdropClick = (e: React.MouseEvent) => {
        if (e.target === e.currentTarget) {
            onOpenChange(false)
        }
    }

    return createPortal(
        <div
            className="fixed inset-0 flex items-center justify-center p-4"
            onClick={handleBackdropClick}
            style={ALERT_DIALOG_BACKDROP_STYLE}>
            {children}
        </div>,
        document.body,
    )
}

/**
 * Render the shared translucent blurred alert dialog panel.
 * @param props Standard div properties and dialog content.
 * @returns Centered alert dialog content panel.
 */
export function AlertDialogContent({ className, children, style, ...props }: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            aria-modal="true"
            className={cn(
                "w-[min(420px,calc(100vw-2rem))] rounded-xs border border-[rgba(255,255,255,0.18)] p-5 text-(--vscode-editor-foreground) shadow-[0_22px_64px_rgba(0,0,0,0.72),inset_0_0_0_1px_rgba(255,255,255,0.08)]",
                className,
            )}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            style={{ ...ALERT_DIALOG_PANEL_STYLE, ...style }}
            {...props}>
            {children}
        </div>
    )
}

/**
 * Render the dialog header layout.
 * @param props Standard div properties.
 * @returns Alert dialog header container.
 */
export function AlertDialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("flex flex-col gap-1 text-left", className)} {...props} />
}

/**
 * Render the dialog footer layout.
 * @param props Standard div properties.
 * @returns Alert dialog footer container.
 */
export function AlertDialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("mt-6 flex flex-row justify-end gap-2", className)} {...props} />
}

/**
 * Render the dialog title text.
 * @param props Standard heading properties.
 * @returns Alert dialog title heading.
 */
export function AlertDialogTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
    return <h2 className={cn("flex items-center gap-2 text-left text-base font-semibold text-[#f8fafc]", className)} {...props} />
}

/**
 * Render the dialog description text.
 * @param props Standard paragraph properties.
 * @returns Alert dialog description paragraph.
 */
export function AlertDialogDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
    return <p className={cn("text-left text-sm leading-5 text-[#e4e4e7]", className)} {...props} />
}

/**
 * Render the dialog primary action.
 * @param props VS Code button properties.
 * @returns Alert dialog action button.
 */
export function AlertDialogAction({ className, ...props }: React.ComponentProps<typeof VSCodeButton>) {
    return <VSCodeButton appearance="primary" className={className} {...props} />
}

/**
 * Render the dialog cancel action.
 * @param props VS Code button properties.
 * @returns Alert dialog cancel button.
 */
export function AlertDialogCancel({ className, ...props }: React.ComponentProps<typeof VSCodeButton>) {
    return <VSCodeButton appearance="secondary" className={className} {...props} />
}

export function UnsavedChangesDialog({
    open,
    onOpenChange,
    onConfirm,
    onCancel,
    onSave,
    title = "Unsaved Changes",
    description = "You have unsaved changes. Are you sure you want to discard them?",
    confirmText = "Discard Changes",
    saveText = "Save & Continue",
    showSaveOption = false,
}: {
    open: boolean
    onOpenChange: (open: boolean) => void
    onConfirm: () => void
    onCancel: () => void
    onSave?: () => void
    title?: string
    description?: string
    confirmText?: string
    saveText?: string
    showSaveOption?: boolean
}) {
    return (
        <AlertDialog onOpenChange={onOpenChange} open={open}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>
                        <AlertTriangle className="w-5 h-5 text-(--vscode-errorForeground)" />
                        {title}
                    </AlertDialogTitle>
                    <AlertDialogDescription>{description}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
                    {showSaveOption && onSave && <AlertDialogAction onClick={onSave}>{saveText}</AlertDialogAction>}
                    <AlertDialogAction appearance={showSaveOption ? "secondary" : "primary"} onClick={onConfirm}>
                        {confirmText}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    )
}
