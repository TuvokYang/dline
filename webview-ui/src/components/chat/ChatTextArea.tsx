import { DEFAULT_CHAT_INPUT_SEND_SHORTCUT } from "@shared/ChatInputSendShortcut"
import type { InputSemanticCatalog } from "@shared/input-semantics/catalog"
import { Mode } from "@shared/storage/types"
import { AtSignIcon, PlusIcon } from "lucide-react"
import type React from "react"
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react"
import styled from "styled-components"
import ContextMenu from "@/components/chat/ContextMenu"
import { CHAT_CONSTANTS } from "@/components/chat/chat-view/constants"
import { ModeSwitchDialog } from "@/components/chat/mode-switch/ModeSwitchDialog"
import type { TransitionDraftComposer } from "@/components/chat/mode-switch/transitionDraft"
import { useModeSwitch } from "@/components/chat/mode-switch/useModeSwitch"
import SlashCommandMenu from "@/components/chat/SlashCommandMenu"
import ModelSwitcher from "@/components/chat/task-header/ModelSwitcher"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { usePlatform } from "@/context/PlatformContext"
import { cn } from "@/lib/utils"
import { composerShortcutLabels, type QueueChord, shouldSendChatInput } from "@/utils/chat-input-shortcut"
import { useMetaKeyDetection, useShortcut } from "@/utils/hooks"
import { isSafari } from "@/utils/platformUtils"
import ClineRulesToggleModal from "../agent-capabilities/ClineRulesToggleModal"
import {
    CHAT_INPUT_LINE_HEIGHT,
    CHAT_INPUT_MAX_HEIGHT_RATIO,
    CHAT_INPUT_MIN_ROWS,
    CHAT_INPUT_PADDING_Y_PX,
} from "./chat-input-height"
import { ChatInputRuntimeControls } from "./input/ChatInputRuntimeControls"
import { ComposerActionButton } from "./input/composer-action/ComposerActionButton"
import type { ComposerSubmitKind } from "./input/composer-action/composer-action"
import { QueueChordTracker } from "./input/queue-chord"
import type { ChipAction } from "./input/semantic-composer/dom"
import { composerHighlights } from "./input/semantic-composer/highlights"
import {
    type ComposerAtom,
    type ComposerSegment,
    contentLength,
    flatTextOf,
    resourceAtomsOf,
    selectionRange,
} from "./input/semantic-composer/model"
import { type ComposerProjection, projectComposerDocument } from "./input/semantic-composer/projection"
import { openResource, retryResource } from "./input/semantic-composer/resource-staging"
import { SemanticComposerEditor, type SemanticComposerEditorHandle } from "./input/semantic-composer/SemanticComposerEditor"
import { type ComposerSendDraft, captureComposerSend, describeSendBlock } from "./input/semantic-composer/send-draft"
import type { ComposerDraft } from "./input/semantic-composer/useComposerDraft"
import { useComposerMenus } from "./input/useComposerMenus"
import { useComposerResourceInput } from "./input/useComposerResourceInput"
import ServersToggleModal from "./ServersToggleModal"
import { UsageBar } from "./UsageBar"

const { MAX_IMAGES_AND_FILES_PER_MESSAGE } = CHAT_CONSTANTS

/**
 * Above this length (~20K characters) the composer stops re-lexing the draft on every keystroke for
 * highlights, so pasting 100KB+ stays responsive. Sending still lexes it once; there is no input limit.
 */
const MAX_HIGHLIGHTED_INPUT_LENGTH = 20_000
/** Highlights only need entity ranges, so their projection does not take the draft's document identity. */
const HIGHLIGHT_DOCUMENT_ID = "composer-highlight"
const TRANSIENT_NOTICE_MS = 3000
/** What a mode switch carries when the draft cannot travel with it; the draft then stays in the composer. */
const EMPTY_SEND_DRAFT: ComposerSendDraft = { segments: [], text: "", images: [], files: [] }

