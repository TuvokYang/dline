/**
 * Minimal ambient declaration for the `archiver` runtime dependency.
 *
 * `archiver` ships without bundled types and `@types/archiver` is not a project
 * dependency. Only the members used by the diagnostic bundle writer are
 * declared, so an unmodelled API surface fails type checking instead of
 * silently resolving to `any`.
 */
declare module "archiver" {
    import type { Writable } from "node:stream"

    type ArchiverFormat = "zip" | "tar"

    type ArchiverOptions = {
        zlib?: {
            level?: number
        }
    }

    type EntryData = {
        name: string
    }

    type ArchiverEvent = "error" | "warning"

    interface Archiver {
        /** Pipe archive output into `destination` and return it for chaining. */
        pipe<T extends Writable>(destination: T): T
        /** Append in-memory content as a single archive entry. */
        append(source: string | Buffer, data: EntryData): this
        /** Stop the archive without finalizing; releases the output stream. */
        abort(): this
        /** Signal that no further entries follow and flush the archive. */
        finalize(): Promise<void>
        /** Total number of bytes written so far. */
        pointer(): number
        on(event: ArchiverEvent, listener: (error: Error) => void): this
    }

    function archiver(format: ArchiverFormat, options?: ArchiverOptions): Archiver

    export default archiver
}
