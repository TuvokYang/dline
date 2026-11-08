import type { AccountUsageData } from "@shared/ExtensionMessage"
import { AccountUsageResetResult } from "@shared/proto/dline/account"
import type { UiLanguage } from "@shared/UiLanguage"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import { ProviderUsageDetails } from "./ProviderUsageDetails"

const usage: AccountUsageData = {
    profileId: "usage-profile-id",
    providerId: "openai-codex",
    currency: "USD",
    planType: "Pro [provider payload]",
    local: { inputTokens: 100, outputTokens: 20, usageReported: true, degraded: true },
    quotas: [{ type: "weekly", label: "Server quota [raw]", used: 83, limit: 100 }],
    resetCreditsAvailableCount: 1,
    resetCredits: [{ id: "credit-raw-id", expiresAt: "2030-01-02T03:04:05Z" }],
}

describe("usage details language changes", () => {
    it("keeps the selected reset card across portal translations and re-renders a completed semantic result", async () => {
        const consume = vi.fn().mockResolvedValue(
            AccountUsageResetResult.create({
                profileId: usage.profileId,
                outcome: "reset",
                quotaTypesReset: ["5hour", "weekly"],
            }),
        )
        const tree = (language: UiLanguage) => (
            <UiLanguageProvider language={language}>
                <ProviderUsageDetails consumeResetCredit={consume} resetting={false} usage={usage} />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        expect(screen.getByText("17% remaining")).toBeVisible()
        expect(screen.getByText("Local usage is incomplete")).toBeVisible()
        expect(screen.getByText("Pro [provider payload]")).toBeVisible()
        fireEvent.click(screen.getByRole("button", { name: "Use reset card 1" }))
        const dialog = screen.getByRole("dialog", { name: "Use a rate-limit reset card?" })
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("dialog", { name: "使用速率限制重置卡？" })).toBe(dialog)
        expect(within(dialog).getByRole("button", { name: "使用重置卡" })).toBeVisible()
        expect(consume).not.toHaveBeenCalled()
        view.rerender(tree("en"))
        expect(screen.getByRole("dialog", { name: "Use a rate-limit reset card?" })).toBe(dialog)
        fireEvent.click(within(dialog).getByRole("button", { name: "Use reset card" }))
        expect(await screen.findByRole("status")).toHaveTextContent("Reset completed for 5hour and weekly.")
        expect(consume).toHaveBeenCalledExactlyOnceWith("credit-raw-id")
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())

        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("status")).toHaveTextContent("已完成 5hour、weekly 的重置。")
        expect(screen.getByText("剩余 17%")).toBeVisible()
        expect(screen.getByText("本地用量不完整")).toBeVisible()
        expect(screen.getByText("Server quota [raw]")).toBeVisible()
        expect(screen.getByText("Pro [provider payload]")).toBeVisible()
        view.rerender(tree("en"))
        expect(screen.getByRole("status")).toHaveTextContent("Reset completed for 5hour and weekly.")
        expect(consume).toHaveBeenCalledTimes(1)
    })

    it("preserves semantic note identities through translations and changing legacy detail", () => {
        const consume = vi.fn()
        const tree = (language: UiLanguage, legacyPartial = true, degraded = true, includeLegacy = true) => (
            <UiLanguageProvider language={language}>
                <ProviderUsageDetails
                    consumeResetCredit={consume}
                    resetting={false}
                    usage={{
                        ...usage,
                        local: {
                            inputTokens: 100,
                            outputTokens: 20,
                            usageReported: true,
                            legacyInputTokens: includeLegacy ? 10 : undefined,
                            legacyPartial,
                            degraded,
                        },
                    }}
                />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        const legacy = screen.getByText("Includes an earlier day total that cannot be split by model")
        const degraded = screen.getByText("Local usage is incomplete")
        view.rerender(tree("zh-CN"))
        expect(screen.getByText("包含无法按模型拆分的早期当日总量")).toBe(legacy)
        expect(screen.getByText("本地用量不完整")).toBe(degraded)
        view.rerender(tree("en"))
        expect(screen.getByText("Includes an earlier day total that cannot be split by model")).toBe(legacy)
        expect(screen.getByText("Local usage is incomplete")).toBe(degraded)
        view.rerender(tree("en", false))
        expect(screen.getByText("Includes an earlier day total")).toBe(legacy)
        expect(screen.getByText("Local usage is incomplete")).toBe(degraded)
        view.rerender(tree("en", false, true, false))
        expect(legacy).not.toBeInTheDocument()
        expect(screen.getByText("Local usage is incomplete")).toBe(degraded)
        view.rerender(tree("en", false, false, false))
        expect(degraded).not.toBeInTheDocument()
        expect(consume).not.toHaveBeenCalled()
    })
})
