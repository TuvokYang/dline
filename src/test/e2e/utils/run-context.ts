import { randomUUID } from "node:crypto"
import * as path from "node:path"

const E2E_RUN_ID_ENVIRONMENT_VARIABLE = "DLINE_E2E_RUN_ID"
const E2E_RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/

function createE2ERunId(): string {
    const timestamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, "")
    return `${timestamp}-${process.pid}-${randomUUID().slice(0, 8)}`
}

export function resolveE2ERunId(env: NodeJS.ProcessEnv = process.env): string {
    const configuredRunId = env[E2E_RUN_ID_ENVIRONMENT_VARIABLE]?.trim()
    if (configuredRunId && !E2E_RUN_ID_PATTERN.test(configuredRunId)) {
        throw new Error(
            `Invalid ${E2E_RUN_ID_ENVIRONMENT_VARIABLE}: only letters, numbers, dots, underscores, and hyphens are allowed`,
        )
    }

    const runId = configuredRunId || createE2ERunId()
    env[E2E_RUN_ID_ENVIRONMENT_VARIABLE] = runId
    return runId
}

export const E2E_RUN_ID = resolveE2ERunId()
export const E2E_OUTPUT_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "tmp", "test-result", E2E_RUN_ID)
