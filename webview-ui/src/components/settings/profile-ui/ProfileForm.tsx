import { ChevronDownIcon, ChevronRightIcon, InfoIcon, TriangleAlertIcon, XCircleIcon } from "lucide-react"
import { type HTMLAttributes, type ReactNode, useId, useState } from "react"
import { cn } from "@/lib/utils"

export function ProfileForm({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            className={cn(
                "profile-form flex w-full min-w-0 flex-col gap-4 [&_div[style*='font-size']]:!text-xs [&_label]:!text-sm [&_p]:!m-0 [&_p]:!text-xs [&_p]:leading-normal [&_p]:text-description [&_span[style*='font-size']]:!text-xs [&_vscode-button]:min-h-7 [&_vscode-dropdown]:!min-h-7 [&_vscode-dropdown]:!min-w-0 [&_vscode-dropdown]:w-full [&_vscode-dropdown]:!text-sm [&_vscode-option[style*='font-size']]:!text-sm [&_vscode-text-field]:min-h-7 [&_vscode-text-field]:min-w-0 [&_vscode-text-field]:w-full",
                className,
            )}
            {...props}
        />
    )
}

export function ProfileSection({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return <section className={cn("flex flex-col gap-2", className)} {...props} />
}

export function ProfileSectionTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
    return <h3 className={cn("m-0 text-sm font-semibold leading-tight text-foreground", className)} {...props} />
}

interface ProfileFieldProps extends HTMLAttributes<HTMLDivElement> {
    label?: ReactNode
    description?: ReactNode
    error?: ReactNode
    actions?: ReactNode
    htmlFor?: string
}

export function ProfileField({ label, description, error, actions, htmlFor, className, children, ...props }: ProfileFieldProps) {
    return (
        <div className={cn("profile-field flex min-w-0 flex-col gap-1", className)} {...props}>
            {label ? (
                <div className="flex min-w-0 items-center justify-between gap-2">
                    {htmlFor ? (
                        <label className="min-w-0 text-sm font-medium leading-tight text-foreground" htmlFor={htmlFor}>
                            {label}
                        </label>
                    ) : (
                        <div className="min-w-0 text-sm font-medium leading-tight text-foreground">{label}</div>
                    )}
                    {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
                </div>
            ) : null}
            <div className="min-w-0 [&_input]:min-h-7 [&_select]:min-h-7 [&_vscode-dropdown]:min-h-7 [&_vscode-dropdown]:w-full [&_vscode-text-field]:min-h-7 [&_vscode-text-field]:w-full">
                {children}
            </div>
            {description ? <p className="text-xs leading-normal text-description">{description}</p> : null}
            {error ? (
                <p className="text-xs leading-normal text-error" role="alert">
                    {error}
                </p>
            ) : null}
        </div>
    )
}

export function ProfileInlineGrid({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("grid min-w-0 grid-cols-1 gap-2 xs:grid-cols-2", className)} {...props} />
}

export function ProfileActionRow({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("flex flex-wrap items-center justify-end gap-2", className)} {...props} />
}

type NoticeVariant = "info" | "warning" | "error" | "unavailable"

const noticeStyles: Record<NoticeVariant, string> = {
    info: "border-editor-widget-border/50 bg-toolbar-hover/35 text-foreground",
    warning: "border-editor-warning-foreground/60 bg-warning/10 text-foreground",
    error: "border-error/60 bg-input-error-background/35 text-foreground",
    unavailable: "border-editor-widget-border/60 bg-muted/35 text-description",
}

const noticeIcons: Record<NoticeVariant, ReactNode> = {
    info: <InfoIcon className="size-4" />,
    warning: <TriangleAlertIcon className="size-4 text-editor-warning-foreground" />,
    error: <XCircleIcon className="size-4 text-error" />,
    unavailable: <TriangleAlertIcon className="size-4" />,
}

interface ProfileNoticeProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
    variant?: NoticeVariant
    title?: ReactNode
}

export function ProfileNotice({ variant = "info", title, className, children, ...props }: ProfileNoticeProps) {
    return (
        <div
            className={cn(
                "flex items-start gap-2 rounded-xs border p-2 text-xs leading-normal",
                noticeStyles[variant],
                className,
            )}
            role={variant === "error" ? "alert" : "status"}
            {...props}>
            <span aria-hidden="true" className="mt-0.5 shrink-0">
                {noticeIcons[variant]}
            </span>
            <div className="min-w-0 flex-1">
                {title ? <div className="font-medium text-foreground">{title}</div> : null}
                <div className={cn(title && "mt-0.5")}>{children}</div>
            </div>
        </div>
    )
}

interface ProfileDisclosureProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
    title: ReactNode
    defaultExpanded?: boolean
}

export function ProfileDisclosure({ title, defaultExpanded = false, className, children, ...props }: ProfileDisclosureProps) {
    const [expanded, setExpanded] = useState(defaultExpanded)
    const contentId = useId()
    return (
        <div className={cn("flex flex-col gap-2", className)} {...props}>
            <button
                aria-controls={contentId}
                aria-expanded={expanded}
                className="flex min-h-7 w-full items-center gap-1 rounded-xs border-0 bg-transparent px-1 text-left text-sm font-semibold text-description hover:bg-toolbar-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border"
                onClick={() => setExpanded((value) => !value)}
                type="button">
                {expanded ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}
                <span>{title}</span>
            </button>
            {expanded ? (
                <div className="flex flex-col gap-3 pl-1" id={contentId}>
                    {children}
                </div>
            ) : null}
        </div>
    )
}
