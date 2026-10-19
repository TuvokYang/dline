import type { McpVariableOwner, McpVariableStore } from "@/core/storage/secrets/McpVariableStore"
import { Logger } from "@/shared/services/Logger"
import { collectEnvironmentReferences, type EnvironmentLookup, expandEnvironmentVariables } from "@/utils/envExpansion"

/** Asks the user for one value; undefined or an empty string means the user declined. */
export type McpVariablePrompt = (request: {
    readonly serverLabel: string
    readonly variable: string
}) => Promise<string | undefined>

export type McpVariableResolution<T> =
    | { readonly kind: "resolved"; readonly config: T }
    /** The user declined to provide this variable; the server must not connect. */
    | { readonly kind: "missing"; readonly variable: string }
    /** No value is known and asking is not allowed yet; connect again once it is. */
    | { readonly kind: "deferred"; readonly variable: string }

export interface McpVariableResolverOptions {
    readonly store: Pick<McpVariableStore, "read" | "save">
    readonly prompt: McpVariablePrompt
    /** Defaults to the extension host's process environment. */
    readonly environment?: EnvironmentLookup
    /** Whether the user may be asked now. Defaults to always. */
    readonly canPrompt?: () => boolean
}

/**
 * Resolves the `${env:VAR}` references of one MCP server configuration at connect time.
 *
 * Each variable is looked up in the value saved for this server in its own scope,
 * then in the process environment, and only then asked for. A value the user enters
 * is saved for this server only, so servers never see each other's values.
 */
export class McpVariableResolver {
    private readonly environment: EnvironmentLookup
    private promptQueue: Promise<unknown> = Promise.resolve()

    constructor(private readonly options: McpVariableResolverOptions) {
        this.environment = options.environment ?? ((name) => process.env[name])
    }

    async resolve<T>(owner: McpVariableOwner, serverLabel: string, config: T): Promise<McpVariableResolution<T>> {
        const values = new Map<string, string>()
        for (const variable of collectEnvironmentReferences(config)) {
            let value = this.lookup(owner, variable)
            if (value === undefined) {
                if (this.options.canPrompt?.() === false) return { kind: "deferred", variable }
                value = await this.ask(owner, serverLabel, variable)
            }
            if (value === undefined) return { kind: "missing", variable }
            values.set(variable, value)
        }
        if (values.size === 0) return { kind: "resolved", config }
        return { kind: "resolved", config: expandEnvironmentVariables(config, (name) => values.get(name)) }
    }

    private lookup(owner: McpVariableOwner, variable: string): string | undefined {
        return this.options.store.read(owner, variable) ?? this.environment(variable)
    }

    /**
     * Prompts run one at a time, so several servers starting together do not stack
     * input boxes. Each prompt re-reads the store first: a value saved meanwhile, by
     * an earlier prompt or another window, is used without asking again.
     */
    private ask(owner: McpVariableOwner, serverLabel: string, variable: string): Promise<string | undefined> {
        const answer = this.promptQueue.then(async () => {
            const saved = this.lookup(owner, variable)
            if (saved !== undefined) return saved
            const entered = await this.options.prompt({ serverLabel, variable })
            if (!entered) return undefined
            try {
                await this.options.store.save(owner, variable, entered)
            } catch (error) {
                // The value still serves this connection; only its reuse is lost.
                Logger.warn(
                    `[MCP Variables] Could not save ${variable} for ${serverLabel}: ${error instanceof Error ? error.message : String(error)}`,
                )
            }
            return entered
        })
        this.promptQueue = answer.catch(() => undefined)
        return answer
    }
}
