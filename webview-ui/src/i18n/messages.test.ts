import { UI_LANGUAGE_LABELS } from "@shared/UiLanguage"
import { describe, expect, it } from "vitest"
import { en } from "./en"
import { translateUi } from "./messages"
import { zhCN } from "./zh_CN"

// Independent copy expectations: resource-to-resource equality alone cannot prove a translation.
const staticMessages = [
    ["settings.title", "Settings", "设置"],
    ["settings.done", "Done", "完成"],
    ["settings.apiConfiguration.name", "API Configuration", "API 配置"],
    ["settings.apiConfiguration.tooltip", "API Configuration", "API 配置"],
    ["settings.apiConfiguration.heading", "API Configuration", "API 配置"],
    ["settings.features.name", "Features", "功能"],
    ["settings.features.tooltip", "Feature Settings", "功能设置"],
    ["settings.features.heading", "Feature Settings", "功能设置"],
    ["settings.browser.name", "Browser", "浏览器"],
    ["settings.browser.tooltip", "Browser Settings", "浏览器设置"],
    ["settings.browser.heading", "Browser Settings", "浏览器设置"],
    ["settings.terminal.name", "Terminal", "终端"],
    ["settings.terminal.tooltip", "Terminal Settings", "终端设置"],
    ["settings.terminal.heading", "Terminal Settings", "终端设置"],
    ["settings.general.name", "General", "通用"],
    ["settings.general.tooltip", "General Settings", "通用设置"],
    ["settings.general.heading", "General Settings", "通用设置"],
    ["settings.remoteConfig.name", "Remote Config", "远程配置"],
    ["settings.remoteConfig.tooltip", "Remotely configured fields", "远程配置的字段"],
    ["settings.remoteConfig.heading", "Remote Config", "远程配置"],
    ["settings.about.name", "About", "关于"],
    ["settings.about.tooltip", "About Dline", "关于 Dline"],
    ["settings.about.heading", "About", "关于"],
    ["settings.debug.name", "Debug", "调试"],
    ["settings.debug.tooltip", "Debug Tools", "调试工具"],
    ["settings.debug.heading", "Debug", "调试"],
    ["settings.general.uiLanguage.label", "Interface language", "界面语言"],
    [
        "settings.general.uiLanguage.description",
        "Controls the Dline interface, not the model's response language.",
        "控制 Dline 的界面显示语言，不改变模型的回复语言。",
    ],
    [
        "settings.general.uiLanguage.coverage",
        "Messages, code, tool output and external content keep their original language.",
        "消息、代码、工具输出和外部内容保留原文。",
    ],
    ["settings.general.uiLanguage.auto", "Auto", "自动"],
    ["settings.general.uiLanguage.saving", "Saving interface language…", "正在保存界面语言…"],
    [
        "settings.general.uiLanguage.saveError",
        "Couldn't confirm the interface language update. Please try again.",
        "无法确认界面语言更新，请重试。",
    ],
    ["settings.general.uiLanguage.retry", "Retry", "重试"],
    ["settings.general.preferredLanguage.label", "Model response language", "模型沟通语言"],
    [
        "settings.general.preferredLanguage.description",
        "Choose the language for model replies. Auto follows the language you use in your messages.",
        "选择模型回复的语言。自动模式跟随你在消息中使用的语言。",
    ],
    ["settings.general.chatInputSendShortcut.label", "Send messages with", "发送消息快捷键"],
    ["settings.general.chatInputSendShortcut.enter", "Enter", "Enter"],
    ["settings.general.chatInputSendShortcut.ctrlEnter", "Ctrl + Enter", "Ctrl + Enter"],
    ["settings.general.chatInputSendShortcut.shiftEnter", "Shift + Enter", "Shift + Enter"],
    ["settings.general.aggressiveRendering.label", "Chat folding", "对话折叠"],
    ["settings.general.aggressiveRendering.none", "No folding", "不折叠"],
    ["settings.general.aggressiveRendering.round", "Per request", "按请求轮次"],
    ["settings.general.aggressiveRendering.message_segment", "Per message segment", "按消息段"],
    ["settings.general.aggressiveRendering.user_turn", "Per user turn", "按对话回合"],
    [
        "settings.general.aggressiveRendering.description",
        "Folded blocks show a summary and expand on click. Work that is still running stays visible; failed edits, commands and subagents join the block, and its summary states how many errors it holds.",
        "折叠块显示摘要，点击即可展开。仍在运行的工作保持可见；失败的编辑、命令和子代理也会纳入折叠块，摘要会标明其中的错误数量。",
    ],
] as const

describe("typed UI messages", () => {
    it.each(staticMessages)("translates %s using independently specified copy", (key, english, chinese) => {
        expect(translateUi("en", key)).toBe(english)
        expect(translateUi("zh-CN", key)).toBe(chinese)
    })

    it("has exactly the same complete key set and message kinds in both resources", () => {
        const baselineKeys = [...staticMessages.map(([key]) => key), "settings.general.uiLanguage.followHost"]
        expect(Object.keys(en)).toEqual(expect.arrayContaining(baselineKeys))
        expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort())
        for (const key of Object.keys(en) as (keyof typeof en)[]) {
            expect(typeof zhCN[key]).toBe(typeof en[key])
        }
    })

    it("explains the host display language with named arguments outside the option label", () => {
        expect(translateUi("en", "settings.general.uiLanguage.followHost", { language: UI_LANGUAGE_LABELS.en })).toBe(
            "Auto uses the VS Code display language (English).",
        )
        expect(translateUi("zh-CN", "settings.general.uiLanguage.followHost", { language: UI_LANGUAGE_LABELS["zh-CN"] })).toBe(
            "自动模式使用 VS Code 显示语言（简体中文）。",
        )
        expect(translateUi("zh-CN", "settings.general.uiLanguage.followHost", { language: "English" })).toBe(
            "自动模式使用 VS Code 显示语言（English）。",
        )
    })

    it("treats dynamic values as literal text, never a template or executable source", () => {
        const language = `<strong>\${language}</strong>`
        expect(translateUi("en", "settings.general.uiLanguage.followHost", { language })).toBe(
            `Auto uses the VS Code display language (<strong>\${language}</strong>).`,
        )
        expect(translateUi("zh-CN", "settings.general.uiLanguage.followHost", { language })).toBe(
            `自动模式使用 VS Code 显示语言（<strong>\${language}</strong>）。`,
        )
    })
})
