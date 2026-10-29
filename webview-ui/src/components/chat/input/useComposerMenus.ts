import { DEFAULT_CHAT_INPUT_SEND_SHORTCUT } from "@shared/ChatInputSendShortcut"
import type { InputSemanticCatalog } from "@shared/input-semantics/catalog"
import type { SemanticTrigger } from "@shared/input-semantics/lexer"
import { EmptyRequest, StringRequest } from "@shared/proto/dline/common"
import { FileSearchRequest, FileSearchType, type RefreshedDlineToggles } from "@shared/proto/dline/file"
import type { SlashCommand } from "@shared/slashCommands"
import type React from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useTaskCapabilityToggles } from "@/hooks/useTaskCapabilityToggles"
import { FileServiceClient, SlashServiceClient } from "@/services/grpc-client"
import { shouldCompleteMenuSelection } from "@/utils/chat-input-shortcut"
import {
    ContextMenuOptionType,
    getContextMenuOptionIndex,
    getContextMenuOptions,
    type SearchResult,
} from "@/utils/context-mentions"
import {
    getAvailableSlashCommands,
    getMatchingSlashCommands,
    type SlashCommandSources,
    type SlashMenuEntry,
} from "@/utils/slash-commands"
import { createCommandAtom, createMentionAtom } from "./semantic-composer/atoms"
import type { SemanticComposerEngine } from "./semantic-composer/engine"
import { type ComposerAtom, isCollapsed, selectionRange } from "./semantic-composer/model"
import { composerTriggerAt } from "./semantic-composer/projection"
import { useComposerState } from "./semantic-composer/useComposerState"

/** The "File" row is preselected when the mention menu opens without a query. */
const DEFAULT_CONTEXT_MENU_OPTION = getContextMenuOptionIndex(ContextMenuOptionType.File)
const FILE_SEARCH_DEBOUNCE_MS = 200

interface GitCommit {
    type: ContextMenuOptionType.Git
    value: string
    label: string
    description: string
}

/** Where the open menu was triggered; it stays open only while the caret still completes that trigger. */
interface MenuAnchor {
    readonly kind: SemanticTrigger["kind"]
    readonly start: number
}

export interface ComposerMenusOptions {
    readonly engine: SemanticComposerEngine
    readonly catalog: InputSemanticCatalog
    /** Called after a pick was written, so the host can return focus to the editor. */
    readonly onPicked?: () => void
}

export interface ComposerMenus {
    readonly slash: {
        readonly open: boolean
        readonly entries: readonly SlashMenuEntry[]
        readonly selectedIndex: number
        readonly setSelectedIndex: (index: number) => void
        readonly select: (entry: SlashMenuEntry) => void
        readonly containerRef: React.RefObject<HTMLDivElement>
    }
    readonly mention: {
        readonly open: boolean
        readonly searchQuery: string
        readonly selectedType: ContextMenuOptionType | null
        readonly selectedIndex: number
        readonly setSelectedIndex: (index: number) => void
        readonly results: SearchResult[]
        readonly loading: boolean
        readonly queryItems: { type: ContextMenuOptionType; value: string; label?: string; description?: string }[]
        readonly select: (type: ContextMenuOptionType, value?: string) => void
        readonly containerRef: React.RefObject<HTMLDivElement>
    }
    /** Handle a key while a menu is open; returns true when the menu consumed it. */
    readonly handleKeyDown: (event: React.KeyboardEvent, isComposing: boolean) => boolean
    /** Record that a menu is being clicked, so the editor's blur does not close it. */
    readonly onMenuMouseDown: () => void
    /**
     * Close menus when focus leaves the editor, unless the blur came from
     * clicking a menu or only the editor's window or frame lost focus.
     */
    readonly onEditorBlur: (event: React.FocusEvent<HTMLElement>) => void
    readonly close: () => void
}

