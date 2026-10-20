import { BROWSER_VIEWPORT_PRESETS } from "@shared/BrowserSettings"
import { BrowserAction, UiMessage } from "@shared/ExtensionMessage"
import { StringRequest } from "@shared/proto/dline/common"
import deepEqual from "fast-deep-equal"
import { ChevronDownIcon, ChevronRightIcon, GlobeIcon } from "lucide-react"
import React, { CSSProperties, memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useSize } from "react-use"
import styled from "styled-components"
import { BrowserSettingsMenu } from "@/components/browser/BrowserSettingsMenu"
import { ChatRowContent, ProgressIndicator } from "@/components/chat/ChatRow"
import { CheckpointMarker } from "@/components/chat/chat-view/components/messages/CheckpointMarker"
import type { BrowserSessionEnd } from "@/components/chat/chat-view/utils/chatRowKinds"
import { resolveMessageRowExpanded } from "@/components/chat/chat-view/utils/messageUtils"
import { TOOL_RESPONSE_MAX_HEIGHT, TOOL_RESPONSE_SCROLL_CLASS } from "@/components/chat/constants"
import { ThinkingRow } from "@/components/chat/ThinkingRow"
import CodeBlock, { CODE_BLOCK_BG_COLOR } from "@/components/common/CodeBlock"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { FileServiceClient } from "@/services/grpc-client"
import { BrowserActionIcon } from "./browser-session/BrowserActionIcon"
import { BrowserSessionToolbar } from "./browser-session/BrowserSessionToolbar"
import {
    BROWSER_SESSION_PHASE_LABELS,
    browserSessionAnchor,
    describeBrowserAction,
    headCheckpoint,
    projectBrowserSession,
    resolveBrowserSessionPhase,
    summarizeBrowserSession,
    unfoldableCheckpoints,
} from "./browser-session/browser-session-model"

interface BrowserSessionRowProps {
    messages: UiMessage[]
    /** How the session stopped taking messages; a session the transcript still ends in is open. */
    end?: BrowserSessionEnd
    expandedRows: Record<number, boolean>
    onToggleExpand: (messageTs: number) => void
    lastModifiedMessage?: UiMessage
    isLast: boolean
    onHeightChange: (isTaller: boolean) => void
    onSetQuote: (text: string) => void
}

const browserSessionRowContainerInnerStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    marginBottom: "10px",
}
const browserIconStyle: CSSProperties = {
    color: "var(--vscode-foreground)",
    marginBottom: "-1.5px",
}
const approveTextStyle: CSSProperties = { fontWeight: "bold" }
/** The card surface shared by the open frame and the folded card. */
const browserFrameStyle: CSSProperties = {
    borderRadius: 3,
    border: "1px solid var(--vscode-editorGroup-border)",
    backgroundColor: CODE_BLOCK_BG_COLOR,
    margin: "0 auto 10px auto",
}
const urlBarContainerStyle: CSSProperties = {
    margin: "5px auto",
    width: "calc(100% - 10px)",
    display: "flex",
    alignItems: "center",
    gap: "4px",
}
const imgScreenshotStyle: CSSProperties = {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    objectFit: "contain",
    cursor: "pointer",
}
const noScreenshotContainerStyle: CSSProperties = {
    position: "absolute",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
}
const noScreenshotIconStyle: CSSProperties = {
    fontSize: "80px",
    color: "var(--vscode-descriptionForeground)",
}
const consoleLogsContainerStyle: CSSProperties = { width: "100%" }
const consoleLogsTextStyle: CSSProperties = { fontSize: "0.8em" }
const browserActionBoxContainerStyle: CSSProperties = { padding: "10px 0 0 0" }
const browserActionBoxContainerInnerStyle: CSSProperties = {
    borderRadius: 3,
    backgroundColor: CODE_BLOCK_BG_COLOR,
    overflow: "hidden",
    border: "1px solid var(--vscode-editorGroup-border)",
}
const browseActionRowContainerStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    padding: "9px 10px",
}
const browseActionRowStyle: CSSProperties = {
    whiteSpace: "normal",
    wordBreak: "break-word",
}
const browseActionTextStyle: CSSProperties = { fontWeight: 500 }
const chatRowContentContainerStyle: CSSProperties = { padding: "10px 0 10px 0" }

