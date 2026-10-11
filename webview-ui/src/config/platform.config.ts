import platformConfigs from "./platform-configs.json"

export interface PlatformConfig {
    type: PlatformType
    messageEncoding: MessageEncoding
    showNavbar: boolean
    postMessage: PostMessageFunction
    encodeMessage: MessageEncoder
    decodeMessage: MessageDecoder
    togglePlanActKeys: string
    supportsTerminalMentions: boolean
}

export enum PlatformType {
    VSCODE = 0,
    STANDALONE = 1,
}

function stringToPlatformType(name: string): PlatformType {
    const mapping: Record<string, PlatformType> = {
        vscode: PlatformType.VSCODE,
        standalone: PlatformType.STANDALONE,
    }
    if (name in mapping) {
        return mapping[name]
    }
    console.error("Unknown platform:", name)
    // Default to VSCode for unknown types
    return PlatformType.VSCODE
}

// Internal type for JSON structure (not exported)
type PlatformConfigJson = {
    messageEncoding: "none" | "json"
    showNavbar: boolean
    postMessageHandler: "vscode" | "standalone"
    togglePlanActKeys: string
    supportsTerminalMentions: boolean
}

type PlatformConfigs = Record<string, PlatformConfigJson>

// Global type declarations for postMessage and vscode API
declare global {
    interface Window {
        // This is the post message handler injected by JetBrains.
        // !! Do not change the name of the handler without updating it on
        // the JetBrains side as well. !!
        standalonePostMessage?: (message: string) => void
    }
    function acquireVsCodeApi(): any
}

// Initialize the vscode API if available
const vsCodeApi = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null

// Listen for panel state persistence requests from the extension host.
// Calls acquireVsCodeApi().setState() so VSCode can restore this panel
// via WebviewPanelSerializer.deserializeWebviewPanel on next window reload.
window.addEventListener("message", (event) => {
    const message = event.data
    if (!message?.type) return
    try {
        // Answered here, before React mounts, so the host can tell a running
        // document from a blank one even when rendering has failed.
        if (message.type === "dlinePing") {
            vsCodeApi?.postMessage({ type: "dlinePong", nonce: message.nonce })
        } else if (message.type === "dlineSetPanelState" && message.taskId && vsCodeApi) {
            vsCodeApi.setState({ taskId: message.taskId })
        } else if (message.type === "dlineClearPanelState" && vsCodeApi) {
            vsCodeApi.setState({})
        }
    } catch (_e) {
        // Silently ignore — state persistence is best-effort
    }
})

// Notify the extension host that the webview is ready to receive state messages.
vsCodeApi?.postMessage({ type: "webviewReady" })

/**
 * Tell the extension host that the root component mounted. A script that runs
 * but fails to render still shows a blank view; only this signal proves it booted.
 */
export function announceWebviewMounted(): void {
    vsCodeApi?.postMessage({ type: "webviewMounted" })
}

// Implementations for post message handling
const postMessageStrategies: Record<string, PostMessageFunction> = {
    vscode: (message: any) => {
        if (vsCodeApi) {
            vsCodeApi.postMessage(message)
        } else {
            console.log("postMessage fallback: ", message)
        }
    },
    standalone: (message: any) => {
        if (!window.standalonePostMessage) {
            console.error("Standalone postMessage not found.")
            return
        }
        const json = JSON.stringify(message)
        console.log(`Standalone postMessage: ${json.slice(0, 200)}`)
        window.standalonePostMessage(json)
    },
}

// Implementations for message encoding
const messageEncoders: Record<string, MessageEncoder> = {
    none: <T>(message: T, _encoder: (_: T) => unknown) => message,
    json: <T>(message: T, encoder: (_: T) => unknown) => encoder(message),
}

// Implementations for message decoding
const messageDecoders: Record<string, MessageDecoder> = {
    none: <T>(message: any, _decoder: (_: { [key: string]: any }) => T) => message,
    json: <T>(message: any, decoder: (_: { [key: string]: any }) => T) => decoder(message),
}

// Local declaration of the platform compile-time constant
declare const __PLATFORM__: string

// Get the specific platform config at compile time
const configs = platformConfigs as PlatformConfigs
const selectedConfig = configs[__PLATFORM__]
console.log("[PLATFORM_CONFIG] Build platform:", __PLATFORM__)

// Build the platform config with injected functions
// Callers should use this in the situations where the react component is not available.
export const PLATFORM_CONFIG: PlatformConfig = {
    type: stringToPlatformType(__PLATFORM__),
    messageEncoding: selectedConfig.messageEncoding,
    showNavbar: selectedConfig.showNavbar,
    postMessage: postMessageStrategies[selectedConfig.postMessageHandler],
    encodeMessage: messageEncoders[selectedConfig.messageEncoding],
    decodeMessage: messageDecoders[selectedConfig.messageEncoding],
    togglePlanActKeys: selectedConfig.togglePlanActKeys,
    supportsTerminalMentions: selectedConfig.supportsTerminalMentions,
}

type MessageEncoding = "none" | "json"

// Function types for platform-specific behaviors
type PostMessageFunction = (message: any) => void
type MessageEncoder = <T>(message: T, encoder: (_: T) => unknown) => any
type MessageDecoder = <T>(message: any, decoder: (_: { [key: string]: any }) => T) => T
