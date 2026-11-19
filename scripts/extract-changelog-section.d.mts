/** Options accepted by the notes CLI, keyed by their `--flag` spelling. */
export declare function parseArguments(argv: string[]): {
    options: Record<string, string | true>
    help: boolean
}

/** Command entry point of the notes CLI. */
export declare function main(argv?: string[]): Promise<void>
