import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import NewTaskButton from "./NewTaskButton"

describe("NewTaskButton", () => {
	it("exposes the task-closing action and invokes it", async () => {
		const onClick = vi.fn(async () => undefined)
		render(<NewTaskButton onClick={onClick} />)

		fireEvent.click(screen.getByRole("button", { name: "Close Task" }))

		expect(onClick).toHaveBeenCalledOnce()
		await waitFor(() => expect(screen.getByRole("button", { name: "Close Task" })).toHaveAttribute("aria-busy", "false"))
	})

	it("shows closing progress and ignores repeated clicks until the close settles", async () => {
		let finishClose!: () => void
		const onClick = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishClose = resolve
				}),
		)
		render(<NewTaskButton onClick={onClick} />)
		const button = screen.getByRole("button", { name: "Close Task" })

		fireEvent.click(button)
		fireEvent.click(button)
		expect(onClick).toHaveBeenCalledOnce()
		expect(button).toBeDisabled()
		expect(button).toHaveAttribute("aria-busy", "true")

		await act(async () => finishClose())
		expect(button).not.toBeDisabled()
	})

	it("shows a safe failure and allows a deliberate retry", async () => {
		const onClick = vi.fn().mockRejectedValueOnce(new Error("secret-token")).mockResolvedValueOnce(undefined)
		render(<NewTaskButton onClick={onClick} />)
		const button = screen.getByRole("button", { name: "Close Task" })

		fireEvent.click(button)
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not close"))
		expect(screen.getByRole("alert")).not.toHaveTextContent("secret-token")
		expect(button).not.toBeDisabled()

		fireEvent.click(button)
		await waitFor(() => expect(onClick).toHaveBeenCalledTimes(2))
		expect(screen.queryByRole("alert")).not.toBeInTheDocument()
	})
})
