export type ResourceKind = "provider" | "mcp" | "terminal" | "browser" | "diff"

export interface ResourceScope {
	readonly taskId: string
	readonly subruntimeId: string
}

export interface AcquiredResource {
	readonly value: unknown
	release(): void | Promise<void>
}

export interface ResourceProvider {
	acquire(scope: ResourceScope, kind: ResourceKind): Promise<AcquiredResource>
}

export interface ResourceLease {
	readonly leaseId: string
	readonly scope: ResourceScope
	get<T = unknown>(kind: ResourceKind): T
	release(): Promise<void>
}

class ScopedResourceLease implements ResourceLease {
	private released = false

	constructor(
		readonly leaseId: string,
		readonly scope: ResourceScope,
		private readonly resources: ReadonlyMap<ResourceKind, AcquiredResource>,
		private readonly onRelease: () => void,
	) {}

	get<T = unknown>(kind: ResourceKind): T {
		if (this.released) throw new Error("ResourceLeaseReleased")
		const resource = this.resources.get(kind)
		if (!resource) throw new Error(`ResourceNotLeased:${kind}`)
		return resource.value as T
	}

	async release(): Promise<void> {
		if (this.released) return
		this.released = true
		try {
			await Promise.allSettled([...this.resources.values()].reverse().map((resource) => resource.release()))
		} finally {
			this.onRelease()
		}
	}
}

export class ResourceBroker {
	private readonly activeScopes = new Map<string, string>()
	private sequence = 0

	constructor(private readonly provider: ResourceProvider) {}

	async acquire(scope: ResourceScope, kinds: readonly ResourceKind[]): Promise<ResourceLease> {
		const scopeKey = `${scope.taskId}:${scope.subruntimeId}`
		if (this.activeScopes.has(scopeKey)) throw new Error(`ResourceScopeActive:${scopeKey}`)
		const leaseId = `${scopeKey}:${++this.sequence}`
		this.activeScopes.set(scopeKey, leaseId)
		const resources = new Map<ResourceKind, AcquiredResource>()
		try {
			for (const kind of [...new Set(kinds)]) resources.set(kind, await this.provider.acquire(scope, kind))
			return new ScopedResourceLease(leaseId, scope, resources, () => {
				if (this.activeScopes.get(scopeKey) === leaseId) this.activeScopes.delete(scopeKey)
			})
		} catch (error) {
			await Promise.allSettled([...resources.values()].reverse().map((resource) => resource.release()))
			if (this.activeScopes.get(scopeKey) === leaseId) this.activeScopes.delete(scopeKey)
			throw error
		}
	}

	isActive(scope: ResourceScope): boolean {
		return this.activeScopes.has(`${scope.taskId}:${scope.subruntimeId}`)
	}
}
