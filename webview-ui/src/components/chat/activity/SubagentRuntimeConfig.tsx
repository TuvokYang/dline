import type { TaskActivityRuntimeConfig } from "@shared/proto/dline/task"
import type { UiTranslator } from "@/i18n/messages"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"

interface SubagentRuntimeConfigProps {
    runtime: TaskActivityRuntimeConfig | undefined
    className?: string
}

/** Provider and model identifiers stay raw; only the words the product owns are translated. */
function thinkingLabel(runtime: TaskActivityRuntimeConfig, t: UiTranslator): string | undefined {
    if (runtime.reasoningEffort) return runtime.reasoningEffort
    if (runtime.thinkingBudgetTokens !== undefined) {
        return t("chatRows.common.tokens", { count: runtime.thinkingBudgetTokens.toLocaleString() })
    }
    if (runtime.thinkingEnabled !== undefined) {
        return runtime.thinkingEnabled
            ? t("chatRows.subagent.runtime.thinkingEnabled")
            : t("chatRows.subagent.runtime.thinkingDisabled")
    }
    return undefined
}

/** Display the effective runtime configuration captured by the subagent runner. */
export function SubagentRuntimeConfig({ runtime, className }: SubagentRuntimeConfigProps) {
    const { t } = useUiTranslation()
    if (!runtime) return null
    const items = [
        ["profile", t("chatRows.subagent.runtime.profile"), runtime.profileName],
        ["provider", t("chatRows.subagent.runtime.provider"), runtime.providerId],
        ["model", t("chatRows.subagent.runtime.model"), runtime.modelId],
        ["api", t("chatRows.subagent.runtime.api"), runtime.apiFormat],
        ["thinking", t("chatRows.subagent.runtime.thinking"), thinkingLabel(runtime, t)],
    ].filter((item): item is [string, string, string] => Boolean(item[2]))
    if (items.length === 0) return null

    return (
        <span
            className={["inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-description", className]
                .filter(Boolean)
                .join(" ")}
            data-testid="subagent-runtime-config">
            {items.map(([id, label, value], index) => (
                <span
                    className="inline-flex min-w-0 items-center gap-0.5"
                    key={id}
                    title={t("chatRows.subagent.runtime.value", { label, value })}>
                    {index > 0 && <span aria-hidden="true">·</span>}
                    <span>{`${label}:`}</span>
                    <span className="min-w-0 truncate font-mono text-foreground">{value}</span>
                </span>
            ))}
        </span>
    )
}
