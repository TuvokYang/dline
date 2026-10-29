export interface CommandToolExecutionOptions {
    background: boolean
    synchronous: boolean
    timeoutSeconds: number | undefined
    muteStdout: boolean
}

export function resolveCommandTimeoutSeconds(timeoutParam: string | undefined): number | undefined {
    const normalized = timeoutParam?.trim()
    if (normalized && /^-?\d+$/.test(normalized)) {
        const parsed = Number(normalized)
        if (Number.isSafeInteger(parsed)) return parsed
    }

    return undefined
}

export function parseCommandExecutionOptions(
    _command: string,
    backgroundParam: string | undefined,
    timeoutParam: string | undefined,
    synchronousParam?: string | undefined,
    muteStdoutParam?: string | undefined,
): CommandToolExecutionOptions {
    const background = backgroundParam === "true"
    return {
        background,
        synchronous: !background && synchronousParam === "true",
        timeoutSeconds: resolveCommandTimeoutSeconds(timeoutParam),
        muteStdout: muteStdoutParam === "true",
    }
}
