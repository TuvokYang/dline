import { memo } from "react"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { formatReasoningEffort } from "./utils/uiLabels"

interface ReasoningEffortSelectorProps {
    label?: string
    description?: string
    allowedEfforts: readonly string[]
    defaultEffort?: string
    reasoningEffort?: string
    onReasoningEffortChange: (value: string) => void
}

/** Display only caller-declared levels; an omitted default leaves the provider field unset. */
const ReasoningEffortSelector = ({
    label: customLabel,
    description: customDescription,
    allowedEfforts,
    defaultEffort,
    reasoningEffort,
    onReasoningEffortChange,
}: ReasoningEffortSelectorProps) => {
    const { t } = useUiTranslation()
    const label = customLabel ?? t("settings.ui.reasoningEffort")
    const description = customDescription ?? t("settings.ui.effortHelp")
    const efforts = allowedEfforts.filter((value) => value.length > 0)
    const selectedEffort =
        reasoningEffort && efforts.includes(reasoningEffort)
            ? reasoningEffort
            : defaultEffort && efforts.includes(defaultEffort)
              ? defaultEffort
              : ""
    const handleEffortChange = (value: string) => {
        if (efforts.includes(value)) onReasoningEffortChange(value)
    }
    if (efforts.length === 0) return null

    return (
        <div style={{ marginTop: 10, marginBottom: 5 }}>
            <Label className="text-xs font-medium">{label}</Label>
            <Select onValueChange={handleEffortChange} value={selectedEffort}>
                <SelectTrigger className="w-full mt-1">
                    <SelectValue placeholder={t("settings.ui.providerDefault")} />
                </SelectTrigger>
                <SelectContent>
                    {efforts.map((effort) => (
                        <SelectItem key={effort} value={effort}>
                            {formatReasoningEffort(t, effort)}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            <p
                style={{
                    fontSize: "12px",
                    marginTop: 3,
                    marginBottom: 0,
                    color: "var(--vscode-descriptionForeground)",
                }}>
                {description}
            </p>
        </div>
    )
}

export default memo(ReasoningEffortSelector)