const COMPOSER_PADDING_Y = 2 * CHAT_INPUT_PADDING_Y_PX
const COMPOSER_MIN_HEIGHT = `calc(${CHAT_INPUT_MIN_ROWS} * ${CHAT_INPUT_LINE_HEIGHT} + ${COMPOSER_PADDING_Y}px)`
const COMPOSER_MAX_HEIGHT = `calc(${CHAT_INPUT_MAX_HEIGHT_RATIO} * (${CHAT_INPUT_MIN_ROWS} * ${CHAT_INPUT_LINE_HEIGHT} + ${COMPOSER_PADDING_Y}px))`

const PLAN_MODE_COLOR = "var(--vscode-activityWarningBadge-background)"

type TransientNotice = "rejected_files" | "oversized_images" | "refused_text" | "attachment_limit"

const TRANSIENT_NOTICE_TEXT: Record<TransientNotice, string> = {
    rejected_files: "File too large: PDF up to 50MB, other files up to 20MB",
    oversized_images: "Image dimensions exceed 7500px",
    refused_text: "Text this long is attached as a file, but no attachment can be added here",
    attachment_limit: `A message can carry up to ${MAX_IMAGES_AND_FILES_PER_MESSAGE} attachments; the rest were left out`,
}

interface ChatTextAreaProps {
    /** The draft this composer edits; the chat view owns it. */
    composer: ComposerDraft
    sendingDisabled: boolean
    placeholderText: string
    onSend: (draft: ComposerSendDraft) => void
    /**
     * Hands a draft to the queue: a send made while sending is disabled, or a
     * queue chord. Absent when nothing can take it.
     */
    onSendBlocked?: (draft: ComposerSendDraft) => void
    /** Whether a blocked send will be delivered later, so the action button offers to queue it. */
    queueAvailable?: boolean
    /** Stops the running task; absent while the task offers no cancel. */
    onCancelTask?: () => Promise<void>
    /** What a send does to the task, shown by the action button; `send` when omitted. */
    submitKind?: ComposerSubmitKind
    /** The model's output rate while a response streams, which tints the action button. */
    outputTokensPerSecond?: number
    /** True when the current interaction cannot take attachments at all. */
    attachmentsDisabled: boolean
    /** Whether the active model reads images natively, so the file dialog offers them. */
    imagesAllowed: boolean
    onHeightChange?: (height: number) => void
    onFocusChange?: (isFocused: boolean) => void
    /** The catalog every submission of this view is composed against. */
    semanticCatalog: InputSemanticCatalog
}

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
	background-color: ${(props) => (props.isPlan ? PLAN_MODE_COLOR : "var(--vscode-focusBorder)")};
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

/** A notice that hides itself after a few seconds; showing it again restarts the timer. */
function useTransientNotice(): [TransientNotice | undefined, (notice: TransientNotice) => void, () => void] {
    const [notice, setNotice] = useState<TransientNotice>()
    const timerRef = useRef<ReturnType<typeof setTimeout>>()
    const clear = useCallback(() => {
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = undefined
        setNotice(undefined)
    }, [])
    const show = useCallback((next: TransientNotice) => {
        if (timerRef.current) clearTimeout(timerRef.current)
        setNotice(next)
        timerRef.current = setTimeout(() => {
            timerRef.current = undefined
            setNotice(undefined)
        }, TRANSIENT_NOTICE_MS)
    }, [])
    useEffect(() => () => timerRef.current && clearTimeout(timerRef.current), [])
    return [notice, show, clear]
}

/**
 * The chat composer: a semantic editor whose commands, mentions and attachments
 * are atoms of the draft, plus the controls around it.
 *
 * This component only wires parts together. The draft and its history live in
 * the engine the chat view owns; menus, attachment input and the send snapshot
 * each have their own module, so none of them reads or writes the DOM text.
 */
