import { BedrockProviderConfig } from "@shared/proto/dline/provider/bedrock"
import BedrockData from "@shared/providers/bedrock.json"
import { resolveProfileModelInfo } from "@shared/providers/profile-model-info"
import { VSCodeCheckbox, VSCodeOption, VSCodeRadio, VSCodeRadioGroup, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import Fuse from "fuse.js"
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react"
import styled from "styled-components"
import { LocalizedDropdown, LocalizedOption } from "@/components/common/LocalizedDropdown"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { DebouncedTextField } from "../common/DebouncedTextField"
import { ModelInfoView } from "../common/ModelInfoView"
import { DropdownContainer } from "../common/ModelSelector"
import ThinkingControl from "../ThinkingControl"
import type { ApiProfile } from "./ProviderProfile"
import { useProviderModels } from "./useProviderModels"

const AWS_REGIONS = BedrockData.regions
const DROPDOWN_Z_INDEX = 1000

interface BedrockProviderProps {
    showModelOptions: boolean
    isPopup?: boolean
    profile: ApiProfile
    onUpdate: (updates: Partial<ApiProfile>) => void
}

/** AWS Bedrock provider â€?all data from ApiProfile. All aws* fields stored in profile.bedrock. */
export const BedrockProvider = ({ showModelOptions, isPopup, profile, onUpdate }: BedrockProviderProps) => {
    const { t } = useUiTranslation()
    const { remoteConfigSettings } = useExtensionState()
    const remote = remoteConfigSettings as any // legacy compat for remote config fields

    const pc = profile.bedrock ?? BedrockProviderConfig.create()
    const awsRegion = pc.awsRegion
    const awsAuthentication = pc.awsAuthentication || (pc.awsProfile ? "profile" : "credentials")
    const awsProfile = pc.awsProfile
    const awsAccessKey = pc.awsAccessKey
    const awsSecretKey = pc.awsSecretKey
    const awsSessionToken = pc.awsSessionToken
    const awsBedrockApiKey = pc.awsBedrockApiKey
    const awsBedrockEndpoint = pc.awsBedrockEndpoint
    const awsUseCrossRegionInference = Boolean(pc.awsUseCrossRegionInference)
    const awsUseGlobalInference = Boolean(pc.awsUseGlobalInference)
    const awsBedrockUsePromptCache = Boolean(pc.awsBedrockUsePromptCache)
    const awsBedrockCustomSelected = Boolean(pc.awsBedrockCustomSelected)
    const awsBedrockCustomModelBaseId = pc.awsBedrockCustomModelBaseId
    const { models: bedrockModels, defaultModelId: bedrockDefaultModelId } = useProviderModels("bedrock")
    const modelInfoAny = resolveProfileModelInfo(profile, { models: bedrockModels, defaultModelId: bedrockDefaultModelId })
    const modelId = modelInfoAny.id
    const selectedModelLabel = awsBedrockCustomSelected
        ? t("settings.ui.customBadge")
        : modelId === ""
          ? t("settings.ui.selectModel")
          : Object.keys(bedrockModels).includes(modelId)
            ? modelId
            : undefined
    const selectedBaseModelId = awsBedrockCustomModelBaseId || bedrockDefaultModelId
    const selectedBaseModelLabel =
        selectedBaseModelId === ""
            ? t("settings.ui.selectModel")
            : Object.keys(bedrockModels).includes(selectedBaseModelId)
              ? selectedBaseModelId
              : undefined
    const modelInfo = modelInfoAny as any
    const thinking = modelInfoAny.capabilities?.thinking
    const thinkingSupported = thinking?.supported === true && modelInfoAny.capabilities?.supportsReasoning !== false
    const effortSupported = thinkingSupported && thinking?.mode === "effort"
    const budgetSupported = thinkingSupported && thinking?.mode === "budget"
    const [awsEndpointSelected, setAwsEndpointSelected] = useState(!!awsBedrockEndpoint)

    const persistConfig = (key: string, value: string) => {
        onUpdate({ bedrock: { ...pc, [key]: value } })
    }

    // Region combobox state
    const currentRegion = awsRegion
    const [searchTerm, setSearchTerm] = useState("")
    const [isDropdownVisible, setIsDropdownVisible] = useState(false)
    const [selectedIndex, setSelectedIndex] = useState(-1)
    const dropdownRef = useRef<HTMLDivElement>(null)
    const itemRefs = useRef<(HTMLDivElement | null)[]>([])
    const dropdownListRef = useRef<HTMLDivElement>(null)
    const isSelectingRef = useRef(false)

    useEffect(() => {
        setSearchTerm(currentRegion)
    }, [currentRegion])

    const fuse = useMemo(
        () =>
            new Fuse(AWS_REGIONS, {
                threshold: 0.3,
                shouldSort: true,
                isCaseSensitive: false,
                ignoreLocation: false,
                includeMatches: true,
                minMatchCharLength: 1,
            }),
        [],
    )
    const regionSearchResults = useMemo(
        () => (searchTerm ? fuse.search(searchTerm).map((r) => r.item) : AWS_REGIONS),
        [searchTerm, fuse],
    )

    const handleRegionChange = (newRegion: string) => {
        setSearchTerm(newRegion)
        persistConfig("awsRegion", newRegion)
    }

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (!isDropdownVisible) return
        switch (event.key) {
            case "ArrowDown":
                event.preventDefault()
                setSelectedIndex((p) => (p < regionSearchResults.length - 1 ? p + 1 : p))
                break
            case "ArrowUp":
                event.preventDefault()
                setSelectedIndex((p) => (p > 0 ? p - 1 : p))
                break
            case "Enter":
                event.preventDefault()
                if (selectedIndex >= 0 && selectedIndex < regionSearchResults.length) {
                    handleRegionChange(regionSearchResults[selectedIndex])
                    setIsDropdownVisible(false)
                } else {
                    handleRegionChange(searchTerm)
                    setIsDropdownVisible(false)
                }
                break
            case "Escape":
                setIsDropdownVisible(false)
                setSelectedIndex(-1)
                break
        }
    }

    useEffect(() => {
        const h = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setIsDropdownVisible(false)
        }
        document.addEventListener("mousedown", h)
        return () => document.removeEventListener("mousedown", h)
    }, [])
    useEffect(() => {
        setSelectedIndex(-1)
        if (dropdownListRef.current) dropdownListRef.current.scrollTop = 0
    }, [])
    useEffect(() => {
        if (selectedIndex >= 0 && itemRefs.current[selectedIndex])
            itemRefs.current[selectedIndex]?.scrollIntoView({ block: "nearest", behavior: "smooth" })
    }, [selectedIndex])

    return (
        <div className="flex flex-col gap-1">
            <VSCodeRadioGroup
                onChange={(e) => {
                    persistConfig("awsAuthentication", (e.target as HTMLInputElement)?.value)
                }}
                value={awsAuthentication}>
                <VSCodeRadio value="apikey">{t("settings.ui.aws.apiKey")}</VSCodeRadio>
                <VSCodeRadio value="profile">{t("settings.ui.aws.profile")}</VSCodeRadio>
                <VSCodeRadio value="credentials">{t("settings.ui.aws.credentials")}</VSCodeRadio>
            </VSCodeRadioGroup>

            {awsAuthentication === "profile" ? (
                <DebouncedTextField
                    className="w-full"
                    initialValue={awsProfile}
                    key="profile"
                    onChange={(value) => persistConfig("awsProfile", value)}
                    placeholder={t("settings.ui.aws.profilePlaceholder")}>
                    <span className="font-medium">{t("settings.ui.aws.profileName")}</span>
                </DebouncedTextField>
            ) : awsAuthentication === "apikey" ? (
                <DebouncedTextField
                    className="w-full"
                    initialValue={awsBedrockApiKey}
                    key="apikey"
                    onChange={(value) => persistConfig("awsBedrockApiKey", value)}
                    placeholder={t("settings.ui.aws.bedrockKeyPlaceholder")}
                    type="password">
                    <span className="font-medium">{t("settings.ui.aws.bedrockKey")}</span>
                </DebouncedTextField>
            ) : (
                <>
                    <DebouncedTextField
                        ariaLabel={t("settings.ui.aws.accessKey")}
                        className="w-full"
                        initialValue={awsAccessKey}
                        key="accessKey"
                        onChange={(value) => persistConfig("awsAccessKey", value)}
                        placeholder={t("settings.ui.aws.enterAccessKey")}
                        type="password">
                        <span className="font-medium">{t("settings.ui.aws.accessKey")}</span>
                    </DebouncedTextField>
                    <DebouncedTextField
                        ariaLabel={t("settings.ui.aws.secretKey")}
                        className="w-full"
                        initialValue={awsSecretKey}
                        onChange={(value) => persistConfig("awsSecretKey", value)}
                        placeholder={t("settings.ui.aws.enterSecretKey")}
                        type="password">
                        <span className="font-medium">{t("settings.ui.aws.secretKey")}</span>
                    </DebouncedTextField>
                    <DebouncedTextField
                        ariaLabel={t("settings.ui.aws.sessionToken")}
                        className="w-full"
                        initialValue={awsSessionToken}
                        onChange={(value) => persistConfig("awsSessionToken", value)}
                        placeholder={t("settings.ui.aws.enterToken")}
                        type="password">
                        <span className="font-medium">{t("settings.ui.aws.sessionToken")}</span>
                    </DebouncedTextField>
                </>
            )}

            <Tooltip>
                <TooltipContent hidden={remote?.awsRegion === undefined}>{t("settings.ui.managed")}</TooltipContent>
                <TooltipTrigger>
                    <DropdownContainer className="dropdown-container mb-2.5" zIndex={DROPDOWN_Z_INDEX - 1}>
                        <div className="flex items-center gap-2 mb-1">
                            <label htmlFor="aws-region">
                                <span className="font-medium">{t("settings.ui.aws.region")}</span>
                            </label>
                            {remote?.awsRegion !== undefined && (
                                <i className="codicon codicon-lock text-description text-sm flex items-center" />
                            )}
                        </div>
                        <RegionDropdownWrapper ref={dropdownRef}>
                            <VSCodeTextField
                                aria-autocomplete="list"
                                aria-expanded={isDropdownVisible}
                                disabled={remote?.awsRegion !== undefined}
                                id="aws-region"
                                onBlur={() => {
                                    if (!isSelectingRef.current && searchTerm !== currentRegion)
                                        handleRegionChange(searchTerm || currentRegion)
                                    isSelectingRef.current = false
                                }}
                                onFocus={() => {
                                    setIsDropdownVisible(true)
                                    setSearchTerm("")
                                }}
                                onInput={(e) => {
                                    setSearchTerm((e.target as HTMLInputElement)?.value || "")
                                    setIsDropdownVisible(true)
                                }}
                                onKeyDown={handleKeyDown}
                                placeholder={t("settings.ui.aws.searchRegion")}
                                role="combobox"
                                style={{ width: "100%", zIndex: DROPDOWN_Z_INDEX - 1, position: "relative", minWidth: 130 }}
                                value={searchTerm}>
                                {searchTerm && searchTerm !== currentRegion && (
                                    <div
                                        aria-label={t("settings.ui.clearSearch")}
                                        className="input-icon-button codicon codicon-close"
                                        onClick={() => {
                                            setSearchTerm("")
                                            setIsDropdownVisible(true)
                                        }}
                                        slot="end"
                                        style={{
                                            display: "flex",
                                            justifyContent: "center",
                                            alignItems: "center",
                                            height: "100%",
                                        }}
                                    />
                                )}
                            </VSCodeTextField>
                            {isDropdownVisible && regionSearchResults.length > 0 && (
                                <RegionDropdownList ref={dropdownListRef} role="listbox">
                                    {regionSearchResults.map((region, index) => (
                                        <RegionDropdownItem
                                            aria-selected={index === selectedIndex}
                                            isSelected={index === selectedIndex}
                                            key={region}
                                            onClick={() => {
                                                handleRegionChange(region)
                                                setIsDropdownVisible(false)
                                                isSelectingRef.current = false
                                            }}
                                            onMouseDown={() => {
                                                isSelectingRef.current = true
                                            }}
                                            onMouseEnter={() => setSelectedIndex(index)}
                                            ref={(el) => {
                                                itemRefs.current[index] = el
                                            }}
                                            role="option">
                                            <span>{region}</span>
                                        </RegionDropdownItem>
                                    ))}
                                </RegionDropdownList>
                            )}
                        </RegionDropdownWrapper>
                    </DropdownContainer>
                </TooltipTrigger>
            </Tooltip>

            <div className="flex flex-col">
                <Tooltip>
                    <TooltipContent hidden={remote?.awsBedrockEndpoint === undefined}>{t("settings.ui.managed")}</TooltipContent>
                    <TooltipTrigger>
                        <div className="flex items-center gap-2">
                            <VSCodeCheckbox
                                checked={awsEndpointSelected}
                                disabled={remote?.awsBedrockEndpoint !== undefined}
                                onChange={(e: any) => {
                                    const c = e.target.checked === true
                                    setAwsEndpointSelected(c)
                                    if (!c) persistConfig("awsBedrockEndpoint", "")
                                }}>
                                {t("settings.ui.aws.customVpc")}
                            </VSCodeCheckbox>
                            {remote?.awsBedrockEndpoint !== undefined && (
                                <i className="codicon codicon-lock text-description text-sm flex items-center" />
                            )}
                        </div>
                        {awsEndpointSelected && (
                            <DebouncedTextField
                                className="mt-0.5 mb-1 text-sm text-description"
                                disabled={remote?.awsBedrockEndpoint !== undefined}
                                initialValue={awsBedrockEndpoint}
                                onChange={(value) => persistConfig("awsBedrockEndpoint", value)}
                                placeholder={t("settings.ui.aws.vpcPlaceholder")}
                                type="text"
                            />
                        )}
                    </TooltipTrigger>
                </Tooltip>

                <Tooltip>
                    <TooltipContent hidden={remote?.awsUseCrossRegionInference === undefined}>
                        {t("settings.ui.managed")}
                    </TooltipContent>
                    <TooltipTrigger>
                        <div className="flex items-center gap-2">
                            <VSCodeCheckbox
                                checked={awsUseCrossRegionInference}
                                disabled={remote?.awsUseCrossRegionInference !== undefined}
                                onChange={(e: any) =>
                                    persistConfig("awsUseCrossRegionInference", String(e.target.checked === true))
                                }>
                                {t("settings.ui.aws.crossRegion")}
                            </VSCodeCheckbox>
                            {remote?.awsUseCrossRegionInference !== undefined && (
                                <i className="codicon codicon-lock text-description text-sm" />
                            )}
                        </div>
                    </TooltipTrigger>
                </Tooltip>

                {awsUseCrossRegionInference && modelInfo.supportsGlobalEndpoint && (
                    <Tooltip>
                        <TooltipContent hidden={remote?.awsUseGlobalInference === undefined}>
                            {t("settings.ui.managed")}
                        </TooltipContent>
                        <TooltipTrigger>
                            <div className="flex items-center gap-2">
                                <VSCodeCheckbox
                                    checked={awsUseGlobalInference}
                                    disabled={remote?.awsUseGlobalInference !== undefined}
                                    onChange={(e: any) =>
                                        persistConfig("awsUseGlobalInference", String(e.target.checked === true))
                                    }>
                                    {t("settings.ui.aws.global")}
                                </VSCodeCheckbox>
                                {remote?.awsUseGlobalInference !== undefined && (
                                    <i className="codicon codicon-lock text-description text-sm" />
                                )}
                            </div>
                        </TooltipTrigger>
                    </Tooltip>
                )}

                {modelInfo.capabilities?.supportsPromptCache && (
                    <Tooltip>
                        <TooltipContent hidden={remote?.awsBedrockUsePromptCache === undefined}>
                            {t("settings.ui.managed")}
                        </TooltipContent>
                        <TooltipTrigger>
                            <div className="flex items-center gap-2">
                                <VSCodeCheckbox
                                    checked={awsBedrockUsePromptCache}
                                    disabled={remote?.awsBedrockUsePromptCache !== undefined}
                                    onChange={(e: any) =>
                                        persistConfig("awsBedrockUsePromptCache", String(e.target.checked === true))
                                    }>
                                    {t("settings.ui.aws.cache")}
                                </VSCodeCheckbox>
                                {remote?.awsBedrockUsePromptCache !== undefined && (
                                    <i className="codicon codicon-lock text-description text-sm" />
                                )}
                            </div>
                        </TooltipTrigger>
                    </Tooltip>
                )}
            </div>

            <p className="mt-1 text-sm text-description">
                {awsAuthentication === "profile" ? t("settings.ui.aws.profileHelp") : t("settings.ui.aws.credentialsHelp")}
            </p>

            {showModelOptions && (
                <>
                    <label htmlFor="bedrock-model-dropdown">
                        <span className="font-medium">{t("settings.ui.model")}</span>
                    </label>
                    <DropdownContainer className="dropdown-container" zIndex={DROPDOWN_Z_INDEX - 2}>
                        <LocalizedDropdown
                            className="w-full"
                            id="bedrock-model-dropdown"
                            onChange={(e: any) => {
                                const isCustom = e.target.value === "custom"
                                onUpdate({
                                    modelId: isCustom ? "" : e.target.value,
                                    modelInfo: isCustom ? undefined : (bedrockModels[e.target.value] as any),
                                    bedrock: {
                                        ...pc,
                                        awsBedrockCustomSelected: isCustom,
                                        awsBedrockCustomModelBaseId: isCustom ? bedrockDefaultModelId : "",
                                    },
                                })
                            }}
                            selectedLabel={selectedModelLabel}
                            value={awsBedrockCustomSelected ? "custom" : modelId}>
                            <LocalizedOption label={t("settings.ui.selectModel")} value="" />
                            {Object.keys(bedrockModels).map((mid) => (
                                <VSCodeOption className="whitespace-normal wrap-break-word max-w-full" key={mid} value={mid}>
                                    {mid}
                                </VSCodeOption>
                            ))}
                            <LocalizedOption label={t("settings.ui.customBadge")} value="custom" />
                        </LocalizedDropdown>
                    </DropdownContainer>

                    {awsBedrockCustomSelected && (
                        <div>
                            <p className="mt-1 text-sm text-description">{t("settings.ui.aws.customHelp")}</p>
                            <DebouncedTextField
                                className="w-full mt-0.5"
                                id="bedrock-model-input"
                                initialValue={modelId}
                                onChange={(value) => onUpdate({ modelId: value, modelInfo: undefined })}
                                placeholder={t("settings.ui.aws.customModel")}>
                                <span className="font-medium">{t("settings.ui.modelId")}</span>
                            </DebouncedTextField>
                            <label htmlFor="bedrock-base-model-dropdown">
                                <span className="font-medium">{t("settings.ui.aws.baseModel")}</span>
                            </label>
                            <DropdownContainer className="dropdown-container" zIndex={DROPDOWN_Z_INDEX - 3}>
                                <LocalizedDropdown
                                    className="w-full"
                                    id="bedrock-base-model-dropdown"
                                    onChange={(e: any) =>
                                        onUpdate({
                                            modelInfo: undefined,
                                            bedrock: { ...pc, awsBedrockCustomModelBaseId: e.target.value },
                                        })
                                    }
                                    selectedLabel={selectedBaseModelLabel}
                                    value={awsBedrockCustomModelBaseId || bedrockDefaultModelId}>
                                    <LocalizedOption label={t("settings.ui.selectModel")} value="" />
                                    {Object.keys(bedrockModels).map((mid) => (
                                        <VSCodeOption
                                            className="whitespace-normal wrap-break-word max-w-full"
                                            key={mid}
                                            value={mid}>
                                            {mid}
                                        </VSCodeOption>
                                    ))}
                                </LocalizedDropdown>
                            </DropdownContainer>
                        </div>
                    )}

                    {(effortSupported || budgetSupported) && (
                        <ThinkingControl
                            defaultEffort={thinking?.defaultEffort}
                            defaultEnabled={thinking?.defaultEnabled}
                            disableSupported={thinking?.canDisable !== false}
                            effortOptions={thinking?.effortLevels ?? []}
                            maxBudget={thinking?.maxBudget}
                            minBudget={thinking?.minBudget}
                            mode={effortSupported ? "effort-only" : "budget-only"}
                            onReasoningConfigUpdate={(reasoning) => onUpdate({ bedrock: { ...pc, reasoning } })}
                            reasoningConfig={pc.reasoning}
                            showModeSelector={false}
                        />
                    )}

                    <ModelInfoView isPopup={isPopup} modelInfo={modelInfoAny} selectedModelId={modelId} />
                </>
            )}
        </div>
    )
}

const RegionDropdownWrapper = styled.div` position: relative; width: 100%; `
const RegionDropdownList = styled.div` position: absolute; top: calc(100% - 3px); left: 0; width: calc(100% - 2px); max-height: 200px; overflow-y: auto; background-color: var(--vscode-dropdown-background); border: 1px solid var(--vscode-list-activeSelectionBackground); z-index: ${DROPDOWN_Z_INDEX - 1}; border-bottom-left-radius: 3px; border-bottom-right-radius: 3px; `
const RegionDropdownItem = styled.div<{
    isSelected: boolean
}>` padding: 5px 10px; cursor: pointer; word-break: break-all; white-space: normal; text-align: left; background-color: ${({ isSelected }) => (isSelected ? "var(--vscode-list-activeSelectionBackground)" : "inherit")}; &:hover { background-color: var(--vscode-list-activeSelectionBackground); } `
