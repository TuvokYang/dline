export interface SessionResourceReleasePort {
	release(): Promise<void>
}

/** Release every owner in reverse acquisition order, without hiding failures. */
export async function releaseSessionResources(resources: readonly SessionResourceReleasePort[]): Promise<void> {
	const failures: unknown[] = []
	for (const resource of [...resources].reverse()) {
		try {
			await resource.release()
		} catch (error) {
			failures.push(error)
		}
	}
	if (failures.length > 0) throw new AggregateError(failures, "Failed to release task session resources")
}

/** Holds acquired resources until composition transfers ownership to the session. */
export class SessionResourceScope implements SessionResourceReleasePort {
	private readonly resources: SessionResourceReleasePort[] = []
	private releasePromise: Promise<void> | undefined

	add(resource: SessionResourceReleasePort): void {
		if (this.releasePromise) throw new Error("Task session resource scope is already closing")
		this.resources.push(resource)
	}

	/** Idempotent even after a failure: every registered release is attempted once. */
	release(): Promise<void> {
		this.releasePromise ??= Promise.resolve().then(() => releaseSessionResources(this.resources))
		return this.releasePromise
	}
}
