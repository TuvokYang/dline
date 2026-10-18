import "@testing-library/jest-dom/vitest"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { UserInputMarkdownBody } from "./UserInputMarkdownBody"

describe("UserInputMarkdownBody", () => {
    it("renders Markdown inside the bounded direct-input scroll surface", () => {
        render(<UserInputMarkdownBody markdown={"# Heading\n\n- item"} testId="direct-body" variant="direct" />)

        const body = screen.getByTestId("direct-body")
        expect(screen.getByRole("heading", { name: "Heading" })).toBeInTheDocument()
        expect(screen.getByText("item")).toBeInTheDocument()
        expect(body).toHaveClass("overflow-y-auto", "max-h-[min(30vh,320px)]")
        // A short body must let the wheel chain to the chat list.
        expect(body).not.toHaveClass("overscroll-contain")
    })

    it("uses the smaller pending-queue height contract", () => {
        render(<UserInputMarkdownBody markdown="queued" testId="queued-body" variant="queued-pending" />)

        expect(screen.getByTestId("queued-body")).toHaveClass("max-h-[min(20vh,180px)]")
    })
})
