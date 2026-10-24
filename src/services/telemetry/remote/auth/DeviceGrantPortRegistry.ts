import type { AtomicDeviceGrant } from "../contracts/deviceGrant"
import type { DeviceGrantClient, DeviceGrantPort } from "./DeviceGrantPort"

/**
 * Keeps the credential port stable while the grant acquisition adapter evolves.
 *
 * Adoption is compare-and-swap by adapter identity: a stale bootstrap owner
 * cannot overwrite a recoverable coordinator installed after it.
 */
export class DeviceGrantPortRegistry implements DeviceGrantClient {
    private client: DeviceGrantClient

    constructor(
        readonly port: DeviceGrantPort,
        initialClient: DeviceGrantClient,
    ) {
        this.client = initialClient
    }

    readActiveGrant(now: number): Promise<AtomicDeviceGrant | null> {
        return this.port.readActive(now)
    }

    ensureActiveGrant(deviceSecret: string, signal?: AbortSignal): Promise<AtomicDeviceGrant | null> {
        return this.client.ensureActiveGrant(deviceSecret, signal)
    }

    adopt(expected: DeviceGrantClient, replacement: DeviceGrantClient): boolean {
        if (this.client !== expected) return false
        this.client = replacement
        return true
    }
}
