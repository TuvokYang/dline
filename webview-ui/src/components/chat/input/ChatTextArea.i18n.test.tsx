import { BUILTIN_INPUT_SEMANTICS, type InputSemanticCatalog } from "@shared/input-semantics/catalog"
import type { UiLanguage } from "@shared/UiLanguage"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { useLayoutEffect } from "react"
import { describe, expect, it, vi } from "vitest"
import { UiLanguageProvider, useUiTranslation } from "@/i18n/UiLanguageProvider"
import ChatTextArea from "../ChatTextArea"
import { createCommandAtom } from "./semantic-composer/atoms"
import { readModelSelection, writeModelSelection } from "./semantic-composer/dom"
import type { ComposerSegment } from "./semantic-composer/model"
import { type ComposerSendDraft, captureComposerSend } from "./semantic-composer/send-draft"
import { type ComposerDraft, useComposerDraft } from "./semantic-composer/useComposerDraft"

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({ mode: "act", modeSwitch: { phase: "idle" }, stateRevision: 1, platform: "win32" }),
}))
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ togglePlanActKeys: "Meta+." }) }))
vi.mock("@/utils/hooks", () => ({ useMetaKeyDetection: () => [false, "Ctrl"], useShortcut: () => undefined }))
vi.mock("../task-header/ModelSwitcher", () => ({ default: () => null }))
vi.mock("../ServersToggleModal", () => ({ default: () => null }))
vi.mock("../UsageBar", () => ({ UsageBar: () => null }))
vi.mock("@/components/agent-capabilities/ClineRulesToggleModal", () => ({ default: () => null }))
vi.mock("./ChatInputRuntimeControls", () => ({ ChatInputRuntimeControls: () => null }))
vi.mock("./useComposerMenus", () => ({
    useComposerMenus: () => ({
        slash: { open: false },
        mention: { open: false },
        handleKeyDown: () => false,
        onEditorBlur: () => undefined,
    }),
}))
vi.mock("./useComposerResourceInput", () => ({
    useComposerResourceInput: () => ({
        handleDrop: () => undefined,
        handlePaste: () => undefined,
        handlePastedText: () => false,
        selectResources: () => undefined,
    }),
}))

const CATALOG: InputSemanticCatalog = { revision: 1, descriptors: BUILTIN_INPUT_SEMANTICS }

/** The draft owner is real; only unrelated menus/host controls are stubbed. */
function ComposerHarness({
    initial,
    expose,
    onSend,
}: {
    initial: readonly ComposerSegment[]
    expose: (draft: ComposerDraft) => void
    onSend: (draft: ComposerSendDraft) => void
}) {
    const composer = useComposerDraft()
    const { t } = useUiTranslation()
    expose(composer)
    useLayoutEffect(() => {
        composer.load(initial)
    }, [composer.load, initial])
    return (
        <ChatTextArea
            attachmentsDisabled={false}
            composer={composer}
            imagesAllowed
            onSend={onSend}
            placeholderText={t("chatInput.view.taskPlaceholder")}
            semanticCatalog={CATALOG}
            sendingDisabled={false}
        />
    )
}

function setSelection(root: HTMLElement, selection: { anchor: number; focus: number }) {
    act(() => {
        root.focus()
        writeModelSelection(root, selection)
        document.dispatchEvent(new Event("selectionchange"))
    })
}

