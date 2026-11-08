import type { UiLanguage } from "@shared/UiLanguage"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import {
    type AnchorHTMLAttributes,
    type ButtonHTMLAttributes,
    Children,
    type HTMLAttributes,
    isValidElement,
    type OptionHTMLAttributes,
    type ReactNode,
    type SelectHTMLAttributes,
    useState,
} from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const accountState = vi.hoisted(() => ({
    getUserCredits: vi.fn(),
    getOrganizationCredits: vi.fn(),
    setUserOrganization: vi.fn(),
    updateSettings: vi.fn().mockResolvedValue({}),
    remoteConfigSettings: {} as Record<string, unknown>,
    optOutOfRemoteConfig: false,
}))

vi.mock("@vscode/webview-ui-toolkit/react", async (importOriginal) => {
    const { forwardRef } = await import("react")
    return {
        ...(await importOriginal<typeof import("@vscode/webview-ui-toolkit/react")>()),
        VSCodeButton: forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { appearance?: string }>(
            ({ appearance: _appearance, ...props }, ref) => <button type="button" {...props} ref={ref} />,
        ),
        VSCodeLink: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
        VSCodeDropdown: ({
            children,
            currentValue,
            ...props
        }: SelectHTMLAttributes<HTMLSelectElement> & { currentValue?: string }) => (
            <select {...props} value={currentValue}>
                {Children.toArray(children).filter(
                    (child) => !isValidElement<{ slot?: string }>(child) || child.props.slot !== "selected-value",
                )}
            </select>
        ),
        VSCodeOption: ({ ariaLabel: _ariaLabel, ...props }: OptionHTMLAttributes<HTMLOptionElement> & { ariaLabel?: string }) => (
            <option {...props} />
        ),
        VSCodeTag: (props: HTMLAttributes<HTMLSpanElement>) => <span {...props} />,
        VSCodeDataGrid: ({ children }: { children: ReactNode }) => <div role="grid">{children}</div>,
        VSCodeDataGridRow: ({ children }: { children: ReactNode }) => <div role="row">{children}</div>,
        VSCodeDataGridCell: ({ children }: { children: ReactNode }) => <div role="gridcell">{children}</div>,
    }
})

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({
        environment: "production",
        remoteConfigSettings: accountState.remoteConfigSettings,
        optOutOfRemoteConfig: accountState.optOutOfRemoteConfig,
    }),
}))
vi.mock("@/context/ClineAuthContext", () => ({
    handleSignOut: vi.fn(),
    useClineSignIn: () => ({ isLoginLoading: false, handleSignIn: vi.fn() }),
}))
vi.mock("@/assets/DlineLogo", () => ({ default: () => <div data-testid="dline-logo" /> }))
vi.mock("@/services/grpc-client", () => ({
    AccountServiceClient: {
        getUserCredits: accountState.getUserCredits,
        getOrganizationCredits: accountState.getOrganizationCredits,
        setUserOrganization: accountState.setUserOrganization,
    },
    StateServiceClient: { updateSettings: accountState.updateSettings },
}))

import { ClineAccountView } from "@/components/account/AccountView"
import { AccountWelcomeView } from "@/components/account/AccountWelcomeView"
import { CreditBalance } from "@/components/account/CreditBalance"
import CreditsHistoryTable from "@/components/account/CreditsHistoryTable"
import { getMainRole } from "@/components/account/helpers"
import { flushPendingSettingsRequests } from "@/components/settings/utils/settingsHandlers"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"

const user = { uid: "user-1", email: "dev@example.test", displayName: "Dev User", appBaseUrl: "https://app.example.test" }

function Switcher({ children }: { children: ReactNode }) {
    const [language, setLanguage] = useState<UiLanguage>("en")
    return (
        <UiLanguageProvider language={language}>
            <button onClick={() => setLanguage(language === "en" ? "zh-CN" : "en")} type="button">
                switch-language
            </button>
            {children}
        </UiLanguageProvider>
    )
}

function switchLanguage() {
    fireEvent.click(screen.getByRole("button", { name: "switch-language" }))
}

