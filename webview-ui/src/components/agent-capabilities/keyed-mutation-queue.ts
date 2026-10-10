export class KeyedMutationQueue {
    private readonly queues = new Map<string, Promise<void>>()

    enqueue(key: string, operation: () => Promise<void>): Promise<void> {
        const previous = this.queues.get(key)
        const mutation = previous ? previous.catch(() => undefined).then(operation) : operation()
        this.queues.set(key, mutation)
        return mutation.finally(() => {
            if (this.queues.get(key) === mutation) this.queues.delete(key)
        })
    }
}