describe("chat composer language reactivity", () => {
    it("switches both ways in the same tree without replacing draft, text/chip nodes, focus, selection or send meaning", () => {
        const command = createCommandAtom(CATALOG, "command.compact", "/cmd:compact")
        if (!command) throw new Error("Built-in compact command required")
        const initial: readonly ComposerSegment[] = [
            { kind: "atom", atom: command },
            { kind: "text", text: " Receiving 用户原文 /not-a-command", source: "pasted" },
        ]
        const onSend = vi.fn()
        let composer!: ComposerDraft
        const expose = (next: ComposerDraft) => {
            composer = next
        }
        const tree = (language: UiLanguage) => (
            <UiLanguageProvider language={language}>
                <ComposerHarness expose={expose} initial={initial} onSend={onSend} />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        const editor = screen.getByRole("textbox", { name: "Message input" })
        setSelection(editor, { anchor: 4, focus: 11 })
        const before = composer.engine.getState()
        const identity = { draftId: composer.draftId, documentId: composer.documentId }
        const chip = editor.querySelector("[data-composer-atom]")
        const textNode = editor.querySelector("[data-composer-text]")?.firstChild
        const expected = captureComposerSend(before.segments, { catalog: CATALOG, documentId: identity.documentId })
        expect(expected.ok).toBe(true)

        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("textbox", { name: "消息输入框" })).toBe(editor)
        expect(editor).toHaveAttribute("aria-placeholder", "在此输入任务…")
        expect(screen.getByRole("button", { name: "添加上下文" })).toBeInTheDocument()
        expect(chip).toHaveAttribute("aria-label", "命令 /cmd:compact")
        expect(editor.querySelector("[data-composer-atom]")).toBe(chip)
        expect(editor.querySelector("[data-composer-text]")?.firstChild).toBe(textNode)
        expect(document.activeElement).toBe(editor)
        expect(readModelSelection(editor)).toEqual({ anchor: 4, focus: 11 })
        expect(composer.engine.getState()).toBe(before)
        expect({ draftId: composer.draftId, documentId: composer.documentId }).toEqual(identity)
        fireEvent.click(screen.getByRole("button", { name: "发送消息" }))
        if (expected.ok) expect(onSend).toHaveBeenLastCalledWith(expected.draft)

        setSelection(editor, { anchor: 4, focus: 11 })
        view.rerender(tree("en"))
        expect(screen.getByRole("textbox", { name: "Message input" })).toBe(editor)
        expect(chip).toHaveAttribute("aria-label", "Command /cmd:compact")
        expect(readModelSelection(editor)).toEqual({ anchor: 4, focus: 11 })
        expect(composer.engine.getState().segments).toBe(before.segments)
        fireEvent.click(screen.getByRole("button", { name: "Send message" }))
        expect(onSend).toHaveBeenCalledTimes(2)
        expect(onSend.mock.calls[1][0]).toEqual(onSend.mock.calls[0][0])
        expect(onSend.mock.calls[0][0].semanticInput.documentId).toBe(identity.documentId)
        expect(onSend.mock.calls[0][0].text).toContain("Receiving 用户原文 /not-a-command")
    })

    it.each([
        ["semantic_input_resource_stage_failed", "The attachment could not be staged.", "无法暂存此附件。"],
        ["semantic_input_resource_missing", "The attachment is no longer available.", "此附件已不可用。"],
    ])("retranslates the owned %s failure without rewriting the retained resource", (code, english, chinese) => {
        const initial: readonly ComposerSegment[] = [
            {
                kind: "atom",
                atom: {
                    kind: "resource",
                    entityId: "owned-failure",
                    nodeKind: "file",
                    fileOrigin: "uploaded_file",
                    displayName: "Receiving.log",
                    status: "failed",
                    error: { code, message: "ORIGINAL stored diagnostic" },
                },
            },
        ]
        let composer!: ComposerDraft
        const expose = (next: ComposerDraft) => {
            composer = next
        }
        const onSend = vi.fn()
        const tree = (language: UiLanguage) => (
            <UiLanguageProvider language={language}>
                <ComposerHarness expose={expose} initial={initial} onSend={onSend} />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        const chip = screen.getByRole("group", { name: new RegExp(english) })
        const before = composer.engine.getState()
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("group", { name: new RegExp(chinese) })).toBe(chip)
        expect(chip).toHaveAttribute("title", `Receiving.log：${chinese}`)
        expect(composer.engine.getState()).toBe(before)
        view.rerender(tree("en"))
        expect(chip).toHaveAttribute("title", `Receiving.log: ${english}`)
        expect(composer.engine.getState().segments).toBe(before.segments)
        expect(onSend).not.toHaveBeenCalled()
    })

    it("keeps a refused draft and its original host diagnostic while chip actions and notices change language", () => {
        const initial: readonly ComposerSegment[] = [
            {
                kind: "atom",
                atom: {
                    kind: "resource",
                    entityId: "attachment-1",
                    nodeKind: "file",
                    fileOrigin: "uploaded_file",
                    displayName: "Receiving.log",
                    status: "failed",
                    error: { code: "host_error", message: "RAW host diagnostic", retryable: true },
                },
            },
        ]
        let composer!: ComposerDraft
        const expose = (next: ComposerDraft) => {
            composer = next
        }
        const onSend = vi.fn()
        const tree = (language: UiLanguage) => (
            <UiLanguageProvider language={language}>
                <ComposerHarness expose={expose} initial={initial} onSend={onSend} />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        fireEvent.click(screen.getByRole("button", { name: "Send message" }))
        expect(screen.getByRole("status")).toHaveTextContent("An attachment could not be added.")
        const before = composer.engine.getState()
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("status")).toHaveTextContent("无法添加某个附件")
        expect(screen.getByRole("button", { name: "重试 Receiving.log" })).toBeInTheDocument()
        expect(screen.getByRole("group", { name: /RAW host diagnostic/ })).toHaveAttribute(
            "title",
            "Receiving.log：RAW host diagnostic",
        )
        expect(composer.engine.getState()).toBe(before)
        expect(onSend).not.toHaveBeenCalled()
        view.rerender(tree("en"))
        expect(screen.getByRole("button", { name: "Retry Receiving.log" })).toBeInTheDocument()
        expect(screen.getByRole("status")).toHaveTextContent("An attachment could not be added.")
    })
})
