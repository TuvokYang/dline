/**
 * Stored data that cannot be read back as written.
 *
 * Reads fail with this error instead of skipping the record, so a damaged file is
 * never mistaken for a shorter history.
 */
export class UnifyStoreCorruptionError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options)
        this.name = "UnifyStoreCorruptionError"
    }
}
