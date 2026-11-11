import { execFileSync } from "node:child_process"
import { appendFileSync } from "node:fs"
import { resolve } from "node:path"
import { setTimeout } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import { assertChannelVersion } from "../release-version-policy.mjs"

const MAIN_WORKFLOW = ".github/workflows/test-main.yml"
const SHA = /^[0-9a-f]{40}$/
const REQUIRED_CHECKS = [
    "TypeScript",
    "Biome",
    "Smoke",
    ...["backend-task", "backend-prompts", "backend-hooks", "backend-core", "backend", "webview"].map(
        (project) => `Vitest (${project})`,
    ),
]

export function assertTagHead({ tag, sha, main, tagged }) {
    const match = /^v(\d+\.\d+\.\d+)$/.exec(tag ?? "")
    if (!match || !SHA.test(sha ?? "")) throw new Error("An exact production tag and full commit SHA are required.")
    assertChannelVersion("production", match[1])
    if (sha !== main || sha !== tagged)
        throw new Error("The production tag and current main head must equal the validated commit.")
}

export function resolveMainGate(runs, { repository, sha }) {
    if (!SHA.test(sha ?? "")) throw new Error("A full commit SHA is required.")
    const latest = runs
        .filter(
            (run) =>
                run.path === MAIN_WORKFLOW &&
                run.event === "push" &&
                run.head_branch === "main" &&
                run.head_sha === sha &&
                run.head_repository?.full_name === repository,
        )
        .sort((left, right) => right.id - left.id)[0]
    if (!latest || latest.status !== "completed") return { status: "waiting" }
    if (latest.conclusion !== "success")
        throw new Error(`Main Tests ${latest.id} ended with ${latest.conclusion}; production is blocked.`)
    if (!Number.isSafeInteger(latest.id) || latest.id < 1 || !Number.isSafeInteger(latest.run_attempt) || latest.run_attempt < 1)
        throw new Error("Main Tests identity is invalid.")
    return { status: "ready", id: latest.id, attempt: latest.run_attempt }
}

export function assertMainChecks(jobs) {
    for (const check of REQUIRED_CHECKS) {
        const matches = jobs.filter((job) => job.name === check || job.name.endsWith(`/ ${check}`))
        if (matches.length !== 1 || matches[0].conclusion !== "success")
            throw new Error(`Main check '${check}' must have exactly one successful result.`)
    }
}

export async function awaitMainGate(context, ports, attempts = 120) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        const gate = resolveMainGate(await ports.listRuns(), context)
        if (gate.status === "ready") {
            assertMainChecks(await ports.listJobs(gate))
            return gate
        }
        if (attempt + 1 < attempts) await ports.pause()
    }
    throw new Error("Timed out waiting for the existing Main Tests run; no replacement tests were started.")
}

function github(repository, endpoint) {
    return JSON.parse(
        execFileSync("gh", ["api", "--paginate", "--slurp", `repos/${repository}/${endpoint}`], {
            encoding: "utf8",
            timeout: 30_000,
            maxBuffer: 4 * 1024 * 1024,
            stdio: ["ignore", "pipe", "inherit"],
        }),
    )
}

async function main(env) {
    const repository = env.GITHUB_REPOSITORY
    if (
        !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") ||
        env.GITHUB_EVENT_NAME !== "push" ||
        env.GITHUB_REF !== `refs/tags/${env.RELEASE_TAG}`
    )
        throw new Error("Production validation requires this repository's exact tag push.")
    const context = { repository, sha: env.COMMIT_SHA }
    const verify = () =>
        assertTagHead({
            tag: env.RELEASE_TAG,
            sha: context.sha,
            main: github(repository, "git/ref/heads/main")[0].object.sha,
            tagged: github(repository, `commits/${encodeURIComponent(env.RELEASE_TAG)}`)[0].sha,
        })
    verify()
    const gate = await awaitMainGate(context, {
        listRuns: () =>
            github(
                repository,
                `actions/workflows/test-main.yml/runs?branch=main&event=push&head_sha=${context.sha}&per_page=100`,
            ).flatMap((page) => page.workflow_runs),
        listJobs: ({ id, attempt }) =>
            github(repository, `actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`).flatMap((page) => page.jobs),
        pause: () => setTimeout(30_000),
    })
    verify()
    appendFileSync(env.GITHUB_OUTPUT, `tests_run_id=${gate.id}\n`)
    console.log(`Reusing Main Tests ${gate.id}, attempt ${gate.attempt}, for ${context.sha}. No checks were restarted.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main(process.env).catch((error) => {
        console.error(error.message)
        process.exitCode = 1
    })
}
