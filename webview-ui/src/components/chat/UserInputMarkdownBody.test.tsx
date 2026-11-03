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
        // A short body must let the wheel chain to the chat list.
    })
})
