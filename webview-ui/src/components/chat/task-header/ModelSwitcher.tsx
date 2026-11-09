import { ProfileCapabilityIcons } from "@components/settings/providers/ProfileCapabilityIcons"
import type { ApiProfile } from "@shared/proto/dline/profile"
import { CheckIcon, SettingsIcon } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useApiProfiles } from "@/components/settings/providers/useApiProfiles"
import { updateSetting } from "@/components/settings/utils/settingsHandlers"
import { Switch } from "@/components/ui/switch"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { getCurrencySymbol } from "@/utils/currency"
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip"
import { thinkingEffortLabel } from "../input/runtime-presentation"
import type { TransitionDraftComposer, TransitionDraftContent } from "../mode-switch/transitionDraft"
import { ProfileSwitchDialog } from "../profile-switch/ProfileSwitchDialog"
import { useProfileSwitch } from "../profile-switch/useProfileSwitch"
import { resolveProfileDisplayState } from "./profileDisplayState"

interface ModelSwitcherProps {
    onOpenSettings: () => void
    /** The composer draft a Profile switch carries to a dialog awaiting a reply. */
    draft?: TransitionDraftContent
    /** The composer the draft came from, which lets go of a draft the switch delivered. */
    draftComposer?: TransitionDraftComposer
}

/** Tab labels and their mode mapping */
type ModeTab = "act" | "plan"

/**
 * Bottom-bar model display. Click opens popover with profile list +
 * check circle radio selection. Supports Act/Plan tabs when
 * planActSeparateModelsSetting is enabled.
 */
