import type { DlineFeatureSettings } from "@shared/DlineFeatureSettings"
import type { UiLanguage } from "@shared/UiLanguage"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { type ReactNode, useState } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const onboardingState = vi.hoisted(() => ({
    accountEnabled: { featureFlag: true, user: true } as DlineFeatureSettings | undefined,
    hideAccount: vi.fn(),
    hideSettings: vi.fn(),
    setShowWelcome: vi.fn(),
}))

vi.mock("@/assets/DlineLogo", () => ({ default: () => <div data-testid="dline-logo" /> }))
vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({
        hideAccount: onboardingState.hideAccount,
        hideSettings: onboardingState.hideSettings,
        setShowWelcome: onboardingState.setShowWelcome,
        accountEnabled: onboardingState.accountEnabled,
        lazyTeammateModeEnabled: false,
        environment: "production",
    }),
}))
vi.mock("@/services/grpc-client", () => ({
    AccountServiceClient: { accountLoginClicked: vi.fn().mockResolvedValue({ value: "https://example.test" }) },
    StateServiceClient: { captureOnboardingProgress: vi.fn(), setWelcomeViewCompleted: vi.fn().mockResolvedValue({}) },
    UiServiceClient: { openWalkthrough: vi.fn() },
    TaskServiceClient: { newTask: vi.fn() },
}))
vi.mock("@/components/settings/sections/ApiConfigurationSection", () => ({
    default: () => <div data-testid="api-configuration" />,
}))

import OnboardingView from "@/components/onboarding/OnboardingView"
import HomeHeader from "@/components/welcome/HomeHeader"
import { SuggestedTasks } from "@/components/welcome/SuggestedTasks"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"

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

describe("onboarding language switching", () => {
    beforeEach(() => {
        onboardingState.accountEnabled = { featureFlag: true, user: true }
    })

    it("translates the step title, description, choices and CTAs in both directions", async () => {
        render(
            <Switcher>
                <OnboardingView />
            </Switcher>,
        )

        const continueButton = screen.getByRole("button", { name: "Continue" })
        expect(screen.getByRole("heading", { name: "How will you use Dline?" })).toBeTruthy()
        expect(screen.getByText("Select an option below to get started.")).toBeTruthy()
        expect(screen.getByText("Login / Sign up account")).toBeTruthy()
        expect(screen.getByText("You can change this later in settings")).toBeTruthy()

        await act(async () => switchLanguage())

        expect(screen.getByRole("button", { name: "继续" })).toBe(continueButton)
        expect(screen.getByRole("heading", { name: "你将如何使用 Dline？" })).toBeTruthy()
        expect(screen.getByText("在下方选择一个选项即可开始。")).toBeTruthy()
        expect(screen.getByText("登录 / 注册账户")).toBeTruthy()
        expect(screen.getByText("你稍后可以在设置中更改")).toBeTruthy()

        await act(async () => switchLanguage())
        expect(screen.getByRole("button", { name: "Continue" })).toBe(continueButton)
    })

    it("keeps the bring-your-own-key selection and its step when the language changes", async () => {
        render(
            <Switcher>
                <OnboardingView />
            </Switcher>,
        )

        fireEvent.click(screen.getByText("Bring your own API key"))
        fireEvent.click(screen.getByRole("button", { name: "Continue" }))
        expect(screen.getByTestId("api-configuration")).toBeTruthy()
        expect(screen.getByRole("heading", { name: "Configure your provider" })).toBeTruthy()

        await act(async () => switchLanguage())

        // The step and the API section stay mounted; only their copy changes.
        expect(screen.getByTestId("api-configuration")).toBeTruthy()
        expect(screen.getByRole("heading", { name: "配置你的服务提供方" })).toBeTruthy()
        expect(screen.getByRole("button", { name: "继续" })).toBeTruthy()
        expect(screen.getByRole("button", { name: "返回" })).toBeTruthy()
    })

    it("offers only bring-your-own-key while the account feature is off, in every language", () => {
        onboardingState.accountEnabled = { featureFlag: true, user: false }
        render(
            <Switcher>
                <OnboardingView />
            </Switcher>,
        )
        expect(screen.queryByText("Login / Sign up account")).toBeNull()

        act(() => switchLanguage())
        expect(screen.queryByText("登录 / 注册账户")).toBeNull()
        expect(screen.getByText("使用自己的 API 密钥")).toBeTruthy()
    })
})

describe("welcome surface language switching", () => {
    it("translates the home heading and the tour button", async () => {
        render(
            <Switcher>
                <HomeHeader shouldShowQuickWins />
            </Switcher>,
        )
        expect(screen.getByRole("heading", { name: "What can I do for you?" })).toBeTruthy()
        const tour = screen.getByRole("button", { name: /Take a Tour/ })

        await act(async () => switchLanguage())

        expect(screen.getByRole("heading", { name: "有什么可以帮你？" })).toBeTruthy()
        expect(screen.getByRole("button", { name: /快速导览/ })).toBe(tour)
    })

    it("translates quick-win labels while keeping the prompt sent to the model unchanged", async () => {
        const { newTask } = await import("@/services/grpc-client").then((module) => module.TaskServiceClient)
        render(
            <Switcher>
                <SuggestedTasks shouldShowQuickWins />
            </Switcher>,
        )

        expect(screen.getByText("Build a Next.js App")).toBeTruthy()
        expect(screen.getByText("Create a beautiful notetaking app with Next.js and Tailwind")).toBeTruthy()

        await act(async () => switchLanguage())

        expect(screen.getByText("构建 Next.js 应用")).toBeTruthy()
        expect(screen.getByText("用 Next.js 和 Tailwind 创建一个漂亮的笔记应用")).toBeTruthy()

        fireEvent.click(screen.getByText("构建 Next.js 应用"))

        // The prompt is model input: it stays byte-identical to the shipped one.
        expect(newTask).toHaveBeenCalledWith(
            expect.objectContaining({
                text: "Make a beautiful Next.js notetaking app, using Tailwind CSS for styling. Set up the basic structure and a simple UI for adding and viewing notes.",
            }),
        )
    })
})
