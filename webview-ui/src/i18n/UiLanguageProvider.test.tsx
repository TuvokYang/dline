import { UI_LANGUAGE_LABELS } from "@shared/UiLanguage"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { memo, useCallback, useEffect, useMemo, useState } from "react"
import { createPortal } from "react-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { UiTranslator } from "./messages"
import { UiDocumentLanguage, UiLanguageProvider, useUiTranslation } from "./UiLanguageProvider"

let originalDocumentLanguage: string | null

beforeEach(() => {
    originalDocumentLanguage = document.documentElement.getAttribute("lang")
})

afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    if (originalDocumentLanguage === null) document.documentElement.removeAttribute("lang")
    else document.documentElement.lang = originalDocumentLanguage
})

function TranslatedControls() {
    const { language, t } = useUiTranslation()
    return (
        <section>
            <h1>{t("settings.title")}</h1>
            <button aria-label={t("settings.done")} type="button">
                {t("settings.done")}
            </button>
            <p>{t("settings.general.uiLanguage.followHost", { language: UI_LANGUAGE_LABELS[language] })}</p>
        </section>
    )
}

const DraftConsumer = memo(function DraftConsumer({
    onMount,
    onUnmount,
    onTranslatedClick,
}: {
    onMount: () => void
    onUnmount: () => void
    onTranslatedClick: (text: string) => void
}) {
    const { t } = useUiTranslation()
    const [draft, setDraft] = useState("")
    const done = useMemo(() => t("settings.done"), [t])
    const handleClick = useCallback(() => onTranslatedClick(t("settings.done")), [onTranslatedClick, t])
    useEffect(() => {
        onMount()
        return onUnmount
    }, [onMount, onUnmount])

    return (
        <section>
            <h1>{t("settings.title")}</h1>
            <textarea aria-label="Draft" onChange={(event) => setDraft(event.target.value)} value={draft} />
            <details>
                <summary>Details</summary>
                <p>{t("settings.general.uiLanguage.description")}</p>
            </details>
            <button aria-label={done} onClick={handleClick} type="button">
                {done}
            </button>
        </section>
    )
})

