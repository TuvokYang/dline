import { Resource } from "@opentelemetry/resources"
import { ATTR_SERVICE_INSTANCE_ID, ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions/incubating"
import { ExtensionRegistryInfo } from "@/registry"
import { getProcessTelemetrySessionId } from "../journal/session-identity"

/**
 * The single definition of who is producing telemetry.
 *
 * Product analytics and runtime diagnostics used to build this independently,
 * which let the two drift: a backend receiving both streams could not tell that
 * they came from the same extension host, and any change to the identity had to
 * be remembered in two places.
 *
 * `service.name` is required by OTLP — without it a backend cannot attribute
 * records to a service. The registry is the normal source, but it reads from
 * `package.json` and is stubbed in some test environments, so the literals here
 * guarantee the attribute is always populated.
 */

const FALLBACK_SERVICE_NAME = "dline"
const UNKNOWN_VERSION = "unknown"

export interface TelemetryResourceOptions {
	/**
	 * Overrides the reported service name.
	 *
	 * Only callers with an established external contract should set this; the
	 * default keeps every producer under one identity.
	 */
	readonly serviceName?: string
	/**
	 * Identifies one extension host run.
	 *
	 * This belongs on the resource rather than on each record: it describes the
	 * producer, not the event, and repeating it per record would inflate every
	 * payload with a constant.
	 */
	readonly sessionId?: string
}

export function createTelemetryResource(options: TelemetryResourceOptions = {}): Resource {
	const attributes: Record<string, string | number> = {
		[ATTR_SERVICE_NAME]: options.serviceName || ExtensionRegistryInfo.name || FALLBACK_SERVICE_NAME,
		[ATTR_SERVICE_VERSION]: ExtensionRegistryInfo.version || UNKNOWN_VERSION,
		[ATTR_SERVICE_INSTANCE_ID]: options.sessionId ?? getProcessTelemetrySessionId(),
		"process.pid": process.pid,
	}

	return new Resource(attributes)
}
