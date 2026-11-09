import { BUILTIN_INPUT_SEMANTICS, type InputSemanticCatalog } from "@shared/input-semantics/catalog"
import type { McpServer } from "@shared/mcp"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createEmptyApiProfile } from "@/components/settings/providers/ProviderProfile"
import { useMenuAnnouncement } from "@/hooks/useMenuAnnouncement"
import { translateUi, type UiTranslator } from "@/i18n/messages"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import { ContextMenuOptionType, getContextMenuOptions } from "../context-mentions"
import { getAvailableSlashCommands, getMcpPromptCommands } from "../slash-commands"
import { validateApiConfiguration } from "../validate"

const zh: UiTranslator = (key, ...args) => translateUi("zh-CN", key, ...args)
const catalog: InputSemanticCatalog = { revision: 0, descriptors: BUILTIN_INPUT_SEMANTICS }
const menuItems = ["first/file.ts", "second/file.ts"]
const itemLabel = (item: string) => item

function MenuHarness() {
    const [selectedIndex, select] = useState(0)
    const { announcement } = useMenuAnnouncement({ items: menuItems, selectedIndex, getItemLabel: itemLabel })
    return (
        <>
            <button onClick={() => select(1)} type="button">
                next
            </button>
            <output>{announcement}</output>
        </>
    )
}

function server(prompts: NonNullable<McpServer["prompts"]>): McpServer {
    return {
        name: "external-server",
        status: "connected",
        config: "{}",
        tools: [],
        resources: [],
        resourceTemplates: [],
        prompts,
    }
}

afterEach(() => {
    cleanup()
    vi.useRealTimers()
})

describe("localized UI presenters preserve semantic inputs", () => {
    it("changes only built-in descriptions, never slash triggers or catalog identities", () => {
        const english = getAvailableSlashCommands({}, catalog)
        const chinese = getAvailableSlashCommands({}, catalog, zh)
        expect(chinese.map(({ trigger, commandId, section }) => ({ trigger, commandId, section }))).toEqual(
            english.map(({ trigger, commandId, section }) => ({ trigger, commandId, section })),
        )
        expect(chinese.find(({ command }) => command.name === "newtask")?.command.description).toBe(
            "携带当前任务的上下文创建新任务",
        )
        expect(english.find(({ command }) => command.name === "newtask")?.command.description).toBe(
            "Create a new task with context from the current task",
        )
    })

    it("keeps third-party descriptions and titles verbatim and translates only the missing-description wrapper", () => {
        const prompts = [
            { name: "raw", description: "KEEP **external** description" },
            { name: "title", title: "KEEP external title" },
            { name: "empty" },
        ]
        const commands = getMcpPromptCommands([server(prompts)], zh)
        expect(commands).toEqual([
            { name: "external-server:raw", section: "mcp", description: "KEEP **external** description" },
            { name: "external-server:title", section: "mcp", description: "KEEP external title" },
            { name: "external-server:empty", section: "mcp", description: "来自 external-server 的 MCP 提示词" },
        ])
        expect(prompts).toEqual([
            { name: "raw", description: "KEEP **external** description" },
            { name: "title", title: "KEEP external title" },
            { name: "empty" },
        ])
    })

    it("keeps mention values, matching and external commit messages independent from translated labels", () => {
        const external = {
            type: ContextMenuOptionType.Git,
            value: "abcdef0",
            label: "KEEP commit message",
            description: "KEEP author",
        }
        const options = getContextMenuOptions("", ContextMenuOptionType.Git, [external], [], zh)
        expect(options).toEqual([
            { type: ContextMenuOptionType.Git, value: "git-changes", label: "工作区更改", description: "当前未提交的更改" },
            external,
        ])
        expect(options[1]).toBe(external)
        const hashOptions = getContextMenuOptions("deed123", ContextMenuOptionType.Git, [], [], zh)
        expect(hashOptions[0]).toEqual({
            type: ContextMenuOptionType.Git,
            value: "deed123",
            label: "提交 deed123",
            description: "Git 提交哈希",
        })
    })

    it("localizes profile validation without changing admission inputs or configured names", () => {
        const profile = { ...createEmptyApiProfile(), name: "KEEP profile name", usedFor: ["act"], apiKey: "test-key" }
        const original = structuredClone(profile)
        expect(validateApiConfiguration("act", undefined, [profile], zh)).toBeUndefined()
        expect(validateApiConfiguration("plan", undefined, [profile], zh)).toBe("未找到适用于 plan 模式的已启用配置。")
        expect(validateApiConfiguration("plan", undefined, [profile])).toBe("No enabled profile found for plan mode.")
        expect(validateApiConfiguration("act", undefined, [{ ...profile, apiKey: "" }], zh)).toBe(
            "请提供有效的 API 密钥，或选择其他提供方。",
        )
        expect(profile).toEqual(original)
    })

    it("retranslates screen-reader positions in the same mounted menu and retains its selected item", () => {
        vi.useFakeTimers()
        const view = render(
            <UiLanguageProvider language="en">
                <MenuHarness />
            </UiLanguageProvider>,
        )
        fireEvent.click(screen.getByRole("button", { name: "next" }))
        expect(screen.getByRole("status").textContent).toBe("second/file.ts, 2 of 2")
        const original = screen.getByRole("button", { name: "next" })
        view.rerender(
            <UiLanguageProvider language="zh-CN">
                <MenuHarness />
            </UiLanguageProvider>,
        )
        expect(screen.getByRole("status").textContent).toBe("second/file.ts，第 2 项，共 2 项")
        expect(screen.getByRole("button", { name: "next" })).toBe(original)
        view.rerender(
            <UiLanguageProvider language="en">
                <MenuHarness />
            </UiLanguageProvider>,
        )
        expect(screen.getByRole("status").textContent).toBe("second/file.ts, 2 of 2")
        act(() => vi.advanceTimersByTime(1_000))
        expect(screen.getByRole("status").textContent).toBe("")
    })
})