const ModelSwitcher: React.FC<ModelSwitcherProps> = ({ onOpenSettings, draft, draftComposer }) => {
    const { t } = useUiTranslation()
    const {
        apiConfiguration,
        mode,
        planActSeparateModelsSetting,
        currentTaskItem,
        taskTitleMessage,
        taskViewState,
        profileSwitch,
    } = useExtensionState()
    const { profiles, loaded, error, addProfile, selectProfile, selectProfiles } = useApiProfiles()
    const [open, setOpen] = useState(false)
    const [activeTab, setActiveTab] = useState<ModeTab>(mode || "act")
    const [menuPosition, setMenuPosition] = useState<{ left: number; bottom: number }>()
    const containerRef = useRef<HTMLDivElement>(null)
    const menuRef = useRef<HTMLDivElement>(null)
    const [hoveredId, setHoveredId] = useState<string | null>(null)

    // A completed Task can remain open and accept another turn even when its
    // history item or title message is temporarily absent from the state window.
    const taskId = taskViewState?.taskId
    const hasActiveTask = Boolean(taskId)
    const profileSwitchFlow = useProfileSwitch({ profileSwitch, draft, composer: draftComposer })

    useEffect(() => {
        if (!open) setActiveTab(mode || "act")
    }, [mode, open])

    useEffect(() => {
        if (!open) return
        const updateMenuPosition = (): void => {
            const anchor = containerRef.current?.getBoundingClientRect()
            if (!anchor) return
            setMenuPosition({ left: anchor.left, bottom: window.innerHeight - anchor.top + 4 })
        }
        const handlePointerDown = (event: PointerEvent): void => {
            const target = event.target
            if (target instanceof Node && !containerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
                setOpen(false)
            }
        }
        updateMenuPosition()
        document.addEventListener("pointerdown", handlePointerDown)
        window.addEventListener("resize", updateMenuPosition)
        window.addEventListener("scroll", updateMenuPosition, true)
        return () => {
            document.removeEventListener("pointerdown", handlePointerDown)
            window.removeEventListener("resize", updateMenuPosition)
            window.removeEventListener("scroll", updateMenuPosition, true)
        }
    }, [open])

    // Resolve currently selected Profile identity and legacy display name per mode.
    const planProfileId = apiConfiguration?.planModeProfileId
    const planProfileName = apiConfiguration?.planModeProfile
    const actProfileId = apiConfiguration?.actModeProfileId
    const actProfileName = apiConfiguration?.actModeProfile

    // Stable identity remains valid across rename; name is legacy fallback only.
    const currentProfileId = mode === "plan" ? planProfileId : actProfileId
    const currentProfileName = mode === "plan" ? planProfileName : actProfileName
    const displayState = resolveProfileDisplayState(
        {
            profiles,
            loaded,
            error,
            profileId: currentProfileId,
            profileName: currentProfileName,
        },
        t,
    )
    const currentProfile = displayState.kind === "selected" ? displayState.profile : undefined
    const displayLine = displayState.text

    // Build detailed tooltip from the explicit Profile state and model metadata.
    const tooltipLines: string[] = [displayLine]
    if ("detail" in displayState && displayState.detail) tooltipLines.push(displayState.detail)
    const info = currentProfile?.modelInfo
    if (info) {
        if (info.capabilities?.contextWindow)
            tooltipLines.push(t("chatInput.profile.context", { tokens: info.capabilities.contextWindow.toLocaleString() }))
        if (info.pricing?.strategy?.flat) {
            const prices = info.pricing.strategy.flat.prices
            const symbol = info.pricing.currency?.trim() ? getCurrencySymbol(info.pricing.currency) : ""
            const input = prices?.inputPrice === undefined ? "—" : `${symbol}${prices.inputPrice}`
            const output = prices?.outputPrice === undefined ? "—" : `${symbol}${prices.outputPrice}`
            tooltipLines.push(t("chatInput.profile.prices", { input, output }))
        }
    }
    const tooltip = tooltipLines.join("\n")

    // Handle profile selection
    const handleCreateProfile = () => {
        addProfile()
        setOpen(false)
        onOpenSettings()
    }

    // Selection is keyed by stable identity: display names collide across Profiles
    // (one Profile's name can equal another's `provider:modelId` fallback label),
    // so a name-based lookup could rebind the wrong entry.
    const handleSelect = (profileId: string) => {
        const profile = profiles.find((p) => p.id === profileId)
        if (!profile) return
        setOpen(false)

        const targetModes: ModeTab[] = planActSeparateModelsSetting ? [activeTab] : ["plan", "act"]
        if (hasActiveTask) {
            void profileSwitchFlow.requestSwitch(profile.id, targetModes)
            return
        }
        if (planActSeparateModelsSetting) {
            void selectProfile(profile.id, activeTab, taskId, false)
        } else {
            void selectProfiles(profile.id, targetModes, taskId, false)
        }
    }

    // Toggle plan/act separation
    const toggleSeparation = () => {
        updateSetting("planActSeparateModelsSetting", !planActSeparateModelsSetting)
    }

    /**
     * Report whether one Profile owns the binding shown for the current tab.
     *
     * The check mirrors `resolveProfileDisplayState`: stable ID first, current
     * name only as the legacy fallback. An earlier "first visible entry" default
     * could tick a Profile that the header did not display, so an unresolved
     * binding now marks nothing as selected.
     */
    const isSelected = (profile: ApiProfile): boolean => {
        // Unified mode writes the same Profile to both bindings, so reading the plan
        // binding alone avoids two ticks while the two bindings still differ.
        const targetId = planActSeparateModelsSetting && activeTab === "act" ? actProfileId : planProfileId
        const targetName = planActSeparateModelsSetting && activeTab === "act" ? actProfileName : planProfileName
        if (targetId) return targetId === profile.id
        if (targetName) return targetName === profile.name || (profile.legacyNames ?? []).includes(targetName)
        return false
    }

    /**
     * List only the Profiles the current conversational scope can actually use.
     *
     * `usedFor` is the authoritative usage contract, so a Profile reserved for
     * subagents or image generation never belongs in the model selector. An empty
     * `usedFor` means no usage is enabled, matching `validate.ts`, `ApiOptions`,
     * and `SubagentBuilder`; the previous "empty means every mode" reading was the
     * only place in the project that inverted it.
     */
    const visibleProfiles = useMemo(() => {
        const scopedModes: ModeTab[] = planActSeparateModelsSetting ? [activeTab] : ["act", "plan"]
        return profiles.filter(
            (profile) => profile.enabled !== false && scopedModes.some((mode) => profile.usedFor.includes(mode)),
        )
    }, [profiles, planActSeparateModelsSetting, activeTab])

    return (
        <div
            className="flex h-[18.5px] min-w-0 items-center"
            ref={containerRef}
            style={{ flex: "1 1 auto", position: "relative", zIndex: open ? 50 : undefined }}>
            <ProfileSwitchDialog
                onCancel={profileSwitchFlow.cancelSwitch}
                onConfirm={profileSwitchFlow.confirmSwitch}
                onRetry={() => {
                    if (profileSwitch?.targetProfile && profileSwitch.targetModes?.length) {
                        void profileSwitchFlow.requestSwitch(profileSwitch.targetProfile, profileSwitch.targetModes)
                    }
                }}
                state={profileSwitch ?? { phase: "idle" }}
            />
            <Tooltip>
                {!open && (
                    <TooltipContent side="top">
                        <div className="flex flex-col gap-1">
                            <span className="whitespace-pre-line">{tooltip}</span>
                            <ProfileCapabilityIcons capabilities={info?.capabilities} className="items-start" showLabels />
                        </div>
                    </TooltipContent>
                )}
                <TooltipTrigger asChild>
                    <button
                        aria-label={t("chatInput.profile.selectModel")}
                        className="chat-input-control-outline inline-flex h-[18.5px] w-full min-w-0 cursor-pointer items-center overflow-hidden rounded-sm border-0 bg-toolbar-hover px-1 py-0 text-left text-xs font-medium leading-[18px] text-foreground shadow-none transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60"
                        onClick={() => {
                            if (displayState.kind === "create") {
                                handleCreateProfile()
                                return
                            }
                            if (open) {
                                setOpen(false)
                                return
                            }
                            const anchor = containerRef.current?.getBoundingClientRect()
                            if (anchor) setMenuPosition({ left: anchor.left, bottom: window.innerHeight - anchor.top + 4 })
                            setOpen(true)
                        }}
                        type="button">
                        <span
                            className="inline-flex h-full min-w-0 flex-1 items-center truncate text-center"
                            data-chat-input-profile-text>
                            {profileSwitchFlow.statusText
                                ? t("chatInput.profile.status", { profile: displayLine, status: profileSwitchFlow.statusText })
                                : displayLine}
                        </span>
                    </button>
                </TooltipTrigger>
            </Tooltip>

            {open &&
                menuPosition &&
                createPortal(
                    <div
                        className="fixed z-[2000] flex max-h-[360px] min-w-[280px] flex-col overflow-hidden rounded border border-editor-group-border bg-menu text-menu-foreground shadow-lg"
                        data-testid="profile-menu"
                        ref={menuRef}
                        style={{
                            bottom: menuPosition.bottom,
                            left: menuPosition.left,
                        }}>
                        {/* Title row with separation toggle */}
                        <div className="flex shrink-0 items-center justify-between border-b border-editor-group-border px-3 py-2">
                            <span className="text-xs font-medium" style={{ color: "var(--vscode-foreground)" }}>
                                {t("chatInput.profile.available")}
                            </span>
                            <div className="flex items-center gap-1.5">
                                <span className="text-[10px]" style={{ color: "var(--vscode-descriptionForeground)" }}>
                                    {t("chatInput.profile.split")}
                                </span>
                                <Switch
                                    checked={planActSeparateModelsSetting}
                                    className="scale-75"
                                    onClick={toggleSeparation}
                                    title={t(
                                        planActSeparateModelsSetting
                                            ? "chatInput.profile.disableSplit"
                                            : "chatInput.profile.enableSplit",
                                    )}
                                />
                                <button
                                    aria-label={t("chatInput.profile.settings")}
                                    className="cursor-pointer bg-transparent border-0 p-0"
                                    onClick={() => {
                                        setOpen(false)
                                        onOpenSettings()
                                    }}
                                    style={{ color: "var(--vscode-foreground)", opacity: 0.6 }}
                                    title={t("chatInput.profile.settings")}
                                    type="button">
                                    <SettingsIcon size={14} />
                                </button>
                            </div>
                        </div>

                        {/* Act/Plan tabs (only in separated mode) */}
                        {planActSeparateModelsSetting && (
                            <div className="flex shrink-0 border-b border-editor-group-border">
                                {(["act", "plan"] as ModeTab[]).map((tab) => (
                                    <button
                                        className="flex-1 cursor-pointer bg-transparent border-0 py-1.5 text-xs font-medium"
                                        key={tab}
                                        onClick={() => setActiveTab(tab)}
                                        style={{
                                            color:
                                                activeTab === tab
                                                    ? "var(--vscode-foreground)"
                                                    : "var(--vscode-descriptionForeground)",
                                            borderBottom:
                                                activeTab === tab
                                                    ? "2px solid var(--vscode-button-background)"
                                                    : "2px solid transparent",
                                        }}
                                        type="button">
                                        {t(tab === "act" ? "chatInput.mode.act" : "chatInput.mode.plan")}
                                    </button>
                                ))}
                            </div>
                        )}

                        {/* Profile list */}
                        <div className="min-h-0 overflow-y-auto overscroll-contain" data-testid="profile-list">
                            {visibleProfiles.length === 0 ? (
                                profiles.length === 0 ? (
                                    <button
                                        className="w-full cursor-pointer border-0 bg-transparent px-3 py-2 text-left text-xs text-foreground hover:bg-list-hover"
                                        onClick={handleCreateProfile}
                                        type="button">
                                        {t("chatInput.profile.create")}
                                    </button>
                                ) : (
                                    <div className="px-3 py-2 text-xs" style={{ color: "var(--vscode-descriptionForeground)" }}>
                                        {t("chatInput.profile.emptyMode")}
                                    </div>
                                )
                            ) : (
                                visibleProfiles.map((profile) => {
                                    const name =
                                        profile.name || `${profile.provider}:${profile.modelId}` || t("chatInput.profile.unnamed")
                                    const selected = isSelected(profile)
                                    const isHovered = hoveredId === profile.id

                                    // Build capability tooltip from modelInfo
                                    const capLines: string[] = [name]
                                    const mi = profile.modelInfo
                                    if (mi) {
                                        if (mi.capabilities?.contextWindow)
                                            capLines.push(
                                                t("chatInput.profile.context", {
                                                    tokens: mi.capabilities.contextWindow.toLocaleString(),
                                                }),
                                            )
                                        if (mi.pricing?.strategy?.flat) {
                                            const prices = mi.pricing.strategy.flat.prices
                                            const symbol = mi.pricing.currency?.trim()
                                                ? getCurrencySymbol(mi.pricing.currency)
                                                : ""
                                            const input = prices?.inputPrice === undefined ? "—" : `${symbol}${prices.inputPrice}`
                                            const output =
                                                prices?.outputPrice === undefined ? "—" : `${symbol}${prices.outputPrice}`
                                            capLines.push(t("chatInput.profile.prices", { input, output }))
                                        }
                                        if (mi.capabilities?.supportsReasoning)
                                            capLines.push(
                                                t("chatInput.profile.reasoning", {
                                                    levels:
                                                        mi.capabilities?.thinking?.effortLevels
                                                            ?.map((effort) => thinkingEffortLabel(effort, t))
                                                            .join(", ") || t("chatInput.common.yes"),
                                                }),
                                            )
                                        if (mi.capabilities?.supportsImages) capLines.push(t("chatInput.profile.images"))
                                        if (mi.capabilities?.supportsPromptCache) capLines.push(t("chatInput.profile.cache"))
                                    }
                                    const capTooltip = capLines.join("\n")

                                    return (
                                        <div
                                            aria-selected={selected}
                                            className="flex items-center px-3 py-2 cursor-pointer transition-colors"
                                            key={profile.id}
                                            onClick={() => handleSelect(profile.id)}
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter" || e.key === " ") handleSelect(profile.id)
                                            }}
                                            onMouseEnter={() => setHoveredId(profile.id)}
                                            onMouseLeave={() => setHoveredId(null)}
                                            role="option"
                                            style={{
                                                background: selected
                                                    ? "var(--vscode-list-activeSelectionBackground)"
                                                    : isHovered
                                                      ? "var(--vscode-list-hoverBackground)"
                                                      : "transparent",
                                                transition: "background 0.1s ease",
                                            }}
                                            tabIndex={0}
                                            title={capTooltip}>
                                            {/* Check circle */}
                                            <div
                                                className="shrink-0 mr-2 flex items-center justify-center rounded-full"
                                                style={{
                                                    width: 16,
                                                    height: 16,
                                                    border: selected
                                                        ? "1px solid var(--vscode-button-background)"
                                                        : "1px solid var(--vscode-descriptionForeground)",
                                                    background: selected ? "var(--vscode-button-background)" : "transparent",
                                                }}>
                                                {selected && <CheckIcon color="var(--vscode-button-foreground)" size={10} />}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <span
                                                    className="text-xs truncate block"
                                                    style={{ color: "var(--vscode-foreground)" }}
                                                    title={name}>
                                                    {name}
                                                </span>
                                                <span
                                                    className="text-[10px] block"
                                                    style={{ color: "var(--vscode-descriptionForeground)" }}>
                                                    {profile.usedFor.length > 0
                                                        ? profile.usedFor
                                                              .map((usage) => {
                                                                  if (usage === "act" || usage === "plan")
                                                                      return t(`chatInput.mode.${usage}`)
                                                                  if (usage === "subagents" || usage === "image")
                                                                      return t(`chatInput.profile.usage.${usage}`)
                                                                  return usage
                                                              })
                                                              .join(", ")
                                                        : t("chatInput.profile.allModes")}
                                                </span>
                                            </div>
                                        </div>
                                    )
                                })
                            )}
                        </div>
                    </div>,
                    document.body,
                )}
        </div>
    )
}

export default ModelSwitcher
