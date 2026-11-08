import { act, fireEvent, render, screen } from "@testing-library/react"
import type { Dropdown, Option } from "@vscode/webview-ui-toolkit"
import { VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import { describe, expect, it, vi } from "vitest"
import { LocalizedDropdown, LocalizedOption } from "./LocalizedDropdown"

/** No toolkit mock: exercise its real custom elements, shadow slot and option ARIA. */
async function flushToolkit() {
    await act(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })
}

function selectedSlot(dropdown: HTMLElement) {
    const slot = dropdown.shadowRoot?.querySelector<HTMLSlotElement>('slot[name="selected-value"]')
    expect(slot).toBeInstanceOf(HTMLSlotElement)
    return slot!
}

describe("LocalizedDropdown with the real toolkit", () => {
    it.each([
        "value",
        "currentValue",
    ] as const)("updates labels/ARIA both ways while preserving %s, identity, disabled and events", async (valueProp) => {
        const onChange = vi.fn()
        const onInput = vi.fn()
        const tree = (label: string) => (
            <LocalizedDropdown
                aria-label="Mode"
                disabled
                onChange={onChange}
                onInput={onInput}
                selectedLabel={label}
                {...{ [valueProp]: "backgroundExec" }}>
                <LocalizedOption label={label} value="backgroundExec" />
                <LocalizedOption disabled label="Raw model/id" value="raw" />
            </LocalizedDropdown>
        )
        const view = render(tree("Background Execution"))
        await flushToolkit()
        const host = screen.getByRole("combobox", { name: "Mode" }) as Dropdown
        const options = Array.from(host.querySelectorAll<Option>("vscode-option"))
        const span = host.querySelector('span[slot="selected-value"]')!
        const slot = selectedSlot(host)
        expect(slot.assignedNodes()).toEqual([span])
        expect(host.value).toBe("backgroundExec")
        expect(host.disabled).toBe(true)
        expect(options[1].disabled).toBe(true)

        for (const label of ["后台执行", "Background Execution"]) {
            view.rerender(tree(label))
            await flushToolkit()
            expect(screen.getByRole("combobox", { name: "Mode" })).toBe(host)
            expect(Array.from(host.querySelectorAll("vscode-option"))).toEqual(options)
            expect(host.querySelector('span[slot="selected-value"]')).toBe(span)
            expect(selectedSlot(host)).toBe(slot)
            expect(slot.assignedNodes()).toEqual([span])
            expect(span.textContent).toBe(label)
            expect(options[0]).toHaveTextContent(label)
            expect(options[0]).toHaveAttribute("aria-label", label)
            expect(options[1]).toHaveAttribute("aria-label", "Raw model/id")
            expect(host.value).toBe("backgroundExec")
            expect(host.disabled).toBe(true)
            expect(options[1].disabled).toBe(true)
            expect(onChange).not.toHaveBeenCalled()
            expect(onInput).not.toHaveBeenCalled()
        }
    })

    it("passes a user change through exactly once without replacing its event or business value", async () => {
        const onChange = vi.fn()
        const view = render(
            <LocalizedDropdown aria-label="Selection" onChange={onChange} selectedLabel="Default" value="">
                <LocalizedOption label="Default" value="" />
                <LocalizedOption label="Raw model/id" value="raw" />
            </LocalizedDropdown>,
        )
        await flushToolkit()
        const host = screen.getByRole("combobox", { name: "Selection" }) as Dropdown
        act(() => {
            host.value = "raw"
        })
        const event = new Event("change", { bubbles: true })
        fireEvent(host, event)
        expect(onChange).toHaveBeenCalledExactlyOnceWith(event)
        expect((onChange.mock.calls[0][0].target as Dropdown).value).toBe("raw")
        view.rerender(
            <LocalizedDropdown aria-label="Selection" onChange={onChange} selectedLabel="Raw model/id" value="raw">
                <LocalizedOption label="默认" value="" />
                <LocalizedOption label="Raw model/id" value="raw" />
            </LocalizedDropdown>,
        )
        await flushToolkit()
        expect(host.value).toBe("raw")
        expect(onChange).toHaveBeenCalledTimes(1)
    })

    it("treats an empty label as supplied and otherwise leaves fragmented children and the SDK fallback alone", async () => {
        const children = (
            <>
                <VSCodeOption value="raw">Raw SDK fallback</VSCodeOption>
            </>
        )
        const tree = (selectedLabel?: string) => (
            <LocalizedDropdown aria-label="Fallback" selectedLabel={selectedLabel} value="raw">
                {children}
            </LocalizedDropdown>
        )
        const view = render(tree())
        await flushToolkit()
        const host = screen.getByRole("combobox", { name: "Fallback" }) as Dropdown
        const option = host.querySelector("vscode-option")
        expect(host.querySelector('[slot="selected-value"]')).toBeNull()
        expect(selectedSlot(host).assignedNodes()).toEqual([])
        expect(selectedSlot(host)).toHaveTextContent("Raw SDK fallback")
        view.rerender(tree(""))
        await flushToolkit()
        const span = host.querySelector('[slot="selected-value"]')!
        expect(span.textContent).toBe("")
        expect(selectedSlot(host).assignedNodes()).toEqual([span])
        expect(host.querySelector("vscode-option")).toBe(option)
        expect(host.value).toBe("raw")
        view.rerender(tree())
        await flushToolkit()
        expect(host.querySelector('[slot="selected-value"]')).toBeNull()
        expect(selectedSlot(host).assignedNodes()).toEqual([])
    })

    it.each([
        "aria-label",
        "ariaLabel",
    ] as const)("preserves explicit option %s while its display label changes", async (ariaProp) => {
        const tree = (label: string, aria: string) => (
            <LocalizedDropdown aria-label="Explicit ARIA" selectedLabel={label} value="id">
                <LocalizedOption {...{ [ariaProp]: aria }} label={label} value="id" />
            </LocalizedDropdown>
        )
        const view = render(tree("Display", "Accessible display"))
        await flushToolkit()
        const option = screen.getByRole("option", { name: "Accessible display" })
        view.rerender(tree("展示", "可访问展示"))
        await flushToolkit()
        expect(screen.getByRole("option", { name: "可访问展示" })).toBe(option)
        expect(option).toHaveTextContent("展示")
        view.rerender(tree("Display", "Accessible display"))
        await flushToolkit()
        expect(screen.getByRole("option", { name: "Accessible display" })).toBe(option)
    })

    it("preserves an explicit empty option label and accessible name", async () => {
        const view = render(
            <LocalizedDropdown aria-label="Empty" selectedLabel="" value="">
                <LocalizedOption label="" value="" />
            </LocalizedDropdown>,
        )
        await flushToolkit()
        const option = view.container.querySelector("vscode-option")!
        expect(option.textContent).toBe("")
        expect(option).toHaveAttribute("aria-label", "")
    })

    it("reproduces the underlying plain-toolkit stale fallback/ARIA without the presentation layer", async () => {
        const tree = (label: string) => (
            <VSCodeDropdown aria-label="Plain SDK" value="id">
                <VSCodeOption value="id">{label}</VSCodeOption>
            </VSCodeDropdown>
        )
        const view = render(tree("Original"))
        await flushToolkit()
        const host = screen.getByRole("combobox", { name: "Plain SDK" })
        const option = host.querySelector("vscode-option")!
        view.rerender(tree("切换后"))
        await flushToolkit()
        expect(option).toHaveTextContent("切换后")
        expect(option).toHaveAttribute("aria-label", "Original")
        expect(selectedSlot(host)).toHaveTextContent("Original")
    })
})
