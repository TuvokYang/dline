export type WebviewMessage =
    | { type: "webviewReady" }
    /** The root component mounted; liveness treats only this as a booted document. */
    | { type: "webviewMounted" }
    /** Liveness answer to a host `dlinePing`, echoing its nonce; sent before React mounts. */
    | { type: "dlinePong"; nonce?: string }
    | { type: "grpc_request"; grpc_request?: GrpcRequest }
    | { type: "grpc_request_cancel"; grpc_request_cancel?: GrpcCancel }

export type GrpcRequest = {
    service: string
    method: string
    message: any // JSON serialized protobuf message
    request_id: string // For correlating requests and responses
    is_streaming: boolean // Whether this is a streaming request
}

export type GrpcCancel = {
    request_id: string // ID of the request to cancel
}

export type ClineAskResponse = "yesButtonClicked" | "noButtonClicked" | "messageResponse"

export type ClineCheckpointRestore = "task" | "workspace" | "taskAndWorkspace"

export type TaskFeedbackType = "thumbs_up" | "thumbs_down"
