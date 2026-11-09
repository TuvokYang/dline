import { describe, expect, it } from "vitest"
import { translateUi } from "../../messages"
import { en } from "./en"
import { zhCN } from "./zh_CN"

describe("capabilities resource contract", () => {
    it("has exactly matching product-owned keys and resource kinds", () => {
        expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort())
        for (const [key, value] of Object.entries(en)) {
            expect(key.startsWith("capabilities.")).toBe(true)
            const translated = Object.entries(zhCN).find(([candidate]) => candidate === key)?.[1]
            expect(typeof translated).toBe(typeof value)
        }
    })

    it("uses real named arguments without translating external IDs, URI case, descriptions or raw diagnostics", () => {
        expect(
            translateUi("en", "capabilities.subagent.useMcpResource", {
                server: "Owner/Server",
                value: "repository://CaseSensitive/URI",
            }),
        ).toBe("Use MCP resource Owner/Server/repository://CaseSensitive/URI")
        expect(
            translateUi("zh-CN", "capabilities.subagent.useMcpResource", {
                server: "Owner/Server",
                value: "repository://CaseSensitive/URI",
            }),
        ).toBe("使用 MCP 资源 Owner/Server/repository://CaseSensitive/URI")
        expect(translateUi("zh-CN", "capabilities.subagent.refreshError", { reason: "Raw ENOENT /User Path/中文.md" })).toBe(
            "无法验证刷新的配置：Raw ENOENT /User Path/中文.md。已保留最新的本地选项。",
        )
        expect(
            translateUi("en", "capabilities.subagent.categoryCount", { name: "Tools", active: 2, selected: 3, required: 1 }),
        ).toBe("Tools (2 active, 3 selected, 1 required)")
        expect(
            translateUi("zh-CN", "capabilities.subagent.categoryCount", { name: "工具", active: 2, selected: 3, required: 1 }),
        ).toBe("工具（2 项生效，3 项已选，1 项必需）")
    })
})
