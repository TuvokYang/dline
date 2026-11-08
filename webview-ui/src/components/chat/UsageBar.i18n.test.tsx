import type { AccountUsageData } from "@shared/ExtensionMessage"
import { AccountUsageResetResult } from "@shared/proto/dline/account"
import type { UiLanguage } from "@shared/UiLanguage"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"

const mockedContext = vi.hoisted(() => ({ accountUsage: undefined as AccountUsageData | undefined }))
const mocks = vi.hoisted(() => ({
    consumeAccountUsageResetCredit: vi.fn(),
    getProviderUsage: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mockedContext }))
vi.mock("@/services/grpc-client", () => ({ AccountServiceClient: mocks }))

import { UsageBar } from "./UsageBar"

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

function tree(language: UiLanguage) {
    return (
        <UiLanguageProvider language={language}>
            <UsageBar />
        </UiLanguageProvider>
    )
}

function openDetails() {
    const view = render(tree("en"))
    const trigger = screen.getByRole("button", { name: "Provider usage" })
    fireEvent.click(trigger)
    const menu = screen.getByRole("dialog", { name: "Provider usage details" })
    return { view, trigger, menu }
}

beforeEach(() => {
    mocks.getProviderUsage.mockReset()
    mocks.consumeAccountUsageResetCredit.mockReset()
    mockedContext.accountUsage = {
        profileId: "profile-raw-id",
        providerId: "openai-codex",
        currency: "USD",
        planType: "Pro [provider payload]",
        quotas: [{ type: "5hour", label: "Server quota [raw]", shortLabel: "raw-window", used: 20, limit: 100 }],
        resetCreditsAvailableCount: 1,
        resetCredits: [{ id: "credit-raw-id", expiresAt: "2030-01-02T03:04:05Z" }],
    }
})

afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
})

