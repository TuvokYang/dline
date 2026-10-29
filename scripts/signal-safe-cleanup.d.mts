export interface SignalProcess {
    on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown
    off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown
    exit(code: number): unknown
}

export class SynchronousCleanupStack {
    defer(cleanup: () => void): void
    cleanup(): void
}

export interface SignalSafeCleanupOptions {
    processRef?: SignalProcess
    onSignalCleanupError?: (error: unknown, signal: "SIGINT" | "SIGTERM") => void
}

export function withSignalSafeCleanup<T>(
    work: (cleanups: SynchronousCleanupStack) => T | Promise<T>,
    options?: SignalSafeCleanupOptions,
): Promise<T>