const ChatTextArea = forwardRef<SemanticComposerEditorHandle, ChatTextAreaProps>(
    (
        {
            composer,
            sendingDisabled,
            placeholderText,
            onSend,
            onSendBlocked,
            queueAvailable = true,
            onCancelTask,
            submitKind,
            outputTokensPerSecond,
            attachmentsDisabled,
            imagesAllowed,
            onHeightChange,
            onFocusChange,
            semanticCatalog,
        },
        ref,
    ) => {
        const { mode, modeSwitch, stateRevision, platform, chatInputSendShortcut, navigateToSettings, currentTaskItem } =
            useExtensionState()
        const { engine, draftId, documentId } = composer
        const segments = composer.state.segments
        const editorRef = useRef<SemanticComposerEditorHandle>(null)
        const handle = useMemo<SemanticComposerEditorHandle>(
            () => ({
                focus: () => editorRef.current?.focus(),
                blur: () => editorRef.current?.blur(),
                get element() {
                    return editorRef.current?.element ?? null
                },
                offsetAtPoint: (x, y) => editorRef.current?.offsetAtPoint(x, y),
                revealCaret: () => editorRef.current?.revealCaret(),
            }),
            [],
        )
        useImperativeHandle(ref, () => handle, [handle])

        const [isFocused, setIsFocused] = useState(false)
        const [isDraggingOver, setIsDraggingOver] = useState(false)
        const [shownTooltipMode, setShownTooltipMode] = useState<Mode | null>(null)
        const [transientNotice, showTransientNotice, clearTransientNotice] = useTransientNotice()
        // The draft owns why its last send was refused, so a refusal reported by
        // another send path (the queue, an interaction option) is explained here too.
        const { sendRefusal, reportSendRefusal } = composer
        const [, metaKeyChar] = useMetaKeyDetection(platform)

        // --- highlights, read from the same projection a send uses ---
        const projectionCacheRef = useRef<{ segments: readonly ComposerSegment[]; projection: ComposerProjection }>()
        const projectionOf = useCallback(
            (next: readonly ComposerSegment[]): ComposerProjection | undefined => {
                if (flatTextOf(next).length > MAX_HIGHLIGHTED_INPUT_LENGTH) return undefined
                const cached = projectionCacheRef.current
                if (cached?.segments === next) return cached.projection
                const projection = projectComposerDocument(next, { catalog: semanticCatalog, documentId: HIGHLIGHT_DOCUMENT_ID })
                projectionCacheRef.current = { segments: next, projection }
                return projection
            },
            [semanticCatalog],
        )
        // A new catalog revision re-reads every entity, so the cache must not outlive it.
        useEffect(() => {
            projectionCacheRef.current = undefined
        }, [semanticCatalog])
        const decorate = useCallback(
            (next: readonly ComposerSegment[]) => composerHighlights(projectionOf(next), semanticCatalog).decorations,
            [projectionOf, semanticCatalog],
        )
        const { heldCandidates } = useMemo(
            () => composerHighlights(projectionOf(segments), semanticCatalog),
            [projectionOf, segments, semanticCatalog],
        )

        // --- attachments ---
        const resourceCount = useMemo(() => resourceAtomsOf(segments).length, [segments])
        const freeSlots = MAX_IMAGES_AND_FILES_PER_MESSAGE - resourceCount
        const attachmentsEnabled = !attachmentsDisabled && freeSlots > 0
        const menus = useComposerMenus({ engine, catalog: semanticCatalog, onPicked: handle.focus })
        const resourceInput = useComposerResourceInput({
            engine,
            draftId,
            catalog: semanticCatalog,
            attachmentsEnabled,
            freeSlots,
            imagesAllowed,
            onRejectedFiles: () => showTransientNotice("rejected_files"),
            onOversizedImages: () => showTransientNotice("oversized_images"),
            onRefusedText: () => showTransientNotice("refused_text"),
            onAttachmentLimit: () => showTransientNotice("attachment_limit"),
        })
        const handleChipAction = useCallback(
            (atom: ComposerAtom, action: ChipAction) => {
                if (atom.kind !== "resource") return
                if (action === "open") void openResource(draftId, atom)
                else if (action === "retry") retryResource(engine, atom.entityId)
            },
            [draftId, engine],
        )

        // --- sending ---
        const trySend = useCallback(() => {
            // Nothing can take a send while sending is disabled and no queue is
            // attached; the draft stays, and the user is told why.
            if (sendingDisabled && !onSendBlocked) {
                if (contentLength(engine.getState().segments) > 0) reportSendRefusal("input_not_ready")
                return
            }
            const capture = captureComposerSend(engine.getState().segments, { catalog: semanticCatalog, documentId })
            if (!capture.ok) {
                reportSendRefusal(capture.block)
                return
            }
            if (sendingDisabled) {
                onSendBlocked?.(capture.draft)
                return
            }
            setIsFocused(false)
            onSend(capture.draft)
        }, [documentId, engine, onSend, onSendBlocked, reportSendRefusal, semanticCatalog, sendingDisabled])

        /**
         * Hand the draft to the queue on purpose, as a queue chord asks, even
         * while the task would take a send now. With nothing running to queue
         * behind, the draft simply goes out, still as plain text if asked.
         */
        const tryQueue = useCallback(
            (chord: QueueChord) => {
                const draftSegments = engine.getState().segments
                if (contentLength(draftSegments) === 0) return
                const capture = captureComposerSend(draftSegments, {
                    catalog: semanticCatalog,
                    documentId,
                    plainText: chord === "queue_plain_text",
                })
                if (!capture.ok) {
                    reportSendRefusal(capture.block)
                    return
                }
                if (onSendBlocked && queueAvailable) {
                    onSendBlocked(capture.draft)
                    return
                }
                if (sendingDisabled) {
                    reportSendRefusal("input_not_ready")
                    return
                }
                setIsFocused(false)
                onSend(capture.draft)
            },
            [documentId, engine, onSend, onSendBlocked, queueAvailable, reportSendRefusal, semanticCatalog, sendingDisabled],
        )
        const queueChord = useMemo(
            () => new QueueChordTracker({ insertText: (text) => engine.apply({ type: "insert_text", text, source: "typed" }) }),
            [engine],
        )

        const handleKeyDown = useCallback(
            (event: React.KeyboardEvent<HTMLDivElement>) => {
                // Safari reports InputEvent.isComposing as false throughout, so keyCode 229 identifies composition there.
                const isComposing = isSafari ? event.nativeEvent.keyCode === 229 : (event.nativeEvent?.isComposing ?? false)
                const chord = queueChord.keyDown(event, isComposing)
                if (chord.kind !== "pass") {
                    event.preventDefault()
                    if (chord.kind === "chord") tryQueue(chord.chord)
                    return
                }
                if (menus.handleKeyDown(event, isComposing)) return
                if (shouldSendChatInput(event, chatInputSendShortcut ?? DEFAULT_CHAT_INPUT_SEND_SHORTCUT, isComposing)) {
                    event.preventDefault()
                    trySend()
                }
            },
            [chatInputSendShortcut, menus, queueChord, tryQueue, trySend],
        )

        // --- mode switch ---
        // A switch carries the whole composed draft, resources included, as their
        // document nodes. A draft still staging a resource cannot be captured and
        // stays in the composer instead of travelling with the switch.
        const modeSwitchDraft = useMemo(() => {
            const capture = captureComposerSend(segments, { catalog: semanticCatalog, documentId })
            return capture.ok ? capture.draft : EMPTY_SEND_DRAFT
        }, [documentId, segments, semanticCatalog])
        // Segments are immutable, so a composer still holding the very segments a
        // switch captured holds that draft unedited; any edit or send replaced them.
        const transitionComposer = useMemo<TransitionDraftComposer<ComposerSendDraft>>(
            () => ({
                holds: (captured) => captured.segments === engine.getState().segments,
                retire: composer.retire,
            }),
            [composer.retire, engine],
        )
        const modeSwitchFlow = useModeSwitch({
            mode,
            stateRevision,
            modeSwitch,
            draft: modeSwitchDraft,
            submitDraftAfterSwitch: currentTaskItem !== undefined,
            onSend: (capturedDraft) => onSend(capturedDraft),
            composer: transitionComposer,
        })
        const onModeToggle = useCallback(() => {
            const targetMode: Mode = mode === "plan" ? "act" : "plan"
            void modeSwitchFlow.requestSwitch(targetMode).finally(() => handle.focus())
        }, [handle, mode, modeSwitchFlow.requestSwitch])
        useShortcut(usePlatform().togglePlanActKeys, onModeToggle, { disableTextInputs: false }) // important that we don't disable the text input here

        /** Start a mention at the caret, as if the user had typed the at-sign there. */
        const handleContextButtonClick = useCallback(() => {
            // Read the caret before focusing: focusing may move the browser's caret before the editor restores it.
            const { start, end } = selectionRange(engine.getState().selection)
            handle.focus()
            const before = flatTextOf(engine.getState().segments)[start - 1]
            const text = before === undefined || /\s/.test(before) ? "@" : " @"
            engine.apply({ type: "insert_text", text, source: "typed", range: { start, end } })
        }, [engine, handle])

        // --- drag and drop ---
        const handleDragLeave = (event: React.DragEvent) => {
            event.preventDefault()
            // Leaving into a child is still inside the drop zone; only a real exit ends the highlight.
            if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) setIsDraggingOver(false)
        }
        const handleDrop = (event: React.DragEvent) => {
            setIsDraggingOver(false)
            clearTransientNotice()
            resourceInput.handleDrop(event, editorRef.current?.offsetAtPoint(event.clientX, event.clientY))
        }
        // A drag that ends outside the composer never sends dragleave here.
        useEffect(() => {
            const handleGlobalDragEnd = () => setIsDraggingOver(false)
            document.addEventListener("dragend", handleGlobalDragEnd)
            return () => document.removeEventListener("dragend", handleGlobalDragEnd)
        }, [])

        // Replace Meta with the platform specific key and uppercase the command letter.
        const togglePlanActKeys = usePlatform()
            .togglePlanActKeys.replace("Meta", metaKeyChar)
            .replace(/.$/, (match) => match.toUpperCase())

        const notice: { testId: string; text: string } | undefined = sendRefusal
            ? { testId: "composer-send-blocked-notice", text: describeSendBlock(sendRefusal) }
            : heldCandidates.length > 0
              ? {
                    testId: "pasted-candidate-notice",
                    text: `Pasted ${heldCandidates.join(", ")} will be sent as plain text. Pick it from the menu to run it.`,
                }
              : undefined

        return (
            <div>
                <div
                    className="relative flex transition-colors ease-in-out duration-100 px-3.5 py-2.5"
                    onDragEnter={(event) => {
                        event.preventDefault()
                        // File names and types are unreliable until the drop, so they are checked there.
                        setIsDraggingOver(true)
                    }}
                    onDragLeave={handleDragLeave}
                    onDragOver={(event) => {
                        event.preventDefault()
                        if (!isDraggingOver) setIsDraggingOver(true)
                    }}
                    onDrop={handleDrop}>
                    {transientNotice && (
                        <div className="absolute inset-2.5 bg-[rgba(var(--vscode-errorForeground-rgb),0.1)] border-2 border-error rounded-xs flex items-center justify-center z-10 pointer-events-none">
                            <span className="text-error font-bold text-xs text-center">
                                {TRANSIENT_NOTICE_TEXT[transientNotice]}
                            </span>
                        </div>
                    )}
                    {menus.slash.open && (
                        <div ref={menus.slash.containerRef}>
                            <SlashCommandMenu
                                entries={[...menus.slash.entries]}
                                onMouseDown={menus.onMenuMouseDown}
                                onSelect={menus.slash.select}
                                selectedIndex={menus.slash.selectedIndex}
                                setSelectedIndex={menus.slash.setSelectedIndex}
                            />
                        </div>
                    )}
                    {menus.mention.open && (
                        <div ref={menus.mention.containerRef}>
                            <ContextMenu
                                dynamicSearchResults={menus.mention.results}
                                isLoading={menus.mention.loading}
                                onMouseDown={menus.onMenuMouseDown}
                                onSelect={menus.mention.select}
                                queryItems={menus.mention.queryItems}
                                searchQuery={menus.mention.searchQuery}
                                selectedIndex={menus.mention.selectedIndex}
                                selectedType={menus.mention.selectedType}
                                setSelectedIndex={menus.mention.setSelectedIndex}
                            />
                        </div>
                    )}
                    <SemanticComposerEditor
                        ariaLabel="Message input"
                        className={cn("rounded-xs bg-input-background", !isFocused && "border border-input-border")}
                        composerId={draftId}
                        decorate={decorate}
                        engine={engine}
                        onBlur={() => {
                            queueChord.flush()
                            menus.onEditorBlur()
                            setIsFocused(false)
                            onFocusChange?.(false)
                        }}
                        onChipAction={handleChipAction}
                        onFocus={() => {
                            setIsFocused(true)
                            onFocusChange?.(true)
                        }}
                        onHeightChange={onHeightChange}
                        onKeyDown={handleKeyDown}
                        onKeyUp={(event) => queueChord.keyUp(event)}
                        onPaste={resourceInput.handlePaste}
                        onPasteText={resourceInput.handlePastedText}
                        placeholder={transientNotice ? "" : placeholderText}
                        ref={editorRef}
                        style={{
                            width: "100%",
                            boxSizing: "border-box",
                            color: "var(--vscode-input-foreground)",
                            fontFamily: "var(--vscode-font-family)",
                            fontSize: "var(--vscode-editor-font-size)",
                            lineHeight: CHAT_INPUT_LINE_HEIGHT,
                            minHeight: COMPOSER_MIN_HEIGHT,
                            maxHeight: COMPOSER_MAX_HEIGHT,
                            overflowX: "hidden",
                            overflowY: "auto",
                            // A visible scrollbar shows that long input continues beyond the visible rows.
                            scrollbarWidth: "thin",
                            scrollbarGutter: "stable",
                            // The standard scrollbar properties bypass the webview's ::-webkit-scrollbar theme,
                            // so the colors must be set here or the track renders as an untinted system gutter.
                            scrollbarColor: "var(--vscode-scrollbarSlider-background) transparent",
                            padding: `${CHAT_INPUT_PADDING_Y_PX}px 28px ${CHAT_INPUT_PADDING_Y_PX}px 9px`,
                            flex: 1,
                            zIndex: 1,
                            outline:
                                isDraggingOver && !transientNotice
                                    ? "2px dashed var(--vscode-focusBorder)"
                                    : isFocused
                                      ? `1px solid ${mode === "plan" ? PLAN_MODE_COLOR : "var(--vscode-focusBorder)"}`
                                      : "none",
                            outlineOffset: isDraggingOver && !transientNotice ? "1px" : "0px",
                        }}
                        testId="chat-input"
                    />
                    {segments.length === 0 && (
                        <div className="text-xs absolute bottom-5 left-6.5 right-16 text-(--vscode-input-placeholderForeground)/50 whitespace-nowrap overflow-hidden text-ellipsis pointer-events-none z-1">
                            Type @ for context, / for slash commands & workflows, hold shift to drag in files/images
                        </div>
                    )}
                    {notice && (
                        <div
                            aria-live="polite"
                            className="text-xs absolute -top-5 left-4 right-4 truncate text-(--vscode-editorWarning-foreground) z-1"
                            data-testid={notice.testId}
                            role="status">
                            {notice.text}
                        </div>
                    )}
                    <div
                        className="absolute flex items-end bottom-[13px] right-4 z-10 text-xs"
                        style={{ height: COMPOSER_MIN_HEIGHT }}>
                        <ComposerActionButton
                            onCancel={onCancelTask}
                            onSend={trySend}
                            outputTokensPerSecond={outputTokensPerSecond}
                            shortcuts={composerShortcutLabels(chatInputSendShortcut)}
                            state={{
                                canSend: !sendingDisabled,
                                submitKind,
                                canQueue: Boolean(onSendBlocked) && queueAvailable,
                                canCancel: Boolean(onCancelTask),
                                hasContent: segments.length > 0,
                            }}
                        />
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
                                    // Keep the editor's caret: a button that takes focus first would move it.
                                    onMouseDown={(event) => event.preventDefault()}
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
                                    disabled={!attachmentsEnabled}
                                    onClick={resourceInput.selectResources}
                                    type="button">
                                    <ButtonContainer>
                                        <PlusIcon size={13} />
                                    </ButtonContainer>
                                </button>
                            </TooltipTrigger>
                        </Tooltip>

                        <ServersToggleModal />

                        <ClineRulesToggleModal />

                        <ChatInputRuntimeControls
                            profileControl={
                                <ModelSwitcher
                                    draft={modeSwitchDraft}
                                    draftComposer={transitionComposer}
                                    onOpenSettings={() => navigateToSettings("api-config")}
                                />
                            }
                        />

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