/** Assemble the slash command sources the menu lists, honoring task-scoped capability toggles. */
function useSlashCommandSources(workflowDescriptions: Record<string, string>, availableSkillCommands?: SlashCommand[]) {
    const state = useExtensionState()
    const { snapshot } = useTaskCapabilityToggles()
    const mcpServers = useMemo(
        () => (snapshot ? state.mcpServers.filter((server) => snapshot.mcpServers[server.name] === true) : state.mcpServers),
        [state.mcpServers, snapshot],
    )
    return useMemo<SlashCommandSources>(
        () => ({
            localWorkflowToggles: snapshot?.localWorkflowToggles ?? state.localWorkflowToggles,
            globalWorkflowToggles: snapshot?.globalWorkflowToggles ?? state.globalWorkflowToggles,
            remoteWorkflowToggles: snapshot?.remoteWorkflowToggles ?? state.remoteWorkflowToggles,
            remoteWorkflows: state.remoteConfigSettings?.remoteGlobalWorkflows,
            mcpServers,
            localSkillsToggles: snapshot?.localSkillsToggles ?? state.localSkillsToggles,
            globalSkillsToggles: snapshot?.globalSkillsToggles ?? state.globalSkillsToggles,
            remoteSkills: state.remoteConfigSettings?.remoteGlobalSkills,
            remoteSkillsToggles: snapshot?.remoteSkillsToggles ?? state.remoteSkillsToggles,
            workflowDescriptions,
            availableSkillCommands,
        }),
        [
            snapshot,
            state.localWorkflowToggles,
            state.globalWorkflowToggles,
            state.remoteWorkflowToggles,
            state.remoteConfigSettings?.remoteGlobalWorkflows,
            state.remoteConfigSettings?.remoteGlobalSkills,
            state.localSkillsToggles,
            state.globalSkillsToggles,
            state.remoteSkillsToggles,
            mcpServers,
            workflowDescriptions,
            availableSkillCommands,
        ],
    )
}

/**
 * Whether a blur only took focus away from the editor's window or frame.
 *
 * Another window or the hosting frame taking focus blurs the editor while it
 * stays its document's focused element, and returning puts the caret back
 * where it was. A move to anything inside the document has a related target or
 * leaves the body focused instead.
 */
function isFrameFocusLoss(event: React.FocusEvent<HTMLElement>): boolean {
    return event.relatedTarget === null && event.currentTarget.ownerDocument.activeElement === event.currentTarget
}

/** Close a menu when the user clicks anywhere outside it. */
function useCloseOnOutsideClick(open: boolean, containerRef: React.RefObject<HTMLDivElement>, close: () => void) {
    useEffect(() => {
        if (!open) return
        const onMouseDown = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) close()
        }
        document.addEventListener("mousedown", onMouseDown)
        return () => document.removeEventListener("mousedown", onMouseDown)
    }, [close, containerRef, open])
}

/**
 * The slash command and mention menus of the semantic composer.
 *
 * A menu opens when an edit leaves the caret completing a trigger, and stays
 * open while the caret still completes that same trigger. A pick replaces the
 * trigger text with an atom built from the catalog; a pick the catalog cannot
 * read back as the chosen entity writes nothing and keeps the menu open, so it
 * is never lost silently.
 */