/**
 * One row for a browser session.
 *
 * The restore point taken before the session heads the card, then a header
 * that reports what the session is doing. Open, the card shows the screenshot
 * frame; a toggle at the bottom of the frame lists every round in order — its
 * restore point, its thinking and the browser call, which opens that round's
 * page — the way an exploration run lists its rounds. Folded, only the header
 * and the page URL remain.
 *
 * Rounds fold into the card because browser calls change no workspace files.
 * A restore point that brings back different files or is checked out, and a
 * failure notice, stay visible whatever is folded.
 */
const BrowserSessionRow = memo((props: BrowserSessionRowProps) => {
    const {
        messages,
        end = "open",
        isLast,
        onHeightChange,
        lastModifiedMessage,
        onSetQuote,
        expandedRows,
        onToggleExpand,
    } = props
    const { browserSettings } = useExtensionState()
    const prevHeightRef = useRef(0)
    const [consoleLogsExpanded, setConsoleLogsExpanded] = useState(false)
    const projection = useMemo(() => projectBrowserSession(messages), [messages])
    const { hasBrowserResult, initialUrl, pages, steps } = projection
    const phase = resolveBrowserSessionPhase({ end, isLast, projection, messages, lastModifiedMessage })
    const isBrowsing = phase === "running" && hasBrowserResult
    const anchor = browserSessionAnchor(messages)
    // The chat list keeps one expansion flag per message, set by the reader's
    // first toggle. A session card starts open, so its anchor's flag records
    // that the reader folded it.
    const isFolded = resolveMessageRowExpanded(anchor, expandedRows)
    // Round details are a reading aid, like console logs; they need not survive a remount.
    const [stepsVisible, setStepsVisible] = useState(false)
    const head = useMemo(() => headCheckpoint(steps), [steps])
    const unfoldable = useMemo(() => unfoldableCheckpoints(steps), [steps])
    const notices = useMemo(() => steps.flatMap((step) => step.notices), [steps])
    const summary = useMemo(() => summarizeBrowserSession(steps), [steps])
    const stepsId = `browser-session-${anchor?.ts ?? "empty"}-steps`

    const [currentPageIndex, setCurrentPageIndex] = useState(() => Math.max(0, pages.length - 1))
    const [followLatest, setFollowLatest] = useState(true)
    useEffect(() => {
        const lastPageIndex = Math.max(0, pages.length - 1)
        setCurrentPageIndex((index) => (followLatest ? lastPageIndex : Math.min(index, lastPageIndex)))
    }, [followLatest, pages.length])

    const showPreviousPage = useCallback(() => {
        setFollowLatest(false)
        setCurrentPageIndex((index) => Math.max(0, index - 1))
    }, [])
    const showNextPage = useCallback(() => {
        setCurrentPageIndex((index) => {
            const lastPageIndex = Math.max(0, pages.length - 1)
            const nextIndex = Math.min(lastPageIndex, index + 1)
            if (nextIndex === lastPageIndex) setFollowLatest(true)
            return nextIndex
        })
    }, [pages.length])
    const showPage = useCallback(
        (pageIndex: number) => {
            const lastPageIndex = Math.max(0, pages.length - 1)
            setFollowLatest(pageIndex >= lastPageIndex)
            setCurrentPageIndex(Math.min(pageIndex, lastPageIndex))
        },
        [pages.length],
    )

    // Find the latest available URL and screenshot
    const latestState = useMemo(() => {
        for (let i = pages.length - 1; i >= 0; i--) {
            const page = pages[i]
            if (page.state.url || page.state.screenshot) {
                return page.state
            }
        }
        return {
            url: undefined,
            mousePosition: undefined,
            consoleLogs: undefined,
            screenshot: undefined,
        }
    }, [pages])

    const currentPage = pages[currentPageIndex]
    const isLastPage = currentPageIndex === pages.length - 1

    const defaultMousePosition = `${browserSettings.viewport.width * 0.7},${browserSettings.viewport.height * 0.5}`

    // Use latest state if we're on the last page and don't have a state yet
    const displayState = isLastPage
        ? {
              url: currentPage?.state.url || latestState.url || initialUrl,
              mousePosition: currentPage?.state.mousePosition || latestState.mousePosition || defaultMousePosition,
              consoleLogs: currentPage?.state.consoleLogs,
              screenshot: currentPage?.state.screenshot || latestState.screenshot,
          }
        : {
              url: currentPage?.state.url || initialUrl,
              mousePosition: currentPage?.state.mousePosition || defaultMousePosition,
              consoleLogs: currentPage?.state.consoleLogs,
              screenshot: currentPage?.state.screenshot,
          }

    const latestClickPosition = useMemo(() => {
        if (!isBrowsing) return undefined
        return [...(currentPage?.actions ?? [])].reverse().find((action) => action.action === "click" && action.coordinate)
            ?.coordinate
    }, [currentPage?.actions, isBrowsing])

    // Use latest click position while browsing, otherwise use display state
    const mousePosition = isBrowsing ? latestClickPosition || displayState.mousePosition : displayState.mousePosition

    const renderNotice = (message: UiMessage) => (
        <div key={message.ts} style={chatRowContentContainerStyle}>
            <ChatRowContent
                isExpanded={expandedRows[message.ts] ?? false}
                isLast={isLast}
                lastModifiedMessage={lastModifiedMessage}
                message={message}
                onSetQuote={onSetQuote}
                onToggleExpand={() => onToggleExpand(message.ts)}
            />
        </div>
    )

    const urlBox = (
        <div
            className={cn(
                "flex bg-input-background border border-input-border rounded-sm px-1 py-0.5 min-w-0 text-description w-full justify-center",
                {
                    "text-input-foreground": !!displayState.url,
                },
            )}
            data-testid="browser-session-url">
            <span className="text-xs text-ellipsis overflow-hidden whitespace-nowrap">{displayState.url || "http"}</span>
        </div>
    )
    // Rows a reader must still find while the rounds are folded.
    const showLooseRows = isFolded || !stepsVisible

    const header = (
        <button
            aria-expanded={!isFolded}
            className="flex w-full min-w-0 border-0 bg-transparent p-0 text-left text-foreground cursor-pointer"
            data-testid="browser-session-header"
            onClick={() => anchor && onToggleExpand(anchor.ts)}
            style={isFolded ? { ...browserSessionRowContainerInnerStyle, marginBottom: 0 } : browserSessionRowContainerInnerStyle}
            type="button">
            {isBrowsing ? <ProgressIndicator /> : <span className="codicon codicon-inspect" style={browserIconStyle} />}
            <span className="shrink-0" style={approveTextStyle}>
                {BROWSER_SESSION_PHASE_LABELS[phase]}
            </span>
            {isFolded && summary && <span className="min-w-0 truncate text-description">{summary}</span>}
            {isFolded ? <ChevronRightIcon className="!size-3 shrink-0" /> : <ChevronDownIcon className="!size-3 shrink-0" />}
        </button>
    )
    const stepsToggle =
        steps.length > 0 ? (
            <button
                aria-controls={stepsId}
                aria-expanded={stepsVisible}
                className="flex w-full min-w-0 items-center gap-1 border-0 bg-transparent px-2 py-1.5 text-left text-foreground cursor-pointer"
                data-testid="browser-session-steps-toggle"
                onClick={() => setStepsVisible((visible) => !visible)}
                type="button">
                {stepsVisible ? <ChevronDownIcon size={16} /> : <ChevronRightIcon size={16} />}
                <span className="truncate" style={consoleLogsTextStyle}>
                    {summary || "Steps"}
                </span>
            </button>
        ) : undefined

    // Calculate maxWidth
    const maxWidth = browserSettings.viewport.width < BROWSER_VIEWPORT_PRESETS["Small Desktop (900x600)"].width ? 200 : undefined

    const [browserSessionRow, { height }] = useSize(
        // We don't declare a constant for the inline style here because `useSize` will try to modify the style object
        // Which will cause `Uncaught TypeError: Cannot assign to read only property 'position' of object '#<Object>'`
        <BrowserSessionRowContainer data-testid="browser-session" style={{ marginBottom: -10 }}>
            {head && (
                <div className="mb-2" data-testid="browser-session-head-checkpoint">
                    <CheckpointMarker message={head} />
                </div>
            )}
            {isFolded ? (
                <div data-testid="browser-session-folded" style={{ ...browserFrameStyle, maxWidth, padding: "8px 10px" }}>
                    {header}
                    <div
                        className="flex min-w-0 items-center gap-1.5 pt-1.5 text-foreground"
                        data-testid="browser-session-url-line">
                        <GlobeIcon aria-hidden className="size-3.5 shrink-0" />
                        <span className="min-w-0 truncate text-xs">{displayState.url || initialUrl}</span>
                    </div>
                </div>
            ) : (
                header
            )}
            {!isFolded && (
                <div
                    data-testid="browser-session-frame"
                    style={{
                        ...browserFrameStyle,
                        maxHeight: TOOL_RESPONSE_MAX_HEIGHT,
                        overflowY: "auto",
                        overscrollBehavior: "contain",
                        maxWidth,
                    }}>
                    {/* URL Bar */}
                    <div style={urlBarContainerStyle}>
                        {urlBox}
                        <BrowserSettingsMenu />
                    </div>

                    {/* Screenshot Area */}
                    <div
                        style={{
                            width: "100%",
                            paddingBottom: `${(browserSettings.viewport.height / browserSettings.viewport.width) * 100}%`,
                            position: "relative",
                            backgroundColor: "var(--vscode-input-background)",
                        }}>
                        {displayState.screenshot ? (
                            <img
                                alt="Browser screenshot"
                                onClick={() =>
                                    FileServiceClient.openImage(StringRequest.create({ value: displayState.screenshot })).catch(
                                        (err) => console.error("Failed to open image:", err),
                                    )
                                }
                                src={displayState.screenshot}
                                style={imgScreenshotStyle}
                            />
                        ) : (
                            <div style={noScreenshotContainerStyle}>
                                <span className="codicon codicon-globe" style={noScreenshotIconStyle} />
                            </div>
                        )}
                        {displayState.mousePosition && (
                            <BrowserCursor
                                style={{
                                    position: "absolute",
                                    top: `${(Number.parseInt(mousePosition.split(",")[1], 10) / browserSettings.viewport.height) * 100}%`,
                                    left: `${(Number.parseInt(mousePosition.split(",")[0], 10) / browserSettings.viewport.width) * 100}%`,
                                    transition: "top 0.3s ease-out, left 0.3s ease-out",
                                }}
                            />
                        )}
                    </div>

                    <div style={consoleLogsContainerStyle}>
                        <div
                            onClick={() => {
                                setConsoleLogsExpanded(!consoleLogsExpanded)
                            }}
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "4px",
                                // width: "100%",
                                justifyContent: "flex-start",
                                cursor: "pointer",
                                padding: `9px 8px ${consoleLogsExpanded ? 0 : 8}px 8px`,
                            }}>
                            {consoleLogsExpanded ? <ChevronDownIcon size={16} /> : <ChevronRightIcon size={16} />}
                            <span style={consoleLogsTextStyle}>Console Logs</span>
                        </div>
                        {consoleLogsExpanded && (
                            <CodeBlock source={`${"```"}shell\n${displayState.consoleLogs || "(No new logs)"}\n${"```"}`} />
                        )}
                    </div>
                    {currentPage?.actions.map((action) => (
                        <BrowserActionBox
                            action={action.action}
                            coordinate={action.coordinate}
                            key={action.messageTs}
                            text={action.text}
                        />
                    ))}
                    {!isBrowsing && hasBrowserResult && currentPageIndex === 0 && (
                        <BrowserActionBox action="launch" text={initialUrl} />
                    )}
                    <div style={{ marginTop: 10 }}>
                        <BrowserSessionToolbar
                            currentPageIndex={currentPageIndex}
                            onNext={showNextPage}
                            onPrevious={showPreviousPage}
                            pageCount={pages.length}
                        />
                    </div>
                </div>
            )}

            {!isFolded && stepsToggle && (
                <div data-testid="browser-session-steps-card" style={{ ...browserFrameStyle, maxWidth }}>
                    {stepsToggle}
                    {stepsVisible && (
                        <div
                            className={cn(TOOL_RESPONSE_SCROLL_CLASS, "px-2 pb-1")}
                            data-testid="browser-session-steps"
                            id={stepsId}
                            style={{ borderTop: "1px solid var(--vscode-editorGroup-border)" }}>
                            {steps.map((step) => (
                                <div className="pb-1" data-testid="browser-session-step" key={step.key}>
                                    {step.checkpoint && step.checkpoint !== head && (
                                        <div className="mb-1">
                                            <CheckpointMarker message={step.checkpoint} />
                                        </div>
                                    )}
                                    {step.thoughts.map((thought) => (
                                        <div className="pt-1" key={thought.ts}>
                                            <ThinkingRow
                                                isExpanded={resolveMessageRowExpanded(thought, expandedRows)}
                                                isStreaming={isBrowsing && thought.partial === true}
                                                isVisible={true}
                                                onToggle={() => onToggleExpand(thought.ts)}
                                                reasoningContent={thought.text}
                                                showChevron={Boolean(thought.text?.trim())}
                                                showTitle={true}
                                                title="Thinking"
                                            />
                                        </div>
                                    ))}
                                    {step.actions.map((action) => (
                                        <button
                                            className={cn(
                                                "flex w-full min-w-0 items-center gap-2 border-0 bg-transparent py-1 px-0 text-left text-foreground cursor-pointer",
                                                { "font-semibold": step.pageIndex === currentPageIndex },
                                            )}
                                            data-testid="browser-session-step-action"
                                            key={action.messageTs}
                                            onClick={() => showPage(step.pageIndex)}
                                            title={`Show page ${step.pageIndex + 1}`}
                                            type="button">
                                            <BrowserActionIcon action={action.action} />
                                            <span className="min-w-0 truncate">{describeBrowserAction(action)}</span>
                                            <span className="shrink-0 text-description text-xs">Page {step.pageIndex + 1}</span>
                                        </button>
                                    ))}
                                    {step.notices.map(renderNotice)}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
            {showLooseRows && (
                <>
                    {unfoldable.map((checkpoint) => (
                        <div className="mb-2" data-testid="browser-session-unfoldable-checkpoint" key={checkpoint.ts}>
                            <CheckpointMarker message={checkpoint} />
                        </div>
                    ))}
                    {notices.map(renderNotice)}
                </>
            )}
        </BrowserSessionRowContainer>,
    )

    // Height change effect
    useEffect(() => {
        const isInitialRender = prevHeightRef.current === 0
        if (isLast && height !== 0 && height !== Number.POSITIVE_INFINITY && height !== prevHeightRef.current) {
            if (!isInitialRender) {
                onHeightChange(height > prevHeightRef.current)
            }
            prevHeightRef.current = height
        }
    }, [height, isLast, onHeightChange])

    return browserSessionRow
}, deepEqual)

const BrowserActionBox = ({ action, coordinate, text }: { action: BrowserAction; coordinate?: string; text?: string }) => {
    return (
        <div style={browserActionBoxContainerStyle}>
            <div style={browserActionBoxContainerInnerStyle}>
                <div style={browseActionRowContainerStyle}>
                    <BrowserActionIcon action={action} className="mr-2" />
                    <span style={browseActionRowStyle}>
                        <span style={browseActionTextStyle}>Browse Action: </span>
                        {describeBrowserAction({ action, coordinate, text })}
                    </span>
                </div>
            </div>
        </div>
    )
}

const BrowserCursor: React.FC<{ style?: CSSProperties }> = ({ style }) => {
    // (can't use svgs in vsc extensions)
    const cursorBase64 =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABUAAAAYCAYAAAAVibZIAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAFaADAAQAAAABAAAAGAAAAADwi9a/AAADGElEQVQ4EZ2VbUiTURTH772be/PxZdsz3cZwC4RVaB8SAjMpxQwSWZbQG/TFkN7oW1Df+h6IRV9C+hCpKUSIZUXOfGM5tAKViijFFEyfZ7Ol29S1Pbdzl8Uw9+aBu91zzv3/nt17zt2DEZjBYOAkKrtFMXIghAWM8U2vMN/FctsxGRMpM7NbEEYNMM2CYUSInlJx3OpawO9i+XSNQYkmk2uFb9njzkcfVSr1p/GJiQKMULVaw2WuBv296UKRxWJR6wxGCmM1EAhSNppv33GBH9qI32cPTAtss9lUm6EM3N7R+RbigT+5/CeosFCZKpjEW+iorS1pb30wDUXzQfHqtD/9L3ieZ2ee1OJCmbL8QHnRs+4uj0wmW4QzrpCwvJ8zGg3JqAmhTLynuLiwv8/5KyND8Q3cEkUEDWu15oJE4KRQJt5hs1rcriGNRqP+DK4dyyWXXm/aFQ+cEpSJ8/LyDGPuEZNOmzsOroUSOqzXG/dtBU4ZysTZYKNut91sNo2Cq6cE9enz86s2g9OCMrFSqVC5hgb32u072W3jKMU90Hb1seC0oUwsB+t92bO/rKx0EFGkgFCnjjc1/gVvC8rE0L+4o63t4InjxwbAJQjTe3qD8QrLkXA4DC24fWtuajp06cLFYSBIFKGmXKPRRmAnME9sPt+yLwIWb9WN69fKoTneQz4Dh2mpPNkvfeV0jjecb9wNAkwIEVQq5VJOds4Kb+DXoAsiVquVwI1Dougpij6UyGYx+5cKroeDEFibm5lWRRMbH1+npmYrq6qhwlQHIbajZEf1fElcqGGFpGg9HMuKzpfBjhytCTMgkJ56RX09zy/ysENTBElmjIgJnmNChJqohDVQqpEfwkILE8v/o0GAnV9F1eEvofVQCbiTBEXOIPQh5PGgefDZeAcjrpGZjULBr/m3tZOnz7oEQWRAQZLjWlEU/XEJWySiILgRc5Cz1DkcAyuBFcnpfF0JiXWKpcolQXizhS5hKAqFpr0MVbgbuxJ6+5xX+P4wNpbqPPrugZfbmIbLmgQR3Aw8QSi66hUXulOFbF73GxqjE5BNXWNeAAAAAElFTkSuQmCC"

    return (
        <img
            alt="cursor"
            src={cursorBase64}
            style={{
                width: "17px",
                height: "22px",
                ...style,
            }}
        />
    )
}

const BrowserSessionRowContainer = styled.div`
	padding: 10px 6px 10px 15px;
	position: relative;
`

export default BrowserSessionRow
