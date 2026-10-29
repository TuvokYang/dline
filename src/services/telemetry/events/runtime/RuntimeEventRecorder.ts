import {
    emitSignal,
    isSignalRecordingEnabled,
    type SignalAttributes,
    type SignalContext,
    type SignalLevel,
} from "../../service/pipeline-port"

export interface RuntimeEventRecord {
    readonly name: string
    readonly level: SignalLevel
    readonly attributes?: SignalAttributes
    readonly error?: unknown
    readonly context?: SignalContext
}

export interface RuntimeEventRecorderPort {
    record(input: RuntimeEventRecord): void
}

export interface RuntimeEventRecorderOptions {
    readonly enabled?: () => boolean
    readonly accept?: (input: RuntimeEventRecord) => void
}

/** Standard runtime Event recorder. Consent is checked before signal materialisation. */
export class RuntimeEventRecorder implements RuntimeEventRecorderPort {
    private readonly enabled: () => boolean
    private readonly accept: (input: RuntimeEventRecord) => void

    constructor(options: RuntimeEventRecorderOptions = {}) {
        this.enabled = options.enabled ?? isSignalRecordingEnabled
        this.accept = options.accept ?? emitSignal
    }

    record(input: RuntimeEventRecord): void {
        if (!this.enabled()) return
        this.accept(input)
    }

    debug(name: string, attributes?: SignalAttributes, context?: SignalContext): void {
        this.record({ name, level: "debug", attributes, context })
    }

    info(name: string, attributes?: SignalAttributes, context?: SignalContext): void {
        this.record({ name, level: "info", attributes, context })
    }

    performance(name: string, attributes?: SignalAttributes, context?: SignalContext): void {
        this.record({ name, level: "performance", attributes, context })
    }

    failure(name: string, error: unknown, attributes?: SignalAttributes, context?: SignalContext): void {
        this.record({ name, level: "error", attributes, error, context })
    }

    invariant(name: string, attributes?: SignalAttributes, context?: SignalContext): void {
        this.record({ name, level: "invariant", attributes, context })
    }
}

export const runtimeEventRecorder = new RuntimeEventRecorder()
