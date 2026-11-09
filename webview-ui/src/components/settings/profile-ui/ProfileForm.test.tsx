import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { ProfileDisclosure, ProfileField, ProfileForm, ProfileNotice, ProfileSection, ProfileSectionTitle } from "./ProfileForm"

describe("Profile UI primitives", () => {
    it("provides one consistent field hierarchy", () => {
        render(
            <ProfileForm data-testid="form">
                <ProfileSection>
                    <ProfileSectionTitle>Connection</ProfileSectionTitle>
                    <ProfileField description="Stored locally" error="Required" htmlFor="api-key" label="API Key">
                        <input id="api-key" />
                    </ProfileField>
                </ProfileSection>
            </ProfileForm>,
        )

        expect(screen.getByLabelText("API Key")).toBeInTheDocument()
    })

    it.each(["info", "warning", "error", "unavailable"] as const)("renders %s notices with explicit semantics", (variant) => {
        render(
            <ProfileNotice title="Compatibility" variant={variant}>
                Details
            </ProfileNotice>,
        )
        const notice = screen.getByText("Details").closest("div[role]")
        expect(notice).toHaveAttribute("role", variant === "error" ? "alert" : "status")
    })

    it("provides an accessible disclosure", () => {
        render(<ProfileDisclosure title="Advanced">Advanced settings</ProfileDisclosure>)
        const button = screen.getByRole("button", { name: "Advanced" })
        expect(button).toHaveAttribute("aria-expanded", "false")
        fireEvent.click(button)
        expect(button).toHaveAttribute("aria-expanded", "true")
        expect(screen.getByText("Advanced settings")).toBeVisible()
    })
})
