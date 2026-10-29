import { act, fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { DiffEditRow } from "./DiffEditRow"

vi.mock("@/components/common/CodeAccordian", () => ({
    default: ({ code }: { code: string }) => <pre>{code}</pre>,
}))

vi.mock("@/lib/utils", () => ({
    cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(" "),
}))

vi.mock("@/services/grpc-client", () => ({
    FileServiceClient: {
        openFileRelativePath: vi.fn(),
    },
}))

/**
 * Build a streaming diff patch with deterministic line content.
 *
 * @param lineCount Number of added lines to include.
 * @returns Patch text rendered by DiffEditRow.
 */
function buildPatch(lineCount: number): string {
    return Array.from({ length: lineCount }, (_, index) => `+ streamed line ${index + 1}`).join("\n")
}

/**
 * Find the internal scroll container used by a rendered diff file block.
 *
 * @param root Rendered test root element.
 * @returns Internal diff scroll container element.
 */
function findScrollBox(root: HTMLElement): HTMLElement {
    const element = root.querySelector(".max-h-80.overflow-y-auto")
    if (!(element instanceof HTMLElement)) {
        throw new Error("Diff scroll container was not rendered")
    }
    return element
}

/**
 * Override jsdom layout metrics for a scroll container.
 *
 * @param element Scroll container element.
 * @param scrollHeight Full content height.
 * @param clientHeight Visible viewport height.
 */
function setScrollMetrics(element: HTMLElement, scrollHeight: number, clientHeight: number): void {
    Object.defineProperty(element, "scrollHeight", { configurable: true, value: scrollHeight })
    Object.defineProperty(element, "clientHeight", { configurable: true, value: clientHeight })
}

describe("DiffEditRow", () => {
    it("keeps streaming diff content scrolled to the latest line", async () => {
        const { container, rerender } = render(
            <DiffEditRow fileAction="Update" isLoading={true} patch={buildPatch(6)} path="src/example.ts" />,
        )
        const scrollBox = findScrollBox(container)
        setScrollMetrics(scrollBox, 600, 200)
        scrollBox.scrollTop = 0

        await act(async () => {
            rerender(<DiffEditRow fileAction="Update" isLoading={true} patch={buildPatch(12)} path="src/example.ts" />)
        })

        expect(scrollBox.scrollTop).toBe(400)
    })

    it("does not force streaming diff content back to bottom after manual scroll up", async () => {
        const { container, rerender } = render(
            <DiffEditRow fileAction="Update" isLoading={true} patch={buildPatch(6)} path="src/example.ts" />,
        )
        const scrollBox = findScrollBox(container)
        setScrollMetrics(scrollBox, 600, 200)
        scrollBox.scrollTop = 100

        await act(async () => {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        })
        fireEvent.scroll(scrollBox)

        await act(async () => {
            rerender(<DiffEditRow fileAction="Update" isLoading={true} patch={buildPatch(12)} path="src/example.ts" />)
        })

        expect(scrollBox.scrollTop).toBe(100)
    })

    it("renders every file from one multi-file Add patch", () => {
        const patch = [
            "*** Begin Patch",
            "*** Add File: first.txt",
            "+alpha",
            "*** Add File: second.txt",
            "+beta",
            "+gamma",
            "*** End Patch",
        ].join("\n")

        render(<DiffEditRow fileAction="Add" patch={patch} path="first.txt" />)

        expect(screen.getByTestId("diff-edit-scroll")).toHaveClass("max-h-[60vh]", "overflow-y-auto", "overscroll-x-contain")
        expect(screen.getByText("first.txt")).toBeInTheDocument()
        expect(screen.getByText("second.txt")).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: /first\.txt/ }))
        fireEvent.click(screen.getByRole("button", { name: /second\.txt/ }))
        expect(screen.getByText("alpha")).toHaveClass("text-green-400")
        expect(screen.getByText("beta")).toHaveClass("text-green-400")
        expect(screen.getByText("gamma")).toHaveClass("text-green-400")
    })

    it("keeps a user collapse while the stream keeps sending frames", async () => {
        const { container, rerender } = render(
            <DiffEditRow fileAction="Update" isLoading={true} patch={buildPatch(6)} path="src/example.ts" />,
        )
        expect(container.querySelector(".max-h-80.overflow-y-auto")).not.toBeNull()

        fireEvent.click(screen.getByRole("button", { name: /src\/example\.ts/ }))
        expect(container.querySelector(".max-h-80.overflow-y-auto")).toBeNull()

        await act(async () => {
            rerender(<DiffEditRow fileAction="Update" isLoading={true} patch={buildPatch(12)} path="src/example.ts" />)
        })

        // Auto-expansion used to reassert itself on every streamed frame, which
        // reopened the card the user had just closed.
        expect(container.querySelector(".max-h-80.overflow-y-auto")).toBeNull()
    })

    it("keeps the expansion state while a block error appears and clears", async () => {
        const patch = "- old line\n+ new line"
        const { container, rerender } = render(
            <DiffEditRow
                blockErrors={[undefined]}
                fileAction="Update"
                isLoading={false}
                patch={patch}
                path="src/example.ts"
                startLineNumbers={[1]}
            />,
        )

        fireEvent.click(screen.getByRole("button", { name: /src\/example\.ts/ }))
        expect(container.querySelector(".max-h-80.overflow-y-auto")).not.toBeNull()

        await act(async () => {
            rerender(
                <DiffEditRow
                    blockErrors={["SEARCH not found in file"]}
                    fileAction="Update"
                    isLoading={false}
                    patch={patch}
                    path="src/example.ts"
                    startLineNumbers={[0]}
                />,
            )
        })

        expect(screen.getByText("SEARCH not found in file")).toBeInTheDocument()

        await act(async () => {
            rerender(
                <DiffEditRow
                    blockErrors={[undefined]}
                    fileAction="Update"
                    isLoading={false}
                    patch={patch}
                    path="src/example.ts"
                    startLineNumbers={[1]}
                />,
            )
        })

        // The card must stay open across the error transition; toggling it shut
        // and open again is the flicker this guards against.
        expect(container.querySelector(".max-h-80.overflow-y-auto")).not.toBeNull()
    })

    it("stays expanded when streaming completes instead of collapsing", async () => {
        const { container, rerender } = render(
            <DiffEditRow fileAction="Update" isLoading={true} patch={buildPatch(6)} path="src/example.ts" />,
        )
        // Streaming: the diff body is expanded.
        expect(container.querySelector(".max-h-80.overflow-y-auto")).not.toBeNull()

        await act(async () => {
            rerender(<DiffEditRow fileAction="Update" isLoading={false} patch={buildPatch(6)} path="src/example.ts" />)
        })

        // Completion must not force the diff closed; collapsing right when a batch
        // of parallel replace_in_file cards finishes caused visible layout jumps.
        expect(container.querySelector(".max-h-80.overflow-y-auto")).not.toBeNull()
    })
})
