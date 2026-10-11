import React, { useCallback, useEffect, useRef } from "react"
import ScreenReaderAnnounce from "@/components/common/ScreenReaderAnnounce"
import { useMenuAnnouncement } from "@/hooks/useMenuAnnouncement"
import type { SlashMenuEntry, SlashMenuSection } from "@/utils/slash-commands"

interface SlashCommandMenuProps {
    onSelect: (entry: SlashMenuEntry) => void
    selectedIndex: number
    setSelectedIndex: (index: number) => void
    onMouseDown: () => void
    /**
     * The rows to show, already grouped by section. Keyboard navigation indexes
     * the same list, so a row's position here is its selection index.
     */
    entries: SlashMenuEntry[]
}

interface SectionStyle {
    readonly title: string
    readonly typeLabel: string
    readonly badgeClass: string
    readonly badgeColor: string
}

/** Header, badge text and badge color per section. */
const SECTION_STYLES: Readonly<Record<SlashMenuSection, SectionStyle>> = {
    default: {
        title: "Default Commands",
        typeLabel: "Command",
        badgeClass: "bg-(--vscode-textLink-foreground)/15",
        badgeColor: "var(--vscode-textLink-foreground)",
    },
    workflow: {
        title: "Workflows",
        typeLabel: "Workflow",
        badgeClass: "bg-(--vscode-terminal-ansiGreen)/15",
        badgeColor: "var(--vscode-terminal-ansiGreen)",
    },
    skill: {
        title: "Skills",
        typeLabel: "Skill",
        badgeClass: "bg-(--vscode-terminal-ansiYellow)/15",
        badgeColor: "var(--vscode-terminal-ansiYellow)",
    },
    mcp: {
        title: "MCP Prompts",
        typeLabel: "MCP",
        badgeClass: "bg-(--vscode-terminal-ansiMagenta)/15",
        badgeColor: "var(--vscode-terminal-ansiMagenta)",
    },
}

const SlashCommandMenu: React.FC<SlashCommandMenuProps> = ({
    onSelect,
    selectedIndex,
    setSelectedIndex,
    onMouseDown,
    entries,
}) => {
    const menuRef = useRef<HTMLDivElement>(null)

    // Screen reader announcements
    const getCommandLabel = useCallback((entry: SlashMenuEntry) => {
        const description = entry.command.description ? `, ${entry.command.description}` : ""
        return `${entry.command.name}${description}`
    }, [])

    const { announcement } = useMenuAnnouncement({
        items: entries,
        selectedIndex,
        getItemLabel: getCommandLabel,
    })

    useEffect(() => {
        if (menuRef.current) {
            const selectedElement = menuRef.current.querySelector(`#slash-command-menu-item-${selectedIndex}`) as HTMLElement
            if (selectedElement) {
                const menuRect = menuRef.current.getBoundingClientRect()
                const selectedRect = selectedElement.getBoundingClientRect()

                if (selectedRect.bottom > menuRect.bottom) {
                    menuRef.current.scrollTop += selectedRect.bottom - menuRect.bottom
                } else if (selectedRect.top < menuRect.top) {
                    menuRef.current.scrollTop -= menuRect.top - selectedRect.top
                }
            }
        }
    }, [selectedIndex])

    const renderEntry = (entry: SlashMenuEntry, itemIndex: number) => {
        const { command } = entry
        const style = SECTION_STYLES[entry.section]
        const selected = itemIndex === selectedIndex
        const startsSection = itemIndex === 0 || entries[itemIndex - 1].section !== entry.section
        return (
            <React.Fragment key={entry.trigger}>
                {startsSection && (
                    <div
                        className="text-xs text-(--vscode-descriptionForeground) px-3 py-1 font-bold border-b border-(--vscode-editorGroup-border)"
                        role="presentation">
                        {style.title}
                    </div>
                )}
                <div
                    aria-selected={selected}
                    className={`slash-command-menu-item py-2 px-3 cursor-pointer flex flex-row items-center border-b border-(--vscode-editorGroup-border) ${
                        selected
                            ? "bg-(--vscode-quickInputList-focusBackground) text-(--vscode-quickInputList-focusForeground)"
                            : ""
                    } hover:bg-(--vscode-list-hoverBackground)`}
                    id={`slash-command-menu-item-${itemIndex}`}
                    onClick={() => onSelect(entry)}
                    onMouseEnter={() => setSelectedIndex(itemIndex)}
                    role="option">
                    <div className="flex-1 min-w-0">
                        <div className="font-bold whitespace-nowrap overflow-hidden text-ellipsis">
                            <span className="ph-no-capture">{command.name}</span>
                        </div>
                        {command.description && (
                            <div className="text-[0.85em] text-(--vscode-descriptionForeground) whitespace-normal overflow-hidden text-ellipsis">
                                <span className="ph-no-capture">{command.description}</span>
                            </div>
                        )}
                    </div>
                    <span
                        className={`text-[0.8em] font-bold shrink-0 ml-2 px-1.5 py-0.5 rounded-full leading-normal ${style.badgeClass}`}
                        style={selected ? { backgroundColor: style.badgeColor, color: "#fff" } : { color: style.badgeColor }}>
                        {style.typeLabel}
                    </span>
                </div>
            </React.Fragment>
        )
    }

    return (
        <div
            className="absolute bottom-[calc(100%-10px)] left-[15px] right-[15px] overflow-x-hidden z-1000"
            data-testid="slash-commands-menu"
            onMouseDown={(event) => {
                event.preventDefault()
                onMouseDown()
            }}>
            <ScreenReaderAnnounce message={announcement} />
            <div
                aria-activedescendant={entries.length > 0 ? `slash-command-menu-item-${selectedIndex}` : undefined}
                aria-label="Slash commands"
                className="bg-(--vscode-dropdown-background) border border-(--vscode-editorGroup-border) rounded-[3px] shadow-[0_4px_10px_rgba(0,0,0,0.25)] flex flex-col overflow-y-auto"
                ref={menuRef}
                role="listbox"
                style={{ maxHeight: "min(200px, calc(50vh))", overscrollBehavior: "contain" }}
                tabIndex={0}>
                {entries.length > 0 ? (
                    entries.map(renderEntry)
                ) : (
                    <div aria-selected="false" className="py-2 px-3 cursor-default flex flex-col" role="option">
                        <div className="text-[0.85em] text-(--vscode-descriptionForeground)">No matching commands found</div>
                    </div>
                )}
            </div>
        </div>
    )
}

export default SlashCommandMenu
