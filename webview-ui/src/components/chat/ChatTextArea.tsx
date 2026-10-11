import { DEFAULT_CHAT_INPUT_SEND_SHORTCUT, getChatInputSendShortcutLabel } from "@shared/ChatInputSendShortcut"
import { mentionRegex } from "@shared/context-mentions"
import type { UiAsk } from "@shared/ExtensionMessage"
import type { InputSemanticCatalog } from "@shared/input-semantics/catalog"
import { EmptyRequest, StringRequest } from "@shared/proto/dline/common"
import {
    FileSearchRequest,
    FileSearchType,
    RefreshedDlineToggles,
    RelativePathsRequest,
    StageAttachmentRequest,
} from "@shared/proto/dline/file"
import { type SlashCommand } from "@shared/slashCommands"
import { Mode } from "@shared/storage/types"
import { AtSignIcon, PlusIcon } from "lucide-react"
import type React from "react"
import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { flushSync } from "react-dom"
import DynamicTextArea from "react-textarea-autosize"
import styled from "styled-components"
import ContextMenu from "@/components/chat/ContextMenu"
import { CHAT_CONSTANTS } from "@/components/chat/chat-view/constants"
import { ModeSwitchDialog } from "@/components/chat/mode-switch/ModeSwitchDialog"
import { type ModeSwitchDraft, shouldAttachModeSwitchDraft, useModeSwitch } from "@/components/chat/mode-switch/useModeSwitch"
import SlashCommandMenu from "@/components/chat/SlashCommandMenu"
import ModelSwitcher from "@/components/chat/task-header/ModelSwitcher"
import Thumbnails from "@/components/common/Thumbnails"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { usePlatform } from "@/context/PlatformContext"
import { useTaskCapabilityToggles } from "@/hooks/useTaskCapabilityToggles"
import { cn } from "@/lib/utils"
import { FileServiceClient, SlashServiceClient } from "@/services/grpc-client"
import { renderSemanticHighlightHtml } from "@/services/input-semantics/highlight"
import { classifyPaste } from "@/services/input-semantics/paste-intent"
import {
    composeSubmission,
    followNativePaste,
    heldPastedCandidates,
    newComposerDocumentId,
    type PasteProvenance,
    pasteAwareActivation,
    rebaseProvenance,
    recordPaste,
} from "@/services/input-semantics/paste-provenance"
import { storeOversizedPaste } from "@/services/input-semantics/paste-resource"
import { applySemanticEdit, type SemanticEditIntent, typedTriggerSpan } from "@/services/input-semantics/semantic-edit"
import { shouldCompleteMenuSelection, shouldSendChatInput } from "@/utils/chat-input-shortcut"
import { composerMenuQueryAt } from "@/utils/composer-menu"
import {
    classifyTransferFiles,
    isDocumentAttachmentUri,
    parseAttachableFileUris,
    readResourceUris,
} from "@/utils/composer-transfer"
import {
    ContextMenuOptionType,
    getContextMenuOptionIndex,
    getContextMenuOptions,
    removeMention,
    type SearchResult,
} from "@/utils/context-mentions"
import { useMetaKeyDetection, useShortcut } from "@/utils/hooks"
import { isSafari } from "@/utils/platformUtils"
import {
    getAvailableSlashCommands,
    getMatchingSlashCommands,
    removeSlashCommand,
    type SlashCommandSources,
    type SlashMenuEntry,
    slashCommandDeleteRegex,
} from "@/utils/slash-commands"
import ClineRulesToggleModal from "../agent-capabilities/ClineRulesToggleModal"
import { CHAT_INPUT_MIN_ROWS, CHAT_INPUT_PADDING_Y_PX, chatInputMaxRows } from "./chat-input-height"
import { ChatInputRuntimeControls } from "./input/ChatInputRuntimeControls"
import ServersToggleModal from "./ServersToggleModal"
import { UsageBar } from "./UsageBar"

const { MAX_IMAGES_AND_FILES_PER_MESSAGE } = CHAT_CONSTANTS

/**
 * Above this length (~20K characters) the composer stops re-scanning the whole text for @mentions and
 * /commands on every keystroke, so pasting 100KB+ stays responsive. There is no limit on input length.
 */
const MAX_HIGHLIGHTED_INPUT_LENGTH = 20_000

const getImageDimensions = (dataUrl: string): Promise<{ width: number; height: number }> => {
    return new Promise((resolve, reject) => {
        const img = new Image()
        img.onload = () => {
            if (img.naturalWidth > 7500 || img.naturalHeight > 7500) {
                reject(new Error("Image dimensions exceed maximum allowed size of 7500px."))
            } else {
                resolve({ width: img.naturalWidth, height: img.naturalHeight })
            }
        }
        img.onerror = (err) => {
            console.error("Failed to load image for dimension check:", err)
            reject(new Error("Failed to load image to check dimensions."))
        }
        img.src = dataUrl
    })
}

// Set to "File" option by default
const DEFAULT_CONTEXT_MENU_OPTION = getContextMenuOptionIndex(ContextMenuOptionType.File)

interface ChatTextAreaProps {
    inputValue: string
    activeQuote: string | null
    setInputValue: (value: string) => void
    undoInputValue: () => string | undefined
    redoInputValue: () => string | undefined
    sendingDisabled: boolean
    placeholderText: string
    selectedFiles: string[]
    selectedImages: string[]
    setSelectedImages: React.Dispatch<React.SetStateAction<string[]>>
    setSelectedFiles: React.Dispatch<React.SetStateAction<string[]>>
    onSend: (draft: ModeSwitchDraft) => void
    onSendBlocked?: (draft: ModeSwitchDraft) => void
    onSelectFilesAndImages: () => void
    shouldDisableFilesAndImages: boolean
    clineAsk?: UiAsk
    onHeightChange?: (height: number) => void
    onFocusChange?: (isFocused: boolean) => void
    /** Pasted spans of `inputValue`, owned by the draft state (WS-041 AC-09). */
    pasteProvenance: PasteProvenance
    /** Record the provenance of an edit this composer observed. */
    commitPasteProvenance: (provenance: PasteProvenance) => void
    /** The catalog every submission of this view is composed against. */
    semanticCatalog: InputSemanticCatalog
}

interface GitCommit {
    type: ContextMenuOptionType.Git
    value: string
    label: string
    description: string
}

const PLAN_MODE_COLOR = "var(--vscode-activityWarningBadge-background)"
const ACT_MODE_COLOR = "var(--vscode-focusBorder)"

const SwitchContainer = styled.div<{ disabled: boolean }>`
	display: flex;
	align-items: center;
	background-color: transparent;
	border: 1px solid var(--vscode-input-border);
	border-radius: 12px;
	overflow: hidden;
	cursor: ${(props) => (props.disabled ? "not-allowed" : "pointer")};
	opacity: ${(props) => (props.disabled ? 0.5 : 1)};
	transform: scale(1);
	transform-origin: right center;
	margin-left: 0;
	user-select: none; // Prevent text selection
`

const Slider = styled.div.withConfig({
    shouldForwardProp: (prop) => !["isAct", "isPlan"].includes(prop),
})<{ isAct: boolean; isPlan?: boolean }>`
	position: absolute;
	height: 100%;
	width: 50%;
	background-color: ${(props) => (props.isPlan ? PLAN_MODE_COLOR : ACT_MODE_COLOR)};
	transition: transform 0.2s ease;
	transform: translateX(${(props) => (props.isAct ? "100%" : "0%")});
`

const ButtonGroup = styled.div`
	display: flex;
	align-items: center;
	gap: 4px;
	flex: 1 1 auto;
	min-width: 0;
	max-width: 100%;
`

const ButtonContainer = styled.div`
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 3px;
	font-size: 10px;
	height: 100%;
	white-space: nowrap;
	min-width: 0;
	width: 100%;
`

const _ModelContainer = styled.div`
	position: relative;
	display: flex;
	flex: 1;
	min-width: 0;
`

const _ModelButtonWrapper = styled.div`
	display: inline-flex; // Make it shrink to content
	min-width: 0; // Allow shrinking
	max-width: 100%; // Don't overflow parent
`

const _ModelDisplayButton = styled.a<{ isActive?: boolean; disabled?: boolean }>`
	padding: 0px 0px;
	height: 20px;
	width: 100%;
	min-width: 0;
	cursor: ${(props) => (props.disabled ? "not-allowed" : "pointer")};
	text-decoration: ${(props) => (props.isActive ? "underline" : "none")};
	color: ${(props) => (props.isActive ? "var(--vscode-foreground)" : "var(--vscode-descriptionForeground)")};
	display: flex;
	align-items: center;
	font-size: 10px;
	outline: none;
	user-select: none;
	opacity: ${(props) => (props.disabled ? 0.5 : 1)};
	pointer-events: ${(props) => (props.disabled ? "none" : "auto")};

	&:hover,
	&:focus {
		color: ${(props) => (props.disabled ? "var(--vscode-descriptionForeground)" : "var(--vscode-foreground)")};
		text-decoration: ${(props) => (props.disabled ? "none" : "underline")};
		outline: none;
	}

	&:active {
		color: ${(props) => (props.disabled ? "var(--vscode-descriptionForeground)" : "var(--vscode-foreground)")};
		text-decoration: ${(props) => (props.disabled ? "none" : "underline")};
		outline: none;
	}

	&:focus-visible {
		outline: none;
	}
`

const _ModelButtonContent = styled.div`
	width: 100%;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
`

