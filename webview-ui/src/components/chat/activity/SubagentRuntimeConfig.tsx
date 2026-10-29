import type { TaskActivityRuntimeConfig } from "@shared/proto/dline/task"

interface SubagentRuntimeConfigProps {
    runtime: TaskActivityRuntimeConfig | undefined
    className?: string
}

function thinkingLabel(runtime: TaskActivityRuntimeConfig): string | undefined {
    if (runtime.reasoningEffort) return runtime.reasoningEffort
    if (runtime.thinkingBudgetTokens !== undefined) return `${runtime.thinkingBudgetTokens.toLocaleString()} tokens`
    if (runtime.thinkingEnabled !== undefined) return runtime.thinkingEnabled ? "enabled" : "disabled"
    return undefined
}

/** Display the effective runtime configuration captured by the subagent runner. */
export function SubagentRuntimeConfig({ runtime, className }: SubagentRuntimeConfigProps) {
    if (!runtime) return null
    const items = [
        ["Profile", runtime.profileName],
        ["Provider", runtime.providerId],
        ["Model", runtime.modelId],
        ["API", runtime.apiFormat],
        ["Thinking", thinkingLabel(runtime)],
    ].filter((item): item is [string, string] => Boolean(item[1]))
    if (items.length === 0) return null

    return (
        <span
            className={["inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-description", className]
                .filter(Boolean)
                .join(" ")}
            data-testid="subagent-runtime-config">
            {items.map(([label, value], index) => (
                <span className="inline-flex min-w-0 items-center gap-0.5" key={label} title={`${label}: ${value}`}>
                    {index > 0 && <span aria-hidden="true">·</span>}
                    <span>{`${label}:`}</span>
                    <span className="min-w-0 truncate font-mono text-foreground">{value}</span>
                </span>
            ))}
        </span>
    )
}
