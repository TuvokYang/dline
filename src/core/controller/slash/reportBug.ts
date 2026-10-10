import { Empty, StringRequest } from "@shared/proto/dline/common"
import { AskResponseRequest } from "@shared/proto/dline/task"
import { Controller } from ".."
import { askResponse } from "../task/askResponse"

/**
 * Report bug slash command logic
 */
export async function reportBug(controller: Controller, _request: StringRequest): Promise<Empty> {
    await askResponse(controller, AskResponseRequest.create({ responseType: "yesButtonClicked" }))
    return Empty.create()
}
