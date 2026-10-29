import type { BrowserAction } from "@shared/ExtensionMessage"
import {
    ChevronsDownIcon,
    ChevronsUpIcon,
    GlobeIcon,
    KeyboardIcon,
    type LucideIcon,
    MousePointerClickIcon,
    XIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"

const ICONS: Record<BrowserAction, LucideIcon> = {
    launch: GlobeIcon,
    click: MousePointerClickIcon,
    type: KeyboardIcon,
    scroll_down: ChevronsDownIcon,
    scroll_up: ChevronsUpIcon,
    close: XIcon,
}

/** The icon of one browser action, so a list of steps reads by kind at a glance. */
export function BrowserActionIcon({ action, className }: { action: BrowserAction; className?: string }) {
    const Icon = ICONS[action]
    return <Icon aria-hidden className={cn("size-3.5 shrink-0", className)} data-action={action} />
}
