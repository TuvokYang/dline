import type { UiMessage } from "@shared/ExtensionMessage"

/** Delivers an in-memory chat row to the active Webview before it is durable. */
export interface RealtimeMessagePublisher {
    publish(row: UiMessage): void
}