const ChatTextArea = forwardRef<HTMLTextAreaElement, ChatTextAreaProps>(
    (
        {
            inputValue,
            setInputValue,
            undoInputValue,
            redoInputValue,
            sendingDisabled,
            placeholderText,
            selectedFiles,
            selectedImages,
            setSelectedImages,
            setSelectedFiles,
            onSend,
            onSendBlocked,
            onSelectFilesAndImages,
            shouldDisableFilesAndImages,
            clineAsk,
            onHeightChange,
            onFocusChange,
            pasteProvenance,
            commitPasteProvenance,
            semanticCatalog,
        },
        ref,
    ) => {
        const {
            mode,
            modeSwitch,
            stateRevision,
            platform,
            chatInputSendShortcut,
            localWorkflowToggles,
            globalWorkflowToggles,
            remoteWorkflowToggles,
            remoteConfigSettings,
            navigateToSettings,
            mcpServers,
            localSkillsToggles,
            globalSkillsToggles,
            remoteSkillsToggles,
            currentTaskItem,
            setLocalWorkflowToggles,
            setGlobalWorkflowToggles,
            setLocalSkillsToggles,
            setGlobalSkillsToggles,
        } = useExtensionState()
        const { snapshot: scopedCapabilityToggles, reconcile: reconcileCapabilityToggles } = useTaskCapabilityToggles()
        const effectiveLocalWorkflowToggles = scopedCapabilityToggles?.localWorkflowToggles ?? localWorkflowToggles
        const effectiveGlobalWorkflowToggles = scopedCapabilityToggles?.globalWorkflowToggles ?? globalWorkflowToggles
        const effectiveRemoteWorkflowToggles = scopedCapabilityToggles?.remoteWorkflowToggles ?? remoteWorkflowToggles
        const effectiveLocalSkillsToggles = scopedCapabilityToggles?.localSkillsToggles ?? localSkillsToggles
        const effectiveGlobalSkillsToggles = scopedCapabilityToggles?.globalSkillsToggles ?? globalSkillsToggles
        const effectiveRemoteSkillsToggles = scopedCapabilityToggles?.remoteSkillsToggles ?? remoteSkillsToggles
        const effectiveMcpServers = useMemo(
            () =>
                scopedCapabilityToggles
                    ? mcpServers.filter((server) => scopedCapabilityToggles.mcpServers[server.name] === true)
                    : mcpServers,
            [mcpServers, scopedCapabilityToggles],
        )
        const [isTextAreaFocused, setIsTextAreaFocused] = useState(false)
        const [isDraggingOver, setIsDraggingOver] = useState(false)
        const [gitCommits, setGitCommits] = useState<GitCommit[]>([])
        const [showSlashCommandsMenu, setShowSlashCommandsMenu] = useState(false)
        const [selectedSlashCommandsIndex, setSelectedSlashCommandsIndex] = useState(0)
        const [slashCommandsQuery, setSlashCommandsQuery] = useState("")
        const [workflowDescriptions, setWorkflowDescriptions] = useState<Record<string, string>>({})
        const [availableSkillCommands, setAvailableSkillCommands] = useState<SlashCommand[] | undefined>(undefined)
        const slashCommandsMenuContainerRef = useRef<HTMLDivElement>(null)
        const slashCommandSources = useMemo<SlashCommandSources>(
            () => ({
                localWorkflowToggles: effectiveLocalWorkflowToggles,
                globalWorkflowToggles: effectiveGlobalWorkflowToggles,
                remoteWorkflowToggles: effectiveRemoteWorkflowToggles,
                remoteWorkflows: remoteConfigSettings?.remoteGlobalWorkflows,
                mcpServers: effectiveMcpServers,
                localSkillsToggles: effectiveLocalSkillsToggles,
                globalSkillsToggles: effectiveGlobalSkillsToggles,
                remoteSkills: remoteConfigSettings?.remoteGlobalSkills,
                remoteSkillsToggles: effectiveRemoteSkillsToggles,
                workflowDescriptions,
                availableSkillCommands,
            }),
            [
                effectiveLocalWorkflowToggles,
                effectiveGlobalWorkflowToggles,
                effectiveRemoteWorkflowToggles,
                remoteConfigSettings?.remoteGlobalWorkflows,
                effectiveMcpServers,
                effectiveLocalSkillsToggles,
                effectiveGlobalSkillsToggles,
                remoteConfigSettings?.remoteGlobalSkills,
                effectiveRemoteSkillsToggles,
                workflowDescriptions,
                availableSkillCommands,
            ],
        )
        // The menu renders and the keyboard navigates this one list, so a selection index always names a shown row.
        const slashMenuEntries = useMemo(
            () => getMatchingSlashCommands(slashCommandsQuery, getAvailableSlashCommands(slashCommandSources, semanticCatalog)),
            [slashCommandsQuery, slashCommandSources, semanticCatalog],
        )
        // The list can shrink without typing, e.g. when a capability is withdrawn; keep the selection on a row.
        useEffect(() => {
            if (selectedSlashCommandsIndex >= slashMenuEntries.length) {
                setSelectedSlashCommandsIndex(Math.max(0, slashMenuEntries.length - 1))
            }
        }, [selectedSlashCommandsIndex, slashMenuEntries.length])

        const refreshSlashCommandMetadata = useCallback(async () => {
            const response = await SlashServiceClient.getAvailableSlashCommands(EmptyRequest.create({}))
            const descriptions: Record<string, string> = {}
            const skills: SlashCommand[] = []
            for (const command of response.commands) {
                if (command.section === "workflow" && command.description) {
                    descriptions[command.name] = command.description
                } else if (command.section === "skill") {
                    skills.push({
                        name: command.name,
                        description: command.description || undefined,
                        section: "skill",
                    })
                }
            }
            setWorkflowDescriptions(descriptions)
            setAvailableSkillCommands(skills)
        }, [])

        // Fetch names and descriptions parsed by the extension host.
        useEffect(() => {
            void refreshSlashCommandMetadata().catch(() => {})
        }, [refreshSlashCommandMetadata])

        // Refresh workflow toggles when the slash command menu opens,
        // so newly added workflow files are discovered immediately.
        useEffect(() => {
            if (!showSlashCommandsMenu) {
                return
            }

            FileServiceClient.refreshRules({} as EmptyRequest)
                .then(async (response: RefreshedDlineToggles) => {
                    void reconcileCapabilityToggles({
                        ...(response.localWorkflowToggles?.toggles && {
                            localWorkflowToggles: response.localWorkflowToggles.toggles,
                        }),
                        ...(response.globalWorkflowToggles?.toggles && {
                            globalWorkflowToggles: response.globalWorkflowToggles.toggles,
                        }),
                        ...(response.localSkillsToggles?.toggles && {
                            localSkillsToggles: response.localSkillsToggles.toggles,
                        }),
                        ...(response.globalSkillsToggles?.toggles && {
                            globalSkillsToggles: response.globalSkillsToggles.toggles,
                        }),
                    })
                    if (response.localWorkflowToggles?.toggles) {
                        setLocalWorkflowToggles(response.localWorkflowToggles.toggles)
                    }
                    if (response.globalWorkflowToggles?.toggles) {
                        setGlobalWorkflowToggles(response.globalWorkflowToggles.toggles)
                    }
                    if (response.localSkillsToggles?.toggles) {
                        setLocalSkillsToggles(response.localSkillsToggles.toggles)
                    }
                    if (response.globalSkillsToggles?.toggles) {
                        setGlobalSkillsToggles(response.globalSkillsToggles.toggles)
                    }
                    // Rediscovery publishes a new catalog revision to the subscription when capabilities
                    // changed, so a skill or workflow added since the last revision becomes pickable.
                    await Promise.all([
                        refreshSlashCommandMetadata(),
                        SlashServiceClient.getInputSemanticCatalog(EmptyRequest.create({})),
                    ])
                })
                .catch(() => {})
        }, [
            showSlashCommandsMenu,
            setLocalWorkflowToggles,
            setGlobalWorkflowToggles,
            setLocalSkillsToggles,
            setGlobalSkillsToggles,
            reconcileCapabilityToggles,
            refreshSlashCommandMetadata,
        ])

        const [thumbnailsHeight, setThumbnailsHeight] = useState(0)
        const [textAreaBaseHeight, setTextAreaBaseHeight] = useState<number | undefined>(undefined)
        const [textAreaRowHeight, setTextAreaRowHeight] = useState<number | undefined>(undefined)
        const [showContextMenu, setShowContextMenu] = useState(false)
        const [cursorPosition, setCursorPosition] = useState(0)
        const [searchQuery, setSearchQuery] = useState("")
        const textAreaRef = useRef<HTMLTextAreaElement | null>(null)
        const [isMouseDownOnMenu, setIsMouseDownOnMenu] = useState(false)
        const highlightLayerRef = useRef<HTMLDivElement>(null)
        // A text paste the browser inserts natively, applied by the change it causes.
        const pendingNativePasteRef = useRef<{ start: number; end: number; text: string } | undefined>(undefined)
        // The draft's provenance as of the last render. Change handlers are
        // memoized, so they read it here rather than from a stale closure.
        const provenanceRef = useRef(pasteProvenance)
        provenanceRef.current = pasteProvenance
        /** Provenance of `text`, carried forward from the draft's current state. */
        const provenanceOf = useCallback((text: string) => rebaseProvenance(provenanceRef.current, text), [])
        const heldCandidates = useMemo(
            () => heldPastedCandidates(pasteProvenance.text, semanticCatalog, pasteProvenance.spans),
            [pasteProvenance, semanticCatalog],
        )
        /** The draft one send carries; a held pasted candidate travels as a structured document. */
        const captureSendDraft = useCallback(
            (text: string) => {
                const { semanticInput } = composeSubmission({
                    text,
                    spans: rebaseProvenance(pasteProvenance, text).spans,
                    catalog: semanticCatalog,
                    documentId: newComposerDocumentId(),
                })
                return {
                    text,
                    images: [...selectedImages],
                    files: [...selectedFiles],
                    ...(semanticInput ? { semanticInput } : {}),
                }
            },
            [pasteProvenance, semanticCatalog, selectedImages, selectedFiles],
        )
        const [selectedMenuIndex, setSelectedMenuIndex] = useState(-1)
        const [selectedType, setSelectedType] = useState<ContextMenuOptionType | null>(null)
        const [justDeletedSpaceAfterMention, setJustDeletedSpaceAfterMention] = useState(false)
        const [justDeletedSpaceAfterSlashCommand, setJustDeletedSpaceAfterSlashCommand] = useState(false)
        const [intendedCursorPosition, setIntendedCursorPosition] = useState<number | null>(null)
        const contextMenuContainerRef = useRef<HTMLDivElement>(null)

        const [shownTooltipMode, setShownTooltipMode] = useState<Mode | null>(null)
        const [pendingInsertions, setPendingInsertions] = useState<string[]>([])
        const _shiftHoldTimerRef = useRef<NodeJS.Timeout | null>(null)
        const [showUnsupportedFileError, setShowUnsupportedFileError] = useState(false)
        const unsupportedFileTimerRef = useRef<NodeJS.Timeout | null>(null)
        const [showDimensionError, setShowDimensionError] = useState(false)
        const dimensionErrorTimerRef = useRef<NodeJS.Timeout | null>(null)

        const [fileSearchResults, setFileSearchResults] = useState<SearchResult[]>([])
        const [searchLoading, setSearchLoading] = useState(false)
        const [, metaKeyChar] = useMetaKeyDetection(platform)

        // Fetch git commits when Git is selected or when typing a hash
        useEffect(() => {
            if (selectedType === ContextMenuOptionType.Git || /^[a-f0-9]+$/i.test(searchQuery)) {
                FileServiceClient.searchCommits(StringRequest.create({ value: searchQuery || "" }))
                    .then((response) => {
                        if (response.commits) {
                            const commits: GitCommit[] = response.commits.map(
                                (commit: { hash: string; shortHash: string; subject: string; author: string; date: string }) => ({
                                    type: ContextMenuOptionType.Git,
                                    value: commit.hash,
                                    label: commit.subject,
                                    description: `${commit.shortHash} by ${commit.author} on ${commit.date}`,
                                }),
                            )
                            setGitCommits(commits)
                        }
                    })
                    .catch((error) => {
                        console.error("Error searching commits:", error)
                    })
            }
        }, [selectedType, searchQuery])

        const queryItems = useMemo(() => {
            return [
                { type: ContextMenuOptionType.Problems, value: "problems" },
                { type: ContextMenuOptionType.Terminal, value: "terminal" },
                ...gitCommits,
            ]
        }, [gitCommits])

        useEffect(() => {
            const handleClickOutside = (event: MouseEvent) => {
                if (contextMenuContainerRef.current && !contextMenuContainerRef.current.contains(event.target as Node)) {
                    setShowContextMenu(false)
                }
            }

            if (showContextMenu) {
                document.addEventListener("mousedown", handleClickOutside)
            }

            return () => {
                document.removeEventListener("mousedown", handleClickOutside)
            }
        }, [showContextMenu])

        useEffect(() => {
            const handleClickOutsideSlashMenu = (event: MouseEvent) => {
                if (
                    slashCommandsMenuContainerRef.current &&
                    !slashCommandsMenuContainerRef.current.contains(event.target as Node)
                ) {
                    setShowSlashCommandsMenu(false)
                }
            }

            if (showSlashCommandsMenu) {
                document.addEventListener("mousedown", handleClickOutsideSlashMenu)
            }

            return () => {
                document.removeEventListener("mousedown", handleClickOutsideSlashMenu)
            }
        }, [showSlashCommandsMenu])

        /**
         * Write a menu pick as the entity it names, replacing what the user typed
         * for it. Returns false, writing nothing, when the pick would not read
         * back as that entity.
         */
        const applyMenuPick = useCallback(
            (intent: SemanticEditIntent): boolean => {
                const current = textAreaRef.current?.value
                if (current === undefined) return false
                const edit = applySemanticEdit(
                    provenanceOf(current),
                    typedTriggerSpan(current, cursorPosition, intent.kind),
                    intent,
                    semanticCatalog,
                )
                if (!edit.ok) {
                    console.warn(`[ChatTextArea] menu pick refused: ${edit.reason}`)
                    return false
                }
                // Picking from the menu is the user's confirmation (WS-041 AC-09).
                commitPasteProvenance(edit.provenance)
                setInputValue(edit.provenance.text)
                setCursorPosition(edit.caret)
                setIntendedCursorPosition(edit.caret)
                return true
            },
            [cursorPosition, semanticCatalog, provenanceOf, commitPasteProvenance, setInputValue],
        )

        const handleMentionSelect = useCallback(
            (type: ContextMenuOptionType, value?: string) => {
                if (type === ContextMenuOptionType.NoResults) {
                    return
                }

                if (
                    type === ContextMenuOptionType.File ||
                    type === ContextMenuOptionType.Folder ||
                    type === ContextMenuOptionType.Git
                ) {
                    if (!value) {
                        setSelectedType(type)
                        setSearchQuery("")
                        setSelectedMenuIndex(0)

                        // Trigger search with the selected type
                        if (type === ContextMenuOptionType.File || type === ContextMenuOptionType.Folder) {
                            setSearchLoading(true)

                            // Map ContextMenuOptionType to FileSearchType enum
                            let searchType: FileSearchType | undefined
                            if (type === ContextMenuOptionType.File) {
                                searchType = FileSearchType.FILE
                            } else if (type === ContextMenuOptionType.Folder) {
                                searchType = FileSearchType.FOLDER
                            }

                            const myToken = ++latestSearchTokenRef.current
                            FileServiceClient.searchFiles(
                                FileSearchRequest.create({
                                    query: "",
                                    mentionsRequestId: String(myToken),
                                    selectedType: searchType,
                                }),
                            )
                                .then((results) => {
                                    if (myToken !== latestSearchTokenRef.current) {
                                        // Stale response — a newer search has been issued.
                                        return
                                    }
                                    setFileSearchResults((results.results || []) as SearchResult[])
                                    setSearchLoading(false)
                                })
                                .catch((error) => {
                                    if (myToken !== latestSearchTokenRef.current) {
                                        return
                                    }
                                    console.error("Error searching files:", error)
                                    setFileSearchResults([])
                                    setSearchLoading(false)
                                })
                        }
                        return
                    }
                }

                let reference = value || ""
                if (type === ContextMenuOptionType.Problems) {
                    reference = "problems"
                } else if (type === ContextMenuOptionType.Terminal) {
                    reference = "terminal"
                }
                // A refused pick writes nothing and keeps the menu open, so it is never lost silently.
                if (!applyMenuPick({ kind: "mention", reference })) return
                setShowContextMenu(false)
                setSelectedType(null)
                setSearchQuery("")
            },
            [applyMenuPick],
        )

        const handleSlashCommandsSelect = useCallback(
            (entry: SlashMenuEntry) => {
                if (!applyMenuPick({ kind: "command", commandId: entry.commandId, trigger: entry.trigger })) return
                setShowSlashCommandsMenu(false)
                setSlashCommandsQuery("")
                setTimeout(() => {
                    if (textAreaRef.current) {
                        textAreaRef.current.blur()
                        textAreaRef.current.focus()
                    }
                }, 0)
            },
            [applyMenuPick],
        )
        const handleKeyDown = useCallback(
            (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
                // Safari does not support InputEvent.isComposing (always false), so we need to fallback to keyCode === 229 for it
                const isComposing = isSafari ? event.nativeEvent.keyCode === 229 : (event.nativeEvent?.isComposing ?? false)
                const isSelectAllShortcut =
                    (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "a"
                if (isSelectAllShortcut) {
                    event.preventDefault()
                    event.stopPropagation()
                    const textArea = event.currentTarget
                    textArea.setSelectionRange(0, textArea.value.length)
                    setCursorPosition(0)
                    return
                }

                const normalizedKey = event.key.toLowerCase()
                const hasHistoryModifier = (event.metaKey || event.ctrlKey) && !event.altKey
                const isUndoShortcut = hasHistoryModifier && !event.shiftKey && normalizedKey === "z"
                const isRedoShortcut =
                    hasHistoryModifier &&
                    ((!event.shiftKey && normalizedKey === "y") || (event.shiftKey && normalizedKey === "z"))
                if (!isComposing && (isUndoShortcut || isRedoShortcut)) {
                    event.preventDefault()
                    event.stopPropagation()
                    const restoredValue = isUndoShortcut ? undoInputValue() : redoInputValue()
                    if (restoredValue !== undefined) {
                        setShowContextMenu(false)
                        setShowSlashCommandsMenu(false)
                        setCursorPosition(restoredValue.length)
                        setIntendedCursorPosition(restoredValue.length)
                    }
                    return
                }

                if (showSlashCommandsMenu) {
                    if (event.key === "Escape") {
                        setShowSlashCommandsMenu(false)
                        setSlashCommandsQuery("")
                        return
                    }

                    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                        event.preventDefault()
                        setSelectedSlashCommandsIndex((prevIndex) => {
                            const direction = event.key === "ArrowUp" ? -1 : 1
                            const count = slashMenuEntries.length
                            if (count === 0) {
                                return prevIndex
                            }
                            // Wrap around from the last row to the first and back.
                            return (Math.min(prevIndex, count - 1) + direction + count) % count
                        })
                        return
                    }

                    if (
                        shouldCompleteMenuSelection(
                            event,
                            chatInputSendShortcut ?? DEFAULT_CHAT_INPUT_SEND_SHORTCUT,
                            isComposing,
                        ) &&
                        selectedSlashCommandsIndex !== -1
                    ) {
                        event.preventDefault()
                        const entry = slashMenuEntries[selectedSlashCommandsIndex]
                        if (entry) {
                            handleSlashCommandsSelect(entry)
                        }
                        return
                    }
                }
                if (showContextMenu) {
                    if (event.key === "Escape") {
                        setShowContextMenu(false)
                        setSelectedType(null)
                        setSelectedMenuIndex(DEFAULT_CONTEXT_MENU_OPTION)
                        setSearchQuery("")
                        return
                    }

                    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                        event.preventDefault()
                        setSelectedMenuIndex((prevIndex) => {
                            const direction = event.key === "ArrowUp" ? -1 : 1
                            const options = getContextMenuOptions(searchQuery, selectedType, queryItems, fileSearchResults)
                            const optionsLength = options.length

                            if (optionsLength === 0) {
                                return prevIndex
                            }

                            // Find selectable options (non-URL types)
                            const selectableOptions = options.filter(
                                (option) =>
                                    option.type !== ContextMenuOptionType.URL && option.type !== ContextMenuOptionType.NoResults,
                            )

                            if (selectableOptions.length === 0) {
                                return -1 // No selectable options
                            }

                            // Find the index of the next selectable option
                            const currentSelectableIndex = selectableOptions.indexOf(options[prevIndex])

                            const newSelectableIndex =
                                (currentSelectableIndex + direction + selectableOptions.length) % selectableOptions.length

                            // Find the index of the selected option in the original options array
                            return options.indexOf(selectableOptions[newSelectableIndex])
                        })
                        return
                    }
                    if (
                        shouldCompleteMenuSelection(
                            event,
                            chatInputSendShortcut ?? DEFAULT_CHAT_INPUT_SEND_SHORTCUT,
                            isComposing,
                        ) &&
                        selectedMenuIndex !== -1
                    ) {
                        event.preventDefault()
                        const selectedOption = getContextMenuOptions(searchQuery, selectedType, queryItems, fileSearchResults)[
                            selectedMenuIndex
                        ]
                        if (
                            selectedOption &&
                            selectedOption.type !== ContextMenuOptionType.URL &&
                            selectedOption.type !== ContextMenuOptionType.NoResults
                        ) {
                            // Use label if it contains workspace prefix, otherwise use value
                            const mentionValue = selectedOption.label?.includes(":") ? selectedOption.label : selectedOption.value
                            handleMentionSelect(selectedOption.type, mentionValue)
                        }
                        return
                    }
                }

                if (shouldSendChatInput(event, chatInputSendShortcut ?? DEFAULT_CHAT_INPUT_SEND_SHORTCUT, isComposing)) {
                    event.preventDefault()

                    const capturedDraft = captureSendDraft(event.currentTarget.value)
                    if (!sendingDisabled) {
                        setIsTextAreaFocused(false)
                        onSend(capturedDraft)
                    } else {
                        onSendBlocked?.(capturedDraft)
                    }
                }

                if (event.key === "Backspace" && !isComposing) {
                    const charBeforeCursor = inputValue[cursorPosition - 1]
                    const charAfterCursor = inputValue[cursorPosition + 1]

                    const charBeforeIsWhitespace =
                        charBeforeCursor === " " || charBeforeCursor === "\n" || charBeforeCursor === "\r\n"
                    const charAfterIsWhitespace =
                        charAfterCursor === " " || charAfterCursor === "\n" || charAfterCursor === "\r\n"

                    // Check if we're right after a space that follows a mention or slash command
                    if (
                        charBeforeIsWhitespace &&
                        inputValue.slice(0, cursorPosition - 1).match(new RegExp(`${mentionRegex.source}$`))
                    ) {
                        // File mention handling
                        const newCursorPosition = cursorPosition - 1
                        if (!charAfterIsWhitespace) {
                            event.preventDefault()
                            textAreaRef.current?.setSelectionRange(newCursorPosition, newCursorPosition)
                            setCursorPosition(newCursorPosition)
                        }
                        setCursorPosition(newCursorPosition)
                        setJustDeletedSpaceAfterMention(true)
                        setJustDeletedSpaceAfterSlashCommand(false)
                    } else if (charBeforeIsWhitespace && inputValue.slice(0, cursorPosition - 1).match(slashCommandDeleteRegex)) {
                        // New slash command handling
                        const newCursorPosition = cursorPosition - 1
                        if (!charAfterIsWhitespace) {
                            event.preventDefault()
                            textAreaRef.current?.setSelectionRange(newCursorPosition, newCursorPosition)
                            setCursorPosition(newCursorPosition)
                        }
                        setCursorPosition(newCursorPosition)
                        setJustDeletedSpaceAfterSlashCommand(true)
                        setJustDeletedSpaceAfterMention(false)
                    }
                    // Handle the second backspace press for mentions or slash commands
                    else if (justDeletedSpaceAfterMention) {
                        const { newText, newPosition } = removeMention(inputValue, cursorPosition)
                        if (newText !== inputValue) {
                            event.preventDefault()
                            setInputValue(newText)
                            setIntendedCursorPosition(newPosition)
                        }
                        setJustDeletedSpaceAfterMention(false)
                        setShowContextMenu(false)
                    } else if (justDeletedSpaceAfterSlashCommand) {
                        // New slash command deletion
                        const { newText, newPosition } = removeSlashCommand(inputValue, cursorPosition)
                        if (newText !== inputValue) {
                            event.preventDefault()
                            setInputValue(newText)
                            setIntendedCursorPosition(newPosition)
                        }
                        setJustDeletedSpaceAfterSlashCommand(false)
                        setShowSlashCommandsMenu(false)
                    }
                    // Default case - reset flags if none of the above apply
                    else {
                        setJustDeletedSpaceAfterMention(false)
                        setJustDeletedSpaceAfterSlashCommand(false)
                    }
                }
            },
            [
                onSend,
                onSendBlocked,
                showContextMenu,
                searchQuery,
                selectedMenuIndex,
                handleMentionSelect,
                selectedType,
                inputValue,
                cursorPosition,
                setInputValue,
                undoInputValue,
                redoInputValue,
                justDeletedSpaceAfterMention,
                queryItems,
                fileSearchResults,
                showSlashCommandsMenu,
                selectedSlashCommandsIndex,
                slashMenuEntries,
                handleSlashCommandsSelect,
                sendingDisabled,
                selectedImages,
                selectedFiles,
                chatInputSendShortcut,
                justDeletedSpaceAfterSlashCommand,
            ],
        )

        // Effect to set cursor position after state updates
        useLayoutEffect(() => {
            if (intendedCursorPosition !== null && textAreaRef.current) {
                textAreaRef.current.setSelectionRange(intendedCursorPosition, intendedCursorPosition)
                setIntendedCursorPosition(null) // Reset the state after applying
            }
        }, [intendedCursorPosition])

        useEffect(() => {
            if (pendingInsertions.length === 0 || !textAreaRef.current) {
                return
            }

            const reference = pendingInsertions[0]
            const currentTextArea = textAreaRef.current
            const currentValue = currentTextArea.value
            const caret =
                intendedCursorPosition ??
                (currentTextArea.selectionStart >= 0 ? currentTextArea.selectionStart : currentValue.length)
            setPendingInsertions((prev) => prev.slice(1))

            // An inserted path is the user's own action, so it lands as a confirmed mention or not at all.
            const edit = applySemanticEdit(
                provenanceOf(currentValue),
                { start: caret, end: caret },
                { kind: "mention", reference },
                semanticCatalog,
            )
            if (!edit.ok) {
                console.warn(`[ChatTextArea] mention insertion refused: ${edit.reason}`)
                return
            }
            commitPasteProvenance(edit.provenance)
            setInputValue(edit.provenance.text)
            setIntendedCursorPosition(edit.caret)
        }, [pendingInsertions, setInputValue, intendedCursorPosition, provenanceOf, semanticCatalog, commitPasteProvenance])

        const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null)

        // Monotonic token; every searchFiles dispatch bumps it, and resolve
        // handlers drop their result when the token they captured at fire time
        // is no longer the latest. Prevents stale results from a cancelled or
        // superseded picker (e.g. "Add File" still in flight when user picks
        // "Add Folder") from clobbering fresh state.
        const latestSearchTokenRef = useRef(0)

        const handleInputChange = useCallback(
            (e: React.ChangeEvent<HTMLTextAreaElement>) => {
                const newValue = e.target.value
                const newCursorPosition = e.target.selectionStart
                const nativePaste = pendingNativePasteRef.current
                pendingNativePasteRef.current = undefined
                const base = provenanceRef.current
                const nextProvenance = nativePaste
                    ? followNativePaste(base, nativePaste, newValue)
                    : rebaseProvenance(base, newValue)
                // A backend turn-end render can arrive in the same frame as a DOM input
                // event. Commit the controlled value before that external render can
                // reconcile the textarea from the preceding character and drop the key.
                flushSync(() => {
                    setInputValue(newValue)
                    setCursorPosition(newCursorPosition)
                    commitPasteProvenance(nextProvenance)
                })
                const menuQuery = composerMenuQueryAt(newValue, newCursorPosition)
                const slashQuery = menuQuery?.menu === "slash" ? menuQuery.query : undefined
                const mentionQuery = menuQuery?.menu === "mention" ? menuQuery.query : undefined

                setShowSlashCommandsMenu(slashQuery !== undefined)
                setShowContextMenu(mentionQuery !== undefined)
                setSlashCommandsQuery(slashQuery ?? "")
                setSelectedSlashCommandsIndex(0)

                if (mentionQuery !== undefined) {
                    const query = mentionQuery
                    setSearchQuery(query)

                    if (query.length > 0) {
                        setSelectedMenuIndex(0)

                        // Clear any existing timeout
                        if (searchTimeoutRef.current) {
                            clearTimeout(searchTimeoutRef.current)
                        }

                        setSearchLoading(true)

                        const searchType =
                            selectedType === ContextMenuOptionType.File
                                ? FileSearchType.FILE
                                : selectedType === ContextMenuOptionType.Folder
                                  ? FileSearchType.FOLDER
                                  : undefined

                        // Parse workspace hint from query (e.g., "@frontend:/filename")
                        let workspaceHint: string | undefined
                        let searchQuery = query
                        const workspaceHintMatch = query.match(/^([\w-]+):\/(.*)$/)
                        if (workspaceHintMatch) {
                            workspaceHint = workspaceHintMatch[1]
                            searchQuery = workspaceHintMatch[2]
                        }

                        // Set a timeout to debounce the search requests
                        searchTimeoutRef.current = setTimeout(() => {
                            const myToken = ++latestSearchTokenRef.current
                            FileServiceClient.searchFiles(
                                FileSearchRequest.create({
                                    query: searchQuery,
                                    mentionsRequestId: String(myToken),
                                    selectedType: searchType,
                                    workspaceHint: workspaceHint,
                                }),
                            )
                                .then((results) => {
                                    if (myToken !== latestSearchTokenRef.current) {
                                        // Stale response — a newer search has been issued.
                                        return
                                    }
                                    setFileSearchResults((results.results || []) as SearchResult[])
                                    setSearchLoading(false)
                                })
                                .catch((error) => {
                                    if (myToken !== latestSearchTokenRef.current) {
                                        return
                                    }
                                    console.error("Error searching files:", error)
                                    setFileSearchResults([])
                                    setSearchLoading(false)
                                })
                        }, 200) // 200ms debounce
                    } else {
                        setSelectedMenuIndex(DEFAULT_CONTEXT_MENU_OPTION)
                    }
                } else {
                    setSearchQuery("")
                    setSelectedMenuIndex(-1)
                    setFileSearchResults([])
                }
            },
            [setInputValue, selectedType],
        )

        useEffect(() => {
            if (!showContextMenu) {
                setSelectedType(null)
            }
        }, [showContextMenu])

        const handleBlur = useCallback(() => {
            // Only hide the context menu if the user didn't click on it
            if (!isMouseDownOnMenu) {
                setShowContextMenu(false)
                setShowSlashCommandsMenu(false)
            }
            setIsTextAreaFocused(false)
            onFocusChange?.(false) // Call prop on blur
        }, [isMouseDownOnMenu, onFocusChange])

        const showDimensionErrorMessage = useCallback(() => {
            setShowDimensionError(true)
            if (dimensionErrorTimerRef.current) {
                clearTimeout(dimensionErrorTimerRef.current)
            }
            dimensionErrorTimerRef.current = setTimeout(() => {
                setShowDimensionError(false)
                dimensionErrorTimerRef.current = null
            }, 3000)
        }, [])

        /** Adds host paths of attached files, respecting the per-message attachment limit. */
        const appendAttachmentPaths = useCallback(
            (paths: string[]) => {
                if (paths.length === 0) {
                    return
                }
                setSelectedFiles((previous) => {
                    const availableSlots = MAX_IMAGES_AND_FILES_PER_MESSAGE - selectedImages.length - previous.length
                    const added = paths.filter((filePath) => !previous.includes(filePath)).slice(0, Math.max(0, availableSlots))
                    return added.length > 0 ? [...previous, ...added] : previous
                })
            },
            [selectedImages.length, setSelectedFiles],
        )

        /** Attaches files the host can read by URI (Explorer drops, Linux file-manager URIs). */
        const attachFileUris = useCallback(
            async (uris: string[]) => {
                try {
                    const response = await FileServiceClient.resolveAttachmentUris(RelativePathsRequest.create({ uris }))
                    appendAttachmentPaths(response.values)
                } catch (error) {
                    console.error("Error resolving dropped attachments:", error)
                }
            },
            [appendAttachmentPaths],
        )

        /** Sends files that only exist as bytes in the Webview to the host, which stages them as attachments. */
        const stageAttachmentFiles = useCallback(
            async (files: File[]) => {
                const stagedPaths: string[] = []
                for (const file of files) {
                    try {
                        const data = new Uint8Array(await file.arrayBuffer())
                        const response = await FileServiceClient.stageAttachment(
                            StageAttachmentRequest.create({ fileName: file.name, data }),
                        )
                        if (response.value) {
                            stagedPaths.push(response.value)
                        }
                    } catch (error) {
                        console.error(`Error attaching ${file.name}:`, error)
                    }
                }
                appendAttachmentPaths(stagedPaths)
            },
            [appendAttachmentPaths],
        )

        // A paste the composer took over still lands where the browser would have
        // put it. The textarea is read at insertion time rather than from the
        // render closure, because an oversized paste falls back only after the
        // host answers and the user may have typed in the meantime.
        const insertAtCursor = useCallback(
            (text: string, origin: "paste" | "typed" = "typed") => {
                const element = textAreaRef.current
                const value = element?.value ?? inputValue
                const start = element?.selectionStart ?? cursorPosition
                const end = element?.selectionEnd ?? start
                const nextValue = value.slice(0, start) + text + value.slice(end)
                // Text the clipboard supplied stays held even when the composer, not
                // the browser, inserts it (WS-041 AC-09).
                const base = provenanceOf(value)
                commitPasteProvenance(
                    origin === "paste" ? recordPaste(base, start, end, text) : rebaseProvenance(base, nextValue),
                )
                setInputValue(nextValue)
                const newCursorPosition = start + text.length
                setCursorPosition(newCursorPosition)
                setIntendedCursorPosition(newCursorPosition)
                setShowContextMenu(false)
                // Scroll to the new caret without losing focus.
                setTimeout(() => {
                    if (textAreaRef.current) {
                        textAreaRef.current.setSelectionRange(newCursorPosition, newCursorPosition)
                        textAreaRef.current.scrollTop = textAreaRef.current.scrollHeight
                    }
                }, 0)
            },
            [commitPasteProvenance, cursorPosition, inputValue, provenanceOf, setInputValue],
        )

        const attachPastedImages = useCallback(
            async (files: readonly File[]) => {
                const readImage = (file: File) =>
                    new Promise<string | null>((resolve) => {
                        const reader = new FileReader()
                        reader.onloadend = async () => {
                            const result = reader.result
                            if (reader.error || typeof result !== "string") {
                                if (reader.error) console.error("Error reading file:", reader.error)
                                resolve(null)
                                return
                            }
                            try {
                                await getImageDimensions(result)
                                resolve(result)
                            } catch (error) {
                                console.warn((error as Error).message)
                                showDimensionErrorMessage()
                                resolve(null)
                            }
                        }
                        reader.readAsDataURL(file)
                    })
                const dataUrls = (await Promise.all(files.map(readImage))).filter(
                    (dataUrl): dataUrl is string => dataUrl !== null,
                )
                if (dataUrls.length === 0) {
                    console.warn("No valid images were processed")
                    return
                }
                const availableSlots = MAX_IMAGES_AND_FILES_PER_MESSAGE - (selectedImages.length + selectedFiles.length)
                if (availableSlots > 0) setSelectedImages((prevImages) => [...prevImages, ...dataUrls.slice(0, availableSlots)])
            },
            [selectedImages.length, selectedFiles.length, setSelectedImages, showDimensionErrorMessage],
        )

        const handlePaste = useCallback(
            async (e: React.ClipboardEvent) => {
                const pastedText = e.clipboardData.getData("text")
                // Files copied in a file manager arrive as clipboard files, or on Linux as
                // file:// URIs in the text payload; images keep the image intent below.
                const pastedFiles = classifyTransferFiles(Array.from(e.clipboardData.files ?? []))
                const pastedFileUris = parseAttachableFileUris(pastedText)
                const reportsRejected =
                    pastedFiles.rejected.length > 0 && (pastedFiles.attachments.length > 0 || pastedFiles.images.length === 0)
                if (reportsRejected) showUnsupportedFileErrorMessage()
                if (pastedFiles.attachments.length > 0 || pastedFileUris.length > 0) {
                    // Claimed before the first await: the browser pastes as soon as this handler yields.
                    e.preventDefault()
                    if (!shouldDisableFilesAndImages) {
                        if (pastedFiles.attachments.length > 0) await stageAttachmentFiles(pastedFiles.attachments)
                        else await attachFileUris(pastedFileUris)
                    }
                    if (pastedFiles.images.length > 0 && !shouldDisableFilesAndImages)
                        await attachPastedImages(pastedFiles.images)
                    return
                }
                const intent = classifyPaste(pastedText, Array.from(e.clipboardData.items), {
                    attachmentsEnabled: !shouldDisableFilesAndImages,
                    hasFreeSlot: selectedImages.length + selectedFiles.length < MAX_IMAGES_AND_FILES_PER_MESSAGE,
                })
                if (intent.kind === "native") {
                    // The browser inserts the text; the change it causes records where.
                    const element = textAreaRef.current
                    if (element && pastedText) {
                        const { selectionStart: start, selectionEnd: end, value } = element
                        // Pasting exactly the selected text changes nothing, so no change
                        // event follows; the pasted origin must be recorded right here.
                        if (value.slice(start, end) === pastedText) {
                            pendingNativePasteRef.current = undefined
                            commitPasteProvenance(recordPaste(provenanceOf(value), start, end, pastedText))
                            return
                        }
                        pendingNativePasteRef.current = { start, end, text: pastedText }
                    }
                    return
                }
                // The browser applies its default paste as soon as this handler
                // yields, so a takeover must be claimed before the first await.
                e.preventDefault()
                switch (intent.kind) {
                    case "url":
                        // A trailing space lets the user delete the link as one unit.
                        insertAtCursor(`${intent.url} `, "paste")
                        return
                    case "oversized_text": {
                        // An oversized paste becomes a task-owned file so it stays readable
                        // and is not repeated in every later provider request.
                        const stored = await storeOversizedPaste(intent.text)
                        // A declined store keeps what the user pasted instead of dropping it.
                        if (stored) setSelectedFiles((previousFiles) => [...previousFiles, stored.absolutePath])
                        else insertAtCursor(intent.text, "paste")
                        return
                    }
                    case "images":
                        await attachPastedImages(intent.files)
                        return
                }
            },
            [
                attachPastedImages,
                commitPasteProvenance,
                insertAtCursor,
                provenanceOf,
                selectedFiles.length,
                selectedImages.length,
                setSelectedFiles,
                shouldDisableFilesAndImages,
                stageAttachmentFiles,
                attachFileUris,
            ],
        )

        const handleThumbnailsHeightChange = useCallback((height: number) => {
            setThumbnailsHeight(height)
        }, [])

        useEffect(() => {
            if (selectedImages.length === 0 && selectedFiles.length === 0) {
                setThumbnailsHeight(0)
            }
        }, [selectedImages, selectedFiles])

        const handleMenuMouseDown = useCallback(() => {
            setIsMouseDownOnMenu(true)
        }, [])

        /** Keeps the highlight overlay scrolled with the textarea; scrolling never needs a re-highlight. */
        const syncHighlightScroll = useCallback(() => {
            if (!textAreaRef.current || !highlightLayerRef.current) {
                return
            }
            highlightLayerRef.current.scrollTop = textAreaRef.current.scrollTop
            highlightLayerRef.current.scrollLeft = textAreaRef.current.scrollLeft
        }, [])

        const updateHighlights = useCallback(() => {
            if (!textAreaRef.current || !highlightLayerRef.current) {
                return
            }

            const value = textAreaRef.current.value
            // Very large pastes skip the per-keystroke semantic scan so typing stays responsive;
            // the overlay still mirrors the text so layout and scrolling stay aligned.
            if (value.length > MAX_HIGHLIGHTED_INPUT_LENGTH) {
                highlightLayerRef.current.innerHTML = value
                    .replace(/\n$/, "\n\n")
                    .replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] || c)
                syncHighlightScroll()
                return
            }
            // The highlight comes from the same catalog and lexer the task admits
            // with, so an entity stops looking active exactly when it stops acting
            // as one: an unknown mention, or anything a lifecycle barrier moved
            // into the pre-message.
            const spans = provenanceOf(value).spans
            highlightLayerRef.current.innerHTML = renderSemanticHighlightHtml(value, semanticCatalog, pasteAwareActivation(spans))
            syncHighlightScroll()
        }, [semanticCatalog, pasteProvenance, provenanceOf, syncHighlightScroll])

        useLayoutEffect(() => {
            updateHighlights()
        }, [updateHighlights])

        const updateCursorPosition = useCallback(() => {
            if (textAreaRef.current) {
                setCursorPosition(textAreaRef.current.selectionStart)
            }
        }, [])

        const handleKeyUp = useCallback(
            (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
                if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
                    updateCursorPosition()
                }
            },
            [updateCursorPosition],
        )

        const attachDraft = shouldAttachModeSwitchDraft(clineAsk)
        // Composed once per draft content, so an unrelated render neither re-lexes
        // the text nor hands the switch a new document identity.
        const modeSwitchDraft = useMemo(() => captureSendDraft(inputValue), [captureSendDraft, inputValue])
        const modeSwitchFlow = useModeSwitch({
            mode,
            stateRevision,
            modeSwitch,
            draft: modeSwitchDraft,
            attachDraft,
            submitDraftAfterSwitch: currentTaskItem !== undefined,
            onSend: (capturedDraft) => onSend(capturedDraft),
            clearDraft: () => {
                setInputValue("")
                setSelectedImages([])
                setSelectedFiles([])
            },
        })

        /** Request the opposite mode through the backend transaction. */
        const onModeToggle = useCallback(() => {
            const targetMode: Mode = mode === "plan" ? "act" : "plan"
            void modeSwitchFlow.requestSwitch(targetMode).finally(() => textAreaRef.current?.focus())
        }, [mode, modeSwitchFlow.requestSwitch])

        useShortcut(usePlatform().togglePlanActKeys, onModeToggle, { disableTextInputs: false }) // important that we don't disable the text input here

        const handleContextButtonClick = useCallback(() => {
            // Focus the textarea first
            textAreaRef.current?.focus()

            // If input is empty, just insert @
            if (!inputValue.trim()) {
                const event = {
                    target: {
                        value: "@",
                        selectionStart: 1,
                    },
                } as React.ChangeEvent<HTMLTextAreaElement>
                handleInputChange(event)
                updateHighlights()
                return
            }

            // If input ends with space or is empty, just append @
            if (inputValue.endsWith(" ")) {
                const event = {
                    target: {
                        value: `${inputValue}@`,
                        selectionStart: inputValue.length + 1,
                    },
                } as React.ChangeEvent<HTMLTextAreaElement>
                handleInputChange(event)
                updateHighlights()
                return
            }

            // Otherwise add space then @
            const event = {
                target: {
                    value: `${inputValue} @`,
                    selectionStart: inputValue.length + 2,
                },
            } as React.ChangeEvent<HTMLTextAreaElement>
            handleInputChange(event)
            updateHighlights()
        }, [inputValue, handleInputChange, updateHighlights])

        const handleModelButtonClick = () => {
            navigateToSettings("api-config")
        }

        // Function to show error message for unsupported files for drag and drop
        const showUnsupportedFileErrorMessage = () => {
            // Show error message for unsupported files
            setShowUnsupportedFileError(true)

            // Clear any existing timer
            if (unsupportedFileTimerRef.current) {
                clearTimeout(unsupportedFileTimerRef.current)
            }

            // Set timer to hide error after 3 seconds
            unsupportedFileTimerRef.current = setTimeout(() => {
                setShowUnsupportedFileError(false)
                unsupportedFileTimerRef.current = null
            }, 3000)
        }

        const handleDragEnter = (e: React.DragEvent) => {
            e.preventDefault()
            // File names and types are not reliable until drop, so supported types are checked in onDrop.
            setIsDraggingOver(true)
        }
        /**
         * Handles the drag over event to allow dropping.
         * Prevents the default behavior to enable drop.
         *
         * @param {React.DragEvent} e - The drag event.
         */
        const onDragOver = (e: React.DragEvent) => {
            e.preventDefault()
            // Ensure state remains true if dragging continues over the element
            if (!isDraggingOver) {
                setIsDraggingOver(true)
            }
        }

        const handleDragLeave = (e: React.DragEvent) => {
            e.preventDefault()
            // Check if the related target is still within the drop zone; prevents flickering
            const dropZone = e.currentTarget as HTMLElement
            if (!dropZone.contains(e.relatedTarget as Node)) {
                setIsDraggingOver(false)
                // Don't clear the error message here, let it time out naturally
            }
        }

        // Effect to detect when drag operation ends outside the component
        useEffect(() => {
            const handleGlobalDragEnd = () => {
                // This will be triggered when the drag operation ends anywhere
                setIsDraggingOver(false)
                // Don't clear error message, let it time out naturally
            }

            document.addEventListener("dragend", handleGlobalDragEnd)

            return () => {
                document.removeEventListener("dragend", handleGlobalDragEnd)
            }
        }, [])

        /**
         * Handles the drop event for files and text.
         * Processes dropped images and text, updating the state accordingly.
         *
         * @param {React.DragEvent} e - The drop event.
         */
        const onDrop = async (e: React.DragEvent) => {
            e.preventDefault()
            setIsDraggingOver(false) // Reset state on drop

            // Clear any error message when something is actually dropped
            setShowUnsupportedFileError(false)
            if (unsupportedFileTimerRef.current) {
                clearTimeout(unsupportedFileTimerRef.current)
                unsupportedFileTimerRef.current = null
            }

            // --- 1. VS Code Explorer drop: binary documents are attached, everything else is mentioned ---
            const resourceUris = readResourceUris(e.dataTransfer)
            const documentUris = resourceUris.filter(isDocumentAttachmentUri)
            const validUris = resourceUris.filter((uri) => !isDocumentAttachmentUri(uri))
            if (documentUris.length > 0 && !shouldDisableFilesAndImages) {
                void attachFileUris(documentUris)
            }

            if (validUris.length > 0) {
                setPendingInsertions([])
                let initialCursorPos = inputValue.length
                if (textAreaRef.current) {
                    initialCursorPos = textAreaRef.current.selectionStart
                }
                setIntendedCursorPosition(initialCursorPos)

                FileServiceClient.getRelativePaths(RelativePathsRequest.create({ uris: validUris }))
                    .then((response) => {
                        if (response.paths.length > 0) {
                            setPendingInsertions((prev) => [...prev, ...response.paths])
                        }
                    })
                    .catch((error) => {
                        console.error("Error getting relative paths:", error)
                    })
                return
            }

            if (resourceUris.length > 0) {
                return
            }

            // --- 2. OS file-manager drop: files arrive as bytes without a host path ---
            const droppedFiles = classifyTransferFiles(Array.from(e.dataTransfer.files))
            if (droppedFiles.rejected.length > 0) {
                showUnsupportedFileErrorMessage()
            }
            const hasDroppedFiles =
                droppedFiles.images.length + droppedFiles.attachments.length + droppedFiles.rejected.length > 0
            if (!hasDroppedFiles) {
                // --- 3. Text drop; Linux file managers may send files as file:// URIs only ---
                const text = e.dataTransfer.getData("text")
                const droppedFileUris = parseAttachableFileUris(text)
                if (droppedFileUris.length > 0) {
                    if (!shouldDisableFilesAndImages) {
                        void attachFileUris(droppedFileUris)
                    }
                } else if (text) {
                    handleTextDrop(text)
                }
                return
            }

            if (shouldDisableFilesAndImages) {
                return
            }
            if (droppedFiles.attachments.length > 0) {
                void stageAttachmentFiles(droppedFiles.attachments)
            }
            const imageFiles = droppedFiles.images
            if (imageFiles.length === 0) {
                return
            }

            const imageDataArray = await readImageFiles(imageFiles)
            const dataUrls = imageDataArray.filter((dataUrl): dataUrl is string => dataUrl !== null)

            if (dataUrls.length > 0) {
                const filesAndImagesLength = selectedImages.length + selectedFiles.length
                const availableSlots = MAX_IMAGES_AND_FILES_PER_MESSAGE - filesAndImagesLength

                if (availableSlots > 0) {
                    const imagesToAdd = Math.min(dataUrls.length, availableSlots)
                    setSelectedImages((prevImages) => [...prevImages, ...dataUrls.slice(0, imagesToAdd)])
                }
            } else {
                console.warn("No valid images were processed")
            }
        }

        /**
         * Handles the drop event for text.
         * Inserts the dropped text at the current cursor position.
         *
         * @param {string} text - The dropped text.
         */
        const handleTextDrop = (text: string) => {
            // The cursor may still point past a draft that was just cleared; insertion
            // and provenance must use the same, clamped offset.
            const at = Math.min(Math.max(cursorPosition, 0), inputValue.length)
            const newValue = inputValue.slice(0, at) + text + inputValue.slice(at)
            // Dropped text is foreign text, held exactly like a paste (WS-041 AC-09).
            commitPasteProvenance(recordPaste(provenanceOf(inputValue), at, at, text))
            setInputValue(newValue)
            const newCursorPosition = at + text.length
            setCursorPosition(newCursorPosition)
            setIntendedCursorPosition(newCursorPosition)
        }

        /**
         * Reads image files and returns their data URLs.
         * Uses FileReader to read the files as data URLs.
         *
         * @param {File[]} imageFiles - The image files to read.
         * @returns {Promise<(string | null)[]>} - A promise that resolves to an array of data URLs or null values.
         */
        const readImageFiles = (imageFiles: File[]): Promise<(string | null)[]> => {
            return Promise.all(
                imageFiles.map(
                    (file) =>
                        new Promise<string | null>((resolve) => {
                            const reader = new FileReader()
                            reader.onloadend = async () => {
                                // Make async
                                if (reader.error) {
                                    console.error("Error reading file:", reader.error)
                                    resolve(null)
                                } else {
                                    const result = reader.result
                                    if (typeof result === "string") {
                                        try {
                                            await getImageDimensions(result) // Check dimensions
                                            resolve(result)
                                        } catch (error) {
                                            console.warn((error as Error).message)
                                            showDimensionErrorMessage() // Show error to user
                                            resolve(null) // Don't add this image
                                        }
                                    } else {
                                        resolve(null)
                                    }
                                }
                            }
                            reader.readAsDataURL(file)
                        }),
                ),
            )
        }
        // Replace Meta with the platform specific key and uppercase the command letter.
        const togglePlanActKeys = usePlatform()
            .togglePlanActKeys.replace("Meta", metaKeyChar)
            .replace(/.$/, (match) => match.toUpperCase())

        return (
            <div>
                <div
                    className="relative flex transition-colors ease-in-out duration-100 px-3.5 py-2.5"
                    onDragEnter={handleDragEnter}
                    onDragLeave={handleDragLeave}
                    onDragOver={onDragOver}
                    onDrop={onDrop}>
                    {showDimensionError && (
                        <div className="absolute inset-2.5 bg-[rgba(var(--vscode-errorForeground-rgb),0.1)] border-2 border-error rounded-xs flex items-center justify-center z-10 pointer-events-none">
                            <span className="text-error font-bold text-xs text-center">Image dimensions exceed 7500px</span>
                        </div>
                    )}
                    {showUnsupportedFileError && (
                        <div className="absolute inset-2.5 bg-[rgba(var(--vscode-errorForeground-rgb),0.1)] border-2 border-error rounded-xs flex items-center justify-center z-10 pointer-events-none">
                            <span className="text-error font-bold text-xs">
                                File too large: PDF up to 50MB, other files up to 20MB
                            </span>
                        </div>
                    )}
                    {showSlashCommandsMenu && (
                        <div ref={slashCommandsMenuContainerRef}>
                            <SlashCommandMenu
                                entries={slashMenuEntries}
                                onMouseDown={handleMenuMouseDown}
                                onSelect={handleSlashCommandsSelect}
                                selectedIndex={selectedSlashCommandsIndex}
                                setSelectedIndex={setSelectedSlashCommandsIndex}
                            />
                        </div>
                    )}

                    {showContextMenu && (
                        <div ref={contextMenuContainerRef}>
                            <ContextMenu
                                dynamicSearchResults={fileSearchResults}
                                isLoading={searchLoading}
                                onMouseDown={handleMenuMouseDown}
                                onSelect={handleMentionSelect}
                                queryItems={queryItems}
                                searchQuery={searchQuery}
                                selectedIndex={selectedMenuIndex}
                                selectedType={selectedType}
                                setSelectedIndex={setSelectedMenuIndex}
                            />
                        </div>
                    )}
                    <div
                        className={cn(
                            "absolute bottom-2.5 top-2.5 whitespace-pre-wrap wrap-break-word rounded-xs overflow-hidden bg-input-background",
                            isTextAreaFocused ? "left-3.5 right-3.5" : "left-3.5 right-3.5 border border-input-border",
                        )}
                        ref={highlightLayerRef}
                        style={{
                            position: "absolute",
                            pointerEvents: "none",
                            whiteSpace: "pre-wrap",
                            wordWrap: "break-word",
                            color: "transparent",
                            overflow: "hidden",
                            // Reserve the same scrollbar gutter as the textarea so both wrap text identically.
                            scrollbarWidth: "thin",
                            scrollbarGutter: "stable",
                            fontFamily: "var(--vscode-font-family)",
                            fontSize: "var(--vscode-editor-font-size)",
                            lineHeight: "var(--vscode-editor-line-height)",
                            borderRadius: 2,
                            borderLeft: isTextAreaFocused ? 0 : undefined,
                            borderRight: isTextAreaFocused ? 0 : undefined,
                            borderTop: isTextAreaFocused ? 0 : undefined,
                            borderBottom: isTextAreaFocused ? 0 : undefined,
                            padding: `${CHAT_INPUT_PADDING_Y_PX}px 28px ${CHAT_INPUT_PADDING_Y_PX + thumbnailsHeight}px 9px`,
                        }}
                    />
                    <DynamicTextArea
                        data-testid="chat-input"
                        maxRows={chatInputMaxRows(textAreaRowHeight)}
                        minRows={CHAT_INPUT_MIN_ROWS}
                        onBlur={handleBlur}
                        onChange={(e) => {
                            handleInputChange(e)
                            updateHighlights()
                        }}
                        onFocus={() => {
                            setIsTextAreaFocused(true)
                            onFocusChange?.(true) // Call prop on focus
                        }}
                        onHeightChange={(height, { rowHeight }) => {
                            if (textAreaBaseHeight === undefined || height < textAreaBaseHeight) {
                                setTextAreaBaseHeight(height)
                            }
                            setTextAreaRowHeight(rowHeight)
                            onHeightChange?.(height)
                        }}
                        onKeyDown={handleKeyDown}
                        onKeyUp={handleKeyUp}
                        onMouseUp={updateCursorPosition}
                        onPaste={handlePaste}
                        onScroll={syncHighlightScroll}
                        onSelect={updateCursorPosition}
                        placeholder={showUnsupportedFileError || showDimensionError ? "" : placeholderText}
                        ref={(el) => {
                            if (typeof ref === "function") {
                                ref(el)
                            } else if (ref) {
                                ref.current = el
                            }
                            textAreaRef.current = el
                        }}
                        style={{
                            width: "100%",
                            boxSizing: "border-box",
                            backgroundColor: "transparent",
                            color: "var(--vscode-input-foreground)",
                            //border: "1px solid var(--vscode-input-border)",
                            borderRadius: 2,
                            fontFamily: "var(--vscode-font-family)",
                            fontSize: "var(--vscode-editor-font-size)",
                            lineHeight: "var(--vscode-editor-line-height)",
                            resize: "none",
                            overflowX: "hidden",
                            overflowY: "auto",
                            // A visible scrollbar shows that long input continues beyond the visible rows.
                            scrollbarWidth: "thin",
                            scrollbarGutter: "stable",
                            // The standard scrollbar properties bypass the webview's ::-webkit-scrollbar theme,
                            // so the colors must be set here or the track renders as an untinted system gutter.
                            scrollbarColor: "var(--vscode-scrollbarSlider-background) transparent",
                            // Since we have maxRows
                            // borderTop: "9px solid transparent",
                            borderLeft: 0,
                            borderRight: 0,
                            borderTop: 0,
                            borderBottom: `${thumbnailsHeight}px solid transparent`,
                            borderColor: "transparent",
                            // borderRight: "54px solid transparent",
                            // borderLeft: "9px solid transparent", // NOTE: react-textarea-autosize doesn't calculate correct height when using borderLeft/borderRight so we need to use horizontal padding instead
                            // Instead of using boxShadow, we use a div with a border to better replicate the behavior when the textarea is focused
                            // boxShadow: "0px 0px 0px 1px var(--vscode-input-border)",
                            padding: `${CHAT_INPUT_PADDING_Y_PX}px 28px ${CHAT_INPUT_PADDING_Y_PX}px 9px`,
                            cursor: "text",
                            flex: 1,
                            zIndex: 1,
                            outline:
                                isDraggingOver && !showUnsupportedFileError // Only show drag outline if not showing error
                                    ? "2px dashed var(--vscode-focusBorder)"
                                    : isTextAreaFocused
                                      ? `1px solid ${mode === "plan" ? PLAN_MODE_COLOR : "var(--vscode-focusBorder)"}`
                                      : "none",
                            outlineOffset: isDraggingOver && !showUnsupportedFileError ? "1px" : "0px", // Add offset for drag-over outline
                        }}
                        value={inputValue}
                    />
                    {!inputValue && selectedImages.length === 0 && selectedFiles.length === 0 && (
                        <div className="text-xs absolute bottom-5 left-6.5 right-16 text-(--vscode-input-placeholderForeground)/50 whitespace-nowrap overflow-hidden text-ellipsis pointer-events-none z-1">
                            Type @ for context, / for slash commands & workflows, hold shift to drag in files/images
                        </div>
                    )}
                    {heldCandidates.length > 0 && (
                        <div
                            aria-live="polite"
                            className="text-xs absolute -top-5 left-4 right-4 truncate text-(--vscode-editorWarning-foreground) z-1"
                            data-testid="pasted-candidate-notice"
                            role="status">
                            {`Pasted ${heldCandidates.join(", ")} will be sent as plain text. Pick it from the menu to run it.`}
                        </div>
                    )}
                    {(selectedImages.length > 0 || selectedFiles.length > 0) && (
                        <Thumbnails
                            files={selectedFiles}
                            images={selectedImages}
                            onHeightChange={handleThumbnailsHeightChange}
                            setFiles={setSelectedFiles}
                            setImages={setSelectedImages}
                            style={{
                                position: "absolute",
                                paddingTop: 4,
                                bottom: 14,
                                left: 22,
                                right: 47, // (54 + 9) + 4 extra padding
                                zIndex: 2,
                            }}
                        />
                    )}
                    <div
                        className="absolute flex items-end bottom-4.5 right-5 z-10 h-8 text-xs"
                        style={{ height: textAreaBaseHeight }}>
                        <div className="flex flex-row items-center">
                            <button
                                aria-disabled={sendingDisabled}
                                aria-label="Send message"
                                className={cn(
                                    "input-icon-button codicon codicon-send h-5 w-5 appearance-none border-0 bg-transparent p-0 text-sm text-inherit",
                                    { disabled: sendingDisabled },
                                )}
                                data-testid="send-button"
                                onClick={() => {
                                    const capturedDraft = captureSendDraft(textAreaRef.current?.value ?? inputValue)
                                    if (!sendingDisabled) {
                                        setIsTextAreaFocused(false)
                                        onSend(capturedDraft)
                                    } else {
                                        onSendBlocked?.(capturedDraft)
                                    }
                                }}
                                title={`Send message (${getChatInputSendShortcutLabel(chatInputSendShortcut)})`}
                                type="button"
                            />
                        </div>
                    </div>
                </div>
                <div className="flex items-center -mt-0.5 px-3 pb-2 gap-2">
                    <ButtonGroup className="ease-in-out h-5 z-10 flex items-center min-w-0">
                        <Tooltip>
                            <TooltipContent>Add Context</TooltipContent>
                            <TooltipTrigger asChild>
                                <button
                                    aria-label="Add Context"
                                    className="chat-input-control-outline inline-flex size-[18.5px] shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-foreground shadow-none transition-colors duration-150 hover:bg-toolbar-hover focus-visible:bg-toolbar-hover"
                                    data-testid="context-button"
                                    onClick={handleContextButtonClick}
                                    type="button">
                                    <ButtonContainer>
                                        <AtSignIcon size={12} />
                                    </ButtonContainer>
                                </button>
                            </TooltipTrigger>
                        </Tooltip>

                        <Tooltip>
                            <TooltipContent>Add Files & Images</TooltipContent>
                            <TooltipTrigger asChild>
                                <button
                                    aria-label="Add Files & Images"
                                    className="chat-input-control-outline inline-flex size-[18.5px] shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-foreground shadow-none transition-colors duration-150 hover:bg-toolbar-hover focus-visible:bg-toolbar-hover disabled:cursor-not-allowed disabled:opacity-50"
                                    data-testid="files-button"
                                    disabled={shouldDisableFilesAndImages}
                                    onClick={() => {
                                        if (!shouldDisableFilesAndImages) {
                                            onSelectFilesAndImages()
                                        }
                                    }}
                                    type="button">
                                    <ButtonContainer>
                                        <PlusIcon size={13} />
                                    </ButtonContainer>
                                </button>
                            </TooltipTrigger>
                        </Tooltip>

                        <ServersToggleModal />

                        <ClineRulesToggleModal />

                        <ChatInputRuntimeControls profileControl={<ModelSwitcher onOpenSettings={handleModelButtonClick} />} />

                        <UsageBar />
                    </ButtonGroup>
                    {/* Tooltip for Plan/Act toggle remains outside the conditional rendering */}
                    <div className="ml-auto shrink-0">
                        <ModeSwitchDialog
                            onCancel={modeSwitchFlow.cancelSwitch}
                            onConfirm={modeSwitchFlow.confirmSwitch}
                            onRetry={() => {
                                if (modeSwitch?.targetMode) void modeSwitchFlow.requestSwitch(modeSwitch.targetMode)
                            }}
                            state={modeSwitch ?? { phase: "idle" }}
                        />
                        <Tooltip>
                            <TooltipContent
                                className="text-xs px-2 flex flex-col gap-1"
                                hidden={shownTooltipMode === null}
                                side="top">
                                {`In ${shownTooltipMode === "act" ? "Act" : "Plan"}  mode, Dline will ${shownTooltipMode === "act" ? "complete the task immediately" : "gather information to architect a plan"}`}
                                <p className="text-description/80 text-xs mb-0">
                                    Toggle w/ <kbd className="text-muted-foreground mx-1">{togglePlanActKeys}</kbd>
                                </p>
                            </TooltipContent>
                            <TooltipTrigger>
                                <SwitchContainer
                                    data-testid="mode-switch"
                                    disabled={modeSwitchFlow.isSwitchPending}
                                    onClick={onModeToggle}>
                                    <Slider
                                        isAct={modeSwitchFlow.displayMode === "act"}
                                        isPlan={modeSwitchFlow.displayMode === "plan"}
                                    />
                                    {["Plan", "Act"].map((m) => (
                                        <div
                                            aria-checked={modeSwitchFlow.displayMode === m.toLowerCase()}
                                            className={cn(
                                                "pt-0.5 pb-px px-2 z-10 text-xs w-1/2 text-center bg-transparent",
                                                modeSwitchFlow.displayMode === m.toLowerCase()
                                                    ? "text-white"
                                                    : "text-input-foreground",
                                            )}
                                            key={m}
                                            onMouseLeave={() => setShownTooltipMode(null)}
                                            onMouseOver={() => setShownTooltipMode(m.toLowerCase() === "plan" ? "plan" : "act")}
                                            role="switch">
                                            {modeSwitchFlow.statusText && m.toLowerCase() === modeSwitchFlow.displayMode
                                                ? modeSwitchFlow.statusText
                                                : m}
                                        </div>
                                    ))}
                                </SwitchContainer>
                            </TooltipTrigger>
                        </Tooltip>
                    </div>
                </div>
            </div>
        )
    },
)

export default ChatTextArea
