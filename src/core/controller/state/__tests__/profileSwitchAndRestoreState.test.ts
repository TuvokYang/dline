import { PlanActMode, ProfileSwitchRequest, ProfileSwitchStatus } from "@shared/proto/dline/state"
import { describe, expect, it, vi } from "vitest"
import { Controller } from "../.."
import { requestProfileSwitch } from "../requestProfileSwitch"

describe("Profile switch StateService handlers", () => {
    it("maps ordered target modes into the task-local Profile transaction", async () => {
        const controller = Object.create(Controller.prototype) as Controller
        const request = vi.spyOn(controller, "requestProfileSwitch").mockResolvedValue({
            status: "confirmation_required",
            operationId: "profile-operation-1",
        })

        const response = await requestProfileSwitch(
            controller,
            ProfileSwitchRequest.create({
                targetProfile: "small-profile",
                targetModes: [PlanActMode.PLAN, PlanActMode.ACT],
            }),
        )

        expect(request).toHaveBeenCalledWith("small-profile", ["plan", "act"], undefined)
        expect(response.status).toBe(ProfileSwitchStatus.PROFILE_SWITCH_STATUS_CONFIRMATION_REQUIRED)
        expect(response.operationId).toBe("profile-operation-1")
    })
})