describe("controlled UI language context", () => {
    it("renders safely in English without an extension state provider", () => {
        render(<TranslatedControls />)
        expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument()
        expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument()
        expect(screen.getByText("Auto uses the VS Code display language (English).")).toBeInTheDocument()
    })

    it("keeps context and t stable for the same language and publishes a new value on a switch", () => {
        const observed: { language: string; t: UiTranslator }[] = []
        function Probe() {
            const translation = useUiTranslation()
            observed.push(translation)
            return <h1>{translation.t("settings.title")}</h1>
        }
        const view = render(
            <UiLanguageProvider language="en">
                <Probe />
            </UiLanguageProvider>,
        )
        view.rerender(
            <UiLanguageProvider language="en">
                <Probe />
            </UiLanguageProvider>,
        )
        expect(observed[1]).toBe(observed[0])
        expect(observed[1].t).toBe(observed[0].t)
        view.rerender(
            <UiLanguageProvider language="zh-CN">
                <Probe />
            </UiLanguageProvider>,
        )
        expect(observed[2]).not.toBe(observed[1])
        expect(observed[2].t).not.toBe(observed[1].t)
        expect(observed[2].language).toBe("zh-CN")
        expect(screen.getByRole("heading", { name: "设置" })).toBeInTheDocument()
        view.rerender(
            <UiLanguageProvider language="zh-CN">
                <Probe />
            </UiLanguageProvider>,
        )
        expect(observed[3]).toBe(observed[2])
        expect(observed[3].t).toBe(observed[2].t)
    })

    it("updates the same mounted memoized consumer in both directions without losing draft, focus, selection or disclosure", () => {
        const onMount = vi.fn()
        const onUnmount = vi.fn()
        const onTranslatedClick = vi.fn()
        const consumer = <DraftConsumer onMount={onMount} onTranslatedClick={onTranslatedClick} onUnmount={onUnmount} />
        const view = render(<UiLanguageProvider language="en">{consumer}</UiLanguageProvider>)
        const draft = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Draft" })
        const details = screen.getByText("Details").closest("details")
        expect(details).not.toBeNull()
        if (!details) throw new Error("Missing disclosure fixture")
        details.open = true
        fireEvent.change(draft, { target: { value: "Unsent draft 未发送 <code>raw</code>" } })
        draft.focus()
        draft.setSelectionRange(2, 8)

        view.rerender(<UiLanguageProvider language="zh-CN">{consumer}</UiLanguageProvider>)
        expect(screen.getByRole("heading", { name: "设置" })).toBeInTheDocument()
        expect(screen.getByRole("button", { name: "完成" })).toBeInTheDocument()
        expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft)
        expect(draft).toHaveValue("Unsent draft 未发送 <code>raw</code>")
        expect(draft).toHaveFocus()
        expect([draft.selectionStart, draft.selectionEnd]).toEqual([2, 8])
        expect(details.open).toBe(true)
        fireEvent.click(screen.getByRole("button", { name: "完成" }))
        expect(onTranslatedClick).toHaveBeenLastCalledWith("完成")

        view.rerender(<UiLanguageProvider language="en">{consumer}</UiLanguageProvider>)
        expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument()
        expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument()
        expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft)
        expect(draft).toHaveValue("Unsent draft 未发送 <code>raw</code>")
        expect(draft).toHaveFocus()
        expect([draft.selectionStart, draft.selectionEnd]).toEqual([2, 8])
        expect(details.open).toBe(true)
        fireEvent.click(screen.getByRole("button", { name: "Done" }))
        expect(onTranslatedClick).toHaveBeenLastCalledWith("Done")
        expect(onMount).toHaveBeenCalledTimes(1)
        expect(onUnmount).not.toHaveBeenCalled()
        view.unmount()
        expect(onUnmount).toHaveBeenCalledTimes(1)
    })

    it("takes language only from its controlled input and never writes browser persistence", () => {
        const setItem = vi.spyOn(Storage.prototype, "setItem")
        const view = render(
            <UiLanguageProvider language="zh-CN">
                <TranslatedControls />
            </UiLanguageProvider>,
        )
        expect(screen.getByRole("button", { name: "完成" })).toBeInTheDocument()
        expect(screen.getByText("自动模式使用 VS Code 显示语言（简体中文）。")).toBeInTheDocument()
        view.rerender(
            <UiLanguageProvider language="en">
                <TranslatedControls />
            </UiLanguageProvider>,
        )
        expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument()
        expect(setItem).not.toHaveBeenCalled()
    })

    it("does not update the root document unless the independent root effect is mounted", () => {
        document.documentElement.lang = "en"
        render(
            <UiLanguageProvider language="zh-CN">
                <TranslatedControls />
            </UiLanguageProvider>,
        )
        expect(screen.getByRole("heading", { name: "设置" })).toBeInTheDocument()
        expect(document.documentElement.lang).toBe("en")
    })

    it("synchronizes document lang through the root effect across both directions of switching", () => {
        const content = (
            <>
                <UiDocumentLanguage />
                <TranslatedControls />
            </>
        )
        const view = render(<UiLanguageProvider language="en">{content}</UiLanguageProvider>)
        expect(document.documentElement.lang).toBe("en")
        view.rerender(<UiLanguageProvider language="zh-CN">{content}</UiLanguageProvider>)
        expect(document.documentElement.lang).toBe("zh-CN")
        view.rerender(<UiLanguageProvider language="en">{content}</UiLanguageProvider>)
        expect(document.documentElement.lang).toBe("en")
    })

    it("updates portal text under the same context without interpreting dynamic HTML", () => {
        function PortalMessage() {
            const { t } = useUiTranslation()
            return createPortal(
                <p>{t("settings.general.uiLanguage.followHost", { language: "<strong>English</strong>" })}</p>,
                document.body,
            )
        }
        const view = render(
            <UiLanguageProvider language="en">
                <PortalMessage />
            </UiLanguageProvider>,
        )
        expect(screen.getByText("Auto uses the VS Code display language (<strong>English</strong>).")).toBeInTheDocument()
        expect(document.body.querySelector("strong")).toBeNull()
        view.rerender(
            <UiLanguageProvider language="zh-CN">
                <PortalMessage />
            </UiLanguageProvider>,
        )
        expect(screen.getByText("自动模式使用 VS Code 显示语言（<strong>English</strong>）。")).toBeInTheDocument()
        expect(document.body.querySelector("strong")).toBeNull()
    })
})
