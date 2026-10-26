import { credentials } from "@grpc/grpc-js"
import { promisify } from "util"
import { AccountServiceClient } from "../../src/generated/grpc-js/dline/account"
import { BrowserServiceClient } from "../../src/generated/grpc-js/dline/browser"
import { CheckpointsServiceClient } from "../../src/generated/grpc-js/dline/checkpoints"
import { CommandsServiceClient } from "../../src/generated/grpc-js/dline/commands"
import { FileServiceClient } from "../../src/generated/grpc-js/dline/file"
import { McpServiceClient } from "../../src/generated/grpc-js/dline/mcp"
import { ModelsServiceClient } from "../../src/generated/grpc-js/dline/models"
import { SlashServiceClient } from "../../src/generated/grpc-js/dline/slash"
import { StateServiceClient } from "../../src/generated/grpc-js/dline/state"
import { TaskServiceClient } from "../../src/generated/grpc-js/dline/task"
import { UiServiceClient } from "../../src/generated/grpc-js/dline/ui"
import { WebServiceClient } from "../../src/generated/grpc-js/dline/web"

const serviceRegistry = {
    "dline.AccountService": AccountServiceClient,
    "dline.BrowserService": BrowserServiceClient,
    "dline.CheckpointsService": CheckpointsServiceClient,
    "dline.CommandsService": CommandsServiceClient,
    "dline.FileService": FileServiceClient,
    "dline.McpService": McpServiceClient,
    "dline.ModelsService": ModelsServiceClient,
    "dline.SlashService": SlashServiceClient,
    "dline.StateService": StateServiceClient,
    "dline.TaskService": TaskServiceClient,
    "dline.UiService": UiServiceClient,
    "dline.WebService": WebServiceClient,
} as const

export type ServiceClients = {
    -readonly [K in keyof typeof serviceRegistry]: InstanceType<(typeof serviceRegistry)[K]>
}

export class GrpcAdapter {
    private clients: Partial<ServiceClients> = {}

    constructor(address: string) {
        for (const [name, Client] of Object.entries(serviceRegistry)) {
            this.clients[name as keyof ServiceClients] = new (Client as any)(address, credentials.createInsecure())
        }
    }

    async call(service: keyof ServiceClients, method: string, request: any): Promise<any> {
        const client = this.clients[service]
        if (!client) {
            throw new Error(`No gRPC client registered for service: ${String(service)}`)
        }

        const fn = (client as any)[method]
        if (typeof fn !== "function") {
            throw new Error(`Method ${method} not found on service ${String(service)}`)
        }

        try {
            const fnAsync = promisify(fn).bind(client)
            const response = await fnAsync(request.message)
            return response?.toObject ? response.toObject() : response
        } catch (error) {
            console.error(`[GrpcAdapter] ${service}.${method} failed:`, error)
            throw error
        }
    }

    close(): void {
        for (const client of Object.values(this.clients)) {
            if (client && typeof (client as any).close === "function") {
                ;(client as any).close()
            }
        }
    }
}
