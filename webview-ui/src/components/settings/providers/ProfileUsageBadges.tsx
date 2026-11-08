import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { cn } from "@/lib/utils"

const usageDefinitions = [
    { key: "act", label: "settings.ui.profiles.actBadge", mode: "settings.ui.act" },
    { key: "plan", label: "settings.ui.profiles.planBadge", mode: "settings.ui.plan" },
    { key: "subagents", label: "settings.ui.profiles.subBadge", mode: "settings.ui.subagents" },
] as const

interface ProfileUsageBadgesProps {
    usedFor: readonly string[]
    className?: string
}

export function ProfileUsageBadges({ usedFor, className }: ProfileUsageBadgesProps) {
    const { t } = useUiTranslation()
    const visible = usageDefinitions.filter((definition) => usedFor.includes(definition.key))
    if (visible.length === 0) return null

    return (
        <fieldset className={cn("m-0 flex shrink-0 items-center justify-end gap-0.5 border-0 p-0", className)}>
            <legend className="sr-only">{t("settings.ui.profiles.uses")}</legend>
            {visible.map((definition) => (
                <span
                    className="inline-flex h-5 items-center rounded-xs border border-editor-widget-border/50 px-1 text-xs font-medium leading-none text-description"
                    key={definition.key}
                    title={t("settings.ui.profiles.usedFor", { mode: t(definition.mode).toLowerCase() })}>
                    {t(definition.label)}
                </span>
            ))}
        </fieldset>
    )
}