export function useComposerMenus({ engine, catalog, onPicked }: ComposerMenusOptions): ComposerMenus {
    const {
        chatInputSendShortcut,
        setLocalWorkflowToggles,
        setGlobalWorkflowToggles,
        setLocalSkillsToggles,
        setGlobalSkillsToggles,
    } = useExtensionState()
    const { reconcile: reconcileCapabilityToggles } = useTaskCapabilityToggles()
    const { segments, selection } = useComposerState(engine)

    const caret = selectionRange(selection).end
    const trigger = useMemo(
        () => (isCollapsed(selection) ? composerTriggerAt(segments, caret) : undefined),
        [caret, segments, selection],
    )
    const [anchor, setAnchor] = useState<MenuAnchor>()
    // Only an edit opens a menu; moving the caret alone never does.
    const lastSegmentsRef = useRef(segments)
    useEffect(() => {
        if (lastSegmentsRef.current === segments) return
        lastSegmentsRef.current = segments
        setAnchor(trigger ? { kind: trigger.kind, start: trigger.start } : undefined)
    }, [segments, trigger])
    const activeTrigger =
        trigger && anchor && trigger.kind === anchor.kind && trigger.start === anchor.start ? trigger : undefined
    const slashOpen = activeTrigger?.kind === "command"
    const mentionOpen = activeTrigger?.kind === "mention"
    const query = activeTrigger?.query ?? ""

    const close = useCallback(() => setAnchor(undefined), [])
    const menuMouseDownRef = useRef(false)
    const onMenuMouseDown = useCallback(() => {
        menuMouseDownRef.current = true
    }, [])
    const onEditorBlur = useCallback((event: React.FocusEvent<HTMLElement>) => {
        if (menuMouseDownRef.current) {
            menuMouseDownRef.current = false
            return
        }
        // The caret still completes the trigger once focus comes back, so the open menu stays.
        if (isFrameFocusLoss(event)) return
        setAnchor(undefined)
    }, [])

    // --- slash menu ---
    const [workflowDescriptions, setWorkflowDescriptions] = useState<Record<string, string>>({})
    const [availableSkillCommands, setAvailableSkillCommands] = useState<SlashCommand[]>()
    const slashSources = useSlashCommandSources(workflowDescriptions, availableSkillCommands)
    const slashEntries = useMemo(
        () => getMatchingSlashCommands(slashOpen ? query : "", getAvailableSlashCommands(slashSources, catalog)),
        [catalog, query, slashOpen, slashSources],
    )
    const [slashIndex, setSlashIndex] = useState(0)
    const slashContainerRef = useRef<HTMLDivElement>(null)
    useEffect(() => setSlashIndex(0), [query, slashOpen])
    // The list can shrink without typing, e.g. when a capability is withdrawn; keep the selection on a row.
    useEffect(() => {
        if (slashIndex >= slashEntries.length) setSlashIndex(Math.max(0, slashEntries.length - 1))
    }, [slashEntries.length, slashIndex])

    const refreshSlashCommandMetadata = useCallback(async () => {
        const response = await SlashServiceClient.getAvailableSlashCommands(EmptyRequest.create({}))
        const descriptions: Record<string, string> = {}
        const skills: SlashCommand[] = []
        for (const command of response.commands) {
            if (command.section === "workflow" && command.description) descriptions[command.name] = command.description
            else if (command.section === "skill")
                skills.push({ name: command.name, description: command.description || undefined, section: "skill" })
        }
        setWorkflowDescriptions(descriptions)
        setAvailableSkillCommands(skills)
    }, [])
    useEffect(() => {
        void refreshSlashCommandMetadata().catch(() => {})
    }, [refreshSlashCommandMetadata])

    // Rediscover workflows and skills whenever the menu opens, so newly added files are pickable at once.
    useEffect(() => {
        if (!slashOpen) return
        FileServiceClient.refreshRules({} as EmptyRequest)
            .then(async (response: RefreshedDlineToggles) => {
                void reconcileCapabilityToggles({
                    ...(response.localWorkflowToggles?.toggles && {
                        localWorkflowToggles: response.localWorkflowToggles.toggles,
                    }),
                    ...(response.globalWorkflowToggles?.toggles && {
                        globalWorkflowToggles: response.globalWorkflowToggles.toggles,
                    }),
                    ...(response.localSkillsToggles?.toggles && { localSkillsToggles: response.localSkillsToggles.toggles }),
                    ...(response.globalSkillsToggles?.toggles && { globalSkillsToggles: response.globalSkillsToggles.toggles }),
                })
                if (response.localWorkflowToggles?.toggles) setLocalWorkflowToggles(response.localWorkflowToggles.toggles)
                if (response.globalWorkflowToggles?.toggles) setGlobalWorkflowToggles(response.globalWorkflowToggles.toggles)
                if (response.localSkillsToggles?.toggles) setLocalSkillsToggles(response.localSkillsToggles.toggles)
                if (response.globalSkillsToggles?.toggles) setGlobalSkillsToggles(response.globalSkillsToggles.toggles)
                // Rediscovery publishes a new catalog revision when capabilities changed.
                await Promise.all([
                    refreshSlashCommandMetadata(),
                    SlashServiceClient.getInputSemanticCatalog(EmptyRequest.create({})),
                ])
            })
            .catch(() => {})
    }, [
        slashOpen,
        reconcileCapabilityToggles,
        refreshSlashCommandMetadata,
        setGlobalSkillsToggles,
        setGlobalWorkflowToggles,
        setLocalSkillsToggles,
        setLocalWorkflowToggles,
    ])

    /** Replace the trigger text with the picked atom; false when nothing was written. */
    const writePick = useCallback(
        (atom: ComposerAtom | undefined): boolean => {
            if (!atom || !activeTrigger) {
                console.warn("[composer] menu pick refused: the catalog does not resolve it")
                return false
            }
            engine.apply({ type: "insert_atom", atom, range: { start: activeTrigger.start, end: caret } })
            setAnchor(undefined)
            onPicked?.()
            return true
        },
        [activeTrigger, caret, engine, onPicked],
    )

    const selectSlash = useCallback(
        (entry: SlashMenuEntry) => {
            writePick(createCommandAtom(catalog, entry.commandId, entry.trigger))
        },
        [catalog, writePick],
    )

    // --- mention menu ---
    const [selectedType, setSelectedType] = useState<ContextMenuOptionType | null>(null)
    const [mentionIndex, setMentionIndex] = useState(-1)
    const [fileResults, setFileResults] = useState<SearchResult[]>([])
    const [searchLoading, setSearchLoading] = useState(false)
    const [gitCommits, setGitCommits] = useState<GitCommit[]>([])
    const mentionContainerRef = useRef<HTMLDivElement>(null)
    // Every search bumps the token; a response for an older token is stale and dropped.
    const searchTokenRef = useRef(0)
    useEffect(() => {
        if (!mentionOpen) setSelectedType(null)
    }, [mentionOpen])

    const searchFiles = useCallback((searchQuery: string, type: ContextMenuOptionType | null, workspaceHint?: string) => {
        const token = ++searchTokenRef.current
        const selectedSearchType =
            type === ContextMenuOptionType.File
                ? FileSearchType.FILE
                : type === ContextMenuOptionType.Folder
                  ? FileSearchType.FOLDER
                  : undefined
        setSearchLoading(true)
        FileServiceClient.searchFiles(
            FileSearchRequest.create({
                query: searchQuery,
                mentionsRequestId: String(token),
                selectedType: selectedSearchType,
                workspaceHint,
            }),
        )
            .then((results) => {
                if (token !== searchTokenRef.current) return
                setFileResults((results.results || []) as SearchResult[])
                setSearchLoading(false)
            })
            .catch((error) => {
                if (token !== searchTokenRef.current) return
                console.error("Error searching files:", error)
                setFileResults([])
                setSearchLoading(false)
            })
    }, [])

    useEffect(() => {
        if (!mentionOpen) {
            setMentionIndex(-1)
            setFileResults([])
            return
        }
        if (query.length === 0) {
            setMentionIndex(DEFAULT_CONTEXT_MENU_OPTION)
            return
        }
        setMentionIndex(0)
        // A query such as "frontend:/name" searches one workspace of a multi-root window.
        const hinted = /^([\w-]+):\/(.*)$/.exec(query)
        const timer = setTimeout(
            () => searchFiles(hinted ? hinted[2] : query, selectedType, hinted?.[1]),
            FILE_SEARCH_DEBOUNCE_MS,
        )
        return () => clearTimeout(timer)
    }, [mentionOpen, query, searchFiles, selectedType])

    useEffect(() => {
        if (selectedType !== ContextMenuOptionType.Git && !/^[a-f0-9]+$/i.test(query)) return
        FileServiceClient.searchCommits(StringRequest.create({ value: query }))
            .then((response) => {
                setGitCommits(
                    (response.commits ?? []).map((commit) => ({
                        type: ContextMenuOptionType.Git,
                        value: commit.hash,
                        label: commit.subject,
                        description: `${commit.shortHash} by ${commit.author} on ${commit.date}`,
                    })),
                )
            })
            .catch((error) => console.error("Error searching commits:", error))
    }, [query, selectedType])

    const queryItems = useMemo(
        () => [
            { type: ContextMenuOptionType.Problems, value: "problems" },
            { type: ContextMenuOptionType.Terminal, value: "terminal" },
            ...gitCommits,
        ],
        [gitCommits],
    )

    const selectMention = useCallback(
        (type: ContextMenuOptionType, value?: string) => {
            if (type === ContextMenuOptionType.NoResults) return
            const narrowsSearch =
                type === ContextMenuOptionType.File || type === ContextMenuOptionType.Folder || type === ContextMenuOptionType.Git
            if (narrowsSearch && !value) {
                // Choosing a category lists its entries instead of writing anything.
                setSelectedType(type)
                setMentionIndex(0)
                if (type !== ContextMenuOptionType.Git) searchFiles("", type)
                return
            }
            const reference =
                type === ContextMenuOptionType.Problems
                    ? "problems"
                    : type === ContextMenuOptionType.Terminal
                      ? "terminal"
                      : (value ?? "")
            if (writePick(createMentionAtom(catalog, reference))) setSelectedType(null)
        },
        [catalog, searchFiles, writePick],
    )

    const mentionOptions = useCallback(
        () => getContextMenuOptions(query, selectedType, queryItems, fileResults),
        [fileResults, query, queryItems, selectedType],
    )

    const handleKeyDown = useCallback(
        (event: React.KeyboardEvent, isComposing: boolean): boolean => {
            const shortcut = chatInputSendShortcut ?? DEFAULT_CHAT_INPUT_SEND_SHORTCUT
            if (slashOpen) {
                if (event.key === "Escape") {
                    setAnchor(undefined)
                    return true
                }
                if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                    event.preventDefault()
                    const count = slashEntries.length
                    if (count > 0) {
                        const direction = event.key === "ArrowUp" ? -1 : 1
                        setSlashIndex((index) => (Math.min(index, count - 1) + direction + count) % count)
                    }
                    return true
                }
                if (shouldCompleteMenuSelection(event, shortcut, isComposing) && slashIndex !== -1) {
                    event.preventDefault()
                    const entry = slashEntries[slashIndex]
                    if (entry) selectSlash(entry)
                    return true
                }
            }
            if (mentionOpen) {
                if (event.key === "Escape") {
                    setAnchor(undefined)
                    setSelectedType(null)
                    return true
                }
                if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                    event.preventDefault()
                    const options = mentionOptions()
                    const selectable = options.filter(
                        (option) => option.type !== ContextMenuOptionType.URL && option.type !== ContextMenuOptionType.NoResults,
                    )
                    if (selectable.length === 0) {
                        setMentionIndex(-1)
                        return true
                    }
                    const direction = event.key === "ArrowUp" ? -1 : 1
                    setMentionIndex((index) => {
                        const current = selectable.indexOf(options[index])
                        return options.indexOf(selectable[(current + direction + selectable.length) % selectable.length])
                    })
                    return true
                }
                if (shouldCompleteMenuSelection(event, shortcut, isComposing) && mentionIndex !== -1) {
                    event.preventDefault()
                    const option = mentionOptions()[mentionIndex]
                    if (option && option.type !== ContextMenuOptionType.URL && option.type !== ContextMenuOptionType.NoResults) {
                        // A label with a workspace prefix names the file unambiguously in a multi-root window.
                        selectMention(option.type, option.label?.includes(":") ? option.label : option.value)
                    }
                    return true
                }
            }
            return false
        },
        [
            chatInputSendShortcut,
            mentionIndex,
            mentionOpen,
            mentionOptions,
            selectMention,
            selectSlash,
            slashEntries,
            slashIndex,
            slashOpen,
        ],
    )

    useCloseOnOutsideClick(slashOpen, slashContainerRef, close)
    useCloseOnOutsideClick(mentionOpen, mentionContainerRef, close)

    return {
        slash: {
            open: slashOpen,
            entries: slashEntries,
            selectedIndex: slashIndex,
            setSelectedIndex: setSlashIndex,
            select: selectSlash,
            containerRef: slashContainerRef,
        },
        mention: {
            open: mentionOpen,
            searchQuery: query,
            selectedType,
            selectedIndex: mentionIndex,
            setSelectedIndex: setMentionIndex,
            results: fileResults,
            loading: searchLoading,
            queryItems,
            select: selectMention,
            containerRef: mentionContainerRef,
        },
        handleKeyDown,
        onMenuMouseDown,
        onEditorBlur,
        close,
    }
}
