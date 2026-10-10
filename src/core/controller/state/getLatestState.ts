import { EmptyRequest } from "@shared/proto/dline/common"
import { State } from "@shared/proto/dline/state"
import { accountUsageToProto } from "@shared/proto-conversions/account-usage-conversion"
import { Controller } from "../index"

/**
 * Get the latest extension state
 * @param controller The controller instance
 * @param request The empty request
 * @returns The current extension state
 */
export async function getLatestState(controller: Controller, _: EmptyRequest): Promise<State> {
    if (typeof controller.ensureWorkspaceManager === "function") {
        await controller.ensureWorkspaceManager()
    }
    // Get the state using the existing method
    const state = await controller.getStateToPostToWebview()
    const accountUsage = controller.getAccountUsage()

    // Convert the state to a JSON string
    const stateJson = JSON.stringify(state)

    // Return the state with accountUsage proto-serialized separately
    return State.create({
        stateJson,
        accountUsage: accountUsageToProto(accountUsage),
    })
}
