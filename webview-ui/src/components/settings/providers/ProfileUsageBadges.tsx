import { cn } from "@/lib/utils"

const usageDefinitions = [
    { key: "act", label: "ACT" },
    { key: "plan", label: "PLAN" },
    { key: "subagents", label: "SUB" },
] as const

interface ProfileUsageBadgesProps {
    usedFor: readonly string[]
    className?: string
}

export function ProfileUsageBadges({ usedFor, className }: ProfileUsageBadgesProps) {
    const visible = usageDefinitions.filter((definition) => usedFor.includes(definition.key))
    if (visible.length === 0) return null

    return (
        <fieldset className={cn("m-0 flex shrink-0 items-center justify-end gap-0.5 border-0 p-0", className)}>
            <legend className="sr-only">Profile uses</legend>
            {visible.map((definition) => (
                <span
                    className="inline-flex h-5 items-center rounded-xs border border-editor-widget-border/50 px-1 text-xs font-medium leading-none text-description"
                    key={definition.key}
                    title={`Used for ${definition.key}`}>
                    {definition.label}
                </span>
            ))}
        </fieldset>
    )
}
