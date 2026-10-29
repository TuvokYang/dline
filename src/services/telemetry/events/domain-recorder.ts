import type { TelemetrySignalSink } from "../service/signal-sink"

/**
 * Base for every domain recorder.
 *
 * It exists to hold one decision — a recorder owns a sink and nothing else —
 * rather than to share behaviour. That constraint is the point: a recorder
 * that cannot reach a provider, a metadata object, or a lifecycle cannot grow
 * into a second service, which is how the previous single class reached 2,400
 * lines.
 *
 * This replaces the unreferenced `EventHandlerBase` scaffolding, which passed
 * the service into every static method and so gave recorders access to the
 * whole facade.
 */
export abstract class DomainRecorder {
    constructor(protected readonly sink: TelemetrySignalSink) {}
}
