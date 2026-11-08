import { isOpenAiServiceTier, OPENAI_SERVICE_TIER_OPTIONS, type OpenAiServiceTier } from "@shared/storage/types"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { type FormEvent, memo } from "react"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"

const PROVIDER_DEFAULT_VALUE = "provider-default"

const tierLabelKeys = {
    auto: "settings.ui.serviceTier.autoLabel",
    default: "settings.ui.serviceTier.defaultLabel",
    flex: "settings.ui.serviceTier.flexLabel",
    scale: "settings.ui.serviceTier.scaleLabel",
    priority: "settings.ui.serviceTier.priorityLabel",
    ultrafast: "settings.ui.serviceTier.ultrafastLabel",
} as const satisfies Record<OpenAiServiceTier, string>

interface OpenAIServiceTierSelectorProps {
    serviceTier?: string
    serviceTierEnabled?: boolean
    onServiceTierChange: (value: OpenAiServiceTier | undefined) => void
    onServiceTierEnabledChange: (enabled: boolean) => void
}

const OpenAIServiceTierSelector = ({
    serviceTier,
    serviceTierEnabled,
    onServiceTierChange,
    onServiceTierEnabledChange,
}: OpenAIServiceTierSelectorProps) => {
    const { t } = useUiTranslation()
    const tierDescription = (tier: string) =>
        tier === PROVIDER_DEFAULT_VALUE
            ? t("settings.ui.serviceTier.defaultHelp")
            : tier === "priority"
              ? t("settings.ui.serviceTier.priority")
              : t("settings.ui.serviceTier.send", { tier })
    const enabled = serviceTierEnabled === true
    const selectedValue = isOpenAiServiceTier(serviceTier) ? serviceTier : PROVIDER_DEFAULT_VALUE

    return (
        <div style={{ marginTop: 10, marginBottom: 10 }}>
            <VSCodeCheckbox
                checked={enabled}
                onChange={(event: Event | FormEvent<HTMLElement>) =>
                    onServiceTierEnabledChange((event.target as HTMLInputElement | null)?.checked === true)
                }>
                {t("settings.ui.serviceTier.enable")}
            </VSCodeCheckbox>
            {enabled && (
                <div className="mt-2">
                    <Label className="text-xs font-medium">{t("settings.ui.serviceTier.label")}</Label>
                    <Select
                        onValueChange={(value) =>
                            onServiceTierChange(value === PROVIDER_DEFAULT_VALUE ? undefined : (value as OpenAiServiceTier))
                        }
                        value={selectedValue}>
                        <SelectTrigger className="w-full mt-1" title={tierDescription(selectedValue)}>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem title={tierDescription(PROVIDER_DEFAULT_VALUE)} value={PROVIDER_DEFAULT_VALUE}>
                                {t("settings.ui.providerDefault")}
                            </SelectItem>
                            {OPENAI_SERVICE_TIER_OPTIONS.map((tier) => (
                                <SelectItem key={tier} title={tierDescription(tier)} value={tier}>
                                    {t(tierLabelKeys[tier])}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            )}
        </div>
    )
}

export default memo(OpenAIServiceTierSelector)