describe("UsageBar language changes", () => {
    it("keeps its open portal, button focus, provider values and disclosure in the same tree", () => {
        const { view, trigger, menu } = openDetails()
        const refreshButton = within(menu).getByRole("button", { name: "Refresh Provider usage" })
        refreshButton.focus()
        const progress = within(menu).getByRole("progressbar", { name: "Server quota [raw] usage" })
        const expiry = new Date("2030-01-02T03:04:05Z").toLocaleString()
        expect(within(menu).getByText(`Expires ${expiry}`)).toBeVisible()

        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("dialog", { name: "提供方用量详情" })).toBe(menu)
        expect(screen.getByRole("button", { name: "提供方用量" })).toBe(trigger)
        expect(trigger).toHaveAttribute("aria-expanded", "true")
        expect(trigger).toHaveTextContent("raw-window: 80%")
        expect(within(menu).getByRole("button", { name: "刷新提供方用量" })).toBe(refreshButton)
        expect(refreshButton).toHaveFocus()
        expect(within(menu).getByRole("progressbar", { name: "Server quota [raw]用量" })).toBe(progress)
        expect(progress).toHaveAttribute("aria-valuenow", "80")
        expect(within(menu).getByText("Pro [provider payload]")).toBeVisible()
        expect(within(menu).getByText("Server quota [raw]")).toBeVisible()
        expect(within(menu).getByText(`于 ${expiry} 到期`)).toBeVisible()

        view.rerender(tree("en"))
        expect(screen.getByRole("dialog", { name: "Provider usage details" })).toBe(menu)
        expect(within(menu).getByRole("button", { name: "Refresh Provider usage" })).toBe(refreshButton)
        expect(refreshButton).toHaveFocus()
        expect(within(menu).getByRole("progressbar", { name: "Server quota [raw] usage" })).toBe(progress)
        expect(within(menu).getByText(`Expires ${expiry}`)).toBeVisible()
        expect(mocks.getProviderUsage).not.toHaveBeenCalled()
        expect(mocks.consumeAccountUsageResetCredit).not.toHaveBeenCalled()
    })

    it.each(["settled", "pending"] as const)("translates a %s refresh failure without issuing another RPC", async (phase) => {
        const pending = deferred<never>()
        mocks.getProviderUsage.mockReturnValueOnce(pending.promise)
        const { view, trigger, menu } = openDetails()
        const refreshButton = within(menu).getByRole("button", { name: "Refresh Provider usage" })
        fireEvent.click(refreshButton)
        expect(refreshButton).toBeDisabled()
        if (phase === "settled") {
            await act(async () => pending.reject(new Error("provider diagnostic [raw]")))
            expect(within(menu).getByRole("alert")).toHaveTextContent("Provider usage could not be refreshed.")
        }
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("dialog", { name: "提供方用量详情" })).toBe(menu)
        if (phase === "pending") {
            expect(within(menu).getByRole("button", { name: "刷新提供方用量" })).toBe(refreshButton)
            expect(refreshButton).toBeDisabled()
            expect(within(menu).queryByRole("alert")).not.toBeInTheDocument()
            await act(async () => pending.reject(new Error("provider diagnostic [raw]")))
        }
        const alert = within(menu).getByRole("alert")
        expect(alert).toHaveTextContent("无法刷新提供方用量。")
        expect(refreshButton).toBeEnabled()
        view.rerender(tree("en"))
        expect(within(menu).getByRole("alert")).toBe(alert)
        expect(alert).toHaveTextContent("Provider usage could not be refreshed.")
        view.rerender(tree("zh-CN"))
        expect(alert).toHaveTextContent("无法刷新提供方用量。")
        view.rerender(tree("en"))
        expect(trigger).toHaveTextContent("raw-window: 80%")
        expect(mocks.getProviderUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ profileId: "profile-raw-id" }))
        expect(mocks.consumeAccountUsageResetCredit).not.toHaveBeenCalled()
    })

    it.each([
        "settled",
        "pending",
    ] as const)("translates a %s reset failure and keeps the selected confirmation without retrying", async (phase) => {
        const pending = deferred<never>()
        mocks.consumeAccountUsageResetCredit.mockReturnValueOnce(pending.promise)
        const { view, menu } = openDetails()
        fireEvent.click(within(menu).getByRole("button", { name: "Use reset card 1" }))
        const confirmation = screen.getByRole("dialog", { name: "Use a rate-limit reset card?" })
        const confirmButton = within(confirmation).getByRole("button", { name: "Use reset card" })
        expect(mocks.consumeAccountUsageResetCredit).not.toHaveBeenCalled()
        fireEvent.click(confirmButton)
        expect(confirmButton).toBeDisabled()
        expect(confirmButton).toHaveTextContent("Resetting…")
        if (phase === "settled") {
            await act(async () => pending.reject(new Error("reset diagnostic [raw]")))
            expect(within(menu).getByRole("alert")).toHaveTextContent("The Provider rate-limit reset could not be completed.")
        }
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("dialog", { name: "提供方用量详情" })).toBe(menu)
        expect(screen.getByRole("dialog", { name: "使用速率限制重置卡？" })).toBe(confirmation)
        if (phase === "pending") {
            expect(within(confirmation).getByRole("button", { name: "正在重置…" })).toBe(confirmButton)
            expect(confirmButton).toBeDisabled()
            await act(async () => pending.reject(new Error("reset diagnostic [raw]")))
        }
        const alert = within(menu).getByRole("alert")
        expect(alert).toHaveTextContent("无法完成提供方速率限制重置。")
        expect(within(confirmation).getByRole("button", { name: "使用重置卡" })).toBe(confirmButton)
        expect(confirmButton).toBeEnabled()
        view.rerender(tree("en"))
        expect(screen.getByRole("dialog", { name: "Use a rate-limit reset card?" })).toBe(confirmation)
        expect(within(menu).getByRole("alert")).toBe(alert)
        expect(alert).toHaveTextContent("The Provider rate-limit reset could not be completed.")
        view.rerender(tree("zh-CN"))
        expect(alert).toHaveTextContent("无法完成提供方速率限制重置。")
        view.rerender(tree("en"))
        expect(mocks.consumeAccountUsageResetCredit).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                profileId: "profile-raw-id",
                creditId: "credit-raw-id",
            }),
        )
        expect(mocks.getProviderUsage).not.toHaveBeenCalled()
    })

    it("keeps a refresh response across language changes without replacing provider labels or refetching", async () => {
        const pending = deferred<Record<string, unknown>>()
        mocks.getProviderUsage.mockReturnValueOnce(pending.promise)
        const { view, trigger, menu } = openDetails()
        fireEvent.click(within(menu).getByRole("button", { name: "Refresh Provider usage" }))
        view.rerender(tree("zh-CN"))
        await act(async () =>
            pending.resolve({
                profileId: "profile-raw-id",
                providerId: "openai-codex",
                currency: "USD",
                quotas: [{ type: "5hour", label: "Refreshed quota [raw]", shortLabel: "raw-window", used: 40, limit: 100 }],
            }),
        )
        expect(trigger).toHaveTextContent("raw-window: 60%")
        expect(within(menu).getByText("剩余 60%")).toBeVisible()
        expect(within(menu).getByText("Refreshed quota [raw]")).toBeVisible()
        view.rerender(tree("en"))
        expect(screen.getByRole("dialog", { name: "Provider usage details" })).toBe(menu)
        expect(trigger).toHaveTextContent("raw-window: 60%")
        expect(within(menu).getByText("60% remaining")).toBeVisible()
        expect(mocks.getProviderUsage).toHaveBeenCalledTimes(1)
        expect(mocks.consumeAccountUsageResetCredit).not.toHaveBeenCalled()
    })

    it("translates a completed reset result after a pending language change without consuming the card twice", async () => {
        const pending = deferred<AccountUsageResetResult>()
        mocks.consumeAccountUsageResetCredit.mockReturnValueOnce(pending.promise)
        const { view, menu } = openDetails()
        fireEvent.click(within(menu).getByRole("button", { name: "Use reset card 1" }))
        const confirmation = screen.getByRole("dialog", { name: "Use a rate-limit reset card?" })
        fireEvent.click(within(confirmation).getByRole("button", { name: "Use reset card" }))
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("dialog", { name: "使用速率限制重置卡？" })).toBe(confirmation)
        await act(async () =>
            pending.resolve(
                AccountUsageResetResult.create({
                    profileId: "profile-raw-id",
                    outcome: "reset",
                    quotaTypesReset: ["5hour", "weekly"],
                }),
            ),
        )
        expect(confirmation).not.toBeInTheDocument()
        const status = within(menu).getByRole("status")
        expect(status).toHaveTextContent("已完成 5hour、weekly 的重置。")
        view.rerender(tree("en"))
        expect(within(menu).getByRole("status")).toBe(status)
        expect(status).toHaveTextContent("Reset completed for 5hour and weekly.")
        view.rerender(tree("zh-CN"))
        expect(status).toHaveTextContent("已完成 5hour、weekly 的重置。")
        view.rerender(tree("en"))
        expect(mocks.consumeAccountUsageResetCredit).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                profileId: "profile-raw-id",
                creditId: "credit-raw-id",
            }),
        )
        expect(mocks.getProviderUsage).not.toHaveBeenCalled()
    })
})
