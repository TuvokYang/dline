import { BUILTIN_INPUT_SEMANTICS } from "@shared/input-semantics/catalog"
import { lexSemanticInput } from "@shared/input-semantics/lexer"
import { act, render, renderHook, screen, waitFor } from "@testing-library/react"
import { useLayoutEffect } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useChatState } from "./useChatState"

afterEach(() => {
	vi.useRealTimers()
})

describe("useChatState task ownership", () => {
	it("reenables Welcome submission after the active task is closed", async () => {
		const { result, rerender } = renderHook(({ taskId }: { taskId?: string }) => useChatState([], taskId), {
			initialProps: { taskId: "task-1" as string | undefined },
		})

		act(() => result.current.setSendingDisabled(true))
		expect(result.current.sendingDisabled).toBe(true)

		rerender({ taskId: undefined })

		await waitFor(() => expect(result.current.sendingDisabled).toBe(false))
	})

	it("keeps submitted Welcome input undoable after the created task becomes active", () => {
		const { result, rerender } = renderHook(({ taskId }: { taskId?: string }) => useChatState([], taskId), {
			initialProps: { taskId: undefined },
		})

		act(() => {
			result.current.setInputValue("submitted task")
			result.current.setInputValue("")
			result.current.setSendingDisabled(true)
		})
		rerender({ taskId: "task-1" })
		expect(result.current.inputValue).toBe("")

		act(() => result.current.undoInputValue())
		expect(result.current.inputValue).toBe("submitted task")
	})

	it("settles task ownership before the switched task accepts a new draft", () => {
		function TaskDraftProbe({ taskId }: { taskId: string }) {
			const state = useChatState([], taskId)
			useLayoutEffect(() => {
				if (taskId === "task-2") state.setInputValue("task two draft")
			}, [state.setInputValue, taskId])
			return <textarea aria-label="Task draft" readOnly value={state.inputValue} />
		}

		const view = render(<TaskDraftProbe taskId="task-1" />)
		view.rerender(<TaskDraftProbe taskId="task-2" />)

		expect(screen.getByRole("textbox", { name: "Task draft" })).toHaveValue("task two draft")
	})

	it("restores a captured successor draft after the successor task becomes active", async () => {
		const { result, rerender } = renderHook(({ taskId }: { taskId: string }) => useChatState([], taskId), {
			initialProps: { taskId: "task-1" },
		})

		act(() => {
			result.current.setInputValue("unsent successor draft")
			result.current.setSelectedImages(["image"])
			result.current.setSelectedFiles(["file"])
			result.current.setActiveQuote("quote")
		})
		rerender({ taskId: "task-2" })
		await waitFor(() => expect(result.current.inputValue).toBe(""))

		act(() => {
			result.current.restoreDraft({
				text: "unsent successor draft",
				images: ["image"],
				files: ["file"],
				activeQuote: "quote",
			})
		})

		expect(result.current.inputValue).toBe("unsent successor draft")
		expect(result.current.selectedImages).toEqual(["image"])
		expect(result.current.selectedFiles).toEqual(["file"])
		expect(result.current.activeQuote).toBe("quote")

		rerender({ taskId: "task-3" })
		await waitFor(() => expect(result.current.inputValue).toBe(""))
	})
})

describe("useChatState input history", () => {
	it("groups adjacent typing and keeps edits separated by a pause", () => {
		vi.useFakeTimers()
		vi.setSystemTime(0)
		const { result } = renderHook(() => useChatState([]))

		act(() => result.current.setInputValue("h"))
		vi.advanceTimersByTime(100)
		act(() => result.current.setInputValue("he"))
		vi.advanceTimersByTime(1_000)
		act(() => result.current.setInputValue("hello"))

		act(() => result.current.undoInputValue())
		expect(result.current.inputValue).toBe("he")
		act(() => result.current.undoInputValue())
		expect(result.current.inputValue).toBe("")
	})

	it("redoes an undone edit and clears redo after new input", () => {
		vi.useFakeTimers()
		vi.setSystemTime(0)
		const { result } = renderHook(() => useChatState([]))

		act(() => result.current.setInputValue("first"))
		vi.advanceTimersByTime(1_000)
		act(() => result.current.setInputValue("second"))
		act(() => result.current.undoInputValue())
		expect(result.current.inputValue).toBe("first")

		act(() => result.current.redoInputValue())
		expect(result.current.inputValue).toBe("second")
		act(() => result.current.undoInputValue())
		act(() => result.current.setInputValue("replacement"))
		act(() => result.current.redoInputValue())
		expect(result.current.inputValue).toBe("replacement")
	})

	it("retains a submitted draft after the accepted interaction clears the input", () => {
		const { result } = renderHook(() => useChatState([]))

		act(() => result.current.setInputValue("submitted draft"))
		act(() => result.current.setInputValue(""))
		act(() => result.current.undoInputValue())

		expect(result.current.inputValue).toBe("submitted draft")
	})

	it("does not carry input history across an explicit ownership reset", () => {
		const { result } = renderHook(() => useChatState([]))

		act(() => result.current.setInputValue("other task draft"))
		act(() => result.current.resetInputValue())
		act(() => result.current.undoInputValue())

		expect(result.current.inputValue).toBe("")
	})

	it("bounds the number of retained edit groups", () => {
		vi.useFakeTimers()
		vi.setSystemTime(0)
		const { result } = renderHook(() => useChatState([]))

		for (let index = 1; index <= 105; index += 1) {
			vi.advanceTimersByTime(1_000)
			act(() => result.current.setInputValue(`entry-${index}`))
		}
		for (let index = 0; index < 101; index += 1) {
			act(() => result.current.undoInputValue())
		}

		expect(result.current.inputValue).toBe("entry-5")
	})
})

