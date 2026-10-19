import { envFlagEnabled } from "../env"
import { formatDiagnosticArgument, redactDiagnosticString, toSafeDiagnosticValue } from "./logging/safe-diagnostic-value"

export type StructuredLogLevel = "error" | "warn"

export interface StructuredLogRecord {
    readonly level: StructuredLogLevel
    readonly message: string
    readonly args: readonly string[]
    /** Safely normalized non-Error arguments retained as structured telemetry metadata. */
    readonly metadata: readonly unknown[]
    readonly error?: Error
}

/**
 * Simple Logger utility for the extension's backend code.
 *
 * Log level can be controlled via DLINE_LOG_LEVEL environment variable:
 *   - "error": only errors
 *   - "warn": errors + warnings
 *   - "info": errors + warnings + info + log (default)
 *   - "debug": all above + debug
 *   - "trace": all above + trace
 *
 * Arbitrary logged values are normalized by `safe-diagnostic-value` before they
 * reach a subscriber, so a call site cannot leak command bodies, MCP payloads,
 * task titles, or credentials into Dline Output by passing a raw object.
 */
// biome-ignore lint/complexity/noStaticOnlyClass: Preserve the existing Logger static facade used across the codebase.
export class Logger {
    /** Runtime log level, read once at module load. Defaults to "info". */
    private static readonly logLevel = Logger.readLogLevel()

    private static subscribers: Set<(msg: string) => void> = new Set()
    private static structuredSubscribers: Set<(record: StructuredLogRecord) => void> = new Set()

    private static readLogLevel(): "error" | "warn" | "info" | "debug" | "trace" {
        const raw = process.env.DLINE_LOG_LEVEL?.toLowerCase()
        if (raw === "debug" || raw === "trace") {
            return raw
        }
        // Backward compatibility: IS_DEV=true enables debug level
        if (envFlagEnabled(process.env.IS_DEV)) {
            return "debug"
        }
        return "info"
    }

    private static output(msg: string): void {
        for (const subscriber of Logger.subscribers) {
            try {
                subscriber(msg)
            } catch {
                // ignore errors from subscribers
            }
        }
    }

    /**
     * Register a callback to receive log output messages.
     */
    static subscribe(outputFn: (msg: string) => void): () => void {
        Logger.subscribers.add(outputFn)
        return () => Logger.subscribers.delete(outputFn)
    }

    static subscribeStructured(subscriber: (record: StructuredLogRecord) => void): () => void {
        Logger.structuredSubscribers.add(subscriber)
        return () => Logger.structuredSubscribers.delete(subscriber)
    }

    static error(message: string, ...args: any[]) {
        Logger.#output("ERROR", message, args)
    }

    static warn(message: string, ...args: any[]) {
        Logger.#output("WARN", message, args)
    }

    /** Local telemetry-internal diagnostic that cannot re-enter the structured bridge. */
    static internalError(message: string, ...args: any[]) {
        Logger.#output("ERROR", message, args, false)
    }

    /** Local telemetry-internal warning that cannot re-enter the structured bridge. */
    static internalWarn(message: string, ...args: any[]) {
        Logger.#output("WARN", message, args, false)
    }

    static log(message: string, ...args: any[]) {
        Logger.#output("LOG", message, args)
    }

    static isDebugEnabled(): boolean {
        return Logger.logLevel === "debug" || Logger.logLevel === "trace"
    }

    static debug(message: string, ...args: any[]) {
        if (!Logger.isDebugEnabled()) return
        Logger.#output("DEBUG", message, args)
    }

    static info(message: string, ...args: any[]) {
        Logger.#output("INFO", message, args)
    }

    static trace(message: string, ...args: any[]) {
        if (Logger.logLevel !== "trace") return
        Logger.#output("TRACE", message, args)
    }

    static #output(level: string, message: string, args: any[], publishStructured = true) {
        try {
            const safeMessage = redactDiagnosticString(message)
            const safeArgs = args.map(formatDiagnosticArgument)
            const safeMetadata = args
                .filter((argument) => !(argument instanceof Error))
                .map((argument) => toSafeDiagnosticValue(argument))
            if (publishStructured && (level === "ERROR" || level === "WARN")) {
                const record: StructuredLogRecord = {
                    level: level === "ERROR" ? "error" : "warn",
                    message: safeMessage,
                    args: safeArgs,
                    metadata: safeMetadata,
                    error: args.find((argument): argument is Error => argument instanceof Error),
                }
                for (const subscriber of Logger.structuredSubscribers) {
                    try {
                        subscriber(record)
                    } catch {
                        // Structured telemetry must never break ordinary logging.
                    }
                }
            }
            const now = new Date()
            const pad = (value: number, length = 2) => value.toString().padStart(length, "0")
            const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`
            let fullMessage = `${timestamp} [${level.toLowerCase()}] ${safeMessage}`
            if (safeArgs.length > 0) {
                fullMessage += ` ${safeArgs.join(" ")}`
            }
            Logger.output(fullMessage)
        } catch {
            // do nothing if Logger fails
        }
    }
}
