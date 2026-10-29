export interface ConfigurableComponent<TSnapshot> {
    readonly id: string
    configure(snapshot: TSnapshot): void | Promise<void>
}

export interface ComponentConfigurationTiming {
    id: string
    durationMs: number
}

export interface GlobalConfigurationResult {
    durationMs: number
    components: ComponentConfigurationTiming[]
}

/** Applies one immutable global configuration snapshot to registered runtime components. */
export class GlobalConfigurationManager<TSnapshot> {
    private readonly components = new Map<string, ConfigurableComponent<TSnapshot>>()
    private configureQueue: Promise<void> = Promise.resolve()

    constructor(private readonly createSnapshot: () => TSnapshot | Promise<TSnapshot>) {}

    register(component: ConfigurableComponent<TSnapshot>): () => void {
        if (this.components.has(component.id)) {
            throw new Error(`Global configuration component is already registered: ${component.id}`)
        }
        this.components.set(component.id, component)
        return () => {
            if (this.components.get(component.id) === component) this.components.delete(component.id)
        }
    }

    configureAll(): Promise<GlobalConfigurationResult> {
        const pending = this.configureQueue.then(() => this.runConfiguration())
        this.configureQueue = pending.then(
            () => undefined,
            () => undefined,
        )
        return pending
    }

    private async runConfiguration(): Promise<GlobalConfigurationResult> {
        const startedAt = performance.now()
        const snapshot = await this.createSnapshot()
        const components = [...this.components.values()]
        const timings: ComponentConfigurationTiming[] = []
        const failures: Error[] = []

        for (const component of components) {
            const componentStartedAt = performance.now()
            try {
                await component.configure(snapshot)
            } catch (error) {
                failures.push(error instanceof Error ? error : new Error(String(error)))
            } finally {
                timings.push({ id: component.id, durationMs: performance.now() - componentStartedAt })
            }
        }

        if (failures.length > 0) {
            throw new AggregateError(failures, "Failed to configure one or more global components")
        }

        return { durationMs: performance.now() - startedAt, components: timings }
    }
}