describe("account language switching", () => {
    beforeEach(() => {
        accountState.remoteConfigSettings = {}
        accountState.updateSettings.mockClear()
        accountState.getUserCredits.mockResolvedValue({
            balance: { currentBalance: 1234 },
            usageTransactions: [],
            paymentTransactions: [],
        })
        accountState.getOrganizationCredits.mockClear()
        accountState.getOrganizationCredits.mockResolvedValue({ balance: { currentBalance: 0 }, usageTransactions: [] })
    })

    it("keeps the main role an identity so the view can translate it", () => {
        expect(getMainRole(["member", "owner"])).toBe("owner")
        expect(getMainRole(["admin"])).toBe("admin")
        expect(getMainRole(["viewer"])).toBe("member")
        expect(getMainRole(undefined)).toBeUndefined()
    })

    it("translates the dashboard, sign-out and role wrappers while keeping account data", async () => {
        render(
            <Switcher>
                <ClineAccountView
                    activeOrganization={{
                        active: true,
                        memberId: "member-1",
                        organizationId: "org-1",
                        name: "Acme",
                        roles: ["owner"],
                    }}
                    clineEnv="Production"
                    clineUser={user}
                    userOrganizations={[
                        { active: true, memberId: "member-1", organizationId: "org-1", name: "Acme", roles: ["owner"] },
                    ]}
                />
            </Switcher>,
        )

        expect(screen.getByRole("button", { name: "Dashboard" })).toBeTruthy()
        expect(screen.getByRole("button", { name: "Log out" })).toBeTruthy()
        expect(screen.getByText("Dev User")).toBeTruthy()
        expect(screen.getByText("dev@example.test")).toBeTruthy()
        expect(screen.getByText("Owner")).toBeTruthy()

        await act(async () => switchLanguage())

        expect(accountState.getOrganizationCredits).toHaveBeenCalledTimes(1)
        expect(accountState.getOrganizationCredits).toHaveBeenCalledWith({ organizationId: "org-1" })
        expect(screen.getByRole("button", { name: "控制台" })).toBeTruthy()
        expect(screen.getByRole("button", { name: "退出登录" })).toBeTruthy()
        expect(screen.getByText("所有者")).toBeTruthy()
        // The account identity the service returned is display data, not copy.
        expect(screen.getByText("Dev User")).toBeTruthy()
        expect(screen.getByText("dev@example.test")).toBeTruthy()
    })

    it("translates internal-tester environment labels without changing the control, option values or settings payload", async () => {
        const tester = { ...user, email: "tester@cline.bot" }
        const view = (clineEnv: "Production" | "Staging" | "Local") => (
            <Switcher>
                <ClineAccountView activeOrganization={null} clineEnv={clineEnv} clineUser={tester} userOrganizations={null} />
            </Switcher>
        )
        const { rerender } = render(view("Staging"))
        const dropdown = screen.getByRole("combobox", { name: "Dline Environment" })
        const options = within(dropdown).getAllByRole<HTMLOptionElement>("option")
        expect(options.map((option) => [option.value, option.textContent])).toEqual([
            ["Production", "Production"],
            ["Staging", "Staging"],
            ["Local", "Local"],
        ])
        expect(dropdown).toHaveValue("Staging")
        await waitFor(() => expect(screen.queryByText("Loading...")).toBeNull())

        await act(async () => switchLanguage())
        expect(screen.getByRole("combobox", { name: "Dline 环境" })).toBe(dropdown)
        expect(within(dropdown).getAllByRole("option")).toHaveLength(options.length)
        within(dropdown)
            .getAllByRole("option")
            .forEach((option, index) => expect(option).toBe(options[index]))
        expect(options.map((option) => [option.value, option.textContent])).toEqual([
            ["Production", "正式"],
            ["Staging", "预发布"],
            ["Local", "本地"],
        ])
        expect(dropdown).toHaveValue("Staging")
        expect(accountState.updateSettings).not.toHaveBeenCalled()

        await act(async () => {
            fireEvent.change(dropdown, { target: { value: "Local" } })
            await flushPendingSettingsRequests()
        })
        expect(accountState.updateSettings).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ clineEnv: "local" }))
        // Project the acknowledged host value without replacing either controlled tree.
        rerender(view("Local"))
        await act(async () => switchLanguage())
        expect(screen.getByRole("combobox", { name: "Dline Environment" })).toBe(dropdown)
        expect(dropdown).toHaveValue("Local")
        expect(within(dropdown).getAllByRole("option")).toHaveLength(options.length)
        within(dropdown)
            .getAllByRole("option")
            .forEach((option, index) => expect(option).toBe(options[index]))
        expect(options.map((option) => option.textContent)).toEqual(["Production", "Staging", "Local"])
        for (const value of ["Production", "Staging"] as const) {
            await act(async () => {
                fireEvent.change(dropdown, { target: { value } })
                await flushPendingSettingsRequests()
            })
            expect(accountState.updateSettings).toHaveBeenLastCalledWith(
                expect.objectContaining({ clineEnv: value.toLowerCase() }),
            )
        }
        expect(accountState.updateSettings).toHaveBeenCalledTimes(3)
    })

    it("translates the remote-config lock explanation but keeps the stored organization name", async () => {
        accountState.remoteConfigSettings = { usageReportingSetting: "disabled" }
        render(
            <Switcher>
                <ClineAccountView
                    activeOrganization={{
                        active: true,
                        memberId: "member-1",
                        organizationId: "org-1",
                        name: "Acme",
                        roles: ["admin"],
                    }}
                    clineEnv="Production"
                    clineUser={user}
                    userOrganizations={[
                        { active: true, memberId: "member-1", organizationId: "org-1", name: "Acme", roles: ["admin"] },
                    ]}
                />
            </Switcher>,
        )

        fireEvent.focus(screen.getByText("Acme").closest("button")!)
        const tooltip = await screen.findByRole("tooltip")
        expect(tooltip).toHaveTextContent("This cannot be changed while your organization has remote configuration enabled.")
        expect(screen.getByText("Acme")).toBeTruthy()

        await act(async () => switchLanguage())

        expect(screen.getByRole("tooltip")).toBe(tooltip)
        expect(tooltip).toHaveTextContent("当你的组织启用远程配置时，此项无法更改。")
        expect(screen.getByText("管理员")).toBeTruthy()
        expect(screen.getByText("Acme")).toBeTruthy()
    })

    it("translates the signed-out welcome and its legal links without changing the URLs", async () => {
        render(
            <Switcher>
                <AccountWelcomeView />
            </Switcher>,
        )

        const terms = screen.getByRole("link", { name: "Terms of Service" })
        expect(terms).toHaveAttribute("href", "https://dline.cc/terms")

        await act(async () => switchLanguage())

        expect(screen.getByRole("button", { name: "使用 Dline 注册" })).toBeTruthy()
        expect(screen.getByRole("link", { name: "服务条款" })).toHaveAttribute("href", "https://dline.cc/terms")
        expect(screen.getByRole("link", { name: "隐私政策" })).toHaveAttribute("href", "https://docs.dline.cc/privacy/")
        expect(terms.parentElement).toHaveTextContent("继续即表示你同意服务条款和隐私政策。")
    })

    it("translates the balance caption and add-credits action while keeping the amount", async () => {
        render(
            <Switcher>
                <CreditBalance
                    balance={125000}
                    creditUrl={new URL("https://app.example.test/account?tab=credits")}
                    fetchCreditBalance={vi.fn()}
                    isLoading={false}
                    lastFetchTime={new Date(2026, 0, 1, 10, 30).getTime()}
                />
            </Switcher>,
        )

        expect(screen.getByText("CURRENT BALANCE")).toBeTruthy()
        const amount = await screen.findByText(
            (_text, element) => element?.tagName === "SPAN" && element.textContent === "12.5000",
        )
        expect(screen.getByRole("button", { name: "Add Credits" })).toBeTruthy()

        await act(async () => switchLanguage())

        expect(screen.getByText("当前余额")).toBeTruthy()
        expect(amount).toHaveTextContent("12.5000")
        expect(screen.getByRole("button", { name: "充值额度" })).toBeTruthy()
    })

    it("translates the history tabs, headings and empty states while keeping the row data", async () => {
        render(
            <Switcher>
                <CreditsHistoryTable
                    isLoading={false}
                    paymentsData={[]}
                    showPayments
                    usageData={[
                        {
                            id: "usage-1",
                            createdAt: new Date(2026, 0, 1).toISOString(),
                            operation: "web_search",
                            aiModelName: "claude-sonnet-4-6",
                            creditsUsed: 1500000,
                            aiInferenceProviderName: "test-provider",
                            aiModelTypeName: "chat",
                            completionTokens: 50,
                            costUsd: 1.5,
                            generationId: "generation-1",
                            metadata: { additionalProp1: "", additionalProp2: "", additionalProp3: "" },
                            organizationId: "org-1",
                            promptTokens: 100,
                            totalTokens: 150,
                            userId: "user-1",
                        },
                    ]}
                />
            </Switcher>,
        )

        expect(screen.getByText("USAGE HISTORY")).toBeTruthy()
        expect(screen.getByText("Web Search")).toBeTruthy()
        expect(screen.getByText("$1.5000")).toBeTruthy()

        await act(async () => switchLanguage())

        expect(screen.getByText("用量历史")).toBeTruthy()
        expect(screen.getByText("网页搜索")).toBeTruthy()
        expect(screen.getByText("已用额度")).toBeTruthy()
        // The billed amount is a business value, so the digits do not change.
        expect(screen.getByText("$1.5000")).toBeTruthy()
    })

    it("keeps the payment history empty state translated independently of the usage tab", async () => {
        render(
            <Switcher>
                <CreditsHistoryTable isLoading={false} paymentsData={[]} showPayments usageData={[]} />
            </Switcher>,
        )

        fireEvent.click(screen.getByText("PAYMENTS HISTORY"))
        expect(screen.getByText("No payment history")).toBeTruthy()

        act(() => switchLanguage())
        expect(screen.getByText("暂无付款历史")).toBeTruthy()
    })
})