describe("useChatState paste provenance (WS-041 AC-09)", () => {
	const PASTED = { text: "/compact", spans: [{ start: 0, end: 8 }] }

	it("keeps a pasted candidate held when undo brings its text back", () => {
		vi.useFakeTimers()
		vi.setSystemTime(0)
		const { result } = renderHook(() => useChatState([]))

		act(() => {
			result.current.setInputValue(PASTED.text)
			result.current.commitPasteProvenance(PASTED)
		})
		vi.advanceTimersByTime(1_000)
		act(() => {
			result.current.setInputValue("")
			result.current.commitPasteProvenance({ text: "", spans: [] })
		})
		act(() => result.current.undoInputValue())

		expect(result.current.inputValue).toBe(PASTED.text)
		expect(result.current.pasteProvenance).toEqual(PASTED)
	})

	it("does not let a typed draft with the same text release an undone paste", () => {
		vi.useFakeTimers()
		vi.setSystemTime(0)
		const { result } = renderHook(() => useChatState([]))

		act(() => {
			result.current.setInputValue(PASTED.text)
			result.current.commitPasteProvenance(PASTED)
		})
		vi.advanceTimersByTime(1_000)
		act(() => {
			result.current.setInputValue("")
			result.current.commitPasteProvenance({ text: "", spans: [] })
		})
		vi.advanceTimersByTime(1_000)
		act(() => {
			result.current.setInputValue(PASTED.text)
			result.current.commitPasteProvenance({ text: PASTED.text, spans: [] })
		})
		expect(result.current.pasteProvenance.spans).toEqual([])

		act(() => result.current.undoInputValue())
		act(() => result.current.undoInputValue())

		expect(result.current.inputValue).toBe(PASTED.text)
		expect(result.current.pasteProvenance).toEqual(PASTED)
	})

	it("records the replaced provenance when an edit commits before it sets the text", () => {
		vi.useFakeTimers()
		vi.setSystemTime(0)
		const { result } = renderHook(() => useChatState([]))

		act(() => {
			result.current.setInputValue(PASTED.text)
			result.current.commitPasteProvenance(PASTED)
		})
		vi.advanceTimersByTime(1_000)
		// Menu confirmation commits the released text first, then sets it.
		act(() => {
			result.current.commitPasteProvenance({ text: "/cmd:compact", spans: [] })
			result.current.setInputValue("/cmd:compact")
		})
		act(() => result.current.undoInputValue())

		expect(result.current.inputValue).toBe(PASTED.text)
		expect(result.current.pasteProvenance).toEqual(PASTED)
	})

	it("forgets pasted spans when the draft changes owner", () => {
		const { result } = renderHook(() => useChatState([]))

		act(() => {
			result.current.setInputValue(PASTED.text)
			result.current.commitPasteProvenance(PASTED)
		})
		act(() => result.current.resetInputValue())
		act(() => result.current.setInputValue(PASTED.text))

		expect(result.current.pasteProvenance.spans).toEqual([])
	})

	it("carries held spans through an edit it did not observe", () => {
		const { result } = renderHook(() => useChatState([]))

		act(() => {
			result.current.setInputValue(PASTED.text)
			result.current.commitPasteProvenance(PASTED)
		})
		act(() => result.current.setInputValue(`${PASTED.text} now`))

		expect(result.current.pasteProvenance.spans).toEqual([{ start: 0, end: 8 }])
	})

	it("restores held spans from the document of a refused draft", () => {
		const { result } = renderHook(() => useChatState([]))
		const semanticInput = lexSemanticInput("/compact", {
			catalog: { revision: 1, descriptors: BUILTIN_INPUT_SEMANTICS },
			documentId: "doc-1",
			activation: "candidate_only",
		})

		act(() => {
			result.current.restoreDraft({ text: "/compact", images: [], files: [], activeQuote: null, semanticInput })
		})

		expect(result.current.inputValue).toBe("/compact")
		expect(result.current.pasteProvenance.spans).toEqual([{ start: 0, end: 8 }])
	})

	it("keeps a restored pasted fragment held when an edit completes it into a command", () => {
		const { result } = renderHook(() => useChatState([]))
		// A refused queue change restores the draft with the document it was composed with.
		const semanticInput = lexSemanticInput("/compac", {
			catalog: { revision: 1, descriptors: BUILTIN_INPUT_SEMANTICS },
			documentId: "doc-2",
			activation: "candidate_only",
		})

		act(() => {
			result.current.restoreDraft({ text: "/compac", images: [], files: [], activeQuote: null, semanticInput })
		})
		act(() => result.current.setInputValue("/compact"))

		expect(result.current.pasteProvenance.spans).toEqual([{ start: 0, end: 7 }])
	})

	it("holds the plain text of a restored draft that carries no document", () => {
		const { result } = renderHook(() => useChatState([]))

		act(() => {
			result.current.restoreDraft({ text: "/compact now", images: [], files: [], activeQuote: null })
		})

		// The typed command stays live; the rest cannot be told apart from a paste.
		expect(result.current.pasteProvenance.spans).toEqual([{ start: 8, end: 12 }])
	})
})
