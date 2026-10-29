const DEFAULT_CONFIG = "vitest.config.ts"

/**
 * Parse Vitest UI server CLI options.
 *
 * @param {string[]} argv Raw command line arguments.
 * @param {NodeJS.ProcessEnv} env Environment variables.
 * @param {{ host: string, port: number }} defaults Default host and port values.
 * @returns {{ host: string, port: number, config: string }} Parsed server options.
 */
export function parseServerArgs(argv, env, defaults) {
    const options = {
        host: env.VITEST_UI_HOST || defaults.host,
        port: Number(env.VITEST_UI_PORT || defaults.port),
        config: env.VITEST_UI_CONFIG || DEFAULT_CONFIG,
    }
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index]
        if (arg === "--host") options.host = argv[++index]
        else if (arg === "--port") options.port = Number(argv[++index])
        else if (arg === "--config") options.config = argv[++index]
    }
    return options
}

/**
 * Build Vitest 4 UI CLI arguments.
 *
 * @param {{ host: string, port: number, config?: string }} options Vitest UI server options.
 * @returns {string[]} Arguments passed to the local Vitest CLI.
 */
export function buildVitestUiArgs(options) {
    const args = ["--ui", "--watch", "--no-open", "--api.host", options.host, "--api.port", String(options.port)]
    if (options.config) {
        args.push("--config", options.config)
    }
    return args
}
