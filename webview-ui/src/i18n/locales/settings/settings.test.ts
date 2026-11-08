import { describe, expect, it } from "vitest"
import { en as auth } from "./auth.en"
import { en as common } from "./common.en"
import { en } from "./en"
import { en as providers } from "./providers.en"
import { en as sections } from "./sections.en"
import { en as status } from "./status.en"
import { zhCN } from "./zh_CN"

describe("Settings resources", () => {
    it("keeps the domain complete, isolated and free of shadowed keys", () => {
        const keys = Object.keys(en)
        expect(Object.keys(zhCN).sort()).toEqual([...keys].sort())
        expect(keys.every((key) => key.startsWith("settings.ui."))).toBe(true)
        expect(keys.length).toBe(
            [common, sections, providers, auth, status].reduce((count, part) => count + Object.keys(part).length, 0),
        )
    })

    it("formats complete sentences from named arguments without changing user-owned values", () => {
        const profileName = "Personal profile <raw>"
        expect(en["settings.ui.expandProfile"]({ name: profileName })).toBe("Expand Personal profile <raw>")
        expect(zhCN["settings.ui.expandProfile"]({ name: profileName })).toBe("展开 Personal profile <raw>")
        expect(en["settings.ui.signupKey"]({ provider: "OpenAI" })).toBe("You can get an OpenAI API key by signing up here.")
        expect(zhCN["settings.ui.signupKey"]({ provider: "OpenAI" })).toContain("OpenAI")
        expect(en["settings.ui.auth.providerUrl"]({ provider: "ChatGPT" })).toBe("ChatGPT sign-in URL")
        expect(zhCN["settings.ui.auth.providerUrl"]({ provider: "ChatGPT" })).toBe("ChatGPT 登录 URL")
        const quotas = ["5hour", "weekly"]
        expect(en["settings.ui.usage.resetCompleted"]({ quotas })).toBe("Reset completed for 5hour and weekly.")
        expect(zhCN["settings.ui.usage.resetCompleted"]({ quotas })).toBe("已完成 5hour、weekly 的重置。")
        expect(quotas).toEqual(["5hour", "weekly"])
    })
})
