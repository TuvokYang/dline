import { Controller } from "@core/controller"
import { askResponse } from "@core/controller/task/askResponse"
import { sendChatButtonClickedEvent } from "@core/controller/ui/subscribeToChatButtonClicked"
import { AskResponseRequest } from "@shared/proto/dline/task"
import { Logger } from "@/shared/services/Logger"
import { ClineAPI } from "./cline"

export function createClineAPI(sidebarController: Controller): ClineAPI {
    const api: ClineAPI = {
        startNewTask: async (task?: string, images?: string[]) => {
            await sidebarController.clearTask({ clearPanelState: true })
            await sidebarController.postStateToWebview()

            await sendChatButtonClickedEvent(sidebarController)
            await sidebarController.initTask(task, images)
        },

        sendMessage: async (message?: string, images?: string[]) => {
            if (sidebarController.task) {
                await askResponse(
                    sidebarController,
                    AskResponseRequest.create({ responseType: "messageResponse", text: message || "", images: images || [] }),
                )
            } else {
                Logger.error("No active task to send message to")
            }
        },

        pressPrimaryButton: async () => {
            if (sidebarController.task) {
                await askResponse(sidebarController, AskResponseRequest.create({ responseType: "yesButtonClicked" }))
            } else {
                Logger.error("No active task to press button for")
            }
        },

        pressSecondaryButton: async () => {
            if (sidebarController.task) {
                await askResponse(sidebarController, AskResponseRequest.create({ responseType: "noButtonClicked" }))
            } else {
                Logger.error("No active task to press button for")
            }
        },
    }

    return api
}
