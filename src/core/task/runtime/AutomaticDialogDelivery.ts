import type { DialogAutomaticResponseCommand } from "../kernel"
import type { CommandExecutor } from "./contracts"

export interface AutomaticDialogDeliveryPort {
    deliver(command: DialogAutomaticResponseCommand): Promise<void>
}

const AUTOMATIC_DELIVERY_ATTEMPTS = 3

/** Route only committed automatic responses; ordinary dialog effects retain their existing owner. */
export function withAutomaticDialogDelivery(
    executor: CommandExecutor,
    port: AutomaticDialogDeliveryPort | undefined,
    permitted: () => boolean,
    recoverDurability: () => Promise<void>,
): CommandExecutor {
    if (executor.domain !== "dialog") return executor
    return {
        domain: "dialog",
        execute: (command) => {
            if (command.type !== "dialog.deliver_automatic") return executor.execute(command)
            if (!port) return Promise.reject(new Error("Automatic dialog delivery port is unavailable"))
            return deliverAcceptedResponse(command, port, permitted, recoverDurability)
        },
    }
}

/** Retry the same accepted response, never the deadline or the tool. Persistent failure stays recoverable. */
async function deliverAcceptedResponse(
    command: DialogAutomaticResponseCommand,
    port: AutomaticDialogDeliveryPort,
    permitted: () => boolean,
    recoverDurability: () => Promise<void>,
): Promise<void> {
    for (let attempt = 0; attempt < AUTOMATIC_DELIVERY_ATTEMPTS; attempt++) {
        if (!permitted()) throw new Error("Automatic dialog delivery no longer owns the task")
        try {
            // A prior delivery may have applied its event before its durable write failed.
            if (attempt > 0) await recoverDurability()
            if (!permitted()) throw new Error("Automatic dialog delivery no longer owns the task")
            await port.deliver(command)
            if (!permitted()) throw new Error("Automatic dialog delivery no longer owns the task")
            return
        } catch (error) {
            if (!permitted() || attempt === AUTOMATIC_DELIVERY_ATTEMPTS - 1) throw error
        }
    }
}
