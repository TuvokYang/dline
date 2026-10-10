import type { ModelInfo } from "@shared/api"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import Fuse, { type FuseResultMatch } from "fuse.js"
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react"
import { type KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import styled from "styled-components"
import { ProfileField } from "../profile-ui"
import type { ModelOptionOrigin } from "../providers/useProviderModelOptions"
import { type MatchSegment, toMatchSegments } from "./modelMatchSegments"

interface ModelAutocompleteProps {
    models: Record<string, ModelInfo>
    selectedModelId: string | undefined
    onChange: (modelId: string, modelInfo: ModelInfo | undefined) => void
    /**
     * Origin per model id. Ids marked `remote` come from the provider's
     * listing rather than the local catalog and are badged as new.
     */
    optionOrigins?: Record<string, ModelOptionOrigin>
    /**
     * Allows committing an id that is in neither source. When false the picker
     * only accepts listed models and reverts a partial query on close.
     */
    allowCustomModelId?: boolean
    zIndex?: number
    label?: string
    placeholder?: string
    onOpen?: () => void
}

const AUTOCOMPLETE_Z_INDEX = 1_000

/** A row in the open listbox: either a known model or the free-form fallback. */
interface Suggestion {
    id: string
    segments: MatchSegment[]
    badge?: "new" | "custom"
}

const NEW_BADGE_TITLE = "Listed by the provider but missing from the local model catalog"
const CUSTOM_BADGE_TITLE = "Not listed by the provider; sent as a custom model id"

/**
 * Searchable model picker over the merged catalog and provider listing.
 *
 * Opening the picker clears the query so the full list is visible, and the
 * previous selection is restored unless a row is committed. Free-form ids are
 * offered as an explicit row instead of being inferred from a blur, so leaving
 * the field never rewrites the profile with a half-typed id.
 */
export const ModelAutocomplete = ({
    models,
    selectedModelId,
    onChange,
    optionOrigins,
    allowCustomModelId = true,
    zIndex = AUTOCOMPLETE_Z_INDEX,
    label = "Model",
    placeholder = "Search and select a model...",
    onOpen,
}: ModelAutocompleteProps) => {
    const [searchTerm, setSearchTerm] = useState("")
    const [isDropdownVisible, setIsDropdownVisible] = useState(false)
    const [selectedIndex, setSelectedIndex] = useState(-1)
    const dropdownRef = useRef<HTMLDivElement>(null)
    const itemRefs = useRef<(HTMLDivElement | null)[]>([])
    const dropdownListRef = useRef<HTMLDivElement>(null)

    const uniqueId = useId()
    const inputId = `model-autocomplete-${uniqueId}`
    const listboxId = `model-listbox-${uniqueId}`

    // The field mirrors the committed selection while closed and the live
    // query while open, so the visible text is derived rather than stored.
    const displayValue = isDropdownVisible ? searchTerm : (selectedModelId ?? "")

    const modelIds = useMemo(() => Object.keys(models).sort((a, b) => a.localeCompare(b)), [models])

    const searchableItems = useMemo(() => modelIds.map((id) => ({ id })), [modelIds])

    const fuse = useMemo(
        () =>
            new Fuse(searchableItems, {
                keys: ["id"],
                threshold: 0.6,
                shouldSort: true,
                isCaseSensitive: false,
                ignoreLocation: false,
                includeMatches: true,
                minMatchCharLength: 1,
            }),
        [searchableItems],
    )

    const suggestions = useMemo<Suggestion[]>(() => {
        const badgeFor = (id: string): Suggestion["badge"] =>
            optionOrigins?.[id] === "remote" ? "new" : optionOrigins?.[id] === "catalog" ? undefined : "custom"

        const listed: Suggestion[] = searchTerm
            ? fuse.search(searchTerm).map((result) => ({
                  id: result.item.id,
                  segments: toMatchSegments(result.item.id, result.matches as readonly FuseResultMatch[] | undefined),
                  badge: badgeFor(result.item.id),
              }))
            : modelIds.map((id) => ({
                  id,
                  segments: [{ text: id, matched: false, start: 0 }],
                  badge: badgeFor(id),
              }))

        const query = searchTerm.trim()
        const alreadyListed = query.length > 0 && modelIds.includes(query)
        if (!allowCustomModelId || query.length === 0 || alreadyListed) {
            return listed
        }
        // The free-form id is an explicit row so committing it stays a choice.
        return [...listed, { id: query, segments: [{ text: query, matched: false, start: 0 }], badge: "custom" }]
    }, [allowCustomModelId, fuse, modelIds, optionOrigins, searchTerm])

    const closeDropdown = useCallback(() => {
        setIsDropdownVisible(false)
        setSelectedIndex(-1)
        setSearchTerm("")
    }, [])

    const openDropdown = useCallback(() => {
        // An empty query lists every candidate instead of filtering by the
        // current selection, which would hide the rest of the catalog.
        setSearchTerm("")
        setSelectedIndex(-1)
        setIsDropdownVisible(true)
        // Refreshing on every open, not only on the transition from closed,
        // lets a listing that ran before the credentials were saved be retried
        // by clicking the field again.
        onOpen?.()
    }, [onOpen])

    const commitModel = useCallback(
        (newModelId: string) => {
            closeDropdown()
            if (newModelId !== selectedModelId) {
                onChange(newModelId, models[newModelId])
            }
        },
        [closeDropdown, models, onChange, selectedModelId],
    )

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                closeDropdown()
            }
        }

        document.addEventListener("mousedown", handleClickOutside)
        return () => {
            document.removeEventListener("mousedown", handleClickOutside)
        }
    }, [closeDropdown])

    // A shorter result list can leave the highlight past the last row.
    useEffect(() => {
        setSelectedIndex((previous) => (previous >= suggestions.length ? suggestions.length - 1 : previous))
    }, [suggestions.length])

    useEffect(() => {
        if (selectedIndex >= 0) {
            itemRefs.current[selectedIndex]?.scrollIntoView({ block: "nearest" })
        }
    }, [selectedIndex])

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (!isDropdownVisible) {
            if (event.key === "ArrowDown" || event.key === "Enter") {
                event.preventDefault()
                openDropdown()
            }
            return
        }

        switch (event.key) {
            case "ArrowDown":
                event.preventDefault()
                setSelectedIndex((previous) => (previous < suggestions.length - 1 ? previous + 1 : previous))
                break
            case "ArrowUp":
                event.preventDefault()
                setSelectedIndex((previous) => (previous > 0 ? previous - 1 : previous))
                break
            case "Enter": {
                event.preventDefault()
                const target = selectedIndex >= 0 ? suggestions[selectedIndex] : suggestions[0]
                if (target) {
                    commitModel(target.id)
                }
                break
            }
            case "Escape":
                event.preventDefault()
                closeDropdown()
                break
        }
    }

    const activeDescendantId = selectedIndex >= 0 ? `${listboxId}-option-${selectedIndex}` : undefined

    return (
        <ProfileField htmlFor={inputId} label={label}>
            <DropdownWrapper ref={dropdownRef}>
                <VSCodeTextField
                    aria-activedescendant={activeDescendantId}
                    aria-autocomplete="list"
                    aria-controls={isDropdownVisible ? listboxId : undefined}
                    aria-expanded={isDropdownVisible}
                    aria-label={label}
                    className="min-h-7 w-full"
                    id={inputId}
                    onClick={openDropdown}
                    onFocus={openDropdown}
                    onInput={(event) => {
                        setSearchTerm((event.target as HTMLInputElement)?.value ?? "")
                        setSelectedIndex(-1)
                        setIsDropdownVisible(true)
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder={placeholder}
                    role="combobox"
                    style={{ zIndex, position: "relative" }}
                    value={displayValue}>
                    <button
                        aria-label={isDropdownVisible ? `Close ${label} options` : `Open ${label} options`}
                        className="flex h-full cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-description hover:text-foreground"
                        onMouseDown={(event) => {
                            // Keeping focus on the field means the toggle reads the
                            // current open state instead of the state a focus-driven
                            // open would have just produced.
                            event.preventDefault()
                            if (isDropdownVisible) {
                                closeDropdown()
                            } else {
                                openDropdown()
                            }
                        }}
                        slot="end"
                        tabIndex={-1}
                        type="button">
                        {isDropdownVisible ? <ChevronUpIcon className="size-4" /> : <ChevronDownIcon className="size-4" />}
                    </button>
                </VSCodeTextField>
                {isDropdownVisible && suggestions.length > 0 && (
                    <DropdownList
                        aria-label={`${label} suggestions`}
                        id={listboxId}
                        ref={dropdownListRef}
                        role="listbox"
                        style={{ zIndex: zIndex - 1 }}>
                        {suggestions.map((item, index) => (
                            <DropdownItem
                                $isSelected={index === selectedIndex}
                                aria-selected={index === selectedIndex}
                                id={`${listboxId}-option-${index}`}
                                key={`${item.id}-${item.badge ?? "listed"}`}
                                onClick={() => commitModel(item.id)}
                                onMouseDown={(event) => event.preventDefault()}
                                onMouseEnter={() => setSelectedIndex(index)}
                                ref={(element) => {
                                    itemRefs.current[index] = element
                                }}
                                role="option">
                                <span className="min-w-0 break-all">
                                    {item.segments.map((segment) =>
                                        segment.matched ? (
                                            <MatchText key={`${item.id}-match-${segment.start}`}>{segment.text}</MatchText>
                                        ) : (
                                            <span key={`${item.id}-plain-${segment.start}`}>{segment.text}</span>
                                        ),
                                    )}
                                </span>
                                {item.badge ? (
                                    <Badge title={item.badge === "new" ? NEW_BADGE_TITLE : CUSTOM_BADGE_TITLE}>
                                        {item.badge === "new" ? "New" : "Custom"}
                                    </Badge>
                                ) : null}
                            </DropdownItem>
                        ))}
                    </DropdownList>
                )}
            </DropdownWrapper>
        </ProfileField>
    )
}

const DropdownWrapper = styled.div`
	position: relative;
	width: 100%;
`

const DropdownList = styled.div`
	position: absolute;
	top: calc(100% - 3px);
	left: 0;
	width: calc(100% - 2px);
	max-height: 200px;
	overflow-y: auto;
	background-color: var(--vscode-dropdown-background);
	border: 1px solid var(--vscode-list-activeSelectionBackground);
	border-bottom-left-radius: 3px;
	border-bottom-right-radius: 3px;
`

const DropdownItem = styled.div<{ $isSelected: boolean }>`
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	padding: 5px 10px;
	cursor: pointer;
	word-break: break-all;
	white-space: normal;

	background-color: ${({ $isSelected }) => ($isSelected ? "var(--vscode-list-activeSelectionBackground)" : "inherit")};

	&:hover {
		background-color: var(--vscode-list-activeSelectionBackground);
	}
`

// A foreground accent keeps the matched run readable; a filled background
// reads as a text selection and hides the surrounding id.
const MatchText = styled.span`
	color: var(--vscode-list-highlightForeground);
	font-weight: 600;
`

const Badge = styled.span`
	flex-shrink: 0;
	border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
	border-radius: 999px;
	padding: 0 6px;
	font-size: 10px;
	line-height: 16px;
	color: var(--vscode-descriptionForeground);
`
