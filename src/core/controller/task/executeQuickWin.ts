import { Empty } from "@shared/proto/dline/common"
import { ExecuteQuickWinRequest } from "@shared/proto/dline/task"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"

/**
 * Executes a quick win task with command and title
 * @param controller The controller instance
 * @param request The execute quick win request
 * @returns Empty response
 *
 * @example
 * // Usage from webview:
 * import { TaskServiceClient } from "@/services/grpc-client"
 * import { ExecuteQuickWinRequest } from "@shared/proto/dline/task"
 *
 * const request: ExecuteQuickWinRequest = {
 *   command: "npm install",
 *   title: "Install dependencies"
 * }
 *
 * TaskServiceClient.executeQuickWin(request)
 *   .then(() => Logger.log("Quick win executed successfully"))
 *   .catch(error => Logger.error("Failed to execute quick win:", error))
 */
export async function executeQuickWin(controller: Controller, request: ExecuteQuickWinRequest): Promise<Empty> {
    try {
        const { command, title } = request
        // The command and title are user content; only their shape reaches the log channel.
        Logger.log(`Received executeQuickWin: commandChars=${command.length} titleChars=${title.length}`)
        await controller.initTask(title)
        return Empty.create({})
    } catch (error) {
        Logger.error("Failed to execute quick win:", error)
        throw error
    }
}
